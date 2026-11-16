package main

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestProjectWorkflowUsesCurrentEvidenceAndAuthorizedStageIsolation(t *testing.T) {
	app, owner, page := newAssistVisibilityFixture(t, newAssistVisibilityApp(t))
	projectID := page.GetString("project")
	page.Set("status", "approved")
	page.Set("proofread_round", 2)
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	// Imported staging is not yet material available to proofreaders.
	pages, _ := app.FindCollectionByNameOrId("pages")
	staged := core.NewRecord(pages)
	staged.Set("project", projectID)
	staged.Set("status", "importing")
	staged.Set("page_number", 2)
	if err := app.Save(staged); err != nil {
		t.Fatal(err)
	}
	jobs, _ := app.FindCollectionByNameOrId("import_jobs")
	job := core.NewRecord(jobs)
	job.Set("project", projectID)
	job.Set("created_by", owner.Id)
	job.Set("mode", "skip_invalid")
	job.Set("status", "validated")
	if err := app.SaveNoValidate(job); err != nil {
		t.Fatal(err)
	}
	attempts, _ := app.FindCollectionByNameOrId("proofreading_attempts")
	for _, round := range []int{1, 2} {
		attempt := core.NewRecord(attempts)
		attempt.Set("page", page.Id)
		attempt.Set("project", projectID)
		attempt.Set("kind", "proofread")
		attempt.Set("round", round)
		attempt.Set("pass_no", 1)
		attempt.Set("proofreader", owner.Id)
		if err := app.SaveNoValidate(attempt); err != nil {
			t.Fatal(err)
		}
	}
	deliveries, _ := app.FindCollectionByNameOrId("release_deliveries")
	delivery := core.NewRecord(deliveries)
	delivery.Set("project", projectID)
	delivery.Set("snapshot", `{}`)
	if err := app.SaveNoValidate(delivery); err != nil {
		t.Fatal(err)
	}
	events, _ := app.FindCollectionByNameOrId("release_events")
	returned := core.NewRecord(events)
	returned.Set("delivery", delivery.Id)
	returned.Set("kind", "return")
	returned.Set("sequence", 1)
	returned.Set("payload", `{}`)
	if err := app.SaveNoValidate(returned); err != nil {
		t.Fatal(err)
	}
	resolved := core.NewRecord(events)
	resolved.Set("delivery", delivery.Id)
	resolved.Set("kind", "resolution")
	resolved.Set("sequence", 2)
	resolved.Set("payload", `{"resolves":"`+returned.Id+`"}`)
	if err := app.SaveNoValidate(resolved); err != nil {
		t.Fatal(err)
	}
	service := newProjectQueryService(app, "pb_hooks")
	service.hooksDir, _ = filepath.Abs("pb_hooks")
	service.registerProjectWorkflow()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err = app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	token, _ := owner.NewAuthToken()
	get := func(token string, status int) projectWorkflow {
		t.Helper()
		r := httptest.NewRequest("GET", "/api/fangji/projects/"+projectID+"/workflow", nil)
		r.Header.Set("Authorization", token)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("workflow %d: %s", w.Code, w.Body)
		}
		var result projectWorkflow
		if status == 200 {
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
		}
		return result
	}
	get("", 401)
	result := get(token, 200)
	if result.Project.ID != projectID || *result.Summary["entries"] != 1 || *result.Summary["proofreading_completed"] != 1 || len(result.Stages) != 6 {
		t.Fatalf("incorrect project summary: %+v", result)
	}
	metric := func(stage workflowStage, key string) *int {
		t.Helper()
		for _, m := range stage.Metrics {
			if m.Key == key {
				return m.Count
			}
		}
		t.Fatalf("missing %s/%s", stage.Key, key)
		return nil
	}
	if *metric(result.Stages[0], "awaiting_confirmation") != 1 || result.Recommendation == nil || result.Recommendation.Stage != "materials" {
		t.Fatalf("validated import is not actionable: %+v", result)
	}
	if *metric(result.Stages[1], "submitted_entries") != 1 || *metric(result.Stages[1], "independent_entries") != 0 {
		t.Fatal("old round or approved status fabricated independent submissions")
	}
	if *metric(result.Stages[5], "awaiting_receipt") != 0 || *metric(result.Stages[5], "successful_receipt") != 0 || *metric(result.Stages[5], "returned_resolved") != 1 {
		t.Fatal("resolved return became successful acceptance or awaiting receipt")
	}
	service.hooksDir = t.TempDir()
	unknown := get(token, 200)
	if unknown.Stages[2].State != "unknown" || metric(unknown.Stages[2], "source_review") != nil || unknown.Stages[0].State == "unknown" || unknown.Stages[5].State == "unknown" {
		t.Fatal("source read failure became zero or disabled unrelated stages")
	}
	if unknown.Recommendation == nil || unknown.Recommendation.Stage == "verification" {
		t.Fatal("unknown stage was recommended as ready")
	}
	owner.Set("role", "user")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	project, _ := app.FindRecordById("projects", projectID)
	project.Set("admin", "")
	if err := app.SaveNoValidate(project); err != nil {
		t.Fatal(err)
	}
	token, _ = owner.NewAuthToken()
	get(token, 403)
}
