package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// #315 D5.3 与 D9：权利变更的影响面、可追加的重评，以及让 D 段可被系统回答的数。
//
// D5.3 要的不是「把批次改一遍」，而是「列出受影响的既有批次、以追加方式重评、历史不改」。
// 所以这里只写 adoption_events（见 1792972800 迁移），批次上确认过的四个数一个字都不动：
// 确认过的范围是交付依据，后来的权利结论只能追加说明，不能回写成「当时就是这样」。
//
// D9 的数从两处来：批次上确认时的四个数与理由分布（D4.2 的诚实口径），以及事件表里的
// 重评记录。凡是「现在的数据与确认时不同」的判断都只读不写，界面上叫「需重评」而不是
// 「已修正」。

const (
	adoptionEventRightsChanged = "rights_changed"
	adoptionEventReevaluated   = "reevaluated"

	adoptionEventNoteMax = 500
)

func (s *importService) registerAdoptionEvents() {
	// 权利结论落在 source_usages 上（#92 的六类 gate）。新建与更新都要看：新建一行
	// 等于「这个用途从此有了结论」，更新一行可能把 allow 改成 deny 或反过来。
	persistRights := func(e *core.RecordEvent, previous string) error {
		return e.App.RunInTransaction(func(tx core.App) error {
			original := e.App
			e.App = tx
			defer func() { e.App = original }()
			// Validation/persistence may fail. Audit events must commit only with the
			// actual rights change, and a failed audit must roll the rights write back.
			if err := e.Next(); err != nil {
				return err
			}
			return s.recordRightsImpact(e, previous)
		})
	}
	s.app.OnRecordCreate("source_usages").BindFunc(func(e *core.RecordEvent) error {
		return persistRights(e, "")
	})
	s.app.OnRecordUpdate("source_usages").BindFunc(func(e *core.RecordEvent) error {
		previous := e.Record.Original().GetString("decision")
		if previous == e.Record.GetString("decision") {
			return e.Next()
		}
		return persistRights(e, previous)
	})

	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/adoption-batches/{batchId}/events", s.listAdoptionEvents).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/adoption-batches/{batchId}/reevaluate", s.reevaluateAdoptionBatch).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/adoption-summary", s.adoptionSummary).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
}

// recordRightsImpact 在权利结论变化时，给受影响的**已确认**批次各追加一条事件。
//
// 只算已确认的：草稿与已预览批次的数字本来就会在下次预览时重算，而且改动例外会把它
// 退回草稿；真正需要「告诉 E 哪一批作废了」的是已经交出去的那一批。
func (s *importService) recordRightsImpact(e *core.RecordEvent, previous string) error {
	sourceID := e.Record.GetString("source")
	purpose := e.Record.GetString("purpose")
	if sourceID == "" || purpose == "" {
		return nil
	}
	next := e.Record.GetString("decision")
	note := truncateRunes(adoptionRightsNote(purpose, previous, next), adoptionEventNoteMax)

	type affectedRow struct {
		BatchID  string `db:"batch_id"`
		Affected int    `db:"affected"`
	}
	rows := []affectedRow{}
	// 来源按页面自己的 import_job 取，退回到项目级 source——与编选计算同一条口径，
	// 否则「受影响批次」与「编选实际读的权限」会对不上。
	if err := e.App.DB().NewQuery(`
SELECT b.id AS batch_id, COUNT(p.id) AS affected
FROM adoption_batches b
JOIN pages p ON p.project = b.project
LEFT JOIN import_jobs ij ON ij.id = p.import_job
LEFT JOIN projects pr ON pr.id = p.project
WHERE b.purpose = {:purpose}
  AND b.status = 'confirmed'
  AND COALESCE(NULLIF(ij.source, ''), pr.source) = {:source}
GROUP BY b.id
ORDER BY b.id`).
		Bind(dbx.Params{"purpose": purpose, "source": sourceID}).
		All(&rows); err != nil {
		return fmt.Errorf("查找受影响批次失败: %w", err)
	}
	for _, row := range rows {
		if err := s.appendAdoptionEvent(e.App, adoptionEventRecord{
			BatchID:  row.BatchID,
			ActorID:  e.Record.GetString("decided_by"),
			Kind:     adoptionEventRightsChanged,
			SourceID: sourceID,
			Note:     note,
			Affected: row.Affected,
		}); err != nil {
			return err
		}
	}
	return nil
}

// adoptionRightsNote 是权利变更事件的说明，两边标签都要是中文：事件是给
// 维护者读的，「allow → deny」在审计里等于没说。
func adoptionRightsNote(purpose, previous, next string) string {
	return fmt.Sprintf("用途 %s 的权利结论由「%s」改为「%s」",
		purpose, adoptionDecisionLabel(previous), adoptionDecisionLabel(next))
}

func adoptionDecisionLabel(decision string) string {
	switch strings.TrimSpace(decision) {
	case "allow":
		return "允许"
	case "deny":
		return "禁止"
	case "unknown":
		return "未知"
	default:
		if strings.TrimSpace(decision) == "" {
			return "未登记"
		}
		return decision
	}
}

type adoptionCounts struct {
	Total    int
	Selected int
	Excluded int
	Pending  int
}

func adoptionCountsFromRecord(record *core.Record) adoptionCounts {
	return adoptionCounts{
		Total:    record.GetInt("total_count"),
		Selected: record.GetInt("selected_count"),
		Excluded: record.GetInt("excluded_count"),
		Pending:  record.GetInt("pending_count"),
	}
}

func adoptionCountsFromComputation(computation adoptionComputation) adoptionCounts {
	return adoptionCounts{
		Total:    computation.Total,
		Selected: computation.Selected,
		Excluded: computation.Excluded,
		Pending:  computation.Pending,
	}
}

type adoptionEventRecord struct {
	ID       string
	BatchID  string
	Kind     string
	SourceID string
	ActorID  string
	Note     string
	Affected int
	Stored   *adoptionCounts
	Current  *adoptionCounts
}

func (s *importService) appendAdoptionEvent(app core.App, event adoptionEventRecord) error {
	collection, err := app.FindCollectionByNameOrId("adoption_events")
	if err != nil {
		return fmt.Errorf("编选事件存储尚未初始化: %w", err)
	}
	record := core.NewRecord(collection)
	record.Set("batch", event.BatchID)
	record.Set("kind", event.Kind)
	record.Set("source", event.SourceID)
	record.Set("actor", event.ActorID)
	record.Set("note", event.Note)
	record.Set("affected_count", event.Affected)
	if event.Stored != nil {
		record.Set("stored_total", event.Stored.Total)
		record.Set("stored_selected", event.Stored.Selected)
		record.Set("stored_excluded", event.Stored.Excluded)
		record.Set("stored_pending", event.Stored.Pending)
	}
	if event.Current != nil {
		record.Set("current_total", event.Current.Total)
		record.Set("current_selected", event.Current.Selected)
		record.Set("current_excluded", event.Current.Excluded)
		record.Set("current_pending", event.Current.Pending)
	}
	if err := app.Save(record); err != nil {
		return fmt.Errorf("记录编选事件失败: %w", err)
	}
	return nil
}

func adoptionEventView(record *core.Record) map[string]any {
	view := map[string]any{
		"id":       record.Id,
		"batch":    record.GetString("batch"),
		"kind":     record.GetString("kind"),
		"source":   record.GetString("source"),
		"actor":    record.GetString("actor"),
		"note":     record.GetString("note"),
		"affected": record.GetInt("affected_count"),
		"created":  record.GetString("created"),
	}
	if record.GetString("kind") == adoptionEventReevaluated {
		view["stored"] = map[string]any{
			"total":    record.GetInt("stored_total"),
			"selected": record.GetInt("stored_selected"),
			"excluded": record.GetInt("stored_excluded"),
			"pending":  record.GetInt("stored_pending"),
		}
		view["current"] = map[string]any{
			"total":    record.GetInt("current_total"),
			"selected": record.GetInt("current_selected"),
			"excluded": record.GetInt("current_excluded"),
			"pending":  record.GetInt("current_pending"),
		}
	}
	return view
}

func (s *importService) adoptionEvents(batchID string) ([]*core.Record, error) {
	return s.app.FindRecordsByFilter(
		"adoption_events", "batch = {:batch}", "-created", 200, 0,
		dbx.Params{"batch": batchID},
	)
}

func (s *importService) listAdoptionEvents(c *core.RequestEvent) error {
	record, _, _, err := s.loadAdoptionBatch(c)
	if err != nil {
		return err
	}
	page := pageArgument(c.Request.URL.Query().Get("page"), 1, 1000000)
	perPage := pageArgument(c.Request.URL.Query().Get("perPage"), 25, 100)
	total, err := s.app.CountRecords("adoption_events", dbx.HashExp{"batch": record.Id})
	if err != nil {
		return err
	}
	totalPages := max(1, (int(total)+perPage-1)/perPage)
	page = min(page, totalPages)
	records, err := s.app.FindRecordsByFilter("adoption_events", "batch = {:batch}", "-created,-id", perPage, (page-1)*perPage, dbx.Params{"batch": record.Id})
	if err != nil {
		return err
	}
	events := make([]map[string]any, 0, len(records))
	for _, item := range records {
		events = append(events, adoptionEventView(item))
	}
	stale, err := s.app.CountRecords("adoption_events", dbx.And(dbx.HashExp{"batch": record.Id, "kind": adoptionEventRightsChanged}, dbx.NewExp("created > {:confirmed}", dbx.Params{"confirmed": record.GetString("confirmed_at")})))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"events": events, "stale": stale > 0 && record.GetString("status") == adoptionBatchConfirmed, "page": page, "perPage": perPage, "totalItems": total, "totalPages": totalPages})
}

// reevaluateAdoptionBatch 按当前数据重算一次，把「确认时」与「现在」两组数写进一条
// 追加事件，并**不修改批次**。D5.3 的红线是不改写历史；要不要因此撤回这一批由人决定。
func (s *importService) reevaluateAdoptionBatch(c *core.RequestEvent) error {
	var result any
	err := s.app.RunInTransaction(func(app core.App) error {
		var err error
		result, err = s.reevaluateAdoptionBatchInApp(app, c)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, result)
}
func (s *importService) reevaluateAdoptionBatchInApp(app core.App, c *core.RequestEvent) (any, error) {
	record, auth, project, err := s.loadAdoptionBatchInApp(app, c)
	if err != nil {
		return nil, err
	}
	rule, err := parseAdoptionRule(json.RawMessage(record.GetString("rule_json")))
	if err != nil {
		return nil, apis.NewBadRequestError(err.Error(), nil)
	}
	computation, err := computeAdoption(app, project.Id, record.GetString("purpose"), record.Id, rule)
	if err != nil {
		return nil, apis.NewBadRequestError("重算编选范围失败。", err)
	}
	stored := adoptionCountsFromRecord(record)
	current := adoptionCountsFromComputation(computation)
	note := fmt.Sprintf("重评：确认时 %d/%d，现在 %d/%d（进入本批/总数）",
		stored.Selected, stored.Total, current.Selected, current.Total)
	if drifted := adoptionCountsDrifted(record, computation); drifted != "" {
		note = fmt.Sprintf("%s；差异项：%s", note, drifted)
	}
	if err := s.appendAdoptionEvent(app, adoptionEventRecord{
		BatchID: record.Id,
		Kind:    adoptionEventReevaluated,
		ActorID: auth.Id,
		Note:    truncateRunes(note, adoptionEventNoteMax),
		Stored:  &stored,
		Current: &current,
	}); err != nil {
		return nil, apis.NewBadRequestError("记录重评失败。", err)
	}
	return map[string]any{
		"stored":  adoptionCountsView(stored),
		"current": adoptionCountsView(current),
		"drift":   adoptionCountsDrifted(record, computation),
	}, nil
}

func adoptionCountsView(counts adoptionCounts) map[string]any {
	return map[string]any{
		"total":    counts.Total,
		"selected": counts.Selected,
		"excluded": counts.Excluded,
		"pending":  counts.Pending,
	}
}

// adoptionSummary 是 D9.1 要求的「D 段能被系统回答的数」。
//
// 口径：批次与四个数取**确认时**的值（那是交付依据），理由分布是各批 reasons_json 的
// 合并，事件只说「之后发生过什么」。把重算后的数混进汇总会重复计算历史——重算只写事件。
func (s *importService) adoptionSummary(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := s.requireAdoptionManager(c, projectID); err != nil {
		return err
	}
	params := dbx.Params{"project": projectID}

	type keyCount struct {
		Key   string `db:"key"`
		Count int    `db:"count"`
	}
	statuses := []keyCount{}
	if err := s.app.DB().NewQuery(
		`SELECT status AS key, COUNT(*) AS count FROM adoption_batches WHERE project = {:project} GROUP BY 1 ORDER BY 1`,
	).Bind(params).All(&statuses); err != nil {
		return apis.NewBadRequestError("读取批次汇总失败。", err)
	}
	byStatus := map[string]int{}
	totalBatches := 0
	for _, row := range statuses {
		byStatus[row.Key] = row.Count
		totalBatches += row.Count
	}

	type confirmedRow struct {
		Batches  int `db:"batches"`
		Total    int `db:"total_count"`
		Selected int `db:"selected_count"`
		Excluded int `db:"excluded_count"`
		Pending  int `db:"pending_count"`
	}
	confirmed := confirmedRow{}
	if err := s.app.DB().NewQuery(
		`SELECT COUNT(*) AS batches,
		        COALESCE(SUM(total_count), 0) AS total_count,
		        COALESCE(SUM(selected_count), 0) AS selected_count,
		        COALESCE(SUM(excluded_count), 0) AS excluded_count,
		        COALESCE(SUM(pending_count), 0) AS pending_count
		 FROM adoption_batches WHERE project = {:project} AND status = 'confirmed'`,
	).Bind(params).One(&confirmed); err != nil {
		return apis.NewBadRequestError("读取已确认批次汇总失败。", err)
	}

	reasons := []adoptionReasonCount{}
	// Aggregate every confirmed batch. The former newest-200 record fetch silently
	// omitted older reasons (and drafts could displace confirmed batches entirely).
	if err := s.app.DB().NewQuery(`
  SELECT json_extract(r.value, '$.code') AS code,
         SUM(json_extract(r.value, '$.count')) AS count
  FROM adoption_batches b,
       json_each(CASE WHEN json_valid(b.reasons_json) THEN
         CASE WHEN json_type(b.reasons_json) = 'array' THEN b.reasons_json ELSE '[]' END ELSE '[]' END) r
  WHERE b.project = {:project} AND b.status = 'confirmed' AND r.type = 'object'
    AND json_type(r.value, '$.code') = 'text' AND json_extract(r.value, '$.code') != ''
    AND json_type(r.value, '$.count') = 'integer'
  GROUP BY 1
 `).Bind(params).All(&reasons); err != nil {
		return apis.NewBadRequestError("读取编选理由汇总失败。", err)
	}

	sort.Slice(reasons, func(i, j int) bool {
		if reasons[i].Count != reasons[j].Count {
			return reasons[i].Count > reasons[j].Count
		}
		return reasons[i].Code < reasons[j].Code
	})

	type scalars struct {
		Exceptions int `db:"exceptions"`
	}
	exceptionRow := scalars{}
	if err := s.app.DB().NewQuery(
		`SELECT COUNT(*) AS exceptions FROM adoption_exceptions e
		 JOIN adoption_batches b ON b.id = e.batch WHERE b.project = {:project}`,
	).Bind(params).One(&exceptionRow); err != nil {
		return apis.NewBadRequestError("读取例外汇总失败。", err)
	}

	type eventRow struct {
		Total         int `db:"total"`
		RightsChanged int `db:"rights_changed"`
		Reevaluated   int `db:"reevaluated"`
		StaleBatches  int `db:"stale_batches"`
	}
	events := eventRow{}
	if err := s.app.DB().NewQuery(
		`SELECT COUNT(*) AS total,
		        COALESCE(SUM(CASE WHEN ev.kind = 'rights_changed' THEN 1 ELSE 0 END), 0) AS rights_changed,
		        COALESCE(SUM(CASE WHEN ev.kind = 'reevaluated' THEN 1 ELSE 0 END), 0) AS reevaluated,
		        (SELECT COUNT(*) FROM adoption_batches b
		          WHERE b.project = {:project} AND b.status = 'confirmed'
		            AND EXISTS (SELECT 1 FROM adoption_events e2
		                         WHERE e2.batch = b.id AND e2.kind = 'rights_changed'
		                           AND e2.created > b.confirmed_at)) AS stale_batches
		 FROM adoption_events ev
		 JOIN adoption_batches b ON b.id = ev.batch
		 WHERE b.project = {:project}`,
	).Bind(params).One(&events); err != nil {
		return apis.NewBadRequestError("读取编选事件汇总失败。", err)
	}

	return c.JSON(http.StatusOK, map[string]any{
		"batches": map[string]any{
			"total":    totalBatches,
			"byStatus": byStatus,
		},
		"confirmed": map[string]any{
			"batches":  confirmed.Batches,
			"total":    confirmed.Total,
			"selected": confirmed.Selected,
			"excluded": confirmed.Excluded,
			"pending":  confirmed.Pending,
			"complete": confirmed.Pending == 0,
		},
		"reasons": reasons,
		"exceptions": map[string]any{
			"decided": exceptionRow.Exceptions,
		},
		"events": map[string]any{
			"total":         events.Total,
			"rightsChanged": events.RightsChanged,
			"reevaluated":   events.Reevaluated,
			"staleBatches":  events.StaleBatches,
		},
	})
}

// adoptionReasonsFromJSON 解析批次上的理由分布。解析失败按空处理并留下可见的差异：
// 汇总里少了这一批的理由，正是「数据被绕过接口改过」的证据。
func adoptionReasonsFromJSON(raw string) map[string]int {
	out := map[string]int{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	var rows []adoptionReasonCount
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		return out
	}
	for _, row := range rows {
		if row.Code == "" {
			continue
		}
		out[row.Code] += row.Count
	}
	return out
}
