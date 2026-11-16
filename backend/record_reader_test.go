package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func TestRecordReadSnapshotMatchesPocketBaseAndRejectsWrites(t *testing.T) {
	app, owner, page := newAssistVisibilityFixture(t, newAssistVisibilityApp(t))
	want, _ := app.FindRecordById("pages", page.Id)
	app.ConcurrentDB().(*dbx.DB).DB().SetMaxOpenConns(1)
	err := withRecordReadSnapshot(context.Background(), app, func(reader recordReader) error {
		got, err := reader.FindRecordById("pages", page.Id)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(got.PublicExport(), want.PublicExport()) {
			t.Fatalf("record decoding differs: got %v, want %v", got.PublicExport(), want.PublicExport())
		}
		auth, err := reader.FindRecordById("users", owner.Id)
		if err != nil || auth.TokenKey() != owner.TokenKey() {
			t.Fatalf("auth fields were not decoded: %v", err)
		}
		records, err := reader.FindRecordsByFilter("pages", "project.admin={:owner}", "page_number,id", 1, 0, dbx.Params{"owner": owner.Id})
		if err != nil || len(records) != 1 || records[0].Id != page.Id {
			t.Fatalf("relation query: %v %v", records, err)
		}
		var projection []core.Record
		if err := reader.RecordQuery("pages").Select("id", "ocr_row_json").All(&projection); err != nil || len(projection) != 1 || projection[0].GetString("ocr_row_json") != want.GetString("ocr_row_json") {
			t.Fatalf("projected record slice: %v %v", projection, err)
		}
		if _, err := app.NonconcurrentDB().NewQuery("UPDATE pages SET ocr_text='concurrently changed' WHERE id={:page}").Bind(dbx.Params{"page": page.Id}).Execute(); err != nil {
			return err
		}
		old, err := reader.FindFirstRecordByFilter("pages", "id={:id}", dbx.Params{"id": page.Id})
		if err != nil || old.GetString("ocr_text") != want.GetString("ocr_text") {
			t.Fatalf("mixed record snapshots: %v %v", old, err)
		}
		if _, err := reader.DB().NewQuery("UPDATE pages SET ocr_text='forbidden'").Execute(); err == nil {
			t.Fatal("read model allowed a write")
		}
		if _, err := reader.FindRecordById("does_not_exist", page.Id); err == nil {
			t.Fatal("invalid collection silently accepted")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestProjectReadEndpointsDoNotWaitForWriter(t *testing.T) {
	app, owner, page := newAssistVisibilityFixture(t, newAssistVisibilityApp(t))
	page.Set("status", "approved")
	page.Set("verification_basis", "superseded synthetic basis")
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	jobs, _ := app.FindCollectionByNameOrId("import_jobs")
	job := core.NewRecord(jobs)
	job.Set("project", page.GetString("project"))
	job.Set("mode", "skip_invalid")
	job.Set("status", "completed")
	if err := app.SaveNoValidate(job); err != nil {
		t.Fatal(err)
	}
	deliveries, _ := app.FindCollectionByNameOrId("release_deliveries")
	delivery := core.NewRecord(deliveries)
	delivery.Set("project", page.GetString("project"))
	delivery.Set("import_job", job.Id)
	delivery.Set("snapshot", `{}`)
	if err := app.SaveNoValidate(delivery); err != nil {
		t.Fatal(err)
	}
	s := newImportService(app.(*pocketbase.PocketBase))
	t.Cleanup(s.imageCancel)
	s.deliveryHooksDir, _ = filepath.Abs("pb_hooks")
	s.registerManagerTodos()
	s.registerProjectWorkflow()
	s.registerBatchReports()
	s.registerAdoption()
	s.registerDeliveries(s.deliveryHooksDir)
	h := accountTestRouter(t, app)
	token, _ := owner.NewAuthToken()
	// Any record read escaping the snapshot would also deadlock this reader pool.
	app.ConcurrentDB().(*dbx.DB).DB().SetMaxOpenConns(1)
	writer, err := app.NonconcurrentDB().(*dbx.DB).Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	if _, err := writer.NewQuery("UPDATE pages SET ocr_text='uncommitted synthetic content' WHERE id={:page}").Bind(dbx.Params{"page": page.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	base := "/api/fangji/projects/" + page.GetString("project")
	for _, path := range []string{
		"/api/fangji/manager-todos", base + "/workflow", base + "/batch-reports/" + job.Id,
		base + "/adoption-batches", base + "/deliveries?page=1", "/api/fangji/deliveries/" + delivery.Id + "/events",
	} {
		t.Run(path, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			request := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
			request.Header.Set("Authorization", token)
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				response := httptest.NewRecorder()
				h.ServeHTTP(response, request)
				result <- response
			}()
			select {
			case response := <-result:
				if response.Code != 200 || strings.Contains(response.Body.String(), "uncommitted synthetic content") {
					t.Fatalf("read while writer held: %d %s", response.Code, response.Body.String())
				}
				if strings.Contains(response.Body.String(), `"state":"unknown"`) {
					t.Fatalf("source-review helper escaped or failed in snapshot: %s", response.Body.String())
				}
			case <-ctx.Done():
				writer.Rollback()
				select {
				case <-result:
				case <-time.After(3 * time.Second):
				}
				t.Fatal("read waited for writer or acquired another snapshot connection")
			}
		})
	}
}
