package main

import (
	"fmt"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func importErrorCapFixture(t *testing.T) (*importService, string) {
	t.Helper()
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticImportCapPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Import error cap fixture")
	project.Set("admin", owner.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	jobID := "jobcap000000001"
	if _, err := app.DB().NewQuery(`INSERT INTO import_jobs (id, project, mode, status, created) VALUES ({:id}, {:project}, 'csv', 'processing', '2026-11-20 00:00:00.000Z')`).
		Bind(dbx.Params{"id": jobID, "project": project.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	return newImportService(app), jobID
}

func TestAddJobErrorCapsRowsAndMarksTruncation(t *testing.T) {
	s, jobID := importErrorCapFixture(t)
	for i := 1; i <= 1500; i++ {
		s.addJobError(jobID, i, "entry_text", "CSV_PARSE_ERROR", "synthetic bad row", "x", false)
	}
	n, err := s.app.CountRecords("import_job_errors", dbx.HashExp{"job": jobID})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1001 {
		t.Fatalf("error rows=%d want=1001（1000 条明细 + 1 条截断标记）", n)
	}
	marker, err := s.app.FindFirstRecordByFilter("import_job_errors", "job = {:job} && error_code = {:code}", dbx.Params{"job": jobID, "code": "ERROR_ROWS_TRUNCATED"})
	if err != nil {
		t.Fatalf("truncation marker missing: %v", err)
	}
	if marker.GetInt("row_number") != 1001 {
		t.Fatalf("marker row=%d want=1001（首条超限行）", marker.GetInt("row_number"))
	}
}

func TestAddJobErrorCapCountsPreexistingRows(t *testing.T) {
	s, jobID := importErrorCapFixture(t)
	for i := 1; i <= 1000; i++ {
		if _, err := s.app.DB().NewQuery(`INSERT INTO import_job_errors (id, job, row_number, column_name, error_code, message, raw_value, retryable, created) VALUES ({:id}, {:job}, {:row}, '', 'CSV_PARSE_ERROR', 'preexisting', '', 0, '2026-11-20 00:00:00.000Z')`).
			Bind(dbx.Params{"id": fmt.Sprintf("preerr%09d", i), "job": jobID, "row": i}).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	s.addJobError(jobID, 1001, "entry_text", "CSV_PARSE_ERROR", "overflow", "x", false)
	n, err := s.app.CountRecords("import_job_errors", dbx.HashExp{"job": jobID})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1001 {
		t.Fatalf("error rows=%d want=1001（已有 1000 条 + 截断标记，重试不重置上限）", n)
	}
}

func TestImportErrorLimitResetsWhenJobArtifactsCleared(t *testing.T) {
	s, jobID := importErrorCapFixture(t)
	// 预检阶段用满配额并留下截断标记。
	for i := 1; i <= 1001; i++ {
		s.addJobError(jobID, i, "entry_text", "CSV_PARSE_ERROR", "preflight bad row", "x", false)
	}
	job, err := s.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.app.DB().NewQuery(`UPDATE import_jobs SET status = 'validated', failed_count = 1500 WHERE id = {:id}`).
		Bind(dbx.Params{"id": jobID}).Execute(); err != nil {
		t.Fatal(err)
	}
	// confirm→processing 会删除旧明细/标记；配额必须随清理失效。
	if err := s.clearJobArtifacts(jobID); err != nil {
		t.Fatal(err)
	}
	if n, err := s.app.CountRecords("import_job_errors", dbx.HashExp{"job": jobID}); err != nil || n != 0 {
		t.Fatalf("error rows after cleanup=%d err=%v want=0", n, err)
	}
	if _, err := s.app.DB().NewQuery(`UPDATE import_jobs SET status = 'processing' WHERE id = {:id}`).
		Bind(dbx.Params{"id": jobID}).Execute(); err != nil {
		t.Fatal(err)
	}
	s.addJobError(jobID, 1, "entry_text", "PROCESSING_ERROR", "formal import bad row", "x", false)
	records, err := s.app.FindRecordsByFilter("import_job_errors", "job = {:job}", "row_number", 10, 0, dbx.Params{"job": jobID})
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].GetString("error_code") != "PROCESSING_ERROR" {
		t.Fatalf("formal import error rows=%v want=1 条 PROCESSING_ERROR（不得沿用预检配额）", records)
	}
	job, err = s.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.GetInt("failed_count") != 1500 {
		t.Fatalf("failed_count=%d want=1500（清理错误明细不得改失败总数）", job.GetInt("failed_count"))
	}
}
