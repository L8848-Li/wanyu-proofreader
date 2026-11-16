package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fangji/backend/reviewbundle"
	"github.com/dop251/goja"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func deliveryMigration(t *testing.T, path string) (func(core.App) error, func(core.App) error) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	jsvm.BindCore(vm)
	var up, down func(core.App) error
	vm.Set("migrate", func(a, b func(core.App) error) { up, down = a, b })
	if _, err := vm.RunString(string(raw)); err != nil {
		t.Fatal(err)
	}
	return up, down
}

func deliveryArchiveFixture(t *testing.T, app core.App) reviewbundle.DeliverySnapshot {
	t.Helper()
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticDeliveryPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Synthetic rollback fixture")
	project.Set("admin", owner.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	return reviewbundle.DeliverySnapshot{Project: project.Id, ImportJob: "synthetic-job-one", ResultOf: "rb-synthetic", SourceSystem: "xiangsheng-jihe", SourceID: "synthetic", SourceVersion: "v1", RightsRef: "src-synthetic", Recipient: "synthetic-consumer", Purpose: "public_display", SelectionRef: "D-synthetic", SelectionRule: "synthetic", SelectionConfirmedBy: owner.Id, SelectionAuthority: "manual_handoff_pending_315", Operator: owner.Id, Reviewer: "synthetic-reviewer", Version: 1, Expected: reviewbundle.ScopeCounts{Adopted: 1}, Database: reviewbundle.ScopeCounts{Adopted: 1}, Declarations: []reviewbundle.Declaration{{EntryID: "one", Scope: "adopted"}}, Entries: []reviewbundle.ResultEntry{{EntryID: "one", ReviewedFields: []reviewbundle.ReviewedField{{Field: "headword", Value: "synthetic", Decision: "confirmed", Provenance: "proofread_round:2"}}}}}
}

func TestDeliveryMigrationRollbackGuardsBeforeSchemaChanges(t *testing.T) {
	for _, scenario := range []string{"independent-job-chains", "native-idempotency"} {
		t.Run(scenario, func(t *testing.T) {
			app := newSchemaTestApp(t)
			up, _ := deliveryMigration(t, "pb_migrations/1792281600_release_deliveries.js")
			if err := app.RunInTransaction(up); err != nil {
				t.Fatal(err)
			}
			up, down := deliveryMigration(t, "pb_migrations/1794203000_delivery_adoption.js")
			if err := app.RunInTransaction(up); err != nil {
				t.Fatal(err)
			}
			snap := deliveryArchiveFixture(t, app)
			request := ""
			if scenario == "native-idempotency" {
				request = "00000000-0000-4000-8000-000000000001"
			}
			if _, err := saveDeliveryArchive(app, snap, request, "synthetic"); err != nil {
				t.Fatal(err)
			}
			if scenario == "independent-job-chains" {
				snap.ImportJob = "synthetic-job-two"
				if _, err := saveDeliveryArchive(app, snap, "", ""); err != nil {
					t.Fatal(err)
				}
			}
			err := app.RunInTransaction(down)
			if err == nil || !strings.Contains(err.Error(), "Cannot") {
				t.Fatalf("unsafe downgrade accepted: %v", err)
			}
			c, _ := app.FindCollectionByNameOrId("release_deliveries")
			if c.Fields.GetByName("request_id") == nil {
				t.Fatal("rollback lost replay evidence fields")
			}
			indexes := strings.Join(c.Indexes, "\n")
			if !strings.Contains(indexes, "idx_delivery_job_version") || strings.Contains(indexes, "idx_delivery_version ON") {
				t.Fatalf("rollback changed indexes: %s", indexes)
			}
			expected := 1
			if scenario == "independent-job-chains" {
				expected = 2
			}
			count, _ := app.CountRecords("release_deliveries")
			if int(count) != expected {
				t.Fatal("rollback altered evidence")
			}
		})
	}
}

func TestDeliveryArchiveTransactionFailureCleansFiles(t *testing.T) {
	for _, scenario := range []string{"outer-transaction", "save-hook", "security-audit"} {
		t.Run(scenario, func(t *testing.T) {
			app := newSchemaTestApp(t)
			up, _ := deliveryMigration(t, "pb_migrations/1792281600_release_deliveries.js")
			if err := app.RunInTransaction(up); err != nil {
				t.Fatal(err)
			}
			up, _ = deliveryMigration(t, "pb_migrations/1794203000_delivery_adoption.js")
			if err := app.RunInTransaction(up); err != nil {
				t.Fatal(err)
			}
			snap := deliveryArchiveFixture(t, app)
			injected := errors.New("synthetic failure after file persistence")
			if scenario == "security-audit" {
				up, _ = deliveryMigration(t, "pb_migrations/1794201000_account_security.js")
				if err := app.RunInTransaction(up); err != nil {
					t.Fatal(err)
				}
				app.OnRecordCreate("security_events").BindFunc(func(_ *core.RecordEvent) error { return injected })
			}
			if scenario == "save-hook" {
				app.OnRecordCreate("release_deliveries").BindFunc(func(e *core.RecordEvent) error {
					if err := e.Next(); err != nil {
						return err
					}
					return injected
				})
			}
			err := app.RunInTransaction(func(tx core.App) error {
				var requests []*core.RequestEvent
				if scenario == "security-audit" {
					requests = append(requests, nil)
				}
				if _, err := saveDeliveryArchive(tx, snap, "", "", requests...); err != nil {
					return err
				}
				return injected
			})
			if !errors.Is(err, injected) {
				t.Fatalf("injected error lost: %v", err)
			}
			count, _ := app.CountRecords("release_deliveries")
			if count != 0 {
				t.Fatal("failed archive created a database record")
			}
			var archives []string
			_ = filepath.WalkDir(app.DataDir(), func(path string, d fs.DirEntry, err error) error {
				if err == nil && !d.IsDir() && strings.HasSuffix(path, ".zip") {
					archives = append(archives, path)
				}
				return nil
			})
			if len(archives) != 0 {
				t.Fatalf("transaction leaked archives: %v", archives)
			}
		})
	}
}

func TestLegacyDeliveryRechecksQueuedActorInTransaction(t *testing.T) {
	for _, change := range []string{"token-key", "platform-role"} {
		t.Run(change, func(t *testing.T) {
			app := newSchemaTestApp(t)
			for _, path := range []string{"pb_migrations/1792281600_release_deliveries.js", "pb_migrations/1794203000_delivery_adoption.js"} {
				up, _ := deliveryMigration(t, path)
				if err := app.RunInTransaction(up); err != nil {
					t.Fatal(err)
				}
			}
			actor := deliveryArchiveFixture(t, app)
			target := deliveryArchiveFixture(t, app)
			archive, err := saveDeliveryArchive(app, target, "", "")
			if err != nil {
				t.Fatal(err)
			}
			snapshot, _ := app.FindRecordById("users", actor.Operator)
			current, _ := app.FindRecordById("users", actor.Operator)
			expected := 401
			if change == "token-key" {
				current.RefreshTokenKey()
			} else {
				current.Set("role", "user")
				expected = 403
			}
			if err := app.Save(current); err != nil {
				t.Fatal(err)
			}
			s := newDeliveryService(app, "pb_hooks")
			app.OnServe().BindFunc(func(e *core.ServeEvent) error {
				e.Router.POST("/test-queued/{action}", func(c *core.RequestEvent) error {
					// Model a request authenticated before the actor's state changed.
					c.Auth = snapshot
					c.Request.SetPathValue("projectId", target.Project)
					c.Request.SetPathValue("deliveryId", archive.Id)
					switch c.Request.PathValue("action") {
					case "preflight":
						return s.deliveryPreflight(c)
					case "create":
						return s.createDelivery(c)
					default:
						return s.appendDeliveryEvent(c)
					}
				})
				return e.Next()
			})
			h := accountTestRouter(t, app)
			for _, action := range []string{"preflight", "create", "event"} {
				body := map[string]any{"kind": "receipt", "status": "success", "affected": 1, "reason": "synthetic", "reviewer": "synthetic-reviewer"}
				accountTestRequest(t, h, "POST", "/test-queued/"+action, "", body, expected)
			}
			packages, _ := app.CountRecords("release_deliveries")
			events, _ := app.CountRecords("release_events")
			if packages != 1 || events != 0 {
				t.Fatalf("stale actor mutated delivery evidence: packages=%d events=%d", packages, events)
			}
		})
	}
}

func TestDeliveryPagedReadsUseSmallSummariesAndLegacyFallback(t *testing.T) {
	app := newSchemaTestApp(t)
	for _, name := range []string{"1792281600_release_deliveries.js", "1794203000_delivery_adoption.js"} {
		up, _ := deliveryMigration(t, "pb_migrations/"+name)
		if err := app.RunInTransaction(up); err != nil {
			t.Fatal(err)
		}
	}
	snap := deliveryArchiveFixture(t, app)
	first, err := saveDeliveryArchive(app, snap, "", "")
	if err != nil {
		t.Fatal(err)
	}
	snap.Recipient = "synthetic-second"
	if _, err := saveDeliveryArchive(app, snap, "", ""); err != nil {
		t.Fatal(err)
	}
	s := newDeliveryService(app, "pb_hooks")
	s.registerDeliveries()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	owner, _ := app.FindRecordById("users", snap.Operator)
	token, _ := owner.NewAuthToken()
	var queries []string
	db := app.ConcurrentDB().(*dbx.DB)
	old := db.QueryLogFunc
	db.QueryLogFunc = func(_ context.Context, _ time.Duration, query string, _ *sql.Rows, _ error) {
		queries = append(queries, query)
	}
	defer func() { db.QueryLogFunc = old }()
	request := func() {
		req := httptest.NewRequest(http.MethodGet, "/api/fangji/projects/"+snap.Project+"/deliveries?page=1&perPage=1", nil)
		req.Header.Set("Authorization", token)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, req)
		if response.Code != 200 {
			t.Fatalf("paged list failed: %d %s", response.Code, response.Body.String())
		}
		var result struct {
			Items      []map[string]any
			TotalItems int
			Metrics    struct {
				PackageCount         int            `json:"package_count"`
				ReconciliationStates map[string]int `json:"reconciliation_states"`
			}
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Items) != 1 || result.TotalItems != 2 || result.Metrics.PackageCount != 2 || result.Metrics.ReconciliationStates["consistent"] != 2 {
			t.Fatalf("page lost global metrics: %s", response.Body.String())
		}
	}
	request()
	fullReads := 0
	smallRead := false
	for _, query := range queries {
		if strings.Contains(query, "SELECT `release_deliveries`.*") {
			fullReads++
			if !strings.Contains(query, "LIMIT 1") {
				t.Fatalf("unbounded snapshot read: %s", query)
			}
		}
		if strings.Contains(query, "`reconciliation_json`") && !strings.Contains(query, "`snapshot`") {
			smallRead = true
		}
	}
	if fullReads != 1 || !smallRead {
		t.Fatalf("expected one page snapshot query plus small metadata query: %v", queries)
	}
	// Emulate pre-migration evidence: optional cache is absent, immutable snapshot
	// stays authoritative, and GET must not backfill or rewrite it.
	before := first.GetString("snapshot")
	if _, err := app.DB().NewQuery("UPDATE release_deliveries SET reconciliation_json='' WHERE id={:id}").Bind(dbx.Params{"id": first.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	request()
	retained, _ := app.FindRecordById("release_deliveries", first.Id)
	if retained.GetString("snapshot") != before || retained.GetString("reconciliation_json") != "" {
		t.Fatal("legacy read rewrote evidence")
	}
}
