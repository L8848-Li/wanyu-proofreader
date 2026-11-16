package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func TestBatchedSourceReviewMatchesAuthoritativeCompletion(t *testing.T) {
	app, owner, first := newAssistVisibilityFixture(t, newAssistVisibilityApp(t))
	vm := assistVisibilityVM(t, app)
	pages, _ := app.FindCollectionByNameOrId("pages")
	attempts, _ := app.FindCollectionByNameOrId("proofreading_attempts")
	events, _ := app.FindCollectionByNameOrId("verification_events")
	issues, _ := app.FindCollectionByNameOrId("problem_issues")
	reports, _ := app.FindCollectionByNameOrId("problem_reports")
	rows := []*core.Record{}
	save := func(record *core.Record) {
		t.Helper()
		if err := app.SaveNoValidate(record); err != nil {
			t.Fatal(err)
		}
	}
	for i, scenario := range []string{"pending", "proofread", "empty", "complete", "changed_basis", "stale_attempt", "previous_round", "open_report", "stale_resolution", "current_resolution", "revalidated", "hold", "recheck"} {
		page := core.NewRecord(pages)
		page.Set("project", first.GetString("project"))
		page.Set("page_number", i+2)
		page.Set("status", "approved")
		page.Set("ocr_row_json", `{"词条":"  a\u0301𰻞  "}`)
		page.Set("proofread_row_json", `{"词条":"  a\u0301𰻞  "}`)
		page.Set("row_headers_json", `["词条"]`)
		switch scenario {
		case "pending", "proofread":
			page.Set("status", scenario)
		case "empty":
			page.Set("source_empty", true)
			page.Set("status", "arbitration")
		case "changed_basis":
			page.Set("verification_basis", "old synthetic basis")
		case "previous_round":
			page.Set("proofread_round", 2)
		case "hold":
			page.Set("verification_hold", true)
		case "recheck":
			page.Set("verification_needs_recheck", true)
		}
		save(page)
		rows = append(rows, page)
		if scenario == "stale_attempt" || scenario == "previous_round" || scenario == "revalidated" {
			attempt := core.NewRecord(attempts)
			for key, value := range map[string]any{"project": page.GetString("project"), "page": page.Id, "round": 1, "kind": "proofread", "pass_no": 1, "proofreader": owner.Id, "verification_context_json": `{"basis":"old synthetic basis"}`} {
				attempt.Set(key, value)
			}
			save(attempt)
		}
		if scenario == "open_report" || scenario == "stale_resolution" || scenario == "current_resolution" {
			issue := core.NewRecord(issues)
			issue.Set("project", page.GetString("project"))
			issue.Set("status", "new")
			save(issue)
			report := core.NewRecord(reports)
			for key, value := range map[string]any{"project": page.GetString("project"), "page": page.Id, "issue": issue.Id, "reporter": owner.Id, "blocking": true} {
				report.Set(key, value)
			}
			save(report)
			if scenario != "open_report" {
				vm.Set("page", page)
				scope, err := vm.RunString(`require(__hooks+"/lib/source_fidelity.js").contextFor(dao,page).scope_key`)
				if err != nil {
					t.Fatal(err)
				}
				key := scope.String()
				if scenario == "stale_resolution" {
					key = "old synthetic scope"
				}
				resolution, _ := json.Marshal(map[string]any{report.Id: map[string]string{"scope_key": key}})
				issue.Set("resolution_json", string(resolution))
				issue.Set("status", "resolved")
				save(issue)
			}
		}
		if scenario == "revalidated" {
			vm.Set("page", page)
			basis, err := vm.RunString(`require(__hooks+"/lib/source_fidelity.js").contextFor(dao,page,false).basis`)
			if err != nil {
				t.Fatal(err)
			}
			context, _ := json.Marshal(map[string]string{"basis": basis.String()})
			event := core.NewRecord(events)
			for key, value := range map[string]any{"project": page.GetString("project"), "page": page.Id, "kind": "review_completed", "context_json": string(context), "payload_json": `{"source_checked":true}`} {
				event.Set(key, value)
			}
			save(event)
		}
	}
	check := func() int64 {
		t.Helper()
		vm.Set("pages", rows)
		oracle, err := vm.RunString(`(function(){const sf=require(__hooks+"/lib/source_fidelity.js");return pages.filter(page=>{
 if(!["approved","proofread","arbitration"].includes(page.getString("status")))return false;
 const item=sf.completion(dao,page);return (!item.business_complete&&!item.source_empty)||item.needs_review||item.pending_review;
 }).length})()`)
		if err != nil {
			t.Fatal(err)
		}
		batch, err := vm.RunString(`require(__hooks+"/lib/source_fidelity.js").countPendingReviews(dao,pages)`)
		if err != nil || batch.ToInteger() != oracle.ToInteger() {
			t.Fatalf("batch %v differs from authoritative completion %v: %v", batch, oracle, err)
		}
		return batch.ToInteger()
	}
	before := check()
	project, _ := app.FindRecordById("projects", first.GetString("project"))
	project.Set("column_roles_json", `{"词条":"reading"}`)
	save(project)
	if check() <= before {
		t.Fatal("changed column roles reused stale resolution/revalidation evidence")
	}
}

func TestManagerTodoQueriesAreBatched(t *testing.T) {
	app, owner, first := newAssistVisibilityFixture(t, newAssistVisibilityApp(t))
	project := first.GetString("project")
	pages, _ := app.FindCollectionByNameOrId("pages")
	issues, _ := app.FindCollectionByNameOrId("problem_issues")
	reports, _ := app.FindCollectionByNameOrId("problem_reports")
	deliveries, _ := app.FindCollectionByNameOrId("release_deliveries")
	events, _ := app.FindCollectionByNameOrId("release_events")
	if err := app.RunInTransaction(func(tx core.App) error {
		for i := 0; i < 250; i++ {
			page := core.NewRecord(pages)
			for key, value := range map[string]any{"project": project, "page_number": i + 2, "status": "approved", "verification_basis": "old basis", "ocr_row_json": `{"词条":"synthetic"}`} {
				page.Set(key, value)
			}
			if err := tx.SaveNoValidate(page); err != nil {
				return err
			}
			if i >= 40 {
				continue
			}
			issue := core.NewRecord(issues)
			issue.Set("project", project)
			issue.Set("status", "new")
			if err := tx.SaveNoValidate(issue); err != nil {
				return err
			}
			report := core.NewRecord(reports)
			for key, value := range map[string]any{"project": project, "page": page.Id, "issue": issue.Id, "reporter": owner.Id} {
				report.Set(key, value)
			}
			if err := tx.SaveNoValidate(report); err != nil {
				return err
			}
			delivery := core.NewRecord(deliveries)
			delivery.Set("project", project)
			delivery.Set("package_id", fmt.Sprintf("synthetic-%d", i))
			delivery.Set("version", i+1)
			delivery.Set("snapshot", `{}`)
			if err := tx.SaveNoValidate(delivery); err != nil {
				return err
			}
			event := core.NewRecord(events)
			event.Set("delivery", delivery.Id)
			event.Set("kind", "download")
			event.Set("sequence", 1)
			event.Set("payload", fmt.Sprintf(`{"synthetic":%d}`, i))
			if err := tx.SaveNoValidate(event); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	review, err := newTodoSourceReview(app, "pb_hooks")
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		stage string
		count int
		limit int
	}{{"source_problems", 40, 1}, {"delivery_receipt", 40, 2}, {"source_review", 250, 18}} {
		t.Run(fixture.stage, func(t *testing.T) {
			db := app.ConcurrentDB().(*dbx.DB)
			previous := db.QueryLogFunc
			defer func() { db.QueryLogFunc = previous }()
			queries := []string{}
			db.QueryLogFunc = func(_ context.Context, _ time.Duration, query string, _ *sql.Rows, _ error) {
				if !strings.Contains(query, "PRAGMA") {
					queries = append(queries, query)
				}
			}
			row := newManagerTodo(todoProject{ID: project}, fixture.stage)
			if err := (&projectQueryService{}).fillManagerTodo(app, &row, time.Now(), review, nil); err != nil {
				t.Fatal(err)
			}
			if *row.Count != fixture.count || len(queries) > fixture.limit {
				t.Fatalf("count=%d (want %d), queries=%d (limit %d): %v", *row.Count, fixture.count, len(queries), fixture.limit, queries)
			}
			t.Logf("%s: %d entries, %d queries", fixture.stage, *row.Count, len(queries))
		})
	}
}
