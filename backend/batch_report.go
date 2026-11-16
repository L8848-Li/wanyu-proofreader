package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const batchReportSchema = "WanyuBatchReport/v1"

type batchMetric struct {
	Value       *int64 `json:"value"`
	Denominator *int64 `json:"denominator"`
	Unit        string `json:"unit"`
	Basis       string `json:"basis"`
	Note        string `json:"note"`
}

func reportMetric(value, denominator int64, unit, basis, note string) batchMetric {
	return batchMetric{&value, &denominator, unit, basis, note}
}
func unknownBatchMetric(unit, basis, note string) batchMetric {
	return batchMetric{Unit: unit, Basis: basis, Note: note}
}

type batchReport struct {
	Schema      string                            `json:"schema"`
	GeneratedAt string                            `json:"generated_at"`
	ProjectID   string                            `json:"project_id"`
	ProjectName string                            `json:"project_name"`
	Batch       map[string]any                    `json:"batch"`
	Metrics     map[string]map[string]batchMetric `json:"metrics"`
	Adoptions   []map[string]any                  `json:"adoptions"`
	Deliveries  []map[string]any                  `json:"deliveries"`
	Unknowns    []string                          `json:"unknowns"`
	Snapshot    bool                              `json:"snapshot"`
}

// Each row contains identifiers and aggregate facts, never another person's answer.
type batchReportEntry struct {
	ID            string `db:"id"`
	PageNumber    int    `db:"page_number"`
	Status        string `db:"status"`
	QualityState  string `db:"quality_state"`
	Submitted     int64  `db:"submitted"`
	Correct       int64  `db:"correct"`
	Incorrect     int64  `db:"incorrect"`
	Unverified    int64  `db:"unverified"`
	Fields        int64  `db:"fields"`
	CompletedAt   string `db:"completed_at"`
	MismatchAt    string `db:"mismatch_at"`
	BlockedReason string `db:"blocked_reason"`
}

// Same latest-judgment semantics as field_audit.resultsSQL: a newer withdrawn,
// mismatching or unknown judgment shadows an older correct judgment. Historical
// recorded source basis is explicit; this does not claim current revalidation.
const batchReportRowsSQL = `WITH batch AS MATERIALIZED (
 SELECT * FROM pages WHERE project={:project} AND import_job={:job} AND status!='importing'
), judged AS MATERIALIZED (
 SELECT a.page, (SELECT CASE WHEN j.page=a.page
   AND CAST(json_extract(j.payload_json,'$.value') AS TEXT)=CAST(field.value AS TEXT)
   THEN json_extract(j.payload_json,'$.state') END
  FROM verification_events j WHERE j.project={:project} AND j.kind='judgment'
   AND j.ref!='final' AND json_valid(j.payload_json) AND j.ref=a.id AND j.field_name=field.key
  ORDER BY j.created DESC,CAST(COALESCE(json_extract(j.payload_json,'$.revision'),0) AS INTEGER) DESC,j.id DESC LIMIT 1) state
 FROM proofreading_attempts a JOIN batch p ON p.id=a.page AND p.project=a.project,
 json_each(CASE WHEN json_valid(a.row_json) THEN CASE WHEN json_type(a.row_json)='object' THEN a.row_json ELSE '{}' END ELSE '{}' END) field
 WHERE a.kind='proofread'
), quality AS (
 SELECT page,COUNT(*) fields,SUM(CASE WHEN state='correct' THEN 1 ELSE 0 END) correct,
 SUM(CASE WHEN state='incorrect' THEN 1 ELSE 0 END) incorrect FROM judged GROUP BY page
), submitted AS (
 SELECT a.page,COUNT(DISTINCT NULLIF(a.proofreader,'')) submitted FROM proofreading_attempts a
 JOIN batch p ON p.id=a.page AND p.project=a.project
 WHERE a.kind='proofread' AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) GROUP BY a.page
)
SELECT p.id,p.page_number,p.status,COALESCE(NULLIF(TRIM(p.quality_state),''),'candidate') quality_state,
 COALESCE(s.submitted,0) submitted,COALESCE(q.fields,0) fields,COALESCE(q.correct,0) correct,COALESCE(q.incorrect,0) incorrect,
 COALESCE(q.fields-q.correct-q.incorrect,0) unverified,
 COALESCE((SELECT v.created FROM verification_events v WHERE v.project=p.project AND v.page=p.id
  AND v.kind='final_adoption' AND json_valid(v.context_json)
  AND json_extract(v.context_json,'$.round')=COALESCE(NULLIF(p.proofread_round,0),1)
  ORDER BY v.created DESC,v.id DESC LIMIT 1),'') completed_at,
 COALESCE(p.last_mismatch_at,'') mismatch_at,COALESCE(p.blocked_reason,'') blocked_reason
FROM batch p LEFT JOIN quality q ON q.page=p.id LEFT JOIN submitted s ON s.page=p.id ORDER BY p.page_number,p.id`

func (s *importService) registerBatchReports() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/projects/{projectId}/batch-reports/{importJobId}", s.getBatchReport).Bind(apis.RequireAuth("users"))
		e.Router.GET("/api/fangji/projects/{projectId}/batch-reports/{importJobId}/exports", s.listBatchReportExports).Bind(apis.RequireAuth("users"))
		e.Router.POST("/api/fangji/projects/{projectId}/batch-reports/{importJobId}/exports", s.createBatchReportExport).Bind(apis.RequireAuth("users"), apis.BodyLimit(1024))
		e.Router.GET("/api/fangji/batch-report-exports/{exportId}", s.getBatchReportExport).Bind(apis.RequireAuth("users"))
		return e.Next()
	})
	// Completed snapshots are append-only. They are not regenerated on download.
	s.app.OnRecordUpdate("batch_report_exports").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.Original().GetString("status") == "completed" {
			return fmt.Errorf("历史报告不能改写，请生成新报告。")
		}
		return e.Next()
	})
}

func batchImport(app recordReader, project, id string) (*core.Record, error) {
	job, err := app.FindRecordById("import_jobs", id)
	if err != nil || job.GetString("project") != project {
		return nil, apis.NewNotFoundError("导入批次不存在。", nil)
	}
	return job, nil
}
func (s *importService) getBatchReport(c *core.RequestEvent) error {
	project := c.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(c, project); err != nil {
		return err
	}
	var report batchReport
	err := withRecordReadSnapshot(c.Request.Context(), s.app, func(app recordReader) error {
		if _, _, err := requireProjectManagerInApp(app, c, project); err != nil {
			return err
		}
		var err error
		report, _, err = s.buildBatchReport(app, project, c.Request.PathValue("importJobId"), time.Now().UTC())
		return err
	})
	if err != nil {
		return err
	}
	c.Response.Header().Set("Cache-Control", "private, no-store")
	return c.JSON(http.StatusOK, report)
}

func parseBatchTime(raw string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999Z"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func (s *importService) buildBatchReport(app recordReader, projectID, jobID string, now time.Time) (batchReport, []batchReportEntry, error) {
	report := batchReport{Schema: batchReportSchema, GeneratedAt: now.Format(time.RFC3339Nano), ProjectID: projectID, Metrics: map[string]map[string]batchMetric{}, Adoptions: []map[string]any{}, Deliveries: []map[string]any{}, Unknowns: []string{}}
	job, err := batchImport(app, projectID, jobID)
	if err != nil {
		return report, nil, err
	}
	project, err := app.FindRecordById("projects", projectID)
	if err != nil {
		return report, nil, err
	}
	report.ProjectName = project.GetString("name")
	report.Batch = map[string]any{"id": job.Id, "mode": job.GetString("mode"), "status": job.GetString("status"), "filename": job.GetString("original_filename"), "source": job.GetString("source"), "file_hash": job.GetString("file_hash")}
	rows := []batchReportEntry{}
	if err = app.DB().NewQuery(batchReportRowsSQL).Bind(dbx.Params{"project": projectID, "job": jobID}).All(&rows); err != nil {
		return report, nil, err
	}
	total := int64(len(rows))
	unit := "entries"
	importNote := "CSV 导入作业保存的条目计数；错误行未入册，重复跳过与编选排除无关。"
	if job.GetString("mode") == "bundle" {
		importNote = "资料包导入计数；重复复用包含在成功数中，另列重复跳过，不能再相加；当前关联条目可能较少。"
	}
	if job.GetString("mode") == "ocr" {
		unit = "pages"
		importNote = "文字层识别的声明、成功及错误按物理页计，保留条目按条计，不能相加。"
	}
	declared := int64(job.GetInt("total_count"))
	imported := map[string]batchMetric{}
	for name, field := range map[string]string{"declared": "total_count", "succeeded": "success_count", "failed": "failed_count", "excluded": "skipped_count"} {
		imported[name] = reportMetric(int64(job.GetInt(field)), declared, unit, "import_jobs."+field, importNote)
	}
	if !containsStr([]string{"completed", "completed_with_errors"}, job.GetString("status")) {
		imported["succeeded"] = unknownBatchMetric(unit, "import_jobs.success_count", "批次尚未成功发布；预检可导入量、处理中计数或失败前已处理量均不当作成功入册。")
	}
	imported["excluded"] = reportMetric(int64(job.GetInt("skipped_count")), declared, unit, "import_jobs.skipped_count", "重复条目的跳过数量；不是编选排除，也不代表错误。")
	if declared == 0 && !containsStr([]string{"completed", "completed_with_errors", "validated"}, job.GetString("status")) {
		imported["declared"] = unknownBatchMetric(unit, "import_jobs.total_count", "导入尚未完成计数。")
	}
	imported["retained"] = reportMetric(total, total, "entries", "pages.import_job; status != importing", "当前仍关联本批次的已发布条目；不含暂存条目，也不补回已删除或重复复用条目。")
	report.Metrics["import"] = imported
	var submitted, independent, completed, arbitration, correct, incorrect, fields, sampled, validated, withheld, completed7d, unknownCompletion, unknownWait, maxWait int64
	for _, row := range rows {
		if row.Submitted > 0 {
			submitted++
		}
		if row.Submitted >= 2 {
			independent++
		}
		correct += row.Correct
		incorrect += row.Incorrect
		fields += row.Fields
		if row.Correct+row.Incorrect > 0 {
			sampled++
		}
		if row.QualityState == "validated" {
			validated++
		}
		if row.QualityState == "withheld" {
			withheld++
		}
		if row.Status == "approved" {
			completed++
			if t, ok := parseBatchTime(row.CompletedAt); ok && !t.After(now) {
				if !t.Before(now.AddDate(0, 0, -7)) {
					completed7d++
				}
			} else {
				unknownCompletion++
			}
		}
		if row.Status == "arbitration" {
			arbitration++
			if t, ok := parseBatchTime(row.MismatchAt); ok && !t.After(now) {
				maxWait = max(maxWait, int64(now.Sub(t).Seconds()))
			} else {
				unknownWait++
			}
		}
	}
	report.Metrics["proofreading"] = map[string]batchMetric{
		"submitted_coverage":   reportMetric(submitted, total, "entries", "current-round distinct proofreading_attempts.proofreader", "当前轮至少一份独立提交覆盖的条目。"),
		"independent_coverage": reportMetric(independent, total, "entries", "current-round distinct proofreading_attempts.proofreader >= 2", "当前轮至少两名不同校对者已提交；不由轮次或计数推测人数。"),
		"completed":            reportMetric(completed, total, "entries", "pages.status = approved", "流程完成，不等于来源正确、许可完备或已被接收。"),
		"pending_arbitration":  reportMetric(arbitration, total, "entries", "pages.status = arbitration", "当前等待仲裁的条目。"),
	}
	qualityNote := "每份历史提交字段的最新保存判断；使用判断时的来源依据，不代表当前来源重新核验或最终条目正确率。"
	report.Metrics["quality"] = map[string]batchMetric{
		"correct":           reportMetric(correct, fields, "fields", "latest judgment per submitted field", qualityNote),
		"incorrect":         reportMetric(incorrect, fields, "fields", "latest judgment per submitted field", qualityNote),
		"unverified":        reportMetric(fields-correct-incorrect, fields, "fields", "latest judgment per submitted field", "待定、撤回、未记录、值失配都计为未核实。"),
		"evaluated_fields":  reportMetric(correct+incorrect, fields, "fields", "latest judgment correct or incorrect", qualityNote),
		"sampled_entries":   reportMetric(sampled, total, "entries", "entries with at least one evaluated submitted field", "仅表示有来源判断覆盖，不表示整条已核验或随机抽样。"),
		"validated_entries": reportMetric(validated, total, "entries", "pages.quality_state = validated", "人工质量标签，与来源判断和编选决定分开统计。"),
		"withheld_entries":  reportMetric(withheld, total, "entries", "pages.quality_state = withheld", "暂缓外发条目，不当作已排除或已被接收。"),
	}
	efficiency := map[string]batchMetric{
		"completed_7d":             reportMetric(completed7d, completed, "entries", "current approved entries; current-round final_adoption.created", "近7天有最终采用事件的当前已完成条目；不用 updated 或提交时间推测完成。"),
		"arbitration_wait_seconds": reportMetric(maxWait, arbitration, "seconds", "pages.last_mismatch_at", "当前待仲裁条目的最长等待时间。"),
	}
	if unknownCompletion > 0 {
		efficiency["completed_7d"] = unknownBatchMetric("entries", "current-round final_adoption.created", fmt.Sprintf("%d 条已完成记录缺少可靠完成事件；近7天已观察到 %d 条，完整数量未知。", unknownCompletion, completed7d))
	}
	if unknownWait > 0 {
		efficiency["arbitration_wait_seconds"] = unknownBatchMetric("seconds", "pages.last_mismatch_at", fmt.Sprintf("%d 条待仲裁记录缺少等待起点。", unknownWait))
	}
	report.Metrics["efficiency"] = efficiency
	report.Unknowns = append(report.Unknowns, "未记录本报告对应的抽样方法与预先抽样清单；核验覆盖不代表分层或随机抽检。")
	if err = s.addBatchReportWorkflow(app, &report, jobID, now); err != nil {
		return report, nil, err
	}
	return report, rows, nil
}

func (s *importService) addBatchReportWorkflow(app recordReader, report *batchReport, jobID string, now time.Time) error {
	adoptions, err := app.FindRecordsByFilter("adoption_batches", "project={:project}", "created,id", 0, 0, dbx.Params{"project": report.ProjectID})
	if err != nil {
		return err
	}
	for _, record := range adoptions {
		var rule adoptionRule
		if err = json.Unmarshal([]byte(record.GetString("rule_json")), &rule); err != nil {
			return fmt.Errorf("编选范围记录无效：%w", err)
		}
		if len(rule.ImportJobs) > 0 && !containsStr(rule.ImportJobs, jobID) {
			continue
		}
		view := adoptionBatchView(record)
		scope := "import_batches"
		if len(rule.ImportJobs) == 0 {
			scope = "project"
		}
		jobs := rule.ImportJobs
		if jobs == nil {
			jobs = []string{}
		}
		counts := view["counts"]
		if record.GetString("status") == adoptionBatchDraft {
			counts = nil
		}
		report.Adoptions = append(report.Adoptions, map[string]any{"id": record.Id, "purpose": record.GetString("purpose"), "recipient": record.GetString("recipient"), "status": record.GetString("status"), "scope": scope, "import_jobs": jobs, "counts": counts, "reasons": view["reasons"], "scope_digest": record.GetString("scope_digest"), "recorded_at": record.GetString("previewed_at"), "note": "保存时的完整编选范围计数，包含范围外排除；不可分摊为本导入批次数。来源变化后须重新预演核查，不代表当前可交付。"})
	}
	deliveries, err := app.FindRecordsByFilter("release_deliveries", "project={:project} && import_job={:job}", "created,id", 0, 0, dbx.Params{"project": report.ProjectID, "job": jobID})
	if err != nil {
		return err
	}
	var awaiting, missingWait, maxWait int64
	byDelivery, err := deliveryEventIndex(app, deliveries)
	if err != nil {
		return err
	}
	for _, record := range deliveries {
		events := byDelivery[record.Id]
		view := deliveryView(record, events)
		if view["awaiting_receipt"] == true {
			awaiting++
			if t, ok := parseBatchTime(record.GetString("created")); ok && !t.After(now) {
				wait := int64(now.Sub(t).Seconds())
				view["waiting_seconds"] = wait
				maxWait = max(maxWait, wait)
			} else {
				view["waiting_seconds"] = nil
				missingWait++
			}
		}
		report.Deliveries = append(report.Deliveries, view)
	}
	report.Metrics["efficiency"]["receipt_wait_seconds"] = reportMetric(maxWait, awaiting, "seconds", "release_deliveries.created; explicit receipt/return/withdrawal events", "尚无接收回执且未退回、未撤回的交付包最长等待时间；下载不等于接收。")
	if missingWait > 0 {
		report.Metrics["efficiency"]["receipt_wait_seconds"] = unknownBatchMetric("seconds", "release_deliveries.created", "存在缺少可靠生成时间的交付包。")
	}
	return nil
}
