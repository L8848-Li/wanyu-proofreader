package main

import (
	"fmt"
	"net/http"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

type workflowMetric struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Count *int   `json:"count"`
	Unit  string `json:"unit"`
}
type workflowBlocker struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type workflowAction struct {
	Key    string     `json:"key"`
	Label  string     `json:"label"`
	Target todoTarget `json:"target"`
}
type workflowStage struct {
	Key        string            `json:"key"`
	Title      string            `json:"title"`
	State      string            `json:"state"`
	StateLabel string            `json:"state_label"`
	Role       string            `json:"role"`
	Summary    string            `json:"summary"`
	Metrics    []workflowMetric  `json:"metrics"`
	Blockers   []workflowBlocker `json:"blockers"`
	Actions    []workflowAction  `json:"actions"`
	Note       string            `json:"note"`
}
type workflowRecommendation struct {
	Stage  string         `json:"stage"`
	Title  string         `json:"title"`
	Detail string         `json:"detail"`
	Role   string         `json:"role"`
	Action workflowAction `json:"action"`
}
type projectWorkflow struct {
	GeneratedAt    string                  `json:"generated_at"`
	Project        todoProject             `json:"project"`
	Summary        map[string]*int         `json:"summary"`
	Stages         []workflowStage         `json:"stages"`
	Recommendation *workflowRecommendation `json:"recommendation"`
}

func workflowNumber(n int) *int { return &n }
func workflowMetricValue(key, label string, n int, unit string) workflowMetric {
	return workflowMetric{key, label, workflowNumber(n), unit}
}
func workflowTarget(project, key, label, suffix string, query map[string]string) workflowAction {
	if query == nil {
		query = map[string]string{}
	}
	return workflowAction{key, label, todoTarget{Path: "/admin/projects/" + project + suffix, Query: query}}
}
func workflowWorkspace(project, key, label, section, view string) workflowAction {
	return workflowTarget(project, key, label, "", map[string]string{"section": section, "view": view})
}
func workflowTodoAction(key, label string, row managerTodo) workflowAction {
	return workflowAction{key, label, row.Target}
}
func (stage *workflowStage) set(state, label, summary string) {
	stage.State = state
	stage.StateLabel = label
	stage.Summary = summary
}
func (stage *workflowStage) unknown() {
	stage.set("unknown", "暂未更新", "这一步的记录暂时无法读取，请刷新后再判断。")
	for i := range stage.Metrics {
		stage.Metrics[i].Count = nil
	}
	stage.Blockers = []workflowBlocker{{"read_unavailable", "当前状态尚未核实，不能按零项处理。"}}
}
func newWorkflowStage(key, title, role, note string) workflowStage {
	return workflowStage{Key: key, Title: title, Role: role, State: "not_started", StateLabel: "尚无记录", Metrics: []workflowMetric{}, Blockers: []workflowBlocker{}, Actions: []workflowAction{}, Note: note}
}

func (s *projectQueryService) registerProjectWorkflow() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/projects/{projectId}/workflow", s.getProjectWorkflow).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}
func (s *projectQueryService) getProjectWorkflow(e *core.RequestEvent) error {
	projectID := e.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(e, projectID); err != nil {
		return err
	}
	var result projectWorkflow
	err := withRecordReadSnapshot(e.Request.Context(), s.app, func(app recordReader) error {
		actor, err := app.FindRecordById("users", e.Auth.Id)
		if err != nil || actor.TokenKey() != e.Auth.TokenKey() || actor.GetBool("must_change_password") {
			return apis.NewUnauthorizedError("登录状态已变化，请重新登录。", nil)
		}
		project, err := app.FindRecordById("projects", projectID)
		if err != nil {
			return apis.NewNotFoundError("项目不存在。", nil)
		}
		if actor.GetString("role") != "platform_admin" && project.GetString("admin") != actor.Id {
			count, err := app.CountRecords("project_memberships", dbx.HashExp{"project": projectID, "user": actor.Id, "role": "manager"})
			if err != nil {
				return err
			}
			if count == 0 {
				return apis.NewForbiddenError("你已不能管理此项目。", nil)
			}
		}
		result = s.buildProjectWorkflow(app, project, time.Now().UTC())
		return nil
	})
	if err != nil {
		return err
	}
	e.Response.Header().Set("Cache-Control", "private, no-store")
	return e.JSON(http.StatusOK, result)
}

type workflowPages struct {
	Total       int `db:"total"`
	Approved    int `db:"approved"`
	Arbitration int `db:"arbitration"`
	Rework      int `db:"rework"`
	Eligible    int `db:"eligible"`
	Submitted   int `db:"submitted"`
	Independent int `db:"independent"`
	Awaiting    int `db:"awaiting"`
	Empty       int `db:"empty"`
}

func readWorkflowPages(app recordReader, project string, required int) (workflowPages, error) {
	var counts workflowPages
	err := app.DB().NewQuery(`WITH submissions AS (
 SELECT a.page,COUNT(DISTINCT NULLIF(a.proofreader,'')) submitted FROM proofreading_attempts a
 JOIN pages p ON p.id=a.page AND p.project=a.project WHERE p.project={:project}
 AND a.kind='proofread' AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) GROUP BY a.page
 ) SELECT COUNT(*) total,
 COALESCE(SUM(p.status='approved'),0) approved,COALESCE(SUM(p.status='arbitration'),0) arbitration,
 COALESCE(SUM(p.status='rework'),0) rework,COALESCE(SUM(p.source_empty=1),0) empty,
 COALESCE(SUM(p.source_empty IS NOT 1),0) eligible,
 COALESCE(SUM(p.source_empty IS NOT 1 AND COALESCE(s.submitted,0)>0),0) submitted,
 COALESCE(SUM(p.source_empty IS NOT 1 AND COALESCE(s.submitted,0)>={:required}),0) independent,
 COALESCE(SUM(p.source_empty IS NOT 1 AND p.status IN ('pending','claimed','proofreading','proofread')),0) awaiting
 FROM pages p LEFT JOIN submissions s ON s.page=p.id WHERE p.project={:project} AND p.status!='importing'`).Bind(dbx.Params{"project": project, "required": required}).One(&counts)
	return counts, err
}
func (s *projectQueryService) buildProjectWorkflow(app recordReader, project *core.Record, now time.Time) projectWorkflow {
	id := project.Id
	out := projectWorkflow{GeneratedAt: now.Format(time.RFC3339Nano), Project: todoProject{ID: id, Name: project.GetString("name")}, Summary: map[string]*int{"entries": nil, "proofreading_completed": nil, "arbitration": nil}, Stages: []workflowStage{}}
	required := max(2, project.GetInt("required_proofreads"))
	pages, pageErr := readWorkflowPages(app, id, required)
	if pageErr == nil {
		out.Summary["entries"] = workflowNumber(pages.Total)
		out.Summary["proofreading_completed"] = workflowNumber(pages.Approved)
		out.Summary["arbitration"] = workflowNumber(pages.Arbitration)
	}
	review, reviewErr := newTodoSourceReview(app, s.hooksDir)
	todo := func(kind string) (managerTodo, error) {
		row := newManagerTodo(out.Project, kind)
		err := s.fillManagerTodo(app, &row, now, review, reviewErr)
		return row, err
	}
	materials := s.workflowMaterials(app, id, pages, pageErr)
	proof := workflowProofreading(id, required, pages, pageErr)
	verification := s.workflowVerification(id, pages, pageErr, todo)
	adoption := s.workflowAdoption(app, id, todo)
	deliveries, deliveryErr := readWorkflowDeliveries(app, id)
	delivery, receipt := workflowDeliveryStages(id, deliveries, deliveryErr)
	out.Stages = []workflowStage{materials, proof, verification, adoption, delivery, receipt}
	// Actionable exceptions precede ordinary progress; no unknown stage can be
	// recommended as ready. Parallel stages remain visible instead of being locked.
	for _, key := range []string{"delivery", "receipt", "materials", "verification", "adoption"} {
		for _, stage := range out.Stages {
			if stage.Key == key && stage.State == "needs_action" && len(stage.Actions) > 0 {
				out.Recommendation = &workflowRecommendation{stage.Key, stage.StateLabel, stage.Summary, stage.Role, stage.Actions[0]}
				return out
			}
		}
	}
	for _, key := range []string{"materials", "proofreading", "verification", "adoption", "receipt", "delivery"} {
		for _, stage := range out.Stages {
			if stage.Key != key || stage.State == "unknown" || len(stage.Actions) == 0 {
				continue
			}
			recommend := stage.State == "in_progress" || (key == "materials" && stage.State == "not_started") || (key == "adoption" && stage.State == "not_started" && pageErr == nil && pages.Approved > 0) || (key == "delivery" && stage.State == "not_started" && adoption.State == "recorded")
			if recommend {
				out.Recommendation = &workflowRecommendation{stage.Key, stage.StateLabel, stage.Summary, stage.Role, stage.Actions[0]}
				return out
			}
		}
	}
	return out
}
func (s *projectQueryService) workflowMaterials(app recordReader, id string, pages workflowPages, pageErr error) workflowStage {
	stage := newWorkflowStage("materials", "资料准备", "项目管理员", "入册只统计已发布条目。历史失败批次不等于当前仍被阻塞，已入册也不代表原文对应关系已核实。")
	stage.Actions = []workflowAction{workflowWorkspace(id, "imports", "查看导入记录", "materials", "batches"), workflowWorkspace(id, "prepare", "准备材料", "materials", "import")}
	var counts struct {
		Active  int `db:"active"`
		Confirm int `db:"confirm"`
		Failed  int `db:"failed"`
		Total   int `db:"total"`
	}
	err := app.DB().NewQuery(`SELECT COUNT(*) total,COALESCE(SUM(status IN ('inspecting','queued','processing')),0) active,COALESCE(SUM(mode='skip_invalid' AND status='validated'),0) confirm,COALESCE(SUM(status='failed'),0) failed FROM import_jobs WHERE project={:project}`).Bind(dbx.Params{"project": id}).One(&counts)
	var pdf struct {
		Active int `db:"active"`
		Ready  int `db:"ready"`
	}
	pdfErr := app.DB().NewQuery(`SELECT COALESCE(SUM(status='processing'),0) active,COALESCE(SUM(status='ready' AND is_primary=1),0) ready FROM project_files WHERE project={:project}`).Bind(dbx.Params{"project": id}).One(&pdf)
	stage.Metrics = []workflowMetric{workflowMetricValue("published_entries", "已入册条目", pages.Total, "条"), workflowMetricValue("ready_primary_pdf", "当前原文 PDF 已就绪", pdf.Ready, "份"), workflowMetricValue("processing_pdf", "PDF 正在检查", pdf.Active, "份"), workflowMetricValue("active_imports", "正在检查或导入", counts.Active, "批"), workflowMetricValue("awaiting_confirmation", "等待确认导入", counts.Confirm, "批"), workflowMetricValue("rework_entries", "退回材料返工", pages.Rework, "条"), workflowMetricValue("failed_imports", "历史失败记录", counts.Failed, "批")}
	if err != nil || pdfErr != nil || pageErr != nil {
		stage.unknown()
		return stage
	}
	switch {
	case pages.Rework > 0:
		stage.set("needs_action", "有材料需返工", fmt.Sprintf("%d 条已退回材料环节，请核对原文并处理。", pages.Rework))
		stage.Blockers = append(stage.Blockers, workflowBlocker{"material_rework", "这些条目需要先处理材料问题。"})
		stage.Actions = append([]workflowAction{workflowTarget(id, "rework", "查看返工条目", "", map[string]string{"section": "work", "view": "entries", "status": "rework"})}, stage.Actions...)
	case counts.Confirm > 0:
		stage.set("needs_action", "有导入等待确认", fmt.Sprintf("%d 个 CSV 已检查，仍等待管理员确认。", counts.Confirm))
		stage.Actions[0].Label = "查看待确认批次"
	case counts.Active > 0 || pdf.Active > 0:
		stage.set("in_progress", "正在处理材料", fmt.Sprintf("%d 个批次仍在检查或导入，%d 份 PDF 正在检查。", counts.Active, pdf.Active))
	case pages.Total > 0:
		stage.set("recorded", "已有材料入册", fmt.Sprintf("%d 条已入册，可查看原文对应情况。", pages.Total))
	case pdf.Ready > 0:
		stage.set("needs_action", "原文已就绪，待导入条目", "当前原文 PDF 已就绪，但还没有已发布条目。请选择条目导入方式。")
		stage.Actions = append([]workflowAction{workflowTarget(id, "import_entries", "导入条目", "", map[string]string{"section": "materials", "view": "import", "method": "csv"})}, stage.Actions...)
	case counts.Failed > 0:
		stage.set("needs_action", "尚未入册，请查看错误", "已有失败记录，但当前没有已发布条目。请查看错误后整理材料。")
	default:
		stage.set("not_started", "先准备材料", "当前没有已发布条目，先准备原文并导入材料。")
		stage.Actions[0], stage.Actions[1] = stage.Actions[1], stage.Actions[0]
	}
	return stage
}
func workflowProofreading(id string, required int, p workflowPages, err error) workflowStage {
	stage := newWorkflowStage("proofreading", "独立校对", "校对者；管理员安排成员与规则", "独立提交按当前轮不同校对者的实际提交计算；流程完成状态不替代提交人数证据，也不代表来源或用途通过。")
	stage.Actions = []workflowAction{workflowWorkspace(id, "entries", "查看校对条目", "work", "entries"), workflowTarget(id, "members", "安排成员", "/settings", map[string]string{"view": "members"}), workflowTarget(id, "rules", "设置校对规则", "/settings", map[string]string{"view": "rules"})}
	stage.Metrics = []workflowMetric{workflowMetricValue("eligible_entries", "非空记录条目", p.Eligible, "条"), workflowMetricValue("submitted_entries", "当前轮已有提交", p.Submitted, "条"), workflowMetricValue("independent_entries", fmt.Sprintf("已达 %d 人独立提交", required), p.Independent, "条"), workflowMetricValue("awaiting_entries", "等待校对提交", p.Awaiting, "条"), workflowMetricValue("approved_entries", "校对流程完成", p.Approved, "条")}
	if err != nil {
		stage.unknown()
		return stage
	}
	switch {
	case p.Total == 0:
		stage.set("not_started", "等待材料入册", "条目入册后，由校对者独立提交。")
	case p.Awaiting > 0:
		stage.set("in_progress", "继续独立校对", fmt.Sprintf("%d 条仍处于等待提交或校对中的状态；每条要求至少 %d 名校对者独立提交。", p.Awaiting, required))
	default:
		stage.set("recorded", "已有校对状态记录", "当前没有处于待提交状态的条目，请继续查看仲裁与来源核验。")
	}
	return stage
}
func (s *projectQueryService) workflowVerification(id string, p workflowPages, pageErr error, todo func(string) (managerTodo, error)) workflowStage {
	stage := newWorkflowStage("verification", "仲裁与来源核验", "项目管理员", "仲裁、来源核验与成员问题可能重叠，数量不能相加。暂无待办不表示所有字段已判正确，来源完整判断和未记录情况请在核验页查看。")
	arbitration, e1 := todo("arbitration")
	review, e2 := todo("source_review")
	problems, e3 := todo("source_problems")
	stage.Metrics = []workflowMetric{{"arbitration", "等待仲裁", arbitration.Count, "条"}, {"source_review", "当前可核验", review.Count, "条"}, {"source_problems", "未解决成员问题", problems.Count, "项"}}
	stage.Actions = []workflowAction{workflowTodoAction("review", "查看来源核验", review), workflowTodoAction("problems", "查看成员问题", problems), workflowTodoAction("arbitration", "查看仲裁", arbitration)}
	if e1 != nil || e2 != nil || e3 != nil || pageErr != nil {
		stage.unknown()
		return stage
	}
	if *arbitration.Count > 0 {
		stage.Actions = []workflowAction{workflowTodoAction("arbitration", "处理待仲裁条目", arbitration), stage.Actions[0], stage.Actions[1]}
	}
	if *arbitration.Count+*review.Count+*problems.Count > 0 {
		stage.set("needs_action", "有事项需要判断", fmt.Sprintf("%d 条待仲裁，%d 条当前可核验，%d 项成员问题未解决。", *arbitration.Count, *review.Count, *problems.Count))
		if *arbitration.Count > 0 {
			stage.Blockers = append(stage.Blockers, workflowBlocker{"arbitration_pending", "独立结果有分歧，需要管理员逐字段判断。"})
		}
		if *review.Count > 0 {
			stage.Blockers = append(stage.Blockers, workflowBlocker{"source_review_pending", "存在可进入核验的条目，请核对来源与采用依据。"})
		}
		if *problems.Count > 0 {
			stage.Blockers = append(stage.Blockers, workflowBlocker{"member_problems", "存在尚未解决的成员报告。"})
			if *arbitration.Count == 0 && *review.Count == 0 {
				stage.Actions[0], stage.Actions[1] = stage.Actions[1], stage.Actions[0]
			}
		}
	} else if p.Total == 0 {
		stage.set("not_started", "等待条目与提交", "材料入册并有校对提交后，可进入仲裁或来源核验。")
	} else if p.Awaiting > 0 || p.Rework > 0 {
		stage.set("in_progress", "等待校对或材料处理", "当前没有可进入的核验待办；部分条目仍等待校对或材料返工。")
		stage.Actions[0] = workflowTarget(id, "waiting_review", "查看等待校对条目", "/verification", map[string]string{"view": "review", "reviewScope": "waiting"})
	} else {
		stage.set("recorded", "当前暂无核验待办", "未发现当前待仲裁、可核验待办或未解决成员问题；这不等于来源全部正确。")
	}
	return stage
}
func (s *projectQueryService) workflowAdoption(app recordReader, id string, todo func(string) (managerTodo, error)) workflowStage {
	stage := newWorkflowStage("adoption", "用途编选", "项目管理员", "编选按用途与接收方分别确认；已确认数量属于确认时的范围，不表示目前仍可交付。重评与交付检查会核对变化。")
	stage.Actions = []workflowAction{workflowTarget(id, "adoption", "查看编选批次", "/adoption", nil)}
	var counts struct {
		Draft     int `db:"draft"`
		Previewed int `db:"previewed"`
		Confirmed int `db:"confirmed"`
	}
	err := app.DB().NewQuery(`SELECT COALESCE(SUM(status='draft'),0) draft,COALESCE(SUM(status='previewed'),0) previewed,COALESCE(SUM(status='confirmed'),0) confirmed FROM adoption_batches WHERE project={:project}`).Bind(dbx.Params{"project": id}).One(&counts)
	pending, todoErr := todo("adoption")
	stage.Metrics = []workflowMetric{workflowMetricValue("draft_batches", "待检查草稿", counts.Draft, "批"), workflowMetricValue("previewed_batches", "已检查待确认", counts.Previewed, "批"), workflowMetricValue("confirmed_batches", "已有确认记录", counts.Confirmed, "批"), {"pending_batches", "当前有待定例外", pending.Count, "批"}}
	if err != nil || todoErr != nil {
		stage.unknown()
		return stage
	}
	switch {
	case *pending.Count > 0:
		stage.set("needs_action", "编选例外待处理", pending.Note)
		stage.Actions = append([]workflowAction{workflowTodoAction("exceptions", "处理编选例外", pending)}, stage.Actions...)
		stage.Blockers = []workflowBlocker{{"adoption_pending", "部分编选范围仍有待定例外，需要管理员判断。"}}
	case counts.Draft+counts.Previewed > 0:
		stage.set("needs_action", "编选范围待检查或确认", fmt.Sprintf("%d 个草稿待检查，%d 个批次已检查待确认。", counts.Draft, counts.Previewed))
	case counts.Confirmed > 0:
		stage.set("recorded", "已有编选确认记录", fmt.Sprintf("%d 个批次保存了确认记录。交付前仍须检查当前范围和用途。", counts.Confirmed))
	default:
		stage.set("not_started", "尚未建立编选批次", "按用途与接收方新建编选批次，检查范围后由管理员确认。")
	}
	return stage
}

type workflowDeliveries struct {
	Total, Awaiting, Pending, Notices, Withdrawn, Successful, Returned, OtherReceipt int
	FirstPending, FirstAwaiting                                                      string
	BundleImports                                                                    int
}

func readWorkflowDeliveries(app recordReader, id string) (workflowDeliveries, error) {
	var facts workflowDeliveries
	rows, err := app.FindRecordsByFilter("release_deliveries", "project={:project}", "created,id", 0, 0, dbx.Params{"project": id})
	if err != nil {
		return facts, err
	}
	facts.Total = len(rows)
	byDelivery, err := deliveryEventIndex(app, rows)
	if err != nil {
		return facts, err
	}
	for _, record := range rows {
		events := byDelivery[record.Id]
		view := deliveryView(record, events)
		pending := len(deliveryPendingActions(events)) > 0
		notice := view["notice_state"] == "pending_consumer_notice"
		if pending {
			facts.Pending++
		}
		if notice {
			facts.Notices++
		}
		if (pending || notice) && facts.FirstPending == "" {
			facts.FirstPending = record.Id
		}
		if view["withdrawn"] == true {
			facts.Withdrawn++
		}
		if view["awaiting_receipt"] == true {
			facts.Awaiting++
			if facts.FirstAwaiting == "" {
				facts.FirstAwaiting = record.Id
			}
		}
		if view["workflow_state"] == "returned_resolved" {
			facts.Returned++
		}
		// A historical success receipt is not a currently successful package once
		// returned/withdrawn. A resolution never manufactures acceptance.
		if view["workflow_state"] == "receipt_recorded" {
			if view["receipt_state"] == "success" {
				facts.Successful++
			} else {
				facts.OtherReceipt++
			}
		}
	}
	bundles, err := app.CountRecords("import_jobs", dbx.NewExp("project={:project} AND mode='bundle' AND status IN ('completed','completed_with_errors')", dbx.Params{"project": id}))
	facts.BundleImports = int(bundles)
	return facts, err
}
func workflowDeliveryStages(id string, f workflowDeliveries, err error) (workflowStage, workflowStage) {
	delivery := newWorkflowStage("delivery", "交付", "项目管理员", "已生成包不等于已发送、已接收或验收；包数量包含历史版本。正式出包仍须检查范围、来源与用途并由人确认。")
	receipt := newWorkflowStage("receipt", "接收回执", "接收方反馈；项目管理员登记与处置", "只依据明确登记的接收事件；下载不算接收，已处理退回不算接收成功。待处置与交付环节指同一批包，不能相加。")
	delivery.Actions = []workflowAction{workflowTarget(id, "deliveries", "查看交付记录", "/deliveries", nil), workflowTarget(id, "prepare_delivery", "准备交付并检查范围", "/deliveries", map[string]string{"view": "prepare"})}
	receipt.Actions = []workflowAction{workflowTarget(id, "receipts", "查看交付与回执", "/deliveries", nil)}
	delivery.Metrics = []workflowMetric{workflowMetricValue("packages", "已生成包（含历史）", f.Total, "包"), workflowMetricValue("withdrawn", "已撤回", f.Withdrawn, "包"), workflowMetricValue("pending_actions", "有退回或冲突待处置", f.Pending, "包"), workflowMetricValue("pending_notices", "撤回待通知", f.Notices, "包")}
	receipt.Metrics = []workflowMetric{workflowMetricValue("awaiting_receipt", "等待接收回执", f.Awaiting, "包"), workflowMetricValue("successful_receipt", "当前有成功回执", f.Successful, "包"), workflowMetricValue("returned_resolved", "退回已处置", f.Returned, "包"), workflowMetricValue("other_receipt", "其他已登记回执", f.OtherReceipt, "包"), workflowMetricValue("pending_actions", "有退回或冲突待处置", f.Pending, "包"), workflowMetricValue("pending_notices", "撤回待通知", f.Notices, "包")}
	if err != nil {
		delivery.unknown()
		receipt.unknown()
		return delivery, receipt
	}
	if f.FirstPending != "" {
		action := workflowTarget(id, "resolve_delivery", "处理退回、冲突或通知", "/deliveries", map[string]string{"package": f.FirstPending, "tab": "events"})
		delivery.Actions = append([]workflowAction{action}, delivery.Actions...)
		delivery.set("needs_action", "有交付事项待处置", fmt.Sprintf("%d 个包有退回或冲突待处置，%d 个已撤回包待通知。", f.Pending, f.Notices))
		delivery.Blockers = []workflowBlocker{{"delivery_followup", "请逐包登记处置或通知结果，处理后再核对后续交付。"}}
	} else if f.Total > 0 {
		delivery.set("recorded", "已有交付包记录", fmt.Sprintf("已生成 %d 个交付包（含历史版本）；发送与接收请分别核实。", f.Total))
	} else {
		delivery.set("not_started", "尚未生成交付包", "先确认编选范围，再进入交付检查。")
		delivery.Actions[0], delivery.Actions[1] = delivery.Actions[1], delivery.Actions[0]
	}
	if f.Total == 0 && f.BundleImports == 0 {
		delivery.Note += " 当前直接出包支持完整资料包导入批次；CSV 或文字提取材料可先导出工作文件。"
		delivery.Actions = append([]workflowAction{workflowWorkspace(id, "working_export", "查看工作文件导出", "delivery", "exports")}, delivery.Actions...)
	}
	switch {
	case f.FirstPending != "":
		receipt.set("needs_action", "有回执事项待处置", fmt.Sprintf("%d 个包有退回或冲突待处置，%d 个撤回包待通知；另有 %d 个包等待回执。", f.Pending, f.Notices, f.Awaiting))
		receipt.Actions = append([]workflowAction{workflowTarget(id, "resolve_receipt", "处理回执或通知事项", "/deliveries", map[string]string{"package": f.FirstPending, "tab": "events"})}, receipt.Actions...)
		receipt.Blockers = []workflowBlocker{{"receipt_followup", "这些包尚有处置或通知事项，不能视为接收成功。"}}
	case f.Awaiting > 0:
		receipt.set("in_progress", "等待接收方回执", fmt.Sprintf("%d 个包尚无回执且未退回或撤回，请联系接收方并登记结果。", f.Awaiting))
		receipt.Actions = append([]workflowAction{workflowTarget(id, "record_receipt", "查看待回执交付包", "/deliveries", map[string]string{"package": f.FirstAwaiting, "tab": "events"})}, receipt.Actions...)
	case f.Total == 0:
		receipt.set("not_started", "等待交付包", "交付包生成并发给接收方后，登记实际接收结果。")
	default:
		receipt.set("recorded", "已有交付事件记录", fmt.Sprintf("%d 个包当前有成功回执，%d 个包的退回已处置；其余情况请查看交付记录。", f.Successful, f.Returned))
	}
	return delivery, receipt
}
