package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// #315 D 用途编选 v0：这一批交付要不要这些资料，以及为什么不要。
//
// D 与 B 的关系是 #314 明写的边界：**校对完成不等于适合所有用途**。本文件不碰
// pages.status、不改 proofread_row_json、不替 B 下结论，只回答「按这一批的用途
// 与规则，哪些条目进入交付范围，其余为什么没进」。
//
// 三条硬约束来自 owner 与 Steering：
//
//  1. **批次级，不逐条**（owner 2026-10-11 14:38）：编选对象是「这一批」，不为
//     每条已校资料挂一个 adopted/withheld/undecided 状态。只有例外（D2）是逐条的。
//  2. **权利是硬边界**（D5.1/D5.2）：用途结论不是 allow 就一律排除，未知不得当允许。
//     这一条不写在 rule 里，也不能被规则绕过——它是先于规则的门。
//  3. **不得静默遗漏，也不得把部分冒充全量**（D4.2）：counts 必须满足
//     total = selected + excluded + pending；导出默认只含选中条目，读范围外要显式
//     请求且只给平台管理员。
//
// 术语：本文件里 selected/excluded 是**编选**结论，与仲裁台字段级的「采用原文 /
// 采用此结果」不是一件事（D7）。接口与导出都用 select/exclude，不用 adopt。

const (
	adoptionDecisionSelect  = "select"
	adoptionDecisionExclude = "exclude"

	adoptionBatchDraft     = "draft"
	adoptionBatchPreviewed = "previewed"
	adoptionBatchConfirmed = "confirmed"
)

// 排除理由码。前五个是 D 自己的结构原因，后五个与
// backend/pb_hooks/lib/assist_difficulty.js 的 BLOCKED_BUCKETS **逐字一致**，
// 与 #315 D3.2 的要求同源：理由码不得新造第二套，否则 D 的编选结论与 B 的阻塞
// 台账永远对不上账。purpose_denied / purpose_unknown 是六类用途 gate 的两种失败。
const (
	adoptionReasonOutsideImportBatch = "outside_import_batch"
	adoptionReasonStatusNotReady     = "status_not_ready"
	adoptionReasonQualityState       = "quality_state_insufficient"
	adoptionReasonPinyinPending      = "pinyin_pending"
	adoptionReasonPurposeDenied      = "purpose_denied"
	adoptionReasonPurposeUnknown     = "purpose_unknown"
)

// 必须与迁移 1792886400 的 PURPOSES 逐字一致，也与 source_registry.js 同源：
// 用途是 #92 的六类 gate，不是 D 自己发明的一组。
var adoptionPurposes = []string{
	"public_display",
	"internal_research",
	"model_training",
	"commercial_use",
	"redistribution",
	"raw_third_party_transfer",
}

// 必须与 pages.status 的取值域一致（迁移 1788940000）。规则里写一个不存在的
// 状态，等于给自己造一条永远为空的筛选条件，所以加载时就拒绝。
var adoptionPageStatuses = []string{
	"pending", "claimed", "proofreading", "proofread", "reviewing",
	"approved", "rejected", "arbitration", "importing",
}

// 与 #172 的 quality_state 三值一致（backend/quality_state.go）。
var adoptionQualityStates = []string{
	qualityStateCandidate, qualityStateValidated, qualityStateWithheld,
}

// 与 backend/pb_hooks/lib/assist_difficulty.js 的 BLOCKED_BUCKETS 逐字一致。
var adoptionBlockedBuckets = []string{
	"glyph_table", "scanned_read", "column_merge", "rights_gate", "unknown",
}

const (
	adoptionRecipientMax = 120
	adoptionNoteMax      = 500
)

// adoptionReasonCodes 是导出与例外里可用的全部理由码。顺序固定：
// 结构原因在前、阻塞五桶在后，导出按这个顺序稳定排序。
func adoptionReasonCodes() []string {
	codes := []string{
		adoptionReasonOutsideImportBatch,
		adoptionReasonStatusNotReady,
		adoptionReasonQualityState,
		adoptionReasonPinyinPending,
		adoptionReasonPurposeDenied,
		adoptionReasonPurposeUnknown,
	}
	return append(codes, adoptionBlockedBuckets...)
}

// adoptionRule 是「这一批按什么筛」。刻意只有四个字段：#315 v0 的取舍是批次
// 编选，不是一套查询语言。规则随批次存成 JSON 原文（D1.5「规则本身可被读出来」）。
type adoptionRule struct {
	// Statuses 是 B 侧已交成果的状态。空数组按默认值处理，见 normalizeAdoptionRule。
	Statuses []string `json:"statuses"`
	// QualityStates 为空表示不看 #172 的质量状态。
	QualityStates []string `json:"qualityStates,omitempty"`
	// ImportJobs 为空表示整个项目；非空时只在该批导入里选。
	ImportJobs []string `json:"importJobs,omitempty"`
	// RequirePinyin 要求条目已有可交付的拼音结论（EXACT/REVIEWED）。
	RequirePinyin bool `json:"requirePinyin,omitempty"`
}

func defaultAdoptionRule() adoptionRule {
	return adoptionRule{Statuses: []string{"proofread", "approved"}}
}

func parseAdoptionRule(raw json.RawMessage) (adoptionRule, error) {
	if len(strings.TrimSpace(string(raw))) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return normalizeAdoptionRule(defaultAdoptionRule())
	}
	var rule adoptionRule
	if err := json.Unmarshal(raw, &rule); err != nil {
		return adoptionRule{}, fmt.Errorf("筛选规则不是合法的 JSON：%v", err)
	}
	return normalizeAdoptionRule(rule)
}

// normalizeAdoptionRule 归一化并校验规则。它只接受枚举内的取值，因为理由码与
// 计数都要能被统计（D3.1/D9.1）：一个拼错的状态不会得到空结果，而是加载失败。
func normalizeAdoptionRule(raw adoptionRule) (adoptionRule, error) {
	rule := adoptionRule{
		Statuses:      dedupeStrings(raw.Statuses),
		QualityStates: dedupeStrings(raw.QualityStates),
		ImportJobs:    dedupeStrings(raw.ImportJobs),
		RequirePinyin: raw.RequirePinyin,
	}
	if len(rule.Statuses) == 0 {
		rule.Statuses = []string{"proofread", "approved"}
	}
	for _, status := range rule.Statuses {
		if !containsStr(adoptionPageStatuses, status) {
			return adoptionRule{}, fmt.Errorf("筛选规则里的条目状态「%s」不存在；可选值：%s",
				status, strings.Join(adoptionPageStatuses, "、"))
		}
	}
	for _, state := range rule.QualityStates {
		if !containsStr(adoptionQualityStates, state) {
			return adoptionRule{}, fmt.Errorf("筛选规则里的质量状态「%s」不存在；可选值：%s",
				state, strings.Join(adoptionQualityStates, "、"))
		}
	}
	for _, job := range rule.ImportJobs {
		if !looksLikeRecordID(job) {
			return adoptionRule{}, fmt.Errorf("筛选规则里的导入批次标识「%s」不是合法的记录 id", job)
		}
	}
	return rule, nil
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

// looksLikeRecordID 只做形状检查；是不是真记录、属于哪个项目由调用方查库确认。
func looksLikeRecordID(value string) bool {
	if len(value) != 15 {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}

// adoptionRow 是一次编选要看的全部事实。来源经页面自己的 import_job，退回到项目
// 级 source（#169 的登记），因为旧库有项目级登记而没有批次级来源。
type adoptionRow struct {
	PageID              string `db:"page_id"`
	PageNumber          int    `db:"page_number"`
	Status              string `db:"status"`
	QualityState        string `db:"quality_state"`
	BlockedReason       string `db:"blocked_reason"`
	NormalizationStatus string `db:"normalization_status"`
	ImportJob           string `db:"import_job"`
	RightsDecision      string `db:"rights_decision"`
}

type adoptionEntry struct {
	PageID     string `json:"page"`
	PageNumber int    `json:"pageNumber"`
	Decision   string `json:"decision"`
	Reason     string `json:"reason,omitempty"`
	Pending    bool   `json:"pending,omitempty"`
	Source     string `json:"source"`
}

type adoptionReasonCount struct {
	Code  string `json:"code"`
	Count int    `json:"count"`
}

type adoptionComputation struct {
	Total    int
	Selected int
	Excluded int
	Pending  int
	Reasons  map[string]int
	Entries  []adoptionEntry
}

// adoptionRightsFailure 是权利硬边界的唯一判据：返回空串表示 allow，否则返回理由码。
// 例外、预览、确认与导出都必须经过它，不能有任何一条路径用「人填了例外」替代授权。
func adoptionRightsFailure(row adoptionRow) string {
	switch strings.TrimSpace(row.RightsDecision) {
	case "allow":
		return ""
	case "deny":
		return adoptionReasonPurposeDenied
	default:
		// 缺行、空值、以及任何枚举外的写法都按「未决定」处理：未知不是允许（D5.2）。
		return adoptionReasonPurposeUnknown
	}
}

// adoptionRuleVerdict 是纯判据：只看一行事实与规则，返回是否选中与理由码。
//
// 优先级刻意固定并在文档里写明：状态 → 质量状态 → 阻塞原因 → 用途权利 → 拼音。
// 理由码只影响「为什么没进」的表述，不影响是否选中；换一个优先级不会多选或少选
// 条目，但会让同一批的理由分布漂移，所以它不能随实现随手改。
func adoptionRuleVerdict(row adoptionRow, rule adoptionRule) (bool, string) {
	if len(rule.ImportJobs) > 0 && !containsStr(rule.ImportJobs, row.ImportJob) {
		return false, adoptionReasonOutsideImportBatch
	}
	if !containsStr(rule.Statuses, strings.TrimSpace(row.Status)) {
		return false, adoptionReasonStatusNotReady
	}
	if len(rule.QualityStates) > 0 {
		state := normalizeQualityState(row.QualityState)
		if !containsStr(rule.QualityStates, state) {
			return false, adoptionReasonQualityState
		}
	}
	// blocked_reason 是人在 #240 给出的「这条为什么做不下去」的结论，五桶之一。
	// 取值表外的 token 不改写、不归并，按「看过但认不出」的 unknown 桶处理：
	// 那种值本身就是迁移与钩子漂移的证据，不应该被理由分布悄悄吞掉。
	if bucket := strings.TrimSpace(row.BlockedReason); bucket != "" {
		if containsStr(adoptionBlockedBuckets, bucket) {
			return false, bucket
		}
		return false, "unknown"
	}
	if reason := adoptionRightsFailure(row); reason != "" {
		return false, reason
	}
	if rule.RequirePinyin {
		switch strings.TrimSpace(row.NormalizationStatus) {
		case "EXACT", "REVIEWED":
		default:
			return false, adoptionReasonPinyinPending
		}
	}
	return true, ""
}

// adoptionUncertain 回答「这一条是不是规则判不了、要人来看」。
// pending 不是第三种编选结论，只是「排除已经算出，但理由还不够硬」：
// 认不出卡在哪（unknown 桶）与用途权利未决（purpose_unknown）都属于这一类。
func adoptionUncertain(reason string) bool {
	return reason == "unknown" || reason == adoptionReasonPurposeUnknown
}

// classifyAdoptionRows 是编选的纯逻辑，不碰数据库，因此每条分支都能单测。
func classifyAdoptionRows(rows []adoptionRow, rule adoptionRule, exceptions map[string]adoptionExceptionRecord) adoptionComputation {
	computation := adoptionComputation{
		Reasons: map[string]int{},
		Entries: make([]adoptionEntry, 0, len(rows)),
	}
	for _, row := range rows {
		selected, reason := adoptionRuleVerdict(row, rule)
		entry := adoptionEntry{
			PageID:     row.PageID,
			PageNumber: row.PageNumber,
			Decision:   adoptionDecisionSelect,
			Source:     "rule",
		}
		// 例外只能作用于「规则已选中」或「规则判不了（pending）」的条目；它不能
		// 把状态/质量/阻塞原因不合格的条目直接拉进交付范围，也不能替代用途授权。
		pending := adoptionUncertain(reason)
		if exception, ok := exceptions[row.PageID]; ok {
			if selected || adoptionUncertain(reason) {
				switch exception.Decision {
				case adoptionDecisionExclude:
					// 人已经对这条下过结论：即使理由码是 unknown，也不再算待处理。
					entry.Source = "exception"
					selected, reason = false, exception.ReasonCode
					pending = false
				case adoptionDecisionSelect:
					if rightsReason := adoptionRightsFailure(row); rightsReason != "" {
						// 例外说明不是授权记录：权利不是 allow 时 select 不生效。
						// deny 是已定排除，unknown/缺行才留 pending。
						selected, reason = false, rightsReason
						pending = adoptionUncertain(rightsReason)
					} else {
						entry.Source = "exception"
						selected, reason = true, ""
						pending = false
					}
				}
			}
		}
		computation.Total++
		if selected {
			computation.Selected++
			computation.Entries = append(computation.Entries, entry)
			continue
		}
		entry.Decision = adoptionDecisionExclude
		entry.Reason = reason
		entry.Pending = pending
		computation.Reasons[reason]++
		if entry.Pending {
			computation.Pending++
		} else {
			computation.Excluded++
		}
		computation.Entries = append(computation.Entries, entry)
	}
	return computation
}

// adoptionExceptionCandidate 回答「这条能不能被例外处理」。与 classify 共用同一条
// 判据：规则已选中，或规则判不了（pending）。状态未到、质量不足、阻塞未清、拼音未定
// 的条目不在例外范围内——那是应该改规则或上游数据，不是逐条例外。
func adoptionExceptionCandidate(row adoptionRow, rule adoptionRule) bool {
	selected, reason := adoptionRuleVerdict(row, rule)
	return selected || adoptionUncertain(reason)
}

// adoptionScopeDigest 是确认范围的成员指纹。四个计数相同但成员换人时，
// 仅比计数会漏掉范围漂移，所以确认与导出都要比这份指纹。
func adoptionScopeDigest(computation adoptionComputation) string {
	lines := make([]string, 0, len(computation.Entries))
	for _, entry := range computation.Entries {
		lines = append(lines, strings.Join([]string{
			entry.PageID,
			entry.Decision,
			entry.Reason,
			fmt.Sprintf("%t", entry.Pending),
			entry.Source,
		}, "|"))
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:])
}

func (c adoptionComputation) reasonCounts() []adoptionReasonCount {
	counts := make([]adoptionReasonCount, 0, len(c.Reasons))
	for code, count := range c.Reasons {
		counts = append(counts, adoptionReasonCount{Code: code, Count: count})
	}
	// 按数量降序、理由码升序：同一份数据两次导出必须得到同一个顺序。
	sort.Slice(counts, func(i, j int) bool {
		if counts[i].Count != counts[j].Count {
			return counts[i].Count > counts[j].Count
		}
		return counts[i].Code < counts[j].Code
	})
	return counts
}

type adoptionExceptionRecord struct {
	ID         string
	PageID     string
	Decision   string
	ReasonCode string
	Note       string
	DecidedBy  string
	DecidedAt  string
}

func (s *importService) registerAdoption() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST("/api/fangji/projects/{projectId}/adoption-batches", s.createAdoptionBatch).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/adoption-batches", s.listAdoptionBatches).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/adoption-batches/{batchId}", s.getAdoptionBatch).Bind(apis.RequireAuth("users"))
		e.Router.DELETE("/api/fangji/adoption-batches/{batchId}", s.deleteAdoptionBatch).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/adoption-batches/{batchId}/continue", s.continueAdoptionBatch).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/adoption-batches/{batchId}/preview", s.previewAdoptionBatch).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/adoption-batches/{batchId}/exceptions", s.listAdoptionExceptions).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/adoption-batches/{batchId}/exceptions/{pageId}", s.getAdoptionExceptionByPage).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/adoption-batches/{batchId}/exceptions", s.decideAdoptionException).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/adoption-batches/{batchId}/confirm", s.confirmAdoptionBatch).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/adoption-batches/{batchId}/manifest", s.exportAdoptionManifest).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

// loadAdoptionBatch 读批次并校验调用方对该项目有管理权限。批次的 project 是
// 作用域的唯一来源：路由里的 batchId 不带项目，不能拿路径参数当权限依据。
func (s *importService) loadAdoptionBatch(c *core.RequestEvent) (*core.Record, *core.Record, *core.Record, error) {
	return s.loadAdoptionBatchInApp(s.app, c)
}

func (s *importService) loadAdoptionBatchInApp(app core.App, c *core.RequestEvent) (*core.Record, *core.Record, *core.Record, error) {
	record, err := app.FindRecordById("adoption_batches", c.Request.PathValue("batchId"))
	if err != nil || record == nil {
		return nil, nil, nil, apis.NewNotFoundError("编选批次不存在。", err)
	}
	auth, project, err := requireAdoptionManagerInApp(app, c, record.GetString("project"))
	if err != nil {
		return nil, nil, nil, err
	}
	return record, auth, project, nil
}

// requireAdoptionManager 复用项目管理者判据，只把 403 的文案换成编选自己的说法。
// 共用助手的文案是「只有项目所有者或管理员可以上传项目文件」——那是上传路由的说法，
// 用在编选上会让人以为上传坏了，而真正的问题是这个人没有编选权限。
func (s *importService) requireAdoptionManager(c *core.RequestEvent, projectID string) (*core.Record, *core.Record, error) {
	auth, project, err := s.requireProjectManager(c, projectID)
	if err != nil {
		return nil, nil, adoptionManagerError(err)
	}
	return auth, project, nil
}

// adoptionManagerError 只改 403 的文案：401（没登录）与 404（项目不存在）原样返回，
// 那两条说的已经不是「你有没有编选权限」这件事。
func adoptionManagerError(err error) error {
	var apiErr *router.ApiError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusForbidden {
		return apis.NewForbiddenError("只有项目所有者或管理员可以编选交付范围。", nil)
	}
	return err
}

func adoptionBatchView(record *core.Record) map[string]any {
	pending := record.GetInt("pending_count")
	reasons := []adoptionReasonCount{}
	if raw := strings.TrimSpace(record.GetString("reasons_json")); raw != "" {
		if err := json.Unmarshal([]byte(raw), &reasons); err != nil {
			// 解析失败时保留空数组而不是静默给一份假分布：导出里能看到 counts 与
			// reasons 不一致，正是数据被手工改过的证据。
			reasons = []adoptionReasonCount{}
		}
	}
	rule := json.RawMessage(record.GetString("rule_json"))
	return map[string]any{
		"id":        record.Id,
		"project":   record.GetString("project"),
		"purpose":   record.GetString("purpose"),
		"recipient": record.GetString("recipient"),
		"status":    record.GetString("status"),
		"rule":      rule,
		"note":      record.GetString("note"),
		"counts": map[string]any{
			"total":    record.GetInt("total_count"),
			"selected": record.GetInt("selected_count"),
			"excluded": record.GetInt("excluded_count"),
			"pending":  pending,
			"complete": pending == 0,
		},
		"reasons":      reasons,
		"previewedAt":  record.GetString("previewed_at"),
		"createdBy":    record.GetString("created_by"),
		"confirmedBy":  record.GetString("confirmed_by"),
		"confirmedAt":  record.GetString("confirmed_at"),
		"scope_digest": record.GetString("scope_digest"),
		"created":      record.GetString("created"),
	}
}

func adoptionExceptionView(record *core.Record) map[string]any {
	return map[string]any{
		"page":      record.GetString("page"),
		"decision":  record.GetString("decision"),
		"reason":    record.GetString("reason_code"),
		"note":      record.GetString("note"),
		"decidedBy": record.GetString("decided_by"),
		"decidedAt": record.GetString("decided_at"),
	}
}

func openAdoptionBatch(app core.App, projectID, purpose string) *core.Record {
	records, err := app.FindRecordsByFilter(
		"adoption_batches",
		`project = {:project} && purpose = {:purpose} && (status = "draft" || status = "previewed")`,
		"", 1, 0,
		dbx.Params{"project": projectID, "purpose": purpose},
	)
	if err != nil || len(records) == 0 {
		return nil
	}
	return records[0]
}

func (s *importService) createAdoptionBatch(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	auth, project, err := s.requireAdoptionManager(c, projectID)
	if err != nil {
		return err
	}
	payload := struct {
		Purpose   string          `json:"purpose"`
		Recipient string          `json:"recipient"`
		Note      string          `json:"note"`
		Rule      json.RawMessage `json:"rule"`
	}{}
	if err := c.BindBody(&payload); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", err)
	}
	purpose := strings.TrimSpace(payload.Purpose)
	if !containsStr(adoptionPurposes, purpose) {
		return apis.NewBadRequestError(fmt.Sprintf("用途只能是：%s。", strings.Join(adoptionPurposes, "、")), nil)
	}
	recipient := strings.TrimSpace(payload.Recipient)
	if recipient == "" {
		return apis.NewBadRequestError("必须写明这一批交给谁（接收方）。", nil)
	}
	if utf8.RuneCountInString(recipient) > adoptionRecipientMax {
		return apis.NewBadRequestError(fmt.Sprintf("接收方最多 %d 个字符。", adoptionRecipientMax), nil)
	}
	note := strings.TrimSpace(payload.Note)
	if utf8.RuneCountInString(note) > adoptionNoteMax {
		return apis.NewBadRequestError(fmt.Sprintf("说明最多 %d 个字符。", adoptionNoteMax), nil)
	}
	rule, err := parseAdoptionRule(payload.Rule)
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	// 导入批次必须是本项目的：让规则指向别人的批次，会让这一批的范围凭空多出
	// 或少了条目，而且从记录上看不出是配置错了还是数据错了。
	for _, job := range rule.ImportJobs {
		record, findErr := s.app.FindRecordById("import_jobs", job)
		if findErr != nil || record == nil || record.GetString("project") != project.Id {
			return apis.NewBadRequestError("筛选规则里的导入批次不属于本项目。", findErr)
		}
	}

	ruleJSON, err := json.Marshal(rule)
	if err != nil {
		return apis.NewBadRequestError("筛选规则无法保存。", err)
	}
	collection, err := s.app.FindCollectionByNameOrId("adoption_batches")
	if err != nil {
		return apis.NewBadRequestError("编选批次存储尚未初始化。", err)
	}
	record := core.NewRecord(collection)
	record.Set("project", project.Id)
	record.Set("purpose", purpose)
	record.Set("recipient", recipient)
	record.Set("note", note)
	record.Set("rule_json", string(ruleJSON))
	record.Set("status", adoptionBatchDraft)
	record.Set("total_count", 0)
	record.Set("selected_count", 0)
	record.Set("excluded_count", 0)
	record.Set("pending_count", 0)
	record.Set("created_by", auth.Id)
	if err := s.app.Save(record); err != nil {
		// idx_adoption_batches_open 是部分唯一索引：同一项目同一用途同时只允许
		// 一条未确认的编选。撞上时把已有那条还给调用方，而不是报一个看不出原因
		// 的保存失败。
		if existing := openAdoptionBatch(s.app, project.Id, purpose); existing != nil {
			return adoptionOpenConflict(c, existing)
		}
		return apis.NewBadRequestError("创建编选批次失败。", err)
	}
	return c.JSON(http.StatusCreated, adoptionBatchView(record))
}

func adoptionOpenConflict(c *core.RequestEvent, existing *core.Record) error {
	return c.JSON(http.StatusConflict, map[string]any{
		"message": "该项目在这个用途下已有一份未确认的编选，请先完成或删除它。",
		"batch":   adoptionBatchView(existing),
	})
}

func (s *importService) continueAdoptionBatch(c *core.RequestEvent) error {
	var draft, existing *core.Record
	err := s.app.RunInTransaction(func(app core.App) error {
		previous, auth, project, err := s.loadAdoptionBatchInApp(app, c)
		if err != nil {
			return err
		}
		if previous.GetString("status") != adoptionBatchConfirmed {
			return apis.NewBadRequestError("只能沿用已确认的编选批次。", nil)
		}
		rule, err := parseAdoptionRule(json.RawMessage(previous.GetString("rule_json")))
		if err != nil {
			return apis.NewBadRequestError(err.Error(), nil)
		}
		for _, id := range rule.ImportJobs {
			job, jobErr := app.FindRecordById("import_jobs", id)
			if jobErr != nil || job.GetString("project") != project.Id {
				return apis.NewBadRequestError("原编选规则中的导入批次已不可用。", nil)
			}
		}
		draft = core.NewRecord(previous.Collection())
		for _, field := range []string{"project", "purpose", "recipient", "rule_json", "note"} {
			draft.Set(field, previous.GetString(field))
		}
		draft.Set("status", adoptionBatchDraft)
		draft.Set("created_by", auth.Id)
		if err := app.Save(draft); err != nil {
			existing = openAdoptionBatch(app, project.Id, draft.GetString("purpose"))
			return apis.NewBadRequestError("创建接续草稿失败。", err)
		}
		exceptions, err := app.FindRecordsByFilter("adoption_exceptions", "batch = {:batch}", "created,id", 0, 0, dbx.Params{"batch": previous.Id})
		if err != nil {
			return err
		}
		for _, previousDecision := range exceptions {
			decision := core.NewRecord(previousDecision.Collection())
			decision.Set("batch", draft.Id)
			// These are the original decisions, including their authors and dates.
			// Preview still evaluates them against current rules and rights.
			for _, field := range []string{"page", "decision", "reason_code", "note", "decided_by", "decided_at"} {
				decision.Set(field, previousDecision.Get(field))
			}
			if err := app.Save(decision); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		if existing != nil {
			return adoptionOpenConflict(c, existing)
		}
		return err
	}
	return c.JSON(http.StatusCreated, adoptionBatchView(draft))
}

func (s *importService) listAdoptionBatches(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireAdoptionManager(c, projectID); err != nil {
		return err
	}
	query := c.Request.URL.Query()
	page := pageArgument(query.Get("page"), 1, 1000000)
	perPage := pageArgument(query.Get("perPage"), 25, 100)
	var result map[string]any
	// Count and page share one snapshot, including when a draft is deleted
	// while the user is browsing the last page.
	err := withRecordReadSnapshot(c.Request.Context(), s.app, func(app recordReader) error {
		if _, _, err := requireProjectManagerInApp(app, c, projectID); err != nil {
			return err
		}
		params := dbx.Params{"project": projectID}
		totalItems, err := app.CountRecords("adoption_batches", dbx.HashExp{"project": projectID})
		if err != nil {
			return err
		}
		totalPages := max(1, (int(totalItems)+perPage-1)/perPage)
		page = min(page, totalPages)
		records, err := app.FindRecordsByFilter(
			"adoption_batches", "project = {:project}", "-created,-id", perPage, (page-1)*perPage, params,
		)
		if err != nil {
			return err
		}
		batches := make([]map[string]any, 0, len(records))
		for _, record := range records {
			batches = append(batches, adoptionBatchView(record))
		}
		result = map[string]any{
			"batches": batches, "purposes": adoptionPurposes, "reasons": adoptionReasonCodes(),
			"page": page, "perPage": perPage, "totalItems": totalItems, "totalPages": totalPages,
		}
		return nil
	})
	if err != nil {
		var apiError *router.ApiError
		if errors.As(err, &apiError) {
			return apiError
		}
		return apis.NewBadRequestError("读取编选批次失败。", err)
	}
	return c.JSON(http.StatusOK, result)
}

func (s *importService) getAdoptionBatch(c *core.RequestEvent) error {
	record, _, _, err := s.loadAdoptionBatch(c)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, adoptionBatchView(record))
}

func (s *importService) deleteAdoptionBatch(c *core.RequestEvent) error {
	var result any
	err := s.app.RunInTransaction(func(app core.App) error {
		var err error
		result, err = s.deleteAdoptionBatchInApp(app, c)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, result)
}

func (s *importService) deleteAdoptionBatchInApp(app core.App, c *core.RequestEvent) (any, error) {
	record, _, _, err := s.loadAdoptionBatchInApp(app, c)
	if err != nil {
		return nil, err
	}
	// 已确认的批次不能删：它是 E 侧交付包的入选依据，删掉等于抹掉曾经的范围声明。
	// 要重做就再开一批（确认后不占 idx_adoption_batches_open 的位）。
	if record.GetString("status") == adoptionBatchConfirmed {
		return nil, apis.NewBadRequestError("已确认的编选批次不能删除；要改范围请新开一批。", nil)
	}
	if err := app.Delete(record); err != nil {
		return nil, apis.NewBadRequestError("删除编选批次失败。", err)
	}
	return map[string]any{"id": record.Id, "deleted": true}, nil
}

func (s *importService) previewAdoptionBatch(c *core.RequestEvent) error {
	var result any
	err := s.app.RunInTransaction(func(app core.App) error {
		var err error
		result, err = s.previewAdoptionBatchInApp(app, c)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, result)
}

func (s *importService) previewAdoptionBatchInApp(app core.App, c *core.RequestEvent) (any, error) {
	record, _, _, err := s.loadAdoptionBatchInApp(app, c)
	if err != nil {
		return nil, err
	}
	status := record.GetString("status")
	if status == adoptionBatchConfirmed {
		return nil, apis.NewBadRequestError("已确认的批次不能再预览；要改范围请新开一批。", nil)
	}
	rule, err := parseAdoptionRule(json.RawMessage(record.GetString("rule_json")))
	if err != nil {
		return nil, apis.NewBadRequestError(err.Error(), nil)
	}
	computation, err := computeAdoption(app, record.GetString("project"), record.GetString("purpose"), record.Id, rule)
	if err != nil {
		return nil, apis.NewBadRequestError("计算编选范围失败。", err)
	}
	if err := s.saveAdoptionCounts(record, computation); err != nil {
		return nil, apis.NewBadRequestError("保存预览结果失败。", err)
	}
	record.Set("status", adoptionBatchPreviewed)
	record.Set("previewed_at", time.Now().UTC())
	if err := app.Save(record); err != nil {
		return nil, apis.NewBadRequestError("保存预览结果失败。", err)
	}
	return adoptionBatchView(record), nil
}

func (s *importService) saveAdoptionCounts(record *core.Record, computation adoptionComputation) error {
	reasons, err := json.Marshal(computation.reasonCounts())
	if err != nil {
		return err
	}
	record.Set("total_count", computation.Total)
	record.Set("selected_count", computation.Selected)
	record.Set("excluded_count", computation.Excluded)
	record.Set("pending_count", computation.Pending)
	record.Set("reasons_json", string(reasons))
	record.Set("scope_digest", adoptionScopeDigest(computation))
	return nil
}

func (s *importService) confirmAdoptionBatch(c *core.RequestEvent) error {
	var result any
	err := s.app.RunInTransaction(func(app core.App) error {
		var err error
		result, err = s.confirmAdoptionBatchInApp(app, c)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, result)
}

func (s *importService) confirmAdoptionBatchInApp(app core.App, c *core.RequestEvent) (any, error) {
	record, auth, _, err := s.loadAdoptionBatchInApp(app, c)
	if err != nil {
		return nil, err
	}
	if record.GetString("status") != adoptionBatchPreviewed {
		return nil, apis.NewBadRequestError("必须先预览数量再确认本批采用范围。", nil)
	}
	rule, err := parseAdoptionRule(json.RawMessage(record.GetString("rule_json")))
	if err != nil {
		return nil, apis.NewBadRequestError(err.Error(), nil)
	}
	computation, err := computeAdoption(app, record.GetString("project"), record.GetString("purpose"), record.Id, rule)
	if err != nil {
		return nil, apis.NewBadRequestError("计算编选范围失败。", err)
	}
	// 预览之后数据变了：不把新数字悄悄写进「已确认」，而是要求重新预览。否则
	// 「确认时看到多少」与「确认后库里记着多少」会悄悄不同，D4.2 的诚实性就没了。
	if drifted := adoptionCountsDrifted(record, computation); drifted != "" {
		return nil, apis.NewApiError(http.StatusConflict, "预览之后数据变了（"+drifted+"），请重新预览再确认。", nil)
	}
	if err := s.saveAdoptionCounts(record, computation); err != nil {
		return nil, apis.NewBadRequestError("保存确认结果失败。", err)
	}
	record.Set("status", adoptionBatchConfirmed)
	record.Set("confirmed_by", auth.Id)
	record.Set("confirmed_at", time.Now().UTC())
	if err := app.Save(record); err != nil {
		return nil, apis.NewBadRequestError("确认编选批次失败。", err)
	}
	return adoptionBatchView(record), nil
}

func adoptionCountsDrifted(record *core.Record, computation adoptionComputation) string {
	switch {
	case record.GetInt("total_count") != computation.Total:
		return "总数"
	case record.GetInt("selected_count") != computation.Selected:
		return "采用数量"
	case record.GetInt("excluded_count") != computation.Excluded:
		return "未采用数量"
	case record.GetInt("pending_count") != computation.Pending:
		return "待处理数量"
	}
	// 四个数相同不代表范围相同：两条同状态条目互换会保持计数。空 digest 是
	// 旧记录（本字段上线前确认的批次），没有可比对象，不能伪造一个漂移。
	if stored := record.GetString("scope_digest"); stored != "" && stored != adoptionScopeDigest(computation) {
		return "范围成员"
	}
	return ""
}

func (s *importService) listAdoptionExceptions(c *core.RequestEvent) error {
	record, _, _, err := s.loadAdoptionBatch(c)
	if err != nil {
		return err
	}
	rule, err := parseAdoptionRule(json.RawMessage(record.GetString("rule_json")))
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	computation, err := computeAdoption(s.app, record.GetString("project"), record.GetString("purpose"), record.Id, rule)
	if err != nil {
		return apis.NewBadRequestError("计算编选范围失败。", err)
	}
	pending := make([]adoptionEntry, 0)
	for _, entry := range computation.Entries {
		if entry.Pending {
			pending = append(pending, entry)
		}
	}
	page := pageArgument(c.Request.URL.Query().Get("page"), 1, 1000000)
	perPage := pageArgument(c.Request.URL.Query().Get("perPage"), 25, 100)
	totalPages := max(1, (len(pending)+perPage-1)/perPage)
	page = min(page, totalPages)
	start := (page - 1) * perPage
	pending = pending[start:min(start+perPage, len(pending))]
	decidedTotal, err := s.app.CountRecords("adoption_exceptions", dbx.HashExp{"batch": record.Id})
	if err != nil {
		return err
	}
	decidedPage := pageArgument(c.Request.URL.Query().Get("decidedPage"), 1, 1000000)
	decidedPages := max(1, (int(decidedTotal)+perPage-1)/perPage)
	decidedPage = min(decidedPage, decidedPages)
	records, err := s.app.FindRecordsByFilter("adoption_exceptions", "batch = {:batch}", "created,id", perPage, (decidedPage-1)*perPage, dbx.Params{"batch": record.Id})
	if err != nil {
		return err
	}
	decided := make([]map[string]any, 0, len(records))
	for _, item := range records {
		decided = append(decided, adoptionExceptionView(item))
	}
	return c.JSON(http.StatusOK, map[string]any{"exceptions": decided, "pending": pending, "pendingTotal": computation.Pending, "reasons": adoptionReasonCodes(), "page": page, "perPage": perPage, "totalItems": computation.Pending, "totalPages": totalPages, "decidedPage": decidedPage, "decidedTotal": decidedTotal, "decidedPages": decidedPages})
}

func (s *importService) getAdoptionExceptionByPage(c *core.RequestEvent) error {
	record, _, _, err := s.loadAdoptionBatch(c)
	if err != nil {
		return err
	}
	rule, err := parseAdoptionRule(json.RawMessage(record.GetString("rule_json")))
	if err != nil {
		return err
	}
	computation, err := computeAdoption(s.app, record.GetString("project"), record.GetString("purpose"), record.Id, rule)
	if err != nil {
		return err
	}
	for _, entry := range computation.Entries {
		if entry.PageID == c.Request.PathValue("pageId") {
			var decision any
			records, err := s.app.FindRecordsByFilter("adoption_exceptions", "batch = {:batch} && page = {:page}", "", 1, 0, dbx.Params{"batch": record.Id, "page": entry.PageID})
			if err != nil {
				return err
			}
			if len(records) > 0 {
				decision = adoptionExceptionView(records[0])
			}
			return c.JSON(http.StatusOK, map[string]any{"entry": entry, "exception": decision})
		}
	}
	return apis.NewNotFoundError("条目不在本批范围中。", nil)
}

func (s *importService) decideAdoptionException(c *core.RequestEvent) error {
	var result any
	err := s.app.RunInTransaction(func(app core.App) error {
		var err error
		result, err = s.decideAdoptionExceptionInApp(app, c)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, result)
}

func (s *importService) decideAdoptionExceptionInApp(app core.App, c *core.RequestEvent) (any, error) {
	record, auth, project, err := s.loadAdoptionBatchInApp(app, c)
	if err != nil {
		return nil, err
	}
	if record.GetString("status") == adoptionBatchConfirmed {
		return nil, apis.NewBadRequestError("已确认的批次不能再改例外；要改范围请新开一批。", nil)
	}
	payload := struct {
		Page       string `json:"page"`
		Decision   string `json:"decision"`
		ReasonCode string `json:"reason"`
		Note       string `json:"note"`
	}{}
	if err := c.BindBody(&payload); err != nil {
		return nil, apis.NewBadRequestError("请求内容无法解析。", err)
	}
	pageID := strings.TrimSpace(payload.Page)
	if !looksLikeRecordID(pageID) {
		return nil, apis.NewBadRequestError("条目标识无效。", nil)
	}
	page, err := app.FindRecordById("pages", pageID)
	if err != nil || page == nil || page.GetString("project") != project.Id {
		return nil, apis.NewNotFoundError("条目不存在。", err)
	}
	decision := strings.TrimSpace(payload.Decision)
	if decision != adoptionDecisionSelect && decision != adoptionDecisionExclude {
		return nil, apis.NewBadRequestError("例外结论只能是 select 或 exclude。", nil)
	}
	reasonCode := strings.TrimSpace(payload.ReasonCode)
	if decision == adoptionDecisionExclude && !containsStr(adoptionReasonCodes(), reasonCode) {
		return nil, apis.NewBadRequestError(fmt.Sprintf("排除理由必须是枚举内的取值：%s。", strings.Join(adoptionReasonCodes(), "、")), nil)
	}
	note := strings.TrimSpace(payload.Note)
	if note == "" {
		return nil, apis.NewBadRequestError("处理例外必须写明依据。", nil)
	}
	if utf8.RuneCountInString(note) > adoptionNoteMax {
		return nil, apis.NewBadRequestError(fmt.Sprintf("依据最多 %d 个字符。", adoptionNoteMax), nil)
	}
	rule, err := parseAdoptionRule(json.RawMessage(record.GetString("rule_json")))
	if err != nil {
		return nil, apis.NewBadRequestError(err.Error(), nil)
	}
	rows, err := adoptionRows(app, project.Id, record.GetString("purpose"))
	if err != nil {
		return nil, apis.NewBadRequestError("计算编选范围失败。", err)
	}
	var target *adoptionRow
	for index := range rows {
		if rows[index].PageID == pageID {
			target = &rows[index]
			break
		}
	}
	if target == nil {
		return nil, apis.NewNotFoundError("条目不在本项目的编选范围里。", nil)
	}
	if !adoptionExceptionCandidate(*target, rule) {
		_, ruleReason := adoptionRuleVerdict(*target, rule)
		return nil, apis.NewBadRequestError(fmt.Sprintf("该条目不在本批例外范围内（%s）：状态、质量、阻塞或拼音前置条件未满足，请先修规则或上游数据。", ruleReason), nil)
	}
	if decision == adoptionDecisionSelect {
		if rightsReason := adoptionRightsFailure(*target); rightsReason != "" {
			return nil, apis.NewBadRequestError(fmt.Sprintf("该用途的权利结论不是 allow（%s）。例外说明不能替代授权记录，请先在来源登记中更新用途结论。", rightsReason), nil)
		}
	}

	collection, err := app.FindCollectionByNameOrId("adoption_exceptions")
	if err != nil {
		return nil, apis.NewBadRequestError("例外存储尚未初始化。", err)
	}
	item, err := findOrInitAdoptionException(app, collection, record.Id, pageID)
	if err != nil {
		return nil, apis.NewBadRequestError("读取既有例外失败。", err)
	}
	item.Set("decision", decision)
	item.Set("reason_code", reasonCode)
	item.Set("note", note)
	item.Set("decided_by", auth.Id)
	item.Set("decided_at", time.Now().UTC())
	if err := app.Save(item); err != nil {
		return nil, apis.NewBadRequestError("保存例外失败。", err)
	}
	// 例外一变，预览过的数量就过期了：退回 draft，逼调用方重新预览。否则确认时
	// 会拿一份「例外改动之前」的数量去圈范围，正是 D4.2 要防的那种静默偏差。
	if record.GetString("status") == adoptionBatchPreviewed {
		record.Set("status", adoptionBatchDraft)
		if err := app.Save(record); err != nil {
			return nil, apis.NewBadRequestError("保存例外失败。", err)
		}
	}
	return map[string]any{
		"exception": adoptionExceptionView(item),
		"batch":     adoptionBatchView(record),
	}, nil
}

// 读库失败必须原样上抛：吞掉它会让「已有例外」走新建并撞 (batch, page) 唯一索引，
// 真实的 DB 故障被伪装成「保存例外失败」，排查被误导。
func findOrInitAdoptionException(app core.App, collection *core.Collection, batchID, pageID string) (*core.Record, error) {
	existing, findErr := app.FindRecordsByFilter(
		"adoption_exceptions",
		`batch = {:batch} && page = {:page}`,
		"", 1, 0,
		dbx.Params{"batch": batchID, "page": pageID},
	)
	if findErr != nil {
		return nil, findErr
	}
	if len(existing) > 0 {
		return existing[0], nil
	}
	item := core.NewRecord(collection)
	item.Set("batch", batchID)
	item.Set("page", pageID)
	return item, nil
}

func (s *importService) exportAdoptionManifest(c *core.RequestEvent) error {
	record, auth, project, err := s.loadAdoptionBatch(c)
	if err != nil {
		return err
	}
	include := strings.TrimSpace(c.Request.URL.Query().Get("include"))
	if include == "" {
		include = adoptionDecisionSelect
	}
	switch include {
	case adoptionDecisionSelect, adoptionDecisionExclude, "pending", "all":
	default:
		return apis.NewBadRequestError("include 只能是 select、exclude、pending 或 all。", nil)
	}
	// D4.3：默认只含本批采用范围内；范围外要显式请求，而且只给平台管理员。
	// 这不是防管理员，是让「谁在什么时候把范围外正文带出去过」有唯一入口。
	if include != adoptionDecisionSelect && auth.GetString("role") != "platform_admin" {
		return apis.NewForbiddenError("只有平台管理员可以请求把范围外条目写进导出。", nil)
	}
	rule, err := parseAdoptionRule(json.RawMessage(record.GetString("rule_json")))
	if err != nil {
		return apis.NewBadRequestError(err.Error(), nil)
	}
	computation, err := computeAdoption(s.app, project.Id, record.GetString("purpose"), record.Id, rule)
	if err != nil {
		return apis.NewBadRequestError("计算编选范围失败。", err)
	}
	entries := make([]adoptionEntry, 0, computation.Selected)
	for _, entry := range computation.Entries {
		if !adoptionEntryIncluded(entry, include) {
			continue
		}
		entries = append(entries, entry)
	}
	manifest := map[string]any{
		"generatedAt": time.Now().UTC(),
		"batch":       adoptionBatchView(record),
		"rule":        rule,
		"coverage": map[string]any{
			"project":      project.Id,
			"purpose":      record.GetString("purpose"),
			"recipient":    record.GetString("recipient"),
			"statuses":     rule.Statuses,
			"importJobs":   rule.ImportJobs,
			"confirmedBy":  record.GetString("confirmed_by"),
			"confirmedAt":  record.GetString("confirmed_at"),
			"scope_digest": record.GetString("scope_digest"),
		},
		"counts": map[string]any{
			"total":    computation.Total,
			"selected": computation.Selected,
			"excluded": computation.Excluded,
			"pending":  computation.Pending,
			"complete": computation.Pending == 0,
		},
		"reasons": computation.reasonCounts(),
		"entries": entries,
		// 默认导出只带选中条目，但它「没有带」的那部分必须写出来：这是 D4.2
		// 「不得静默遗漏」的机器可读形式。
		"omitted": map[string]any{
			"excluded": computation.Excluded,
			"pending":  computation.Pending,
			"included": include,
		},
		"drift": false,
	}
	// 已确认批次：导出时复算一次，与确认时记下的数字对照。不一致就写 drift=true，
	// 不悄悄用旧数覆盖——那正是「把部分结果冒充全量」。
	if record.GetString("status") == adoptionBatchConfirmed {
		if drifted := adoptionCountsDrifted(record, computation); drifted != "" {
			manifest["drift"] = drifted
		}
	}
	c.Response.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", "adoption-"+record.Id+".json"))
	return c.JSON(http.StatusOK, manifest)
}

func adoptionEntryIncluded(entry adoptionEntry, include string) bool {
	switch include {
	case adoptionDecisionSelect:
		return entry.Decision == adoptionDecisionSelect
	case adoptionDecisionExclude:
		return entry.Decision == adoptionDecisionExclude && !entry.Pending
	case "pending":
		return entry.Pending
	default: // all
		return true
	}
}

func adoptionExceptions(app recordReader, batchID string) (map[string]adoptionExceptionRecord, error) {
	records, err := app.FindRecordsByFilter(
		"adoption_exceptions", "batch = {:batch}", "", 0, 0,
		dbx.Params{"batch": batchID},
	)
	if err != nil {
		return nil, err
	}
	exceptions := make(map[string]adoptionExceptionRecord, len(records))
	for _, record := range records {
		exceptions[record.GetString("page")] = adoptionExceptionRecord{
			ID:         record.Id,
			PageID:     record.GetString("page"),
			Decision:   record.GetString("decision"),
			ReasonCode: record.GetString("reason_code"),
			Note:       record.GetString("note"),
			DecidedBy:  record.GetString("decided_by"),
			DecidedAt:  record.GetString("decided_at"),
		}
	}
	return exceptions, nil
}

// adoptionRowsSQL 一次读出编选要看的全部事实。
//
// 来源按页面自己的 import_job 取，退回到项目级 source：旧库只有项目级登记。
// 这条 join 只连到 source_usages 的用途那一行，因此「本项目这个用途」的权利结论
// 直接随行读出，不需要在 Go 里再查一遍。
const adoptionRowsSQL = `
SELECT p.id AS page_id,
       COALESCE(p.page_number, 0) AS page_number,
       COALESCE(p.status, '') AS status,
       COALESCE(p.quality_state, '') AS quality_state,
       COALESCE(p.blocked_reason, '') AS blocked_reason,
       COALESCE(p.normalization_status, '') AS normalization_status,
       COALESCE(p.import_job, '') AS import_job,
       COALESCE(su.decision, '') AS rights_decision
FROM pages p
LEFT JOIN import_jobs ij ON ij.id = p.import_job
LEFT JOIN projects pr ON pr.id = p.project
LEFT JOIN source_usages su
       ON su.source = COALESCE(NULLIF(ij.source, ''), pr.source)
      AND su.purpose = {:purpose}
WHERE p.project = {:project}
ORDER BY p.page_number, p.id`

func adoptionRows(app recordReader, projectID, purpose string) ([]adoptionRow, error) {
	rows := []adoptionRow{}
	if err := app.DB().NewQuery(adoptionRowsSQL).
		Bind(dbx.Params{"project": projectID, "purpose": purpose}).
		All(&rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func computeAdoption(app recordReader, projectID, purpose, batchID string, rule adoptionRule) (adoptionComputation, error) {
	rows, err := adoptionRows(app, projectID, purpose)
	if err != nil {
		return adoptionComputation{}, err
	}
	exceptions, err := adoptionExceptions(app, batchID)
	if err != nil {
		return adoptionComputation{}, err
	}
	return classifyAdoptionRows(rows, rule, exceptions), nil
}
