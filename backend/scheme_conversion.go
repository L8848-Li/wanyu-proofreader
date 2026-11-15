package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"fangji/backend/scheme"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/search"
	"github.com/pocketbase/pocketbase/tools/types"
	"golang.org/x/text/unicode/norm"
)

// #190 拼音转换的运行面：谁来跑、怎么复核、怎么交付。
//
// 引擎是 #281 的 `backend/scheme`（纯函数、不读库、不持规则），本文件只做它刻意没做的
// 那一半——作业、断点、复核队列与结论回流。三者共用一条口径：**机器判不出来的东西
// 不能猜**，要么进复核队列交给人，要么在作业上给出可诊断的拒绝理由。
//
// 与 #189 的分工：#189 是「方案 A 的音节怎么变成方案 B 的音节」，本文件是「这一批
// 条目什么时候转、谁看过、结论怎么带出去」。

// schemeAdapterDirEnv 指向一个目录，里面是本实例可用的规则文件（`scheme.LoadAdapter` 的入参）。
//
// 刻意**没有默认值**：本仓在 #193/#195 上学过这一课——写死的默认路径最后会把作者本机的
// 目录带进生产。目录不存在或未配置不是错误，是「本实例还没有任何可用方案」这个合法状态，
// 管理端会在概览里看到它。
const schemeAdapterDirEnv = "FANGJI_SCHEME_ADAPTER_DIR"

const readingRole = "reading"

// canonicalPronunciationMaxLength 与 source_scheme_id / canonical_scheme_id 的 200 同口径，
// 也与迁移 1789200700 里 canonical_pronunciation 的 max 一致——两处必须一起改，
// 否则会变成「界面能存、直接调接口存不进」这种只有一半人碰得到的差别。
// 转换侧不设这道闸：那里的值来自引擎的输出，长度由目标清单决定，不是人打的。
const canonicalPronunciationMaxLength = 200

// schemeRegistry 是启动时载入的规则表。载入即校验：一个文件坏掉就整实例起不来
// （#189 明确要求「非法即启动报错，不要静默半生效」），而不是半套规则在跑。
type schemeRegistry struct {
	dir         string
	adapters    map[string]*scheme.Adapter
	notice      string
	ruleDigests map[string]string
}

func loadSchemeRegistry() (*schemeRegistry, error) {
	registry := &schemeRegistry{adapters: map[string]*scheme.Adapter{}, ruleDigests: map[string]string{}}
	registry.dir = strings.TrimSpace(os.Getenv(schemeAdapterDirEnv))
	if registry.dir == "" {
		registry.notice = fmt.Sprintf("本实例没有配置规则目录（环境变量 %s），因此还没有任何可用的转换方案。", schemeAdapterDirEnv)
		return registry, nil
	}
	entries, err := os.ReadDir(registry.dir)
	if err != nil {
		return nil, fmt.Errorf("读取规则目录 %s 失败: %w", registry.dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names) // 目录迭代无序；同名方案冲突时要报出稳定的那一个
	type ruleFileHead struct {
		SchemaVersion     int    `json:"schema_version"`
		SourceSchemeID    string `json:"source_scheme_id"`
		CanonicalSchemeID string `json:"canonical_scheme_id"`
		SchemeID          string `json:"scheme_id"`
	}
	heads := make(map[string]ruleFileHead, len(names))
	snapshots := make(map[string][]byte, len(names))
	for _, name := range names {
		raw, readErr := os.ReadFile(filepath.Join(registry.dir, name))
		if readErr != nil {
			return nil, fmt.Errorf("读取规则文件 %s 失败: %w", name, readErr)
		}
		var head ruleFileHead
		if unmarshalErr := json.Unmarshal(raw, &head); unmarshalErr != nil {
			return nil, fmt.Errorf("规则文件 %s 无法载入: %w", name, unmarshalErr)
		}
		heads[name] = head
		snapshots[name] = raw
	}
	targets := map[string]*scheme.Scheme{}
	for _, name := range names {
		head := heads[name]
		if head.SourceSchemeID != "" || head.SchemeID == "" {
			continue
		}
		target, loadErr := scheme.LoadSchemeData(snapshots[name], filepath.Join(registry.dir, name))
		if loadErr != nil {
			return nil, fmt.Errorf("目标方案 %s 无法载入: %w", name, loadErr)
		}
		if _, dup := targets[target.SchemeID]; dup {
			return nil, fmt.Errorf("目标方案文件 %s 与已载入的 scheme_id %s 重复", name, target.SchemeID)
		}
		targets[target.SchemeID] = target
	}
	for _, name := range names {
		head := heads[name]
		if head.SourceSchemeID == "" && head.SchemeID != "" {
			continue
		}
		if head.SourceSchemeID == "" {
			return nil, fmt.Errorf("规则文件 %s 既不是转换规则，也不是目标方案", name)
		}
		path := filepath.Join(registry.dir, name)
		var adapter *scheme.Adapter
		var loadErr error
		if head.SchemaVersion >= scheme.RealJobSchemaVersion {
			target := targets[head.CanonicalSchemeID]
			if target == nil {
				return nil, fmt.Errorf("规则文件 %s 是 schema_version %d，需要同目录提供目标方案 %s", name, head.SchemaVersion, head.CanonicalSchemeID)
			}
			adapter, loadErr = scheme.LoadAdapterData(snapshots[name], path, target)
		} else {
			adapter, loadErr = scheme.LoadAdapterData(snapshots[name], path, nil)
		}
		if loadErr != nil {
			return nil, fmt.Errorf("规则文件 %s 无法载入: %w", name, loadErr)
		}
		if existing, dup := registry.adapters[adapter.SourceScheme]; dup {
			return nil, fmt.Errorf("规则文件 %s 与已载入的方案 %s（rule_version %s）同名，方案标识必须唯一",
				name, adapter.SourceScheme, existing.RuleVersion)
		}
		registry.adapters[adapter.SourceScheme] = adapter
		rawRule := snapshots[name]
		// Bind v2's separate target inventory too, including its schema and IPA.
		target, _ := json.Marshal(targets[adapter.CanonicalScheme])
		var document any
		if err := json.Unmarshal(rawRule, &document); err != nil {
			return nil, err
		}
		normalizedRule, err := json.Marshal(document)
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(append(append(normalizedRule, 0), target...))
		registry.ruleDigests[adapter.SourceScheme] = hex.EncodeToString(digest[:])
	}
	if len(registry.adapters) == 0 {
		registry.notice = fmt.Sprintf("规则目录 %s 里没有可用的规则文件，因此还没有任何可用的转换方案。", registry.dir)
	}
	return registry, nil
}

// schemeOption 是管理端方案选择器的一行。rule_status 必须一起发出去：
// 「这一套不能用来发起真实作业」要让界面在点按钮之前就能说，而不是等 400 回来才知道。
type schemeOption struct {
	SourceSchemeID     string `json:"source_scheme_id"`
	CanonicalSchemeID  string `json:"canonical_scheme_id"`
	RuleVersion        string `json:"rule_version"`
	RuleStatus         string `json:"rule_status"`
	CanStartConversion bool   `json:"can_start_conversion"`
}

func (r *schemeRegistry) schemes() []schemeOption {
	list := make([]schemeOption, 0, len(r.adapters))
	for _, adapter := range r.adapters {
		_, refused := r.jobAdapter(adapter.SourceScheme)
		list = append(list, schemeOption{
			SourceSchemeID:     adapter.SourceScheme,
			CanonicalSchemeID:  adapter.CanonicalScheme,
			RuleVersion:        adapter.RuleVersion,
			RuleStatus:         adapter.RuleStatus,
			CanStartConversion: refused == "",
		})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].SourceSchemeID < list[j].SourceSchemeID })
	return list
}

// jobAdapter 是「这套规则能不能拿来跑一个真实作业」的唯一判据，发起与续跑两处都走它。
//
// owner 对第 1 条阻断给的是替代方案：真实规则的形状是 #189 的事，本 PR 不发明它，
// 但本 PR 必须让旧/synthetic adapter 进不了真实作业。这里有两道判据，缺一不可：
//
//  1. 声明：规则文件自己写 rule_status。它必须写，但**光凭它不够**——规则文件是数据，
//     改一个字段就能放行。测试脚手架自己就这么做过（把合成夹具改标签成 production），
//     正说明声明不能当唯一闸门。
//  2. 契约：真实作业要求 schema_version >= scheme.RealJobSchemaVersion，即 #189 的
//     `source notation → documented IPA → target notation`。v1 是直接的 from → to，
//     没有 IPA 槽位，改标签改不出这一步。在 #189 交付 v2 之前，所有 v1 规则都过不了
//     这一道；只有带 `schemetest` 构建标签的一次性测试二进制会放行（见
//     scheme_realjobs_enabled.go）。生产镜像不带这个标签。
//
// 返回的第二个值是给管理员看的中文拒绝理由；空串表示放行。四种情形是四句不同的话：
//   - 根本没登记（reason 为空，由调用方给「本实例没有登记…」那句）；
//   - 登记了，但声明是 test（本函数给出）；
//   - 声明了 production，但仍是 v1 直接映射（本函数给出，生产构建）；
//   - 登记了且两道判据都过，但作业记录与规则对不上（processConversion 给出）。
func (r *schemeRegistry) jobAdapter(sourceScheme string) (*scheme.Adapter, string) {
	adapter, ok := r.adapters[sourceScheme]
	if !ok {
		return nil, ""
	}
	if !adapter.MayDriveRealJobs() {
		if adapter.SchemaVersion >= scheme.RealJobSchemaVersion {
			return adapter, fmt.Sprintf(
				"「%s」声明的是 rule_status=%q（rule_version %s），只能用于测试，不能创建真实转换作业。"+
					"它已经按 source → IPA → target 登记；依据不足的音节会 decline，不会猜成生产规则。",
				adapter.SourceScheme, adapter.RuleStatus, adapter.RuleVersion)
		}
		return adapter, fmt.Sprintf(
			"「%s」声明的是 rule_status=%q，只能用于测试，不能创建真实转换作业。"+
				"真实方案要等 #189 把各书凡例转写成 source 侧清单后交付（届时那份规则写 rule_status=%q 并给出 rule_status_basis）。",
			adapter.SourceScheme, adapter.RuleStatus, scheme.RuleStatusProduction)
	}
	if adapter.SchemaVersion < scheme.RealJobSchemaVersion && !allowTestOnlyAdaptersForJobs {
		return adapter, fmt.Sprintf(
			"「%s」虽然声明了 rule_status=production，但仍是 schema_version=%d 的直接映射（源记法 → 目标记法），"+
				"没有 source → IPA → target 的证据，不能创建真实转换作业。真实转换要等 #189 把规则升到 schema_version=%d；"+
				"在那之前，直接映射的规则只能用于测试。",
			adapter.SourceScheme, adapter.SchemaVersion, scheme.RealJobSchemaVersion)
	}
	return adapter, ""
}

// projectReadingColumns 从 #170 的列角色里找出记音列。
// 找不到、或找到多于一列时返回的问题串是要给管理员看的中文说明——「不知道转哪一列」
// 必须是可诊断的拒绝，不能退化成「猜一个」或「什么都不做」。
func projectReadingColumns(project *core.Record) ([]string, string) {
	return readingColumnsFrom(project.GetString("column_roles_json"))
}

func readingColumnsFrom(stored string) ([]string, string) {
	raw := strings.TrimSpace(stored)
	if raw == "" {
		return nil, "本项目还没有标注列角色，无法确定要转换哪一列。请在项目设置的“列角色”中，将需要转换的一列设为“记音”，并保存列角色。"
	}
	roles := map[string]string{}
	if err := json.Unmarshal([]byte(raw), &roles); err != nil {
		return nil, "本项目的列角色记录无法解析，请在项目设置的“列角色”中重新设置并保存后再试。"
	}
	names := []string{}
	for name, role := range roles {
		if role == readingRole {
			names = append(names, name)
		}
	}
	sort.Strings(names) // map 迭代无序，这里要一个稳定的顺序
	switch len(names) {
	case 0:
		return nil, "本项目尚未设置记音列，无法确定要转换哪一列。请在项目设置的“列角色”中，将需要转换的一列设为“记音”，并保存列角色。"
	case 1:
		return names, ""
	default:
		return nil, fmt.Sprintf("本项目标了 %d 个记音列（%s），本作业一次只转换一列。请在项目设置的“列角色”中只保留一个“记音”列并保存后再试。",
			len(names), strings.Join(names, "、"))
	}
}

// pageReadingValue 取一个条目的待转换值。
//
// 优先校对后的值、其次识别值：本功能的前提是「先忠实校原书、再程序化归一」（#114 §2），
// 所以有校对结果时转换的必须是它；只在还没人校过时才退回识别原文。
func pageReadingValue(page *core.Record, column string) string {
	for _, field := range []string{"proofread_row_json", "ocr_row_json"} {
		obj := parseRowJSON(page.GetString(field))
		if obj == nil {
			continue
		}
		value, ok := obj.get(column)
		if !ok {
			continue
		}
		text, ok := value.(string)
		if !ok {
			continue
		}
		// A deliberately blank proofread field is still the current value;
		// it must not revive the old OCR pronunciation.
		return strings.TrimSpace(text)
	}
	return ""
}

func (s *importService) registerSchemeConversion() error {
	registry, err := loadSchemeRegistry()
	if err != nil {
		return err
	}
	s.schemes = registry

	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		// 日志放在 OnServe 而不是 main 里：main 也会被 `pocketbase migrate` 走到，
		// 而那一次既不服务也不加载规则，一次完整的启动序列会白打十几行同样的内容。
		if registry.notice != "" {
			logUpload("info", "scheme_registry_empty", map[string]any{"dir": registry.dir, "notice": registry.notice})
		} else {
			logUpload("info", "scheme_registry_loaded", map[string]any{"dir": registry.dir, "schemes": len(registry.adapters)})
		}

		e.Router.GET("/api/fangji/scheme-adapters", s.listSchemeAdapters).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/projects/{projectId}/conversions", s.startConversion).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/conversions", s.listConversions).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/conversions/{jobId}", s.getConversion).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/normalizations", s.listNormalizations).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/normalization-exceptions", s.exportNormalizationExceptions).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/pages/{pageId}/normalization", s.decideNormalization).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
	return nil
}

func (s *importService) listSchemeAdapters(c *core.RequestEvent) error {
	return c.JSON(http.StatusOK, map[string]any{
		"schemes": s.schemes.schemes(),
		"notice":  s.schemes.notice,
	})
}

func (s *importService) startConversion(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	auth, project, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return err
	}

	payload := struct {
		SourceScheme string `json:"source_scheme_id"`
	}{}
	if err := c.BindBody(&payload); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", nil)
	}
	sourceScheme := strings.TrimSpace(payload.SourceScheme)
	// #114 §10 第 4 条：不自动判断某书用什么方案。没声明就拒绝，不去猜。
	if sourceScheme == "" {
		return apis.NewBadRequestError("必须先声明本批资料用的是哪一套拼音方案（source_scheme_id），系统不会替你判断。", nil)
	}
	adapter, refused := s.schemes.jobAdapter(sourceScheme)
	if adapter == nil {
		return apis.NewBadRequestError(fmt.Sprintf("本实例没有登记「%s」这套方案。可用方案见 /api/fangji/scheme-adapters。", sourceScheme), nil)
	}
	if refused != "" {
		return apis.NewBadRequestError(refused, nil)
	}
	if _, problem := projectReadingColumns(project); problem != "" {
		return apis.NewBadRequestError(problem, nil)
	}

	total, err := countPagesWithFilter(s.app, `project = {:project} && status != "importing"`, dbx.Params{"project": projectID})
	if err != nil {
		return apis.NewBadRequestError("读取项目条目失败。", err)
	}
	if total == 0 {
		return apis.NewBadRequestError("当前项目暂无可转换的条目", nil)
	}

	collection, err := s.app.FindCollectionByNameOrId("conversion_jobs")
	if err != nil {
		return apis.NewBadRequestError("转换作业存储尚未初始化。", err)
	}
	record := core.NewRecord(collection)
	record.Set("project", projectID)
	record.Set("created_by", auth.Id)
	record.Set("source_scheme", adapter.SourceScheme)
	record.Set("canonical_scheme", adapter.CanonicalScheme)
	record.Set("rule_version", adapter.RuleVersion)
	record.Set("status", "queued")
	record.Set("total_count", 0)
	record.Set("cursor", 0)
	if err := s.app.Save(record); err != nil {
		// idx_conversion_jobs_active 是部分唯一索引（WHERE status IN ('queued','processing')）：
		// 同一个项目同时只允许一个在跑的转换。并发点两次时后来者会撞在这里，
		// 重查一次把在跑的那个还给调用方，而不是报一个看不出原因的错误。
		if running, lookupErr := s.activeConversionJob(projectID); lookupErr == nil && running != nil {
			return c.JSON(http.StatusConflict, map[string]any{
				"message": "该项目已有一个转换作业在跑，请等它结束。",
				"job":     running,
			})
		}
		return apis.NewBadRequestError("创建转换作业失败。", err)
	}
	s.enqueue(importWork{kind: "conversion", id: record.Id, requestID: ensureRequestID(c)})
	return c.JSON(http.StatusAccepted, record)
}

func (s *importService) activeConversionJob(projectID string) (*core.Record, error) {
	// PocketBase 的 filter 语法（fexpr）没有 `IN`，只有 `=` / `~` 这些与 `&&` / `||`
	// 两种连接符；写 `IN (...)` 会在这里报「读取失败」，于是撞上唯一索引的那次并发
	// 只会得到一句看不出原因的 400，而不是本该返回的 409。
	records, err := s.app.FindRecordsByFilter(
		"conversion_jobs",
		`project = {:project} && (status = "queued" || status = "processing")`,
		"-created", 1, 0, dbx.Params{"project": projectID},
	)
	if err != nil || len(records) == 0 {
		return nil, err
	}
	return records[0], nil
}

func (s *importService) listConversions(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}
	records, err := s.app.FindRecordsByFilter("conversion_jobs", `project = {:project}`, "-created", 20, 0,
		dbx.Params{"project": projectID})
	if err != nil {
		return apis.NewBadRequestError("读取转换作业失败。", err)
	}
	return c.JSON(http.StatusOK, map[string]any{"items": records, "schemes": s.schemes.schemes(), "notice": s.schemes.notice})
}

// Read the requested job, never a newer job belonging to another administrator.
func (s *importService) getConversion(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}
	record, err := s.app.FindRecordById("conversion_jobs", c.Request.PathValue("jobId"))
	if err != nil || record.GetString("project") != projectID {
		return apis.NewNotFoundError("转换作业不存在或不属于当前项目。", nil)
	}
	return c.JSON(http.StatusOK, record)
}

func (s *importService) listNormalizations(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	_, project, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return err
	}
	query := c.Request.URL.Query()
	// 队列默认只收 AMBIGUOUS，但 UNSUPPORTED 同样是「机器判不出来、需要人」的条目，
	// 管理端要能一起看到（可以传 "AMBIGUOUS,UNSUPPORTED"），否则汇总里的「暂未支持」
	// 永远没有入口。多个状态用逗号分隔。
	statuses, problem := parseNormalizationStatuses(query.Get("status"))
	if problem != "" {
		return apis.NewBadRequestError(problem, nil)
	}
	page, size := pageArgument(query.Get("page"), 1, 1000000), pageArgument(query.Get("perPage"), 25, 100)

	params := dbx.Params{"project": projectID}
	filter := `project = {:project} && ` + normalizationStatusFilter(statuses)
	var result map[string]any
	err = s.app.RunInTransaction(func(app core.App) error {
		total, err := countPagesWithFilter(app, filter, params)
		if err != nil {
			return err
		}
		totalPages := max(1, int((total+int64(size)-1)/int64(size)))
		page = min(page, totalPages)
		records, err := app.FindRecordsByFilter("pages", filter, "page_number,id", size, (page-1)*size, params)
		if err != nil {
			return err
		}
		files, err := normalizationSourceFiles(app, projectID, records)
		if err != nil {
			return err
		}
		items := make([]map[string]any, 0, len(records))
		for _, record := range records {
			items = append(items, s.normalizationReviewView(record, project, files))
		}
		result = map[string]any{"items": items, "page": page, "perPage": size, "totalItems": total, "totalPages": totalPages}
		return nil
	})
	if err != nil {
		return apis.NewBadRequestError("读取复核队列失败。", err)
	}
	return c.JSON(http.StatusOK, result)
}

// reviewableNormalizationStatus 是 decideNormalization 第一道闸的纯函数形态。
// 抽出来是为了能单测：handler 要一整个 app 才跑得起来，而这条判据是策略，不是 I/O。
func reviewableNormalizationStatus(status scheme.Status) bool {
	switch status {
	case scheme.Ambiguous, scheme.Unsupported:
		return true
	}
	return false
}

// reviewBlockedReason 说明「为什么这一条现在不能写人工结论」，空串表示可以写。
// 四种情形给四句不同的话：管理员要能凭这句话知道下一步做什么，而「不能复核」本身
// 对「还没跑过转换」和「机器已经判定了」是两条完全不同的处置路径。
func reviewBlockedReason(status string) string {
	if reviewableNormalizationStatus(scheme.Status(status)) {
		return ""
	}
	switch scheme.Status(status) {
	case "":
		return "这一条还没有跑过转换，不能直接写成复核结论。请先对项目发起一次转换——只有机器判不出来的条目才会进入复核队列。"
	case scheme.Exact:
		return "这一条机器已给出结果，不能在此直接覆盖。人工复核仅处理“需人工确认”或“暂未支持”的条目。"
	case scheme.Reviewed:
		return "这一条已经有人给过结论了。本入口不允许覆盖已复核的结论——覆盖会把判定人与判定时间刷成新的，而原来那条结论没有地方留痕。"
	default:
		return "这一条当前状态不支持人工复核；仅“需人工确认”或“暂未支持”的条目可以填写人工结论。"
	}
}

// parseNormalizationStatuses 解析复核队列的 status 参数：逗号分隔、去重、逐项校验。
// 空值保持原来的默认（只列 AMBIGUOUS），不改变既有调用方的语义。
func parseNormalizationStatuses(raw string) ([]scheme.Status, string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []scheme.Status{scheme.Ambiguous}, ""
	}
	seen := map[scheme.Status]bool{}
	list := make([]scheme.Status, 0, 2)
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !isNormalizationStatus(part) {
			return nil, "状态只能是 EXACT、REVIEWED、AMBIGUOUS 或 UNSUPPORTED；要看多个状态时用逗号分隔。"
		}
		status := scheme.Status(part)
		if !seen[status] {
			seen[status] = true
			list = append(list, status)
		}
	}
	if len(list) == 0 {
		return []scheme.Status{scheme.Ambiguous}, ""
	}
	return list, ""
}

// normalizationStatusFilter 把已校验的状态值拼成 filter。这些值是枚举里的固定字面量，
// 不是用户输入，所以直接内联；若以后状态变成可配置值，这里要改用参数绑定。
//
// 多状态不能用 `IN (...)`：PocketBase 的 filter 语法（fexpr）只认比较符与 `&&` / `||`，
// `IN` 会让整个 filter 解析失败（表现为 400「读取复核队列失败」）。所以拆成等值的
// `||`，并且**必须加括号**——调用方用 `&&` 把项目条件拼在前面，而连接符会原样落进
// SQL，`AND` 的优先级高于 `OR`：不加括号就成了 `(project = … AND status = A) OR status = B`，
// 第二个状态会跨项目命中。
func normalizationStatusFilter(statuses []scheme.Status) string {
	if len(statuses) == 1 {
		return fmt.Sprintf("normalization_status = %q", statuses[0])
	}
	parts := make([]string, len(statuses))
	for i, status := range statuses {
		parts[i] = fmt.Sprintf("normalization_status = %q", status)
	}
	return "(" + strings.Join(parts, " || ") + ")"
}

func isNormalizationStatus(value string) bool {
	switch scheme.Status(value) {
	case scheme.Exact, scheme.Reviewed, scheme.Ambiguous, scheme.Unsupported:
		return true
	}
	return false
}

// normalizationSourceValue 取「这条结论是针对哪个原值下的」。
//
// 优先快照，只有在快照为空时才回落到现读：快照是 convertPage 在转换那一刻抄的，是稳定的；
// 现读的校对行会随校对改动而变。回落的唯一合法场景是快照这一列存在之前就转换过的行
// （迁移前的存量），对它们现读是唯一能给出的答案。新转换的行一律走快照。
func normalizationSourceValue(page *core.Record) string {
	if snapshot := page.GetString("normalization_source_snapshot"); snapshot != "" {
		return snapshot
	}
	return pageReadingValue(page, page.GetString("normalization_source_column"))
}

func normalizationView(page *core.Record) map[string]any {
	trace := []string{}
	if raw := page.GetString("normalization_trace_json"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &trace)
	}
	candidates := []string{}
	if raw := page.GetString("normalization_candidates_json"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &candidates)
	}
	return map[string]any{
		"id":                         page.Id,
		"page_number":                page.GetInt("page_number"),
		"pdf_page":                   page.GetInt("pdf_page"),
		"source_scheme_id":           page.GetString("source_scheme_id"),
		"source_pronunciation":       normalizationSourceValue(page),
		"canonical_scheme_id":        page.GetString("canonical_scheme_id"),
		"canonical_pronunciation":    page.GetString("canonical_pronunciation"),
		"normalization_status":       page.GetString("normalization_status"),
		"normalization_rule_version": page.GetString("normalization_rule_version"),
		"normalization_trace":        trace,
		"candidates":                 candidates,
		"normalization_basis":        page.GetString("normalization_basis"),
		"normalization_reviewed_by":  page.GetString("normalization_reviewed_by"),
		"normalization_reviewed_at":  page.GetString("normalization_reviewed_at"),
	}
}

// At most two queries per queue page, regardless of the number of rows. An
// absent PDF is a stable business state; lookup errors must not masquerade as it.
func normalizationSourceFiles(app core.App, projectID string, pages []*core.Record) (map[string]string, error) {
	result := map[string]string{"": "absent"}
	ids := map[string]bool{}
	for _, page := range pages {
		if id := page.GetString("project_file"); id != "" {
			ids[id] = true
			result[id] = "missing:" + id
		}
	}
	encode := func(file *core.Record) string {
		raw, _ := json.Marshal([]any{file.Id, file.GetString("file"), file.GetString("file_hash"), file.GetInt("page_count"), file.GetString("status")})
		return string(raw)
	}
	primary, err := app.FindRecordsByFilter("project_files", "project={:project} && status='ready' && is_primary=true", "-created,id", 1, 0, dbx.Params{"project": projectID})
	if err != nil {
		return nil, err
	}
	if len(primary) > 0 {
		result[""] = encode(primary[0])
	}
	if len(ids) > 0 {
		names := make([]string, 0, len(ids))
		for id := range ids {
			names = append(names, id)
		}
		sort.Strings(names)
		parts := make([]string, 0, len(names))
		params := dbx.Params{"project": projectID}
		for index, id := range names {
			key := fmt.Sprintf("file%d", index)
			parts = append(parts, "id={:"+key+"}")
			params[key] = id
		}
		records, err := app.FindRecordsByFilter("project_files", "project={:project} && ("+strings.Join(parts, " || ")+")", "id", len(ids), 0, params)
		if err != nil {
			return nil, err
		}
		for _, file := range records {
			result[file.Id] = encode(file)
		}
	}
	return result, nil
}

// normalizationReviewBasis hashes only the decision's business inputs. Lease,
// quality, timestamps and other unrelated changes do not invalidate a draft.
func (s *importService) normalizationReviewBasis(page, project *core.Record, files map[string]string) string {
	source := page.GetString("source_scheme_id")
	columns, _ := projectReadingColumns(project)
	adapter := s.schemes.adapters[source]
	var adapterIdentity any
	if adapter != nil {
		adapterIdentity = []any{adapter.SchemaVersion, adapter.SourceScheme, adapter.CanonicalScheme, adapter.RuleVersion, adapter.RuleStatus}
	}
	raw, _ := json.Marshal(map[string]any{
		"version": 1, "page": page.Id, "project": page.GetString("project"),
		"reading_columns": columns, "source_column": page.GetString("normalization_source_column"),
		"source_snapshot": normalizationSourceValue(page),
		"source_current":  pageReadingValue(page, page.GetString("normalization_source_column")),
		"source_scheme":   source, "target_scheme": page.GetString("canonical_scheme_id"),
		"rule_version": page.GetString("normalization_rule_version"),
		"status":       page.GetString("normalization_status"),
		"trace":        page.GetString("normalization_trace_json"), "candidates": page.GetString("normalization_candidates_json"),
		"canonical": page.GetString("canonical_pronunciation"), "reviewed_by": page.GetString("normalization_reviewed_by"),
		"source_system": page.GetString("source_system"), "source_id": page.GetString("source_id"),
		"source_version": page.GetString("source_version"), "source_entry": page.GetString("source_entry_id"),
		"project_file": page.GetString("project_file"), "pdf_page": page.GetInt("pdf_page"),
		"source_file_snapshot": files[page.GetString("project_file")],
		"adapter":              adapterIdentity, "rule_digest": s.schemes.ruleDigests[source],
	})
	digest := sha256.Sum256(raw)
	return "normalization-v1:" + hex.EncodeToString(digest[:])
}

func normalizationSourceIsCurrent(page, project *core.Record) bool {
	columns, problem := projectReadingColumns(project)
	column := page.GetString("normalization_source_column")
	current := pageReadingValue(page, column)
	return problem == "" && len(columns) == 1 && columns[0] == column && current != "" && current == normalizationSourceValue(page)
}

func (s *importService) normalizationReviewView(page, project *core.Record, files map[string]string) map[string]any {
	view := normalizationView(page)
	view["expected_basis"] = s.normalizationReviewBasis(page, project, files)
	view["normalization_source_column"] = page.GetString("normalization_source_column")
	view["current_source_pronunciation"] = pageReadingValue(page, page.GetString("normalization_source_column"))
	sourceChanged := !normalizationSourceIsCurrent(page, project)
	view["source_changed"] = sourceChanged
	_, blocked := s.normalizationReviewPrerequisite(page, project)
	if blocked == "" && sourceChanged {
		blocked = "来源读音或记音列已变化，请先重跑转换，再按当前来源重新复核。"
	}
	view["review_ready"] = blocked == ""
	view["review_block_reason"] = blocked
	if adapter := s.schemes.adapters[page.GetString("source_scheme_id")]; adapter != nil {
		view["normalization_schema_version"] = adapter.SchemaVersion
	}
	return view
}

type normalizationDecision struct {
	Canonical     string `json:"canonical_pronunciation"`
	Basis         string `json:"basis"`
	ExpectedBasis string `json:"expected_basis"`
}

// The initial lookup only establishes the authorized project. Every decision
// input and the compare-and-save are re-read inside the same write transaction.
func (s *importService) decideNormalization(c *core.RequestEvent) error {
	pageID := c.Request.PathValue("pageId")
	original, err := s.app.FindRecordById("pages", pageID)
	if err != nil || original == nil {
		return apis.NewNotFoundError("条目不存在。", err)
	}
	projectID := original.GetString("project")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}
	payload := normalizationDecision{}
	if err := c.BindBody(&payload); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", nil)
	}
	payload.Canonical, payload.Basis = strings.TrimSpace(payload.Canonical), strings.TrimSpace(payload.Basis)
	if payload.Canonical == "" {
		return apis.NewBadRequestError("人工结论必须给出统一方案的写法；只标「看过了」不构成结论。", nil)
	}
	if payload.Basis == "" {
		return apis.NewBadRequestError("人工结论必须写明依据。", nil)
	}
	if utf8Len(payload.Basis) > 500 {
		return apis.NewBadRequestError("依据最多 500 个字符。", nil)
	}
	if utf8Len(payload.Canonical) > canonicalPronunciationMaxLength {
		return apis.NewBadRequestError(fmt.Sprintf("统一方案的写法最多 %d 个字符。", canonicalPronunciationMaxLength), nil)
	}
	var result map[string]any
	err = s.app.RunInTransaction(func(tx core.App) error {
		page, err := tx.FindRecordById("pages", pageID)
		if err != nil {
			return apis.NewNotFoundError("条目不存在。", err)
		}
		if page.GetString("project") != projectID {
			return apis.NewApiError(http.StatusConflict, "条目所属项目已变化，请刷新复核队列。", nil)
		}
		auth, project, err := requireProjectManagerInApp(tx, c, projectID)
		if err != nil {
			return err
		}
		updated, err := s.applyNormalizationDecision(tx, page, project, auth.Id, payload)
		if err != nil {
			return err
		}
		result = normalizationView(updated)
		return nil
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, result)
}

// Shared by queue readiness and save validation; draft text and expected basis
// still receive their existing checks when the decision is submitted.
func (s *importService) normalizationReviewPrerequisite(page, project *core.Record) (*scheme.Adapter, string) {
	if _, problem := projectReadingColumns(project); problem != "" {
		return nil, problem
	}
	if problem := reviewBlockedReason(page.GetString("normalization_status")); problem != "" {
		return nil, problem
	}
	adapter, ok := s.schemes.adapters[page.GetString("source_scheme_id")]
	if !ok {
		return nil, "这一条使用的规则当前不可用，请联系部署维护者恢复后重新加载复核队列；原值、候选和已填草稿仍可查看。"
	}
	if page.GetString("normalization_rule_version") != adapter.RuleVersion || page.GetString("canonical_scheme_id") != adapter.CanonicalScheme {
		return nil, fmt.Sprintf("这一条是规则版本「%s」跑出来的，当前是「%s」；请先用当前规则重跑一次转换再复核。", page.GetString("normalization_rule_version"), adapter.RuleVersion)
	}
	return adapter, ""
}

func (s *importService) applyNormalizationDecision(tx core.App, page, project *core.Record, actor string, payload normalizationDecision) (*core.Record, error) {
	adapter, blocked := s.normalizationReviewPrerequisite(page, project)
	if blocked != "" {
		return nil, apis.NewBadRequestError(blocked, nil)
	}
	files, err := normalizationSourceFiles(tx, project.Id, []*core.Record{page})
	if err != nil {
		return nil, apis.NewApiError(http.StatusServiceUnavailable, "暂时无法读取来源快照，请稍后刷新队列。", nil)
	}
	if payload.ExpectedBasis == "" {
		return nil, apis.NewApiError(http.StatusConflict, "当前页面缺少复核依据，请先自行保留尚未提交的草稿，刷新整个页面或更新客户端后再重新核对。", nil)
	}
	if payload.ExpectedBasis != s.normalizationReviewBasis(page, project, files) {
		return nil, apis.NewApiError(http.StatusConflict, "复核依据已变化，请刷新队列；旧草稿保留，需按当前来源重新填写。", nil)
	}
	if !normalizationSourceIsCurrent(page, project) {
		return nil, apis.NewApiError(http.StatusConflict, "来源读音或记音列已变化，请先重跑转换，再按当前来源重新复核。", nil)
	}
	normalized, problem := adapter.NormalizeCanonical(payload.Canonical)
	if problem != nil {
		return nil, apis.NewBadRequestError(problem.Error(), nil)
	}
	page.Set("canonical_pronunciation", normalized)
	page.Set("normalization_status", string(scheme.Reviewed))
	page.Set("normalization_basis", payload.Basis)
	page.Set("normalization_reviewed_by", actor)
	page.Set("normalization_reviewed_at", time.Now().UTC())
	page.Set("normalization_rule_version", adapter.RuleVersion)
	page.IgnoreUnchangedFields(true)
	if err := tx.Save(page); err != nil {
		return nil, apis.NewBadRequestError("保存人工结论失败。", err)
	}
	return page, nil
}

// reviewedConclusion 是一条已经有人给过结论的条目在导出时需要的全部字段。
// 抽成普通结构体是为了让分组逻辑能脱离 PocketBase 单测——它决定的是「这份草案贴
// 回去之后 adapter 还能不能加载」，值得有自己的用例。
type reviewedConclusion struct {
	PageID          string
	Source          string // 已按 NFC 归一，与 adapter 例外表的键同一形状
	Canonical       string
	Reviewer        string
	Basis           string
	CanonicalScheme string
	RuleVersion     string
}

type exceptionDraft struct {
	ID         string   `json:"id"`
	Source     string   `json:"source_pronunciation"`
	Canonical  string   `json:"canonical_pronunciation"`
	Status     string   `json:"status"`
	Reviewer   string   `json:"reviewer"`
	Basis      string   `json:"basis"`
	MergedFrom []string `json:"merged_from,omitempty"`
}

type exceptionConflict struct {
	Source      string              `json:"source_pronunciation"`
	Conclusions []map[string]string `json:"conclusions"`
}

// groupExceptionDrafts 合并同一 source 的一致结论，把互相冲突的整组放进 conflicts。
//
// 为什么必须合并：adapter 的例外表以 NFC 之后的 source_pronunciation 为键，加载器
// 明确拒绝重复键（adapter.go 的「the same source form once normalised」）。而同一读音
// 在不同页上重复出现是常态——浏览器夹具里就有三条 kn533。逐条导出会得到一份贴不回去
// 的草案：两个不同 id、同一个 source，adapter 下次启动直接失败。
//
// 为什么冲突不能挑一个：两个人都给了结论却指向不同的目标写法，这是需要人裁决的事实，
// 不是程序能猜的。整组进 conflicts，每条的判定人与依据都还在，调用方看得见。
func groupExceptionDrafts(rows []reviewedConclusion) ([]exceptionDraft, []exceptionConflict) {
	order := make([]string, 0, len(rows))
	grouped := map[string][]reviewedConclusion{}
	for _, row := range rows {
		// 键用 NFC：adapter 加载器按 NFC 之后的写法判重，而人工录入的两条结论
		// 可能是同一段文字的不同组合形式（组合音标尤其容易）。在这里再做一次
		// 归一，调用方就不会因为忘了归一而导出一份「看起来只有一条」的重复键。
		source := norm.NFC.String(row.Source)
		row.Source = source
		if _, seen := grouped[source]; !seen {
			order = append(order, source)
		}
		grouped[source] = append(grouped[source], row)
	}

	drafts := make([]exceptionDraft, 0, len(order))
	conflicts := make([]exceptionConflict, 0)
	for _, source := range order {
		items := grouped[source]
		agree := true
		for _, item := range items[1:] {
			if item.Canonical != items[0].Canonical {
				agree = false
				break
			}
		}
		if agree {
			merged := make([]string, 0, len(items)-1)
			for _, item := range items[1:] {
				merged = append(merged, item.PageID)
			}
			drafts = append(drafts, exceptionDraft{
				ID:         "ex:" + items[0].PageID,
				Source:     source,
				Canonical:  items[0].Canonical,
				Status:     string(scheme.Reviewed),
				Reviewer:   items[0].Reviewer,
				Basis:      items[0].Basis,
				MergedFrom: merged,
			})
			continue
		}
		conclusions := make([]map[string]string, 0, len(items))
		for _, item := range items {
			conclusions = append(conclusions, map[string]string{
				"id":                      "ex:" + item.PageID,
				"canonical_pronunciation": item.Canonical,
				"reviewer":                item.Reviewer,
				"basis":                   item.Basis,
			})
		}
		conflicts = append(conflicts, exceptionConflict{Source: source, Conclusions: conclusions})
	}
	return drafts, conflicts
}

// exportNormalizationExceptions 把人工结论导成可直接粘进规则文件 exceptions[] 的草案。
// 只导出 REVIEWED，且不自动改任何规则文件——#190 期望结果 4 明确要求「生成待评审的草案，不自动改规则」。
//
// 一份草案只属于一个 (source, target, rule_version) 三元组。跨来源混合上一轮已经挡了；
// 同一来源下换过目标方案或规则版本之后，旧结论会被重跑保护稳定地留下来，所以第二层
// 混合同样会自己出现。默认按目录里这份 adapter 当前声明的 target + rule_version 过滤，
// 调用方可以点名别的版本，但必须自己写出来，不能靠默认值取到一份混合表。
func (s *importService) exportNormalizationExceptions(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		return err
	}
	query := c.Request.URL.Query()
	sourceScheme := strings.TrimSpace(query.Get("source_scheme_id"))
	// 必填，而且在册。草案是要贴进**某一套**方案的规则文件的 exceptions[] 的；
	// 把两套来源方案的结论混成一张表，贴到哪个文件里都不对，而收件人多半不会逐条核。
	// 原来不传就静默导出全部——那正是这样一张表。
	if sourceScheme == "" {
		return apis.NewBadRequestError(
			"必须指定 source_scheme_id：草案要贴进某一套方案的规则文件，不能把多套来源方案的结论混成一张表。", nil)
	}
	adapter, ok := s.schemes.adapters[sourceScheme]
	if !ok {
		return apis.NewBadRequestError(fmt.Sprintf("本实例没有登记「%s」这套方案，无法导出它的规则草案。", sourceScheme), nil)
	}

	canonicalScheme := strings.TrimSpace(query.Get("canonical_scheme_id"))
	if canonicalScheme == "" {
		canonicalScheme = adapter.CanonicalScheme
	}
	ruleVersion := strings.TrimSpace(query.Get("rule_version"))
	if ruleVersion == "" {
		ruleVersion = adapter.RuleVersion
	}
	warning := ""
	if canonicalScheme != adapter.CanonicalScheme || ruleVersion != adapter.RuleVersion {
		warning = fmt.Sprintf(
			"导出的是目标方案「%s」/ 规则版本「%s」的结论，而目录里这套规则现在是「%s」/「%s」。贴进 exceptions[] 前请确认这就是你要的那一版。",
			canonicalScheme, ruleVersion, adapter.CanonicalScheme, adapter.RuleVersion)
	}

	params := dbx.Params{"project": projectID, "scheme": sourceScheme}
	filter := `project = {:project} && normalization_status = "REVIEWED" && normalization_basis != "" && source_scheme_id = {:scheme}`
	records, err := s.app.FindRecordsByFilter("pages", filter, "page_number,id", 200000, 0, params)
	if err != nil {
		return apis.NewBadRequestError("读取人工结论失败。", err)
	}

	rows := make([]reviewedConclusion, 0, len(records))
	otherCounts := map[string]int{}
	otherOrder := make([]string, 0)
	for _, page := range records {
		pageCanonical := page.GetString("canonical_scheme_id")
		pageVersion := page.GetString("normalization_rule_version")
		if pageCanonical != canonicalScheme || pageVersion != ruleVersion {
			// 不属于这份草案的结论不静默丢掉：把它们按三元组数出来，调用方才知道
			// 「还有别的版本没导出」，也才知道该用哪两个参数去取。
			key := pageCanonical + "\x00" + pageVersion
			if _, seen := otherCounts[key]; !seen {
				otherOrder = append(otherOrder, key)
			}
			otherCounts[key]++
			continue
		}
		rows = append(rows, reviewedConclusion{
			PageID:          page.Id,
			Source:          norm.NFC.String(normalizationSourceValue(page)),
			Canonical:       page.GetString("canonical_pronunciation"),
			Reviewer:        page.GetString("normalization_reviewed_by"),
			Basis:           page.GetString("normalization_basis"),
			CanonicalScheme: pageCanonical,
			RuleVersion:     pageVersion,
		})
	}

	drafts, conflicts := groupExceptionDrafts(rows)

	otherVersions := make([]map[string]any, 0, len(otherOrder))
	for _, key := range otherOrder {
		parts := strings.SplitN(key, "\x00", 2)
		otherVersions = append(otherVersions, map[string]any{
			"canonical_scheme_id": parts[0],
			"rule_version":        parts[1],
			"count":               otherCounts[key],
		})
	}

	result := map[string]any{
		"source_scheme_id":    sourceScheme,
		"canonical_scheme_id": canonicalScheme,
		"rule_version":        ruleVersion,
		"note": "这是待评审的草案，不会自动写入任何规则文件；确认后由人贴进对应 adapter 的 exceptions[] 并升 rule_version。" +
			"同一 source 的一致结论已合并（merged_from 列出被合并的条目）；相互冲突的结论不会写进 exceptions，列在 conflicts 里等人裁决。",
		"exceptions":     drafts,
		"conflicts":      conflicts,
		"other_versions": otherVersions,
	}
	if warning != "" {
		result["warning"] = warning
	}
	return c.JSON(http.StatusOK, result)
}

// countPagesWithFilter 走 PocketBase 的 filter 解析器，而不是把 filter 当成裸 SQL：
// filter 里用的是 `&&` 与 `{:name}`，那是 PocketBase 的语法，交给 SQLite 会直接语法错误。
func countPagesWithFilter(app core.App, filter string, params dbx.Params) (int64, error) {
	collection, err := app.FindCollectionByNameOrId("pages")
	if err != nil {
		return 0, err
	}
	resolver := core.NewRecordFieldResolver(app, collection, nil, true)
	expr, err := search.FilterData(filter).BuildExpr(resolver, params)
	if err != nil {
		return 0, err
	}
	query := app.RecordQuery(collection).AndWhere(expr)
	if err := resolver.UpdateQuery(query); err != nil {
		return 0, err
	}
	var count int64
	if err := query.Select("COUNT(DISTINCT pages.id)").Row(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func utf8Len(value string) int {
	return len([]rune(value))
}

// conversionCounters 是 #114 §8 那几行汇总的来源。六个数两两不重叠，且
// skipped + 四个状态计数 + failed == total：每一条被本次作业看到的条目恰好落进一格。
//
// skipped 是「这一次没有转换它」（没有可转换的值，或已经人工复核过）；failed 是写入出错。
// 两者都不进那四行，但**都计入 total**——convertPage 的三个失败分支都是 failed++ 且 total++。
// 所以「四行之和 == total」不成立，差额由 skipped 与 failed 解释，而管理端把这两行都画出来了
// （frontend/src/lib/schemeConversion.js 的 conversionSummaryLines），差额因此有据可查。
type conversionCounters struct {
	total       int
	exact       int
	reviewed    int
	ambiguous   int
	unsupported int
	skipped     int
	failed      int
}

func (s *importService) processConversion(work importWork) {
	job, err := s.app.FindRecordById("conversion_jobs", work.id)
	if err != nil {
		logUpload("error", "conversion_job_lookup_failed", map[string]any{
			"request_id": work.requestID, "job_id": work.id, "error": err.Error(),
		})
		return
	}
	projectID := job.GetString("project")
	project, err := s.app.FindRecordById("projects", projectID)
	if err != nil {
		s.markConversionFatal(work, "CONVERSION_PROJECT_MISSING", "项目不存在或已被删除。", err)
		return
	}
	sourceScheme := job.GetString("source_scheme")
	adapter, refused := s.schemes.jobAdapter(sourceScheme)
	if adapter == nil {
		s.markConversionFatal(work, "CONVERSION_SCHEME_UNKNOWN",
			fmt.Sprintf("规则目录里已经没有「%s」这套方案了，请先把它放回规则目录再重跑。", sourceScheme), nil)
		return
	}
	if refused != "" {
		// 发起侧那句话是「你不能建」，这里是「已经建的那个不能再跑了」——同一个判据、
		// 两种处境。作业能走到这里只有一种可能：它是闸门装上之前建的，或者规则文件在
		// 作业中途被改成了 test。续跑会把一半条目落在测试规则下，比直接失败更难查。
		s.markConversionFatal(work, "CONVERSION_RULE_STATUS_DOWNGRADED",
			fmt.Sprintf("作业用的是「%s」，但这套规则现在声明为 rule_status=%q，不能继续跑真实作业。"+
				"请把真实规则放回规则目录，并重新发起一个作业。", sourceScheme, adapter.RuleStatus), nil)
		return
	}
	// 规则身份校验。断点续跑会把同一个作业的条目分两次写；两次之间规则换了版本的话，
	// 同一批条目就落在两套规则下，而汇总仍然只有一个数——比整批重跑更难对账。
	// source_scheme 是查表的键，对上不是巧合；能变的是它指向的那份规则。
	if adapter.CanonicalScheme != job.GetString("canonical_scheme") || adapter.RuleVersion != job.GetString("rule_version") {
		s.markConversionFatal(work, "CONVERSION_RULE_VERSION_CHANGED",
			fmt.Sprintf("规则已换版：作业记的是 %s → %s（%s），规则目录里现在是 %s → %s（%s）。"+
				"续跑会让同一批条目落在两套规则下，请重新发起作业。",
				sourceScheme, job.GetString("canonical_scheme"), job.GetString("rule_version"),
				adapter.SourceScheme, adapter.CanonicalScheme, adapter.RuleVersion), nil)
		return
	}
	columns, problem := projectReadingColumns(project)
	if problem != "" {
		s.markConversionFatal(work, "CONVERSION_READING_COLUMN_UNKNOWN", problem, nil)
		return
	}
	column := columns[0]

	job.Set("status", "processing")
	job.Set("started_at", types.NowDateTime())
	job.Set("finished_at", "")
	job.Set("error_code", "")
	job.Set("error_message", "")
	if err := s.app.Save(job); err != nil {
		logUpload("error", "conversion_job_start_persist_failed", map[string]any{
			"request_id": work.requestID, "job_id": work.id, "error": err.Error(),
		})
		return
	}

	// 从断点续：重启恢复时已处理的条目不重新数一遍，四行汇总因此不会翻倍。
	// 计数也一并从作业上恢复——只恢复 cursor 而不恢复计数，续跑出来的汇总是半截的。
	cursor := job.GetInt("cursor")
	counters := conversionCounters{
		total:       job.GetInt("total_count"),
		exact:       job.GetInt("exact_count"),
		reviewed:    job.GetInt("reviewed_count"),
		ambiguous:   job.GetInt("ambiguous_count"),
		unsupported: job.GetInt("unsupported_count"),
		skipped:     job.GetInt("skipped_count"),
		failed:      job.GetInt("failed_count"),
	}

	// 语义是一次点状快照：只处理「本次读取时 page_number 大于断点」的条目。转换期间
	// 新导入、且 page_number 不大于当前断点的条目不在本次范围内——这是有意的，不是漏转：
	// 它属于下一次转换作业；而重跑时人工结论仍被保护（convertPage 跳过 normalization_reviewed_by
	// 非空的条目），所以「再来一次」是安全的收敛方式，不会变成覆盖历史的重算。
	const batchSize = 200
	for {
		pages, err := s.app.FindRecordsByFilter(
			"pages",
			`project = {:project} && page_number > {:cursor} && status != "importing"`,
			"page_number", batchSize, 0,
			dbx.Params{"project": projectID, "cursor": cursor},
		)
		if err != nil {
			s.markConversionFatal(work, "CONVERSION_READ_FAILED", "读取项目条目失败。", err)
			return
		}
		if len(pages) == 0 {
			break
		}
		for _, page := range pages {
			cursor = page.GetInt("page_number")
			s.convertPage(page, adapter, column, &counters)
		}
		s.persistConversionProgress(job, cursor, &counters)
		if len(pages) < batchSize {
			break
		}
	}

	status := "completed"
	if counters.failed > 0 {
		status = "completed_with_errors"
	}
	job.Set("status", status)
	job.Set("cursor", cursor)
	writeConversionCounters(job, &counters)
	job.Set("error_code", "")
	job.Set("error_message", "")
	job.Set("finished_at", types.NowDateTime())
	if err := s.app.Save(job); err != nil {
		s.markConversionFatal(work, "JOB_FINALIZE_FAILED", "条目已处理，但作业状态更新失败。", err)
		return
	}
	logUpload("info", "conversion_completed", map[string]any{
		"request_id": work.requestID, "job_id": work.id, "project_id": projectID,
		"rule_version": adapter.RuleVersion, "total": counters.total,
		"exact": counters.exact, "reviewed": counters.reviewed,
		"ambiguous": counters.ambiguous, "unsupported": counters.unsupported,
		"skipped": counters.skipped, "failed": counters.failed, "status": status,
	})
}

// convertPage 写一条条目的规范化结论。
//
// 三件事刻意不做：不覆盖已经人工复核过的结论（REVIEWED 是有人看过的，机器不该把它推回去）、
// 不给没有值的条目硬造一个结论、不把失败吞掉当作已处理。
func (s *importService) convertPage(page *core.Record, adapter *scheme.Adapter, column string, counters *conversionCounters) {
	local := conversionCounters{}
	err := s.app.RunInTransaction(func(tx core.App) error {
		latest, err := tx.FindRecordById("pages", page.Id)
		if err != nil {
			return err
		}
		page = latest
		// 只保护**人工**结论。判据是 normalization_reviewed_by 非空——decideNormalization
		// 是唯一写它的地方，所以它精确表示「有人看过并留了依据」。
		//
		// 不能按 status == REVIEWED 一刀切：例外表给出的 REVIEWED 也是 REVIEWED，但它只是
		// 一条规则的结果，重跑时照常重算才对。切在一起会让重跑的汇总越跑越少
		// （上一次的结论被当成"已复核"跳过），管理员没法对账。
		if page.GetString("normalization_reviewed_by") != "" {
			// 只计 skipped，不再计 reviewed：五个计数必须互不重叠，否则
			// 「共处理」与四行之和永远对不上，而那个差额没有第三种解释方式。
			// 已经人工复核过的条目不再被这一次转换处理，它就是被跳过的。
			local.skipped++
			local.total++
			return nil
		}
		value := pageReadingValue(page, column)
		if value == "" {
			local.skipped++
			local.total++
			return nil
		}

		result := scheme.Convert(value, adapter)
		page.Set("source_scheme_id", result.SourceScheme)
		page.Set("normalization_source_column", column)
		// 抄下这一刻读到的源值。之后复核队列、例外草案读的都是这一份，而不是现读校对行：
		// 一条 AMBIGUOUS 是「针对某个原值」判的，如果原值随校对改动而变，那条结论针对的
		// 对象就被悄悄换掉了，而结论本身看不出来。每个走到这里的条目都写，不论结论是什么——
		// 只给 AMBIGUOUS 写会让「为什么这一条没有快照」需要靠状态去猜。
		page.Set("normalization_source_snapshot", value)
		page.Set("canonical_scheme_id", result.CanonicalScheme)
		page.Set("canonical_pronunciation", result.CanonicalPronunciation)
		page.Set("normalization_status", string(result.Status))
		page.Set("normalization_rule_version", result.RuleVersion)
		trace, err := json.Marshal(result.Trace)
		if err != nil {
			logUpload("error", "conversion_trace_serialize_failed", map[string]any{"page_id": page.Id, "error": err.Error()})
			return err
		}
		page.Set("normalization_trace_json", string(trace))
		candidates, err := json.Marshal(result.Candidates)
		if err != nil {
			logUpload("error", "conversion_candidates_serialize_failed", map[string]any{"page_id": page.Id, "error": err.Error()})
			return err
		}
		page.Set("normalization_candidates_json", string(candidates))
		// 只写本函数改动过的字段。processConversion 一次读 200 条进内存，逐条 Save 默认会
		// 把「批次读取那一刻」的整行快照写回库，覆盖掉这个窗口里任何并发的校对提交
		// （proofread_row_json / proofread_at / first_proofreader 等）。IgnoreUnchangedFields(true)
		// 让 Save 只导出本实例 Set 过的字段，未动过的列一律不写。
		page.IgnoreUnchangedFields(true)
		if err := tx.Save(page); err != nil {
			logUpload("error", "conversion_page_write_failed", map[string]any{"page_id": page.Id, "error": err.Error()})
			return err
		}

		local.total++
		switch result.Status {
		case scheme.Exact:
			local.exact++
		case scheme.Reviewed:
			local.reviewed++
		case scheme.Ambiguous:
			local.ambiguous++
		case scheme.Unsupported:
			local.unsupported++
		}
		return nil
	})
	if err != nil {
		counters.total++
		counters.failed++
		return
	}
	counters.total += local.total
	counters.exact += local.exact
	counters.reviewed += local.reviewed
	counters.ambiguous += local.ambiguous
	counters.unsupported += local.unsupported
	counters.skipped += local.skipped
}

func writeConversionCounters(job *core.Record, counters *conversionCounters) {
	job.Set("total_count", counters.total)
	job.Set("exact_count", counters.exact)
	job.Set("reviewed_count", counters.reviewed)
	job.Set("ambiguous_count", counters.ambiguous)
	job.Set("unsupported_count", counters.unsupported)
	job.Set("skipped_count", counters.skipped)
	job.Set("failed_count", counters.failed)
}

func (s *importService) persistConversionProgress(job *core.Record, cursor int, counters *conversionCounters) {
	job.Set("cursor", cursor)
	writeConversionCounters(job, counters)
	if err := s.app.Save(job); err != nil {
		logUpload("error", "conversion_progress_persist_failed", map[string]any{
			"job_id": job.Id, "project_id": job.GetString("project"), "cursor": cursor, "error": err.Error(),
		})
	}
}

// markConversionFatal 收尾一个失败的转换作业。cause 与其它 kind 的 markFatal 同口径：
// 作业状态只写「失败了」，具体是哪个 panic / 哪次读库出错只有日志里有，而 panic 的值
// 是复现线上问题的唯一线索——不带上它，conversion 这条路上的 panic 就查不下去了。
func (s *importService) markConversionFatal(work importWork, code, message string, cause error) {
	job, err := s.app.FindRecordById("conversion_jobs", work.id)
	if err != nil {
		logUpload("error", "conversion_fatal_persist_failed", map[string]any{
			"request_id": work.requestID, "job_id": work.id, "error_code": code,
			"error": err.Error(), "cause": errorText(cause),
		})
		return
	}
	job.Set("status", "failed")
	job.Set("error_code", code)
	job.Set("error_message", message)
	job.Set("finished_at", types.NowDateTime())
	if err := s.app.Save(job); err != nil {
		logUpload("error", "conversion_fatal_persist_failed", map[string]any{
			"request_id": work.requestID, "job_id": work.id, "error_code": code,
			"error": err.Error(), "cause": errorText(cause),
		})
	}
	logUpload("warn", "conversion_failed", map[string]any{
		"request_id": work.requestID, "job_id": work.id, "error_code": code, "message": message,
		"cause": errorText(cause),
	})
}
