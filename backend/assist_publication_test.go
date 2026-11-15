package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func TestAssistStagedFindingNativeUpdateCannotBreakPublication(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	supers, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatal(err)
	}
	superuser := core.NewRecord(supers)
	superuser.SetEmail("synthetic-publication-guard@example.test")
	superuser.SetPassword("SyntheticPublicationGuard123!")
	if err := app.Save(superuser); err != nil {
		t.Fatal(err)
	}
	jsvm.MustRegister(app, jsvm.Config{HooksDir: "pb_hooks", HooksFilesPattern: `^(findings|source_fidelity)\.pb\.js$`, MigrationsFilesPattern: `a^`})
	router := accountTestRouter(t, app)
	token, err := superuser.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	attempted := false
	hook := app.OnRecordAfterCreateSuccess("review_findings").BindFunc(func(e *core.RecordEvent) error {
		if err := e.Next(); err != nil {
			return err
		}
		if attempted || e.Record.GetString("assist_publication") == "" {
			return nil
		}
		// A real staging chunk has committed, but final publication has not run.
		marker, err := app.FindRecordById("assist_publications", e.Record.GetString("assist_publication"))
		if err != nil || marker.GetString("state") != "staging" {
			t.Fatalf("native update probe did not run during staging: %v", err)
		}
		attempted = true
		accountTestRequest(t, router, "PATCH", "/api/collections/review_findings/records/"+e.Record.Id, token,
			map[string]any{"superseded_at": "2026-11-09 00:00:01.000Z"}, 403)
		return nil
	})
	t.Cleanup(func() { app.OnRecordAfterCreateSuccess("review_findings").Unbind(hook) })
	value, err := runAssistScript(app, `JSON.stringify(require(__hooks+'/lib/assist_writer.js').recomputeProject(dao,"`+project+`"))`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Findings    int
		Publication string
	}
	if err := json.Unmarshal([]byte(value.String()), &result); err != nil {
		t.Fatal(err)
	}
	marker, err := app.FindRecordById("assist_publications", result.Publication)
	if err != nil || marker.GetString("state") != "published" {
		t.Fatalf("rejected native update prevented publication: %v", err)
	}
	var current int
	if err := app.DB().NewQuery("SELECT COUNT(*) FROM review_findings WHERE assist_publication={:publication} AND " + assistCurrentSQLForTest).
		Bind(dbx.Params{"publication": result.Publication}).Row(&current); err != nil {
		t.Fatal(err)
	}
	if !attempted || result.Findings == 0 || current != result.Findings {
		t.Fatalf("publication summary and current findings diverged: attempted=%v summary=%d current=%d", attempted, result.Findings, current)
	}
}

func TestAssistPreparedBasisChangeKeepsPreviousPublication(t *testing.T) {
	for _, change := range []string{"source_row", "roles", "tone_pair", "current_finding", "dismissal"} {
		t.Run(change, func(t *testing.T) {
			app, project, page := newAssistAtomicFixture(t)
			if err := runAssistWriter(app, "recomputeProject", project); err != nil {
				t.Fatal(err)
			}
			before := assistDatabaseState(t, app)
			changed := false
			hook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
				if !changed {
					changed = true
					switch change {
					case "source_row":
						row, err := e.App.FindRecordById("pages", page)
						if err != nil {
							return err
						}
						row.Set("ocr_row_json", `{"词条":"甲、乙","拼音":"ka2","莆田IPA":"a𰻞\uEE009999","释义":"新合成"}`)
						if err = e.App.Save(row); err != nil {
							return err
						}
					case "roles", "tone_pair":
						row, err := e.App.FindRecordById("projects", project)
						if err != nil {
							return err
						}
						if change == "roles" {
							row.Set("column_roles_json", `{"释义":"meaning"}`)
						} else {
							row.Set("assist_tone_count_fields_json", `["拼音","莆田IPA"]`)
						}
						if err = e.App.Save(row); err != nil {
							return err
						}
					case "current_finding":
						rows, err := e.App.FindRecordsByFilter("review_findings", "assist_publication != ''", "created", 1, 0)
						if err != nil {
							return err
						}
						rows[0].Set("superseded_at", "2026-11-09 00:00:00.000Z")
						if err = e.App.Save(rows[0]); err != nil {
							return err
						}
					case "dismissal":
						collection, err := e.App.FindCollectionByNameOrId("finding_dismissals")
						if err != nil {
							return err
						}
						row := core.NewRecord(collection)
						owner, err := e.App.FindRecordById("projects", project)
						if err != nil {
							return err
						}
						row.Set("project", project)
						row.Set("group_key", "synthetic")
						row.Set("kind", "duplicate_identity")
						row.Set("status", "not_conflict")
						row.Set("decided_by", owner.GetString("admin"))
						if err = e.App.Save(row); err != nil {
							return err
						}
					}
				}
				return e.Next()
			})
			value, err := runAssistScript(app, `try { require(__hooks+"/lib/assist_writer.js").recomputeProject(dao,"`+project+`"); "unexpected success" } catch (e) { JSON.stringify({status:e.status,reason:e.data?.reasonCode}) }`)
			app.OnRecordCreate("review_findings").Unbind(hook)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(value.String(), `"status":409`) || !strings.Contains(value.String(), "ASSIST_BASIS_CHANGED") {
				t.Fatalf("must expose typed conflict, got %s", value)
			}
			after := assistDatabaseState(t, app)
			if change != "source_row" && after["pages"] != before["pages"] {
				t.Fatal("rejected prepared result changed page tiers")
			}
			if after["verification_events"] != before["verification_events"] {
				t.Fatal("rejected prepared result published events")
			}
			if change != "current_finding" && after["review_findings"] != before["review_findings"] {
				t.Fatal("rejected prepared result changed prior findings")
			}
			var retired int
			if err = app.DB().NewQuery("SELECT COUNT(*) FROM _assist_finding_retirements r JOIN assist_publications p ON p.id=r.publication WHERE p.state='published'").Row(&retired); err != nil {
				t.Fatal(err)
			}
			if retired != 0 {
				t.Fatal("rejected prepared result retired previous findings")
			}
		})
	}
}

func TestAssistFinalSaveFailureDoesNotRetireOldBatch(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	hook := app.OnRecordUpdate("assist_publications").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetString("state") == "published" {
			return errors.New("synthetic final publication failure")
		}
		return e.Next()
	})
	err := runAssistWriter(app, "recomputeProject", project)
	app.OnRecordUpdate("assist_publications").Unbind(hook)
	if err == nil || !strings.Contains(err.Error(), "synthetic final") {
		t.Fatalf("expected final save failure, got %v", err)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("final failure exposed a partial publication")
	}
	var retired int
	if err = app.DB().NewQuery("SELECT COUNT(*) FROM _assist_finding_retirements r JOIN assist_publications p ON p.id=r.publication WHERE p.state='published'").Row(&retired); err != nil {
		t.Fatal(err)
	}
	if retired != 0 {
		t.Fatal("final failure left retirement records")
	}
}

func TestAssistMissingEpochTriggerRefusesPublication(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	if _, err := app.DB().NewQuery("DROP TRIGGER _assist_epoch_pages_update").Execute(); err != nil {
		t.Fatal(err)
	}
	err := runAssistWriter(app, "recomputeProject", project)
	if err == nil || !strings.Contains(err.Error(), "triggers incomplete") {
		t.Fatalf("missing guard must fail closed: %v", err)
	}
	rows, err := app.FindRecordsByFilter("assist_publications", "", "", 0, 0)
	if err != nil || len(rows) != 0 {
		t.Fatalf("missing basis guard created publication: %d, %v", len(rows), err)
	}
}

func TestAssistCommittedStageFailureRemainsInvisibleAndCleanupBounded(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	pages, _ := app.FindCollectionByNameOrId("pages")
	// This fixture needs at least 150 findings even with optional rules off.
	for i := 2; i < 82; i++ {
		page := core.NewRecord(pages)
		page.Set("project", project)
		page.Set("page_number", i+1)
		page.Set("pdf_page", 1)
		page.Set("status", "pending")
		page.Set("ocr_row_json", fmt.Sprintf(`{"词条":"甲、乙%d","拼音":"ka1","莆田IPA":"a𰻞\uEE009999","释义":"合成%d"}`, i, i))
		if err := app.Save(page); err != nil {
			t.Fatal(err)
		}
	}
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	created := 0
	hook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
		created++
		if created == 150 {
			return errors.New("synthetic failure after first committed chunk")
		}
		return e.Next()
	})
	err := runAssistWriter(app, "recomputeProject", project)
	app.OnRecordCreate("review_findings").Unbind(hook)
	if err == nil || !strings.Contains(err.Error(), "first committed chunk") {
		t.Fatalf("expected staged failure: %v", err)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("committed staging records became business-visible")
	}
	var pending int
	if err = app.DB().NewQuery("SELECT COUNT(*) FROM review_findings WHERE assist_publication IN (SELECT id FROM assist_publications WHERE state='aborted')").Row(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 100 {
		t.Fatalf("fixture must retain one actually committed 100-record staging chunk, got %d", pending)
	}
	value, err := runAssistScript(app, `require(__hooks+"/lib/assist_publication.js").cleanup(dao)`)
	if err != nil {
		t.Fatal(err)
	}
	if value.ToInteger() != 100 {
		t.Fatalf("bounded cleanup removed %v, want 100", value)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("cleanup changed previously published history")
	}
	markers, err := app.FindRecordsByFilter("assist_publications", `state="aborted"`, "", 0, 0)
	if err != nil || len(markers) != 1 {
		t.Fatalf("cleanup must retain aborted marker: %d %v", len(markers), err)
	}
}

func TestAssistInputBudgetRefusesWithoutReplacingPreviousBatch(t *testing.T) {
	app, project, page := newAssistAtomicFixture(t)
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	row, err := app.FindRecordById("pages", page)
	if err != nil {
		t.Fatal(err)
	}
	// Storage-fault/legacy-data fixture only: ordinary Save correctly rejects
	// this oversized value under the existing text limit. The budget must also
	// fail before loading unbounded preexisting stored data, not just new API input.
	if _, err = app.DB().NewQuery("UPDATE pages SET ocr_row_json={:value} WHERE id={:id}").Bind(dbx.Params{"id": row.Id, "value": `{"词条":"` + strings.Repeat("合", 800000) + `"}`}).Execute(); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	err = runAssistWriter(app, "recomputeProject", project)
	if err == nil || !strings.Contains(err.Error(), "安全预算") {
		t.Fatalf("expected explicit byte-budget refusal, got %v", err)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("budget refusal replaced previous results")
	}
}

func TestAssistPreparedPageCursorUsesRange(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	var rows []struct {
		Detail string `db:"detail"`
	}
	err := app.DB().NewQuery(`EXPLAIN QUERY PLAN SELECT id,created,page_number FROM pages
 WHERE project={:project} AND page_number>={:number} AND
 (page_number>{:number} OR (page_number={:number} AND created>{:created}) OR (page_number={:number} AND created={:created} AND id>{:id}))
 ORDER BY page_number,created,id LIMIT 16`).Bind(dbx.Params{"project": project, "number": 1, "created": "2026-11-09 00:00:00.000Z", "id": "aaaaaaaaaaaaaaa"}).All(&rows)
	if err != nil {
		t.Fatal(err)
	}
	detail := ""
	for _, row := range rows {
		detail += row.Detail + "\n"
	}
	t.Logf("actual Go SQLite prepared cursor plan:\n%s", detail)
	if !strings.Contains(detail, "page_number>?") {
		t.Fatal("prepared page cursor must use a page_number range, not rescan the project prefix")
	}
}

func TestAssistRetirementEpochTracksOnlyVisibleChanges(t *testing.T) {
	app, project, pageID := newAssistAtomicFixture(t)
	page, err := app.FindRecordById("pages", pageID)
	if err != nil {
		t.Fatal(err)
	}
	first := visibilityFinding(t, app, page, "", "")
	publication := visibilityPublication(t, app, page, "staging")
	epoch := func(projectID string) int64 {
		var value int64
		if err := app.DB().NewQuery("SELECT revision FROM _assist_basis_epochs WHERE scope={:scope}").Bind(dbx.Params{"scope": "project:" + projectID}).Row(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := epoch(project)
	if _, err = app.DB().NewQuery("INSERT INTO _assist_finding_retirements VALUES({:finding},{:publication},'2026-11-09 00:00:00.000Z')").Bind(dbx.Params{"finding": first.Id, "publication": publication.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if epoch(project) != before {
		t.Fatal("invisible staging tombstone changed basis")
	}
	publication.Set("state", "published")
	if err = app.Save(publication); err != nil {
		t.Fatal(err)
	}
	if epoch(project) != before+1 {
		t.Fatal("atomic publication must bump basis once")
	}
	before = epoch(project)
	if _, err = app.DB().NewQuery("DELETE FROM _assist_finding_retirements WHERE finding={:finding}").Bind(dbx.Params{"finding": first.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if epoch(project) <= before {
		t.Fatal("removing published retirement did not change basis")
	}
	before = epoch(project)
	if _, err = app.DB().NewQuery("INSERT INTO _assist_finding_retirements VALUES({:finding},{:publication},'2026-11-09 00:00:00.000Z')").Bind(dbx.Params{"finding": first.Id, "publication": publication.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if epoch(project) <= before {
		t.Fatal("adding published retirement did not change basis")
	}
	_, _, otherPage := newAssistVisibilityFixture(t, app)
	other := visibilityFinding(t, app, otherPage, "", "")
	oldEpoch, newEpoch := epoch(project), epoch(otherPage.GetString("project"))
	if _, err = app.DB().NewQuery("UPDATE _assist_finding_retirements SET finding={:next} WHERE finding={:previous}").Bind(dbx.Params{"next": other.Id, "previous": first.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if epoch(project) <= oldEpoch || epoch(otherPage.GetString("project")) <= newEpoch {
		t.Fatal("moving visible retirement must invalidate both old and new finding projects")
	}
}

func TestAssistStageChunksRespectLargeValidContextBytes(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	policies, _ := app.FindCollectionByNameOrId("verification_policies")
	owner, err := app.FindRecordById("projects", project)
	if err != nil {
		t.Fatal(err)
	}
	policy := core.NewRecord(policies)
	policy.Set("project", project)
	policy.Set("actor", owner.GetString("admin"))
	policy.Set("reason", "Synthetic large context")
	spec := map[string]any{"reading_fields": []string{}, "sources": []any{}, "instructions": strings.Repeat("练习", 10000)}
	payload, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	policy.Set("spec_json", string(payload))
	if err = app.Save(policy); err != nil {
		t.Fatal(err)
	}
	owner.Set("verification_policy", policy.Id)
	if err = app.Save(owner); err != nil {
		t.Fatal(err)
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	for i := 2; i < 20; i++ {
		page := core.NewRecord(pages)
		page.Set("project", project)
		page.Set("page_number", i+1)
		page.Set("pdf_page", 1)
		page.Set("status", "pending")
		page.Set("ocr_row_json", fmt.Sprintf(`{"词条":"甲、乙%d","拼音":"ka1","莆田IPA":"a𰻞\uEE009999","释义":"合成%d"}`, i, i))
		if err = app.Save(page); err != nil {
			t.Fatal(err)
		}
	}
	value, err := runAssistScript(app, `JSON.stringify(require(__hooks+"/lib/assist_writer.js").recomputeProject(dao,"`+project+`"))`)
	if err != nil {
		t.Fatal(err)
	}
	var summary struct {
		Findings int `json:"findings"`
		Metrics  struct {
			MaxBytes int `json:"max_stage_estimated_bytes"`
			Phases   map[string]struct {
				Count int `json:"count"`
			} `json:"phases"`
		} `json:"publication_metrics"`
	}
	if err = json.Unmarshal([]byte(value.String()), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Metrics.MaxBytes > 256*1024 || summary.Metrics.MaxBytes < 60*1024 {
		t.Fatalf("stage byte accounting invalid: %+v", summary)
	}
	if summary.Metrics.Phases["findings"].Count <= (summary.Findings+99)/100 {
		t.Fatal("large valid context still used count-only batches")
	}
}

func TestAssistFinalAuthorizationIsRechecked(t *testing.T) {
	for _, change := range []string{"role", "membership"} {
		t.Run(change, func(t *testing.T) {
			app, project, _ := newAssistAtomicFixture(t)
			if err := runAssistWriter(app, "recomputeProject", project); err != nil {
				t.Fatal(err)
			}
			users, _ := app.FindCollectionByNameOrId("users")
			actor := core.NewRecord(users)
			actor.Set("role", "user")
			actor.SetPassword("SyntheticManager123!")
			if err := app.Save(actor); err != nil {
				t.Fatal(err)
			}
			members, _ := app.FindCollectionByNameOrId("project_memberships")
			member := core.NewRecord(members)
			member.Set("project", project)
			member.Set("user", actor.Id)
			member.Set("role", "manager")
			member.Set("source", "assigned")
			member.Set("created_by", actor.Id)
			if err := app.Save(member); err != nil {
				t.Fatal(err)
			}
			before := assistDatabaseState(t, app)
			changed := false
			hook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
				if !changed {
					changed = true
					if change == "membership" {
						row, err := e.App.FindRecordById("project_memberships", member.Id)
						if err != nil {
							return err
						}
						if err = e.App.Delete(row); err != nil {
							return err
						}
					} else {
						row, err := e.App.FindRecordById("users", actor.Id)
						if err != nil {
							return err
						}
						row.Set("role", "platform_admin")
						if err = e.App.Save(row); err != nil {
							return err
						}
					}
				}
				return e.Next()
			})
			script := `(()=>{const actor=dao.findRecordById("users","` + actor.Id + `");try{return require(__hooks+"/lib/assist_writer.js").recomputeProject(dao,"` + project + `",tx=>require(__hooks+"/lib/assist_publication.js").authorizeRequest(tx,actor,"rules","` + project + `"))}catch(e){return e.status}})()`
			result, err := runAssistScript(app, script)
			app.OnRecordCreate("review_findings").Unbind(hook)
			if err != nil {
				t.Fatal(err)
			}
			want := int64(403)
			if change == "role" {
				want = 401
			}
			if result.ToInteger() != want {
				t.Fatalf("final authority change got %v, want %d", result, want)
			}
			if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
				t.Fatal("revoked preparation changed current findings/tier/events")
			}
		})
	}
}

func TestAssistMigrationRoundTripAndUnsafeDown(t *testing.T) {
	app, project, pageID := newAssistAtomicFixture(t)
	page, err := app.FindRecordById("pages", pageID)
	if err != nil {
		t.Fatal(err)
	}
	legacy := visibilityFinding(t, app, page, "", "")
	vm := goja.New()
	jsvm.BindCore(vm)
	var up, down func(core.App) error
	vm.Set("migrate", func(apply, rollback func(core.App) error) { up = apply; down = rollback })
	raw, err := os.ReadFile("pb_migrations/1794204700_assist_publications.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = vm.RunString(string(raw)); err != nil {
		t.Fatal(err)
	}
	if err = app.RunInTransaction(down); err != nil {
		t.Fatal(err)
	}
	if _, err = app.FindRecordById("review_findings", legacy.Id); err != nil {
		t.Fatal("safe empty-marker down lost legacy finding")
	}
	if err = app.RunInTransaction(up); err != nil {
		t.Fatal(err)
	}
	if err = runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	if err = app.RunInTransaction(down); err == nil || !strings.Contains(err.Error(), "publications exist") {
		t.Fatalf("unsafe down was not refused: %v", err)
	}
	if _, err = app.FindCollectionByNameOrId("assist_publications"); err != nil {
		t.Fatal("unsafe down partially removed publication schema")
	}
}

func TestAssistConcurrentReadersNeverSeeStagedOrHalfPublishedResults(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	pages, _ := app.FindCollectionByNameOrId("pages")
	for i := 2; i < 70; i++ {
		page := core.NewRecord(pages)
		page.Set("project", project)
		page.Set("page_number", i+1)
		page.Set("pdf_page", 1)
		page.Set("status", "pending")
		page.Set("ocr_row_json", fmt.Sprintf(`{"词条":"甲、乙%d","拼音":"ka1","莆田IPA":"a𰻞\uEE009999","释义":"合成%d"}`, i, i))
		if err := app.Save(page); err != nil {
			t.Fatal(err)
		}
	}
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	stageReady, stageResume, finalReady, finalResume := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseStage, releaseFinal sync.Once
	defer releaseStage.Do(func() { close(stageResume) })
	defer releaseFinal.Do(func() { close(finalResume) })
	created := 0
	stageHook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
		created++
		if created == 101 {
			close(stageReady)
			<-stageResume
		}
		return e.Next()
	})
	finalHook := app.OnRecordUpdate("assist_publications").BindFunc(func(e *core.RecordEvent) error {
		err := e.Next()
		if err == nil && e.Record.GetString("state") == "published" {
			close(finalReady)
			<-finalResume
		}
		return err
	})
	defer app.OnRecordCreate("review_findings").Unbind(stageHook)
	defer app.OnRecordUpdate("assist_publications").Unbind(finalHook)
	completed := make(chan error, 1)
	go func() { completed <- runAssistWriter(app, "recomputeProject", project) }()
	await := func(ready chan struct{}, label string) {
		t.Helper()
		select {
		case <-ready:
		case err := <-completed:
			t.Fatalf("%s barrier not reached: %v", label, err)
		case <-time.After(15 * time.Second):
			t.Fatalf("%s barrier timeout", label)
		}
	}
	await(stageReady, "committed staging")
	var staged int
	if err := app.DB().NewQuery("SELECT COUNT(*) FROM review_findings WHERE assist_publication IN (SELECT id FROM assist_publications WHERE state='staging')").Row(&staged); err != nil {
		t.Fatal(err)
	}
	if staged == 0 {
		t.Fatal("fixture did not actually commit a staging chunk")
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("reader observed staged data before publication")
	}
	releaseStage.Do(func() { close(stageResume) })
	await(finalReady, "uncommitted final switch")
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("reader observed partial retirement/tier/publication state before commit")
	}
	releaseFinal.Do(func() { close(finalResume) })
	if err := <-completed; err != nil {
		t.Fatal(err)
	}
	var current int
	if err := app.DB().NewQuery("SELECT COUNT(*) FROM review_findings WHERE " + assistCurrentSQLForTest).Row(&current); err != nil {
		t.Fatal(err)
	}
	var previous int
	if err := app.DB().NewQuery("SELECT COUNT(*) FROM _assist_finding_retirements").Row(&previous); err != nil {
		t.Fatal(err)
	}
	if current == 0 || current != previous {
		t.Fatalf("after commit must see exactly one complete replacement: current=%d retired=%d", current, previous)
	}
}

func TestAssistNativeUTF8BudgetMatchesFallback(t *testing.T) {
	app, _, _ := newAssistAtomicFixture(t)
	value, err := runAssistScript(app, `(() => {
 const writer=require(__hooks+"/lib/assist_writer.js");
 const values=["ASCII","中文","e\u0301","𰻞","a\\uEE00","\ud800","\udc00",JSON.stringify({text:"中𰻞e\u0301\ud800"})];
 const native=values.map(writer.utf8Bytes), binding=toBytes;
 globalThis.toBytes=undefined;
 const fallback=values.map(writer.utf8Bytes);
 globalThis.toBytes=binding;
 return JSON.stringify({native,fallback});
 })()`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct{ Native, Fallback []int }
	if err := json.Unmarshal([]byte(value.String()), &result); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Native, result.Fallback) || !reflect.DeepEqual(result.Native[:7], []int{5, 6, 3, 4, 7, 3, 3}) {
		t.Fatalf("native UTF-8 counting changed budget semantics: %s", value)
	}
}

func TestAssistPreparationCannotResurrectExpiredStage(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	value, err := runAssistScript(app, `(() => {
 const p=require(__hooks+"/lib/assist_publication.js");
 try { p.execute(dao,"rules","`+project+`","",()=>{
   p.cleanup(dao,Date.now()+2*60*60*1000);
   return {findings:[],events:[],derivations:[],kinds:["missing_field"],stageSizes:{findings:[],events:[],derivations:[]},summary:{}};
 }); return "unexpected success" } catch(e) { return JSON.stringify({status:e.status,reason:e.data?.reasonCode}) }
 })()`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(value.String(), `"status":409`) || !strings.Contains(value.String(), "ASSIST_BASIS_CHANGED") {
		t.Fatalf("expired preparation must conflict: %s", value)
	}
	if !reflect.DeepEqual(before, assistDatabaseState(t, app)) {
		t.Fatal("expired preparation replaced last complete publication")
	}
	markers, err := app.FindRecordsByFilter("assist_publications", `state="aborted"`, "", 0, 0)
	if err != nil || len(markers) != 1 || markers[0].GetString("failure_code") != "STAGING_EXPIRED" {
		t.Fatalf("expired marker must remain aborted: %v %v", markers, err)
	}
}

func TestAssistPersistedStageSurvivesReopenInvisible(t *testing.T) {
	app := newAssistVisibilityApp(t)
	_, _, page := newAssistVisibilityFixture(t, app)
	jsvm.MustRegister(app, jsvm.Config{HooksDir: "pb_hooks", MigrationsFilesPattern: `a^`})
	if err := runAssistWriter(app, "recomputeProject", page.GetString("project")); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	marker := visibilityPublication(t, app, page, "staging")
	finding := visibilityFinding(t, app, page, marker.Id, "")
	visibilityEvent(t, app, page, marker.Id, "machine_analysis", "machine")
	// Close all connections and reopen the persisted DB. This models restart
	// after the committed staging chunk, not a claim of process-kill coverage.
	if err := app.ResetBootstrapState(); err != nil {
		t.Fatal(err)
	}
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, assistDatabaseState(t, app)) {
		t.Fatal("reopen exposed unpublished payload")
	}
	if _, err := runAssistScript(app, `require(__hooks+"/lib/assist_publication.js").cleanup(dao)`); err != nil {
		t.Fatal(err)
	}
	if _, err := app.FindRecordById("review_findings", finding.Id); err != nil {
		t.Fatal("cleanup removed active staging work")
	}
	if _, err := runAssistScript(app, `require(__hooks+"/lib/assist_publication.js").cleanup(dao,Date.now()+2*60*60*1000)`); err != nil {
		t.Fatal(err)
	}
	if _, err := app.FindRecordById("review_findings", finding.Id); err == nil {
		t.Fatal("expired staging payload was not cleaned")
	}
	retained, err := app.FindRecordById("assist_publications", marker.Id)
	if err != nil || retained.GetString("state") != "aborted" {
		t.Fatal("expired marker was deleted or resurrected")
	}
	if !reflect.DeepEqual(before, assistDatabaseState(t, app)) {
		t.Fatal("reopen/cleanup changed published results")
	}
}

func TestAssistRuleBudgetStopsBeforeWholeResultAllocation(t *testing.T) {
	app, _, _ := newAssistAtomicFixture(t)
	value, err := runAssistScript(app, `(() => {
 const rules=require(__hooks+"/lib/assist_rules.js"), identity=require(__hooks+"/lib/assist_identity.js");
 const entries=Array.from({length:10},(_,i)=>({pageId:"p"+i,id:"p"+i,row:{"词条":"甲","拼音":"ka1","莆田IPA":"a𰻞","释义":"义"+i},pdfPage:1}));
 const ctx=rules.makeContext({});
 const expected=rules.runProjectRules(ctx,entries), observed=[];
 const actual=rules.runProjectRules(ctx,entries,item=>observed.push(item));
 let reserved=0, refused=false;
 try{rules.runProjectRules(ctx,entries,()=>{if(++reserved===3)throw Error("synthetic budget")})}catch(e){refused=e.message==="synthetic budget"}
 const original=identity.findIdentityConflicts(entries), guarded=identity.findIdentityConflicts(entries,new Set(),undefined,null,()=>{});
 let identityReserved=0, identityRefused=false;
 try{identity.findIdentityConflicts(entries,new Set(),undefined,null,()=>{if(++identityReserved===3)throw Error("synthetic budget")})}catch(e){identityRefused=e.message==="synthetic budget"}
 return JSON.stringify({same:JSON.stringify(expected)===JSON.stringify(actual)&&JSON.stringify(actual)===JSON.stringify(observed),reserved,refused,identitySame:JSON.stringify(original)===JSON.stringify(guarded),identityReserved,identityRefused});
 })()`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Same, Refused, IdentitySame, IdentityRefused bool
		Reserved, IdentityReserved                   int
	}
	if err = json.Unmarshal([]byte(value.String()), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Same || !result.Refused || result.Reserved != 3 || !result.IdentitySame || !result.IdentityRefused || result.IdentityReserved != 3 {
		t.Fatalf("budget changed successful results or accumulated whole result: %s", value)
	}
}

func TestAssistDerivedPublishPreservesNullEmptyAndProjectBoundary(t *testing.T) {
	app, project, _ := newAssistAtomicFixture(t)
	rows, err := app.FindRecordsByFilter("pages", "project={:project}", "page_number", 0, 0, dbx.Params{"project": project})
	if err != nil {
		t.Fatal(err)
	}
	_, _, foreign := newAssistVisibilityFixture(t, app)
	for _, row := range append(rows, foreign) {
		if _, err = app.DB().NewQuery(`UPDATE pages SET difficulty_tier='B',difficulty_basis_json='{}',difficulty_version='old',entry_identity_key='original',updated='2026-01-01 00:00:00.000Z' WHERE id={:id}`).Bind(dbx.Params{"id": row.Id}).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = app.DB().NewQuery(`CREATE TABLE _assist_test_page_updates(id TEXT); CREATE TRIGGER _assist_test_update AFTER UPDATE ON pages BEGIN INSERT INTO _assist_test_page_updates VALUES(NEW.id); END`).Execute(); err != nil {
		t.Fatal(err)
	}
	for _, scope := range []string{"rules", "identity"} {
		value, err := runAssistScript(app, `JSON.stringify(require(__hooks+"/lib/assist_publication.js").execute(dao,"`+scope+`","`+project+`","",()=>({
 findings:[],events:[],kinds:["missing_field"],derivations:[
 {page:"`+rows[0].Id+`",difficulty_tier:null,difficulty_basis_json:null,difficulty_version:"",entry_identity_key:""},
 {page:"`+rows[1].Id+`",difficulty_tier:"B",difficulty_basis_json:"{}",difficulty_version:"old",entry_identity_key:"original"},
 {page:"`+foreign.Id+`",difficulty_tier:"C",difficulty_basis_json:"{}",difficulty_version:"wrong",entry_identity_key:"wrong"}],
 stageSizes:{findings:[],events:[],derivations:[200,200,200]},summary:{}
})))`)
		if err != nil {
			t.Fatalf("%s: %v (%v)", scope, err, value)
		}
		first, err := app.FindRecordById("pages", rows[0].Id)
		if err != nil {
			t.Fatal(err)
		}
		if first.GetString("difficulty_tier") != "B" || first.GetString("difficulty_basis_json") != "{}" || first.GetString("difficulty_version") != "" {
			t.Fatal("NULL fallback or explicit empty version was changed")
		}
		if scope == "rules" && first.GetString("entry_identity_key") != "original" {
			t.Fatal("rules changed identity key")
		}
		if scope == "identity" && first.GetString("entry_identity_key") != "" {
			t.Fatal("identity lost explicit empty key")
		}
	}
	for _, id := range []string{rows[1].Id, foreign.Id} {
		row, err := app.FindRecordById("pages", id)
		if err != nil {
			t.Fatal(err)
		}
		if row.GetString("difficulty_tier") != "B" || row.GetString("difficulty_version") != "old" || row.GetString("entry_identity_key") != "original" || row.GetString("updated") != "2026-01-01 00:00:00.000Z" {
			t.Fatalf("unchanged/foreign page was touched: %s", id)
		}
	}
	var changed int
	if err = app.DB().NewQuery("SELECT COUNT(*) FROM _assist_test_page_updates").Row(&changed); err != nil {
		t.Fatal(err)
	}
	if changed != 2 {
		t.Fatalf("must update only one actual changed page per scope: %d", changed)
	}
}

func TestAssistDerivedPublishUsesSingleJoinPlan(t *testing.T) {
	app := newAssistVisibilityApp(t)
	for _, scope := range []string{"rules", "identity"} {
		value, err := runAssistScript(app, `require(__hooks+"/lib/assist_publication.js").derivationUpdateSQL("`+scope+`")`)
		if err != nil {
			t.Fatal(err)
		}
		var rows []struct {
			Detail string `db:"detail"`
		}
		if err = app.DB().NewQuery("EXPLAIN QUERY PLAN " + value.String()).Bind(dbx.Params{"publication": "synthetic", "project": "synthetic"}).All(&rows); err != nil {
			t.Fatal(err)
		}
		detail := ""
		for _, row := range rows {
			detail += row.Detail + "\n"
		}
		t.Logf("actual Go SQLite %s derived update plan:\n%s", scope, detail)
		if strings.Contains(detail, "CORRELATED SCALAR SUBQUERY") || !strings.Contains(detail, "SEARCH d ") || !strings.Contains(detail, "SEARCH p ") {
			t.Fatal("derived publication must join each staged row once")
		}
	}
}
