package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestValidateRouteDoesNotChangeRecordCounts(t *testing.T) {
	app := newSchemaTestApp(t)
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.Set("username", "bundle-validator")
	user.Set("role", "user")
	user.Set("must_change_password", false)
	user.SetPassword("BundleTest12345!")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	token, err := user.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	registerBundleValidation(app)
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
	zipPath := "reviewbundle/testdata/review-bundle-v0/inbound.zip"
	payload, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{"projects", "pages", "import_jobs", "users"}
	before := map[string]int64{}
	for _, name := range names {
		count, err := app.CountRecords(name)
		if err != nil {
			t.Fatal(err)
		}
		before[name] = count
	}
	post := func(auth string) *httptest.ResponseRecorder {
		t.Helper()
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("bundle", "inbound.zip")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(payload); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/fangji/bundles/validate", &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	anonymous := post("")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status=%d body=%s", anonymous.Code, anonymous.Body.String())
	}
	for i := 0; i < 2; i++ {
		rec := post(token)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var report map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
			t.Fatal(err)
		}
		if report["ok"] != true {
			t.Fatalf("%s", rec.Body.String())
		}
	}
	for _, name := range names {
		count, err := app.CountRecords(name)
		if err != nil {
			t.Fatal(err)
		}
		if count != before[name] {
			t.Fatalf("%s changed from %d to %d", name, before[name], count)
		}
	}
	if before["users"] != 1 {
		t.Fatalf("expected the test user only, got %d", before["users"])
	}
}
