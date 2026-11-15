package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/require"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

// Independently expressed business-current query; raw superseded_at alone is
// intentionally not authority after migration 4700.
const assistCurrentSQLForTest = `review_findings.superseded_at='' AND
(review_findings.assist_publication='' OR EXISTS(SELECT 1 FROM assist_publications p WHERE p.id=review_findings.assist_publication AND p.state='published')) AND
NOT EXISTS(SELECT 1 FROM _assist_finding_retirements r JOIN assist_publications p ON p.id=r.publication AND p.state='published' WHERE r.finding=review_findings.id)`

// Run the actual JS writer and rules against PocketBase/SQLite. The injected
// failure is a database create hook, not a replacement for the production code.
func newAssistAtomicFixture(t *testing.T) (core.App, string, string) {
	t.Helper()
	app := newSchemaTestApp(t)
	for _, name := range []string{
		"1789113600_review_findings.js", "1789113700_page_difficulty.js",
		"1789113800_entry_identity.js", "1789200000_source_registry.js", "1789200100_column_roles.js",
		"1792627200_source_fidelity.js", "1794204700_assist_publications.js",
		"1794442600_assist_tone_count_fields.js",
	} {
		vm := goja.New()
		jsvm.BindCore(vm)
		var up func(core.App) error
		vm.Set("migrate", func(apply, _ func(core.App) error) { up = apply })
		source, err := os.ReadFile(filepath.Join("pb_migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = vm.RunString(string(source)); err != nil {
			t.Fatal(err)
		}
		if err = app.RunInTransaction(up); err != nil {
			t.Fatal(err)
		}
	}
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticAtomicPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Synthetic atomic findings")
	project.Set("access_mode", "members_only")
	project.Set("admin", owner.Id)
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	pageID := ""
	for i := range 2 {
		page := core.NewRecord(pages)
		page.Set("project", project.Id)
		page.Set("page_number", i+1)
		page.Set("pdf_page", 1)
		page.Set("status", "pending")
		page.Set("proofread_round", 1)
		page.Set("ocr_row_json", fmt.Sprintf(`{"词条":"甲、乙","拼音":"ka1","莆田IPA":"a𰻞\uEE009999","释义":"合成%d"}`, i))
		if err := app.Save(page); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			pageID = page.Id
		}
	}
	return app, project.Id, pageID
}

func runAssistWriter(app core.App, method, id string) error {
	_, err := runAssistScript(app, `require(__hooks + "/lib/assist_writer.js").`+method+`(dao, "`+id+`")`)
	return err
}

func runAssistScript(app core.App, script string) (goja.Value, error) {
	vm := goja.New()
	new(require.Registry).Enable(vm)
	jsvm.BindCore(vm)
	jsvm.BindDbx(vm)
	jsvm.BindApis(vm)
	jsvm.BindSecurity(vm)
	jsvm.BindOS(vm)
	hooks, _ := filepath.Abs("pb_hooks")
	vm.Set("__hooks", hooks)
	vm.Set("dao", app)
	vm.Set("console", map[string]any{"log": func(...any) {}, "warn": func(...any) {}})
	return vm.RunString(script)
}

func assistDatabaseState(t *testing.T, app core.App) map[string]string {
	t.Helper()
	state := map[string]string{}
	for _, name := range []string{"pages", "review_findings", "verification_events"} {
		rows := []*core.Record{}
		query := app.RecordQuery(name).OrderBy("id")
		if name != "pages" {
			query.AndWhere(dbx.NewExp("assist_publication='' OR EXISTS(SELECT 1 FROM assist_publications p WHERE p.id=" + name + ".assist_publication AND p.state='published')"))
		}
		err := query.All(&rows)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(rows)
		if err != nil {
			t.Fatal(err)
		}
		state[name] = string(data)
	}
	return state
}

func TestAssistBatchFailurePreservesPreviousFindings(t *testing.T) {
	for _, method := range []string{"recomputePage", "recomputeProject", "recomputeIdentity"} {
		t.Run(method, func(t *testing.T) {
			app, project, page := newAssistAtomicFixture(t)
			id := project
			if method == "recomputePage" {
				id = page
			}
			if err := runAssistWriter(app, method, id); err != nil {
				t.Fatal(err)
			}
			before := assistDatabaseState(t, app)
			created := 0
			hook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
				created++
				if created == 2 {
					return errors.New("synthetic second-finding write failure")
				}
				return e.Next()
			})
			err := runAssistWriter(app, method, id)
			app.OnRecordCreate("review_findings").Unbind(hook)
			if err == nil || !strings.Contains(err.Error(), "synthetic second-finding") {
				t.Fatalf("expected the actual second database insert to fail, got %v", err)
			}
			after := assistDatabaseState(t, app)
			for name, want := range before {
				if after[name] != want {
					t.Errorf("failed %s changed committed %s; the previous batch must remain complete", method, name)
				}
			}
		})
	}
}

func TestAssistConcurrentBatchesKeepExactCharacterResults(t *testing.T) {
	app, project, page := newAssistAtomicFixture(t)
	if err := runAssistWriter(app, "recomputeProject", project); err != nil {
		t.Fatal(err)
	}
	projection := func() []string {
		rows := []*core.Record{}
		err := app.RecordQuery("review_findings").AndWhere(dbx.NewExp(assistCurrentSQLForTest)).OrderBy("page", "field_name", "kind", "message_key").All(&rows)
		if err != nil {
			t.Fatal(err)
		}
		values := make([]string, len(rows))
		for i, row := range rows {
			data, err := json.Marshal([]string{row.GetString("page"), row.GetString("field_name"), row.GetString("kind"), row.GetString("message_key"), row.GetString("params_json"), row.GetString("evidence_json")})
			if err != nil {
				t.Fatal(err)
			}
			values[i] = string(data)
		}
		return values
	}
	want := projection()
	if !strings.Contains(strings.Join(want, ""), "non_ipa_range_codepoints") {
		t.Fatal("fixture must exercise repertoire findings, including the private-use character")
	}
	for wave := range 4 {
		start := make(chan struct{})
		results := make(chan error, 8)
		var ready sync.WaitGroup
		ready.Add(8)
		for i := range 8 {
			go func() {
				ready.Done()
				<-start
				if i%2 == 0 {
					results <- runAssistWriter(app, "recomputePage", page)
				} else {
					results <- runAssistWriter(app, "recomputeProject", project)
				}
			}()
		}
		ready.Wait()
		close(start)
		successes := 0
		for range 8 {
			err := <-results
			if err == nil {
				successes++
			} else if !strings.Contains(err.Error(), "分析依据已变化") && !strings.Contains(err.Error(), "已有全量辅助分析正在准备") {
				t.Fatal(err)
			}
		}
		if successes == 0 {
			t.Fatal("concurrent batch must publish at least one complete result")
		}
		if got := projection(); !reflect.DeepEqual(got, want) {
			t.Fatalf("wave %d changed exact finding/character evidence: got %d rows, want %d", wave, len(got), len(want))
		}
	}
}

func TestAssistNestedTransactionKeepsCallerRollback(t *testing.T) {
	app, _, page := newAssistAtomicFixture(t)
	if err := runAssistWriter(app, "recomputePage", page); err != nil {
		t.Fatal(err)
	}
	before := assistDatabaseState(t, app)
	rollback := errors.New("synthetic caller rollback")
	err := app.RunInTransaction(func(tx core.App) error {
		if err := runAssistWriter(tx, "recomputePage", page); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
		t.Fatal("nested batch escaped the caller's transaction")
	}
}

func TestAssistCaughtNestedFailureKeepsBusinessCommit(t *testing.T) {
	for _, failure := range []string{"second_finding", "publish_save"} {
		t.Run(failure, func(t *testing.T) {
			app, project, page := newAssistAtomicFixture(t)
			if err := runAssistWriter(app, "recomputePage", page); err != nil {
				t.Fatal(err)
			}
			before := assistDatabaseState(t, app)
			var tombstonesBefore int
			if err := app.DB().NewQuery("SELECT COUNT(*) FROM _assist_finding_retirements").Row(&tombstonesBefore); err != nil {
				t.Fatal(err)
			}
			created := 0
			createHook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error {
				created++
				if failure == "second_finding" && created == 2 {
					return errors.New("synthetic nested finding failure")
				}
				return e.Next()
			})
			publishHook := app.OnRecordUpdate("assist_publications").BindFunc(func(e *core.RecordEvent) error {
				if failure == "publish_save" && e.Record.GetString("state") == "published" {
					return errors.New("synthetic nested publication failure")
				}
				return e.Next()
			})
			err := app.RunInTransaction(func(tx core.App) error {
				business, err := tx.FindRecordById("projects", project)
				if err != nil {
					return err
				}
				business.Set("name", "outer business committed")
				if err = tx.Save(business); err != nil {
					return err
				}
				result, err := runAssistScript(tx, `require(__hooks+"/lib/assist_writer.js").safeRecomputePage(dao,"`+page+`",null,"synthetic")`)
				if err != nil {
					return err
				}
				if !goja.IsNull(result) {
					return fmt.Errorf("safe wrapper must expose failure as null, got %v", result)
				}
				return nil
			})
			app.OnRecordCreate("review_findings").Unbind(createHook)
			app.OnRecordUpdate("assist_publications").Unbind(publishHook)
			if err != nil {
				t.Fatal(err)
			}
			business, err := app.FindRecordById("projects", project)
			if err != nil || business.GetString("name") != "outer business committed" {
				t.Fatalf("business did not commit: %v", err)
			}
			if !reflect.DeepEqual(assistDatabaseState(t, app), before) {
				t.Fatal("caught optional analysis failure partially changed committed findings/events/tier")
			}
			var tombstonesAfter int
			if err = app.DB().NewQuery("SELECT COUNT(*) FROM _assist_finding_retirements").Row(&tombstonesAfter); err != nil {
				t.Fatal(err)
			}
			if tombstonesAfter != tombstonesBefore {
				t.Fatal("caught publication failure left retirement tombstones")
			}
		})
	}
}

// Explicit local contention diagnostic, excluded from ordinary CI runs. It
// uses the existing scale fixture's 1/4 shared identities and records writer
// wait separately; these timings are not production capacity acceptance.
func TestAssistBatchScaleContention(t *testing.T) {
	if os.Getenv("ASSIST_SCALE_10K") != "1" {
		t.Skip("set ASSIST_SCALE_10K=1 for the synthetic 10k writer-wait diagnostic")
	}
	rows := 10000
	if raw := os.Getenv("ASSIST_SCALE_ROWS"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || (value != 10000 && value != 20000) {
			t.Fatal("ASSIST_SCALE_ROWS must be 10000 or 20000")
		}
		rows = value
	}
	var app core.App
	var project string
	schemaMode := os.Getenv("ASSIST_SCALE_SCHEMA")
	if schemaMode == "full" {
		app = newAssistVisibilityApp(t)
		_, _, firstPage := newAssistVisibilityFixture(t, app)
		project = firstPage.GetString("project")
		jsvm.MustRegister(app, jsvm.Config{HooksDir: "pb_hooks", MigrationsFilesPattern: `a^`})
	} else if schemaMode == "" || schemaMode == "minimal" {
		schemaMode = "minimal"
		app, project, _ = newAssistAtomicFixture(t)
	} else {
		t.Fatal("ASSIST_SCALE_SCHEMA must be minimal or full")
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	if err := app.RunInTransaction(func(tx core.App) error {
		existing, err := tx.FindRecordsByFilter("pages", "", "page_number", 0, 0)
		if err != nil {
			return err
		}
		for i := range rows {
			page := core.NewRecord(pages)
			if i < len(existing) {
				page = existing[i]
			}
			page.Set("project", project)
			page.Set("page_number", i+1)
			page.Set("pdf_page", i/5+1)
			page.Set("status", "pending")
			page.Set("proofread_round", 1)
			group := i % (rows / 4)
			page.Set("ocr_row_json", fmt.Sprintf(`{"词条":"词%d","拼音":"pin%d","莆田IPA":"ipa%d","释义":"义%d"}`, group, group, group, i))
			if err := tx.Save(page); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	probe := core.NewBaseCollection("assist_atomic_write_probe")
	if err := app.Save(probe); err != nil {
		t.Fatal(err)
	}
	for index, method := range []string{"recomputeProject", "recomputeIdentity", "recomputeProject", "recomputeIdentity"} {
		started := time.Now()
		var firstWrite time.Time
		var once sync.Once
		hook := app.OnRecordCreate("review_findings").BindFunc(func(e *core.RecordEvent) error { once.Do(func() { firstWrite = time.Now() }); return e.Next() })
		type result struct {
			raw string
			err error
		}
		completed := make(chan result, 1)
		go func() {
			value, err := runAssistScript(app, `JSON.stringify(require(__hooks+"/lib/assist_writer.js").`+method+`(dao,"`+project+`"))`)
			if err != nil {
				completed <- result{err: err}
				return
			}
			completed <- result{raw: value.String()}
		}()
		stopResources := startAssistResourceSampler()
		defer stopResources()
		maxWait := time.Duration(0)
		maxWrite := time.Duration(0)
		samples := 0
		ticker := time.NewTicker(5 * time.Millisecond)
		timeout := time.NewTimer(3 * time.Minute)
		var outcome result
	wait:
		for {
			select {
			case outcome = <-completed:
				break wait
			case <-timeout.C:
				t.Fatal("scale publication exceeded diagnostic limit")
			case <-ticker.C:
				writeStarted := time.Now()
				var acquired time.Time
				if err := app.RunInTransaction(func(tx core.App) error { acquired = time.Now(); return tx.Save(core.NewRecord(probe)) }); err != nil {
					t.Fatal(err)
				}
				if wait := acquired.Sub(writeStarted); wait > maxWait {
					maxWait = wait
				}
				if duration := time.Since(writeStarted); duration > maxWrite {
					maxWrite = duration
				}
				samples++
			}
		}
		ticker.Stop()
		timeout.Stop()
		ended := time.Now()
		resources := stopResources()
		app.OnRecordCreate("review_findings").Unbind(hook)
		if outcome.err != nil {
			t.Fatal(outcome.err)
		}
		summary := map[string]any{}
		if err := json.Unmarshal([]byte(outcome.raw), &summary); err != nil {
			t.Fatal(err)
		}
		var persistedJSONBytes int64
		if err := app.DB().NewQuery(`SELECT COALESCE(SUM(bytes),0) FROM (
          SELECT length(CAST(verification_context_json AS BLOB))+length(CAST(params_json AS BLOB))+length(CAST(evidence_json AS BLOB)) AS bytes FROM review_findings WHERE assist_publication={:publication}
          UNION ALL SELECT length(CAST(context_json AS BLOB))+length(CAST(payload_json AS BLOB)) FROM verification_events WHERE assist_publication={:publication}
          UNION ALL SELECT COALESCE(length(CAST(difficulty_basis_json AS BLOB)),0)+COALESCE(length(CAST(entry_identity_key AS BLOB)),0) FROM _assist_page_derivations WHERE publication={:publication}
        )`).Bind(dbx.Params{"publication": summary["publication"]}).Row(&persistedJSONBytes); err != nil {
			t.Fatal(err)
		}
		metrics, _ := json.Marshal(map[string]any{
			"method": method, "iteration": index/2 + 1, "rows": rows, "schema_mode": schemaMode, "dev_mode": app.IsDev(), "total_ms": ended.Sub(started).Milliseconds(),
			"resources":   resources,
			"input_bytes": summary["input_bytes"], "preparation_bytes": summary["preparation_bytes"], "estimated_payload_bytes": summary["estimated_payload_bytes"], "persisted_json_bytes": persistedJSONBytes,
			"pre_stage_ms": firstWrite.Sub(started).Milliseconds(), "probe_samples": samples, "probe_interval_ms": 5,
			"concurrent_writer_wait_max_ms": float64(maxWait.Microseconds()) / 1000,
			"concurrent_write_total_max_ms": float64(maxWrite.Microseconds()) / 1000,
			"publication_metrics":           summary["publication_metrics"], "findings": summary["findings"], "superseded": summary["superseded"],
		})
		t.Logf("ASSIST_STAGED_SCALE %s", metrics)
		if resources["status"] != "complete" {
			t.Errorf("resource evidence incomplete: %v", resources)
		}
		if maxWait > 500*time.Millisecond {
			t.Errorf("%s independent writer waited %v > 500ms engineering target", method, maxWait)
		}
		measured := summary["publication_metrics"].(map[string]any)
		if measured["max_transaction_ms"].(float64) > 500 {
			t.Errorf("%s held a staging/final write transaction >500ms: %v", method, measured)
		}
	}
}

// Sampling runs independently of the write probe, so a blocked writer cannot
// silently suppress memory observations. Actual sample gap and failed ps reads
// remain explicit; unavailable RSS is null, never a misleading zero.
func startAssistResourceSampler() func() map[string]any {
	done := make(chan struct{})
	finished := make(chan struct{})
	var once sync.Once
	result := map[string]any{}
	go func() {
		defer close(finished)
		var memory runtime.MemStats
		var heapStart, heapMax uint64
		var rssMax int64
		samples, rssSamples, rssErrors := 0, 0, 0
		var last time.Time
		maxGap := time.Duration(0)
		sample := func() {
			now := time.Now()
			if !last.IsZero() && now.Sub(last) > maxGap {
				maxGap = now.Sub(last)
			}
			last = now
			runtime.ReadMemStats(&memory)
			if samples == 0 {
				heapStart = memory.HeapAlloc
			}
			if memory.HeapAlloc > heapMax {
				heapMax = memory.HeapAlloc
			}
			samples++
			raw, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(os.Getpid())).Output()
			if err != nil {
				rssErrors++
				return
			}
			kb, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
			if err != nil {
				rssErrors++
				return
			}
			rssSamples++
			if kb*1024 > rssMax {
				rssMax = kb * 1024
			}
		}
		sample()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				sample()
			case <-done:
				result["heap_start_bytes"] = heapStart
				result["heap_sampled_max_bytes"] = heapMax
				result["rss_sampled_max_bytes"] = nil
				if rssSamples > 0 {
					result["rss_sampled_max_bytes"] = rssMax
				}
				result["sample_count"] = samples
				result["rss_sample_count"] = rssSamples
				result["rss_sample_errors"] = rssErrors
				result["target_interval_ms"] = 1000
				result["max_sample_gap_ms"] = float64(maxGap.Microseconds()) / 1000
				// Evidence completeness tolerance, not a product latency target.
				result["maximum_evidence_gap_ms"] = 2500
				result["status"] = "complete"
				if rssSamples == 0 || rssErrors > 0 || maxGap > 2500*time.Millisecond {
					result["status"] = "incomplete"
				}
				return
			}
		}
	}()
	return func() map[string]any { once.Do(func() { close(done); <-finished }); return result }
}
