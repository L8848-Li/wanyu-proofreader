package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

var managerTodoStages = []string{"arbitration", "source_problems", "source_review", "normalization", "adoption", "delivery_receipt", "delivery_return"}

type todoProject struct {
	ID   string `db:"id" json:"id"`
	Name string `db:"name" json:"name"`
}
type todoTarget struct {
	Path  string            `json:"path"`
	Query map[string]string `json:"query"`
}
type managerTodo struct {
	ID             string      `json:"id"`
	Project        todoProject `json:"project"`
	Stage          string      `json:"stage"`
	Count          *int        `json:"count"`
	State          string      `json:"state"`
	OldestAt       *string     `json:"oldest_at"`
	WaitingSeconds *int64      `json:"waiting_seconds"`
	WaitingNote    string      `json:"waiting_note"`
	Role           string      `json:"role"`
	Target         todoTarget  `json:"target"`
	TargetLabel    string      `json:"target_label"`
	Note           string      `json:"note"`
}

func newManagerTodo(project todoProject, stage string) managerTodo {
	zero := 0
	base := "/admin/projects/" + project.ID
	row := managerTodo{ID: project.ID + ":" + stage, Project: project, Stage: stage, Count: &zero, State: "ready", Role: "项目管理员", WaitingNote: "开始时间未记录", Target: todoTarget{Path: base, Query: map[string]string{}}}
	switch stage {
	case "arbitration":
		row.Target.Query = map[string]string{"section": "work", "view": "entries", "status": "arbitration"}
		row.TargetLabel = "查看待仲裁条目"
		row.Note = "当前等待仲裁的条目。"
	case "source_problems":
		row.Target.Path += "/verification"
		row.Target.Query = map[string]string{"view": "problems"}
		row.TargetLabel = "查看问题"
		row.Note = "有成员报告且尚未解决的问题。"
	case "source_review":
		row.Target.Path += "/verification"
		row.Target.Query = map[string]string{"view": "review"}
		row.TargetLabel = "查看核验队列"
		row.Note = "已有提交、当前可进入来源核验或仲裁的条目；等待首次校对或资料返工的条目可在来源核验页查看。"
	case "normalization":
		row.Target.Query = map[string]string{"section": "work", "view": "normalization", "schemeView": "review"}
		row.TargetLabel = "查看待复核条目"
		row.Note = "机器尚不能确定的拼音整理结果。"
	case "adoption":
		row.Target.Path += "/adoption"
		row.TargetLabel = "处理编选批次"
		row.Note = "尚未确认且当前有待定例外的编选批次。"
	case "delivery_receipt":
		row.Target.Path += "/deliveries"
		row.TargetLabel = "查看交付包"
		row.Note = "尚无接收回执、也未退回或撤回的交付包；下载不算接收。"
	case "delivery_return":
		row.Target.Path += "/deliveries"
		row.TargetLabel = "处理交付包"
		row.Note = "仍有退回、冲突或撤回通知待处理的交付包。"
	}
	return row
}

func todoTime(raw string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999Z"} {
		if at, err := time.Parse(layout, raw); err == nil {
			return at, true
		}
	}
	return time.Time{}, false
}
func (row *managerTodo) setWaiting(raw string, missing bool, now time.Time, note string) {
	if missing {
		return
	}
	at, ok := todoTime(raw)
	if !ok || at.After(now) {
		return
	}
	stamp := at.UTC().Format(time.RFC3339Nano)
	seconds := int64(now.Sub(at).Seconds())
	row.OldestAt = &stamp
	row.WaitingSeconds = &seconds
	row.WaitingNote = note
}

func (s *projectQueryService) registerManagerTodos() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/manager-todos", s.managerTodos).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

func (s *projectQueryService) managerTodos(e *core.RequestEvent) error {
	if e.Auth.GetBool("must_change_password") {
		return apis.NewForbiddenError("请先修改初始密码。", nil)
	}
	query := e.Request.URL.Query()
	stage := query.Get("stage")
	selected := query.Get("project")
	if stage != "" && !containsStr(managerTodoStages, stage) {
		return apis.NewBadRequestError("待办工序无效。", nil)
	}
	if selected != "" && !looksLikeRecordID(selected) {
		return apis.NewBadRequestError("项目标识无效。", nil)
	}
	page, size := pageArgument(query.Get("page"), 1, 1000000), pageArgument(query.Get("perPage"), 20, 100)
	var response map[string]any
	err := withRecordReadSnapshot(e.Request.Context(), s.app, func(app recordReader) error {
		actor, err := app.FindRecordById("users", e.Auth.Id)
		if err != nil || actor.TokenKey() != e.Auth.TokenKey() || actor.GetBool("must_change_password") {
			return apis.NewUnauthorizedError("登录状态已变化，请重新登录。", nil)
		}
		projects := []todoProject{}
		if err = app.DB().NewQuery(`SELECT p.id,p.name FROM projects p WHERE {:admin}=1 OR p.admin={:actor} OR EXISTS(SELECT 1 FROM project_memberships m WHERE m.project=p.id AND m.user={:actor} AND m.role='manager') ORDER BY p.name,p.id`).Bind(dbx.Params{"admin": actor.GetString("role") == "platform_admin", "actor": actor.Id}).All(&projects); err != nil {
			return err
		}
		selectedFound := selected == ""
		for _, project := range projects {
			if project.ID == selected {
				selectedFound = true
			}
		}
		if !selectedFound {
			return apis.NewForbiddenError("你已不能管理所选项目。", nil)
		}
		now := time.Now().UTC()
		items := []managerTodo{}
		sourceReview, sourceErr := newTodoSourceReview(app, s.hooksDir)
		for _, project := range projects {
			if selected != "" && selected != project.ID {
				continue
			}
			for _, kind := range managerTodoStages {
				row := newManagerTodo(project, kind)
				err := s.fillManagerTodo(app, &row, now, sourceReview, sourceErr)
				if err != nil {
					row.State = "unknown"
					row.Count = nil
					row.Note = "这组待办未更新，请重试。"
					row.OldestAt = nil
					row.WaitingSeconds = nil
				}
				if row.Count == nil || *row.Count > 0 {
					items = append(items, row)
				}
			}
		}
		type stageSummary struct {
			Count  *int `json:"count"`
			Groups int  `json:"groups"`
		}
		summary := map[string]*stageSummary{}
		for _, kind := range managerTodoStages {
			zero := 0
			summary[kind] = &stageSummary{Count: &zero}
		}
		for _, row := range items {
			bucket := summary[row.Stage]
			bucket.Groups++
			if row.Count == nil {
				bucket.Count = nil
			} else if bucket.Count != nil {
				*bucket.Count += *row.Count
			}
		}
		groups := len(items)
		filtered := []managerTodo{}
		for _, row := range items {
			if stage == "" || row.Stage == stage {
				filtered = append(filtered, row)
			}
		}
		sort.SliceStable(filtered, func(i, j int) bool {
			a, b := filtered[i], filtered[j]
			if a.State != b.State {
				return a.State == "ready"
			}
			if (a.OldestAt == nil) != (b.OldestAt == nil) {
				return a.OldestAt != nil
			}
			if a.OldestAt != nil && *a.OldestAt != *b.OldestAt {
				return *a.OldestAt < *b.OldestAt
			}
			if a.Project.Name != b.Project.Name {
				return a.Project.Name < b.Project.Name
			}
			return a.ID < b.ID
		})
		total := len(filtered)
		totalPages := max(1, (total+size-1)/size)
		page = min(page, totalPages)
		start := (page - 1) * size
		response = map[string]any{"generated_at": now.Format(time.RFC3339Nano), "items": filtered[start:min(start+size, total)], "page": page, "perPage": size, "totalItems": total, "totalPages": totalPages, "projects": projects, "summary": map[string]any{"groups": groups, "by_stage": summary}}
		return nil
	})
	if err != nil {
		return err
	}
	e.Response.Header().Set("Cache-Control", "private, no-store")
	return e.JSON(http.StatusOK, response)
}

func (s *projectQueryService) fillManagerTodo(app recordReader, row *managerTodo, now time.Time, review func([]*core.Record) (int, error), reviewErr error) error {
	project := row.Project.ID
	params := dbx.Params{"project": project}
	switch row.Stage {
	case "arbitration", "normalization":
		predicate := "status='arbitration'"
		if row.Stage == "normalization" {
			predicate = "normalization_status IN ('AMBIGUOUS','UNSUPPORTED')"
		}
		data := struct {
			Count   int    `db:"count"`
			Oldest  string `db:"oldest"`
			Missing int    `db:"missing"`
		}{}
		if err := app.DB().NewQuery(`SELECT COUNT(*) count,COALESCE(MIN(NULLIF(last_mismatch_at,'')),'') oldest,COALESCE(SUM(CASE WHEN last_mismatch_at='' THEN 1 ELSE 0 END),0) missing FROM pages WHERE project={:project} AND ` + predicate).Bind(params).One(&data); err != nil {
			return err
		}
		*row.Count = data.Count
		if row.Stage == "arbitration" && data.Count > 0 {
			first, err := app.FindFirstRecordByFilter("pages", "project={:project} && status='arbitration'", params)
			if err != nil {
				return err
			}
			row.Target = todoTarget{Path: "/admin/projects/" + project + "/arbitration/" + first.Id, Query: map[string]string{}}
			row.TargetLabel = "处理待仲裁条目"
			row.setWaiting(data.Oldest, data.Missing > 0, now, "自最早一次尚待处理的分歧记录起")
		}
	case "source_problems":
		issues := []*core.Record{}
		err := app.RecordQuery("problem_issues").Select("id", "created", "status").
			AndWhere(dbx.HashExp{"project": project}).
			AndWhere(dbx.NewExp("status!='resolved' AND EXISTS (SELECT 1 FROM problem_reports r WHERE r.issue=problem_issues.id AND r.project=problem_issues.project)")).
			OrderBy("created", "id").All(&issues)
		if err != nil {
			return err
		}
		oldest := ""
		missing := false
		for _, issue := range issues {
			*row.Count++
			if *row.Count == 1 {
				row.Target.Query["issue"] = issue.Id
				oldest = issue.GetString("created")
			}
			if at, ok := todoTime(issue.GetString("created")); !ok || at.After(now) {
				missing = true
			}
			if issue.GetString("status") == "reopened" {
				missing = true
			}
		}
		row.setWaiting(oldest, missing, now, "自问题首次登记起")
	case "source_review":
		if reviewErr != nil {
			return reviewErr
		}
		params["after"] = ""
		for {
			pages, err := app.FindRecordsByFilter("pages", "project={:project} && (status='approved' || status='proofread' || status='arbitration') && id>{:after}", "id", 250, 0, params)
			if err != nil {
				return err
			}
			if len(pages) == 0 {
				break
			}
			count, err := review(pages)
			if err != nil {
				return err
			}
			*row.Count += count
			params["after"] = pages[len(pages)-1].Id
		}
	case "adoption":
		batches, err := app.FindRecordsByFilter("adoption_batches", "project={:project} && (status='draft' || status='previewed')", "created,id", 0, 0, params)
		if err != nil {
			return err
		}
		pending := 0
		for _, batch := range batches {
			rule, err := parseAdoptionRule(json.RawMessage(batch.GetString("rule_json")))
			if err != nil {
				return err
			}
			current, err := computeAdoption(app, project, batch.GetString("purpose"), batch.Id, rule)
			if err != nil {
				return err
			}
			if current.Pending > 0 {
				*row.Count++
				pending += current.Pending
				if *row.Count == 1 {
					row.Target.Query = map[string]string{"batch": batch.Id, "tab": "exceptions"}
				}
			}
		}
		row.Note = fmt.Sprintf("%d 个未确认编选批次中共有 %d 条待定例外；先处理一个批次，再返回待办继续。", *row.Count, pending)
	case "delivery_receipt", "delivery_return":
		return fillDeliveryTodos(app, row, now)
	}
	return nil
}

func fillDeliveryTodos(app recordReader, row *managerTodo, now time.Time) error {
	records, err := app.FindRecordsByFilter("release_deliveries", "project={:project}", "created,id", 0, 0, dbx.Params{"project": row.Project.ID})
	if err != nil {
		return err
	}
	oldest := ""
	missing := false
	actionCount := 0
	byDelivery, err := deliveryEventIndex(app, records)
	if err != nil {
		return err
	}
	for _, record := range records {
		events := byDelivery[record.Id]
		state := todoDeliveryState(record, events)
		include := state.Awaiting
		if row.Stage == "delivery_return" {
			include = state.PendingActions > 0 || state.NeedsNotice
		}
		if !include {
			continue
		}
		*row.Count++
		actionCount += state.PendingActions
		if state.NeedsNotice {
			actionCount++
		}
		started := record.GetString("created")
		if row.Stage == "delivery_return" {
			started = state.ActionAt
		}
		if at, ok := todoTime(started); !ok || at.After(now) {
			missing = true
		} else if oldest == "" || started < oldest {
			oldest = started
			row.Target.Query = map[string]string{"package": record.Id, "tab": "events"}
		}
		if len(row.Target.Query) == 0 {
			row.Target.Query = map[string]string{"package": record.Id, "tab": "events"}
		}
	}
	row.setWaiting(oldest, missing, now, "自最早一笔待办记录起")
	if row.Stage == "delivery_return" {
		row.Note = fmt.Sprintf("%d 个交付包有 %d 项未处理的退回、冲突或撤回通知；已追加处置记录的不再计入。", *row.Count, actionCount)
	}
	return nil
}

type todoDelivery struct {
	Awaiting       bool
	PendingActions int
	NeedsNotice    bool
	ActionAt       string
}

func todoDeliveryState(record *core.Record, events []*core.Record) todoDelivery {
	view := deliveryView(record, events)
	pending := deliveryPendingActions(events)
	ids := map[string]bool{}
	for _, id := range pending {
		ids[id] = true
	}
	result := todoDelivery{Awaiting: view["awaiting_receipt"] == true, PendingActions: len(pending), NeedsNotice: view["notice_state"] == "pending_consumer_notice"}
	withdrawal := ""
	for _, event := range events {
		kind := event.GetString("kind")
		if kind == "withdrawal" {
			withdrawal = event.GetString("created")
		}
		if ids[event.Id] && (result.ActionAt == "" || event.GetString("created") < result.ActionAt) {
			result.ActionAt = event.GetString("created")
		}
	}
	if result.NeedsNotice && (result.ActionAt == "" || withdrawal < result.ActionAt) {
		result.ActionAt = withdrawal
	}
	return result
}
