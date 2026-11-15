package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// Reading the request body happens after initial authorization and before the
// write transaction. Change authority there without a timing-dependent race.
type authorityChangeBody struct {
	io.Reader
	once   sync.Once
	change func()
}

func (r *authorityChangeBody) Read(p []byte) (int, error) {
	r.once.Do(r.change)
	return r.Reader.Read(p)
}

func TestProjectWritesRecheckAuthorityBeforeSaving(t *testing.T) {
	for _, endpoint := range []string{"content", "normalization"} {
		for _, change := range []string{"remove_manager", "demote_manager", "transfer_owner", "demote_admin", "logout", "password", "initial_password"} {
			t.Run(endpoint+"/"+change, func(t *testing.T) {
				app, owner, page := newAssistVisibilityFixture(t, newAssistVisibilityApp(t))
				users, _ := app.FindCollectionByNameOrId("users")
				actor := core.NewRecord(users)
				actor.Set("name", "Synthetic project manager")
				actor.Set("role", "user")
				if change == "demote_admin" {
					actor.Set("role", "platform_admin")
				}
				actor.SetPassword("SyntheticAuthority123!")
				if err := app.Save(actor); err != nil {
					t.Fatal(err)
				}
				project, _ := app.FindRecordById("projects", page.GetString("project"))
				members, _ := app.FindCollectionByNameOrId("project_memberships")
				member := core.NewRecord(members)
				member.Set("project", project.Id)
				member.Set("user", actor.Id)
				member.Set("role", "manager")
				member.Set("source", "assigned")
				member.Set("created_by", owner.Id)
				if change == "transfer_owner" {
					project.Set("admin", actor.Id)
					if err := app.Save(project); err != nil {
						t.Fatal(err)
					}
				} else if change != "demote_admin" {
					if err := app.Save(member); err != nil {
						t.Fatal(err)
					}
				}
				s := newImportService(app.(*pocketbase.PocketBase))
				t.Cleanup(s.imageCancel)
				s.registerPageContent()
				app.OnServe().BindFunc(func(e *core.ServeEvent) error {
					e.Router.POST("/test/normalization/{pageId}", s.decideNormalization).Bind(apis.RequireAuth("users"))
					return e.Next()
				})
				h := accountTestRouter(t, app)
				token, _ := actor.NewAuthToken()
				want := http.StatusForbidden
				changed := false
				changeAuthority := func() {
					changed = true
					var err error
					switch change {
					case "remove_manager":
						err = app.Delete(member)
					case "demote_manager":
						member.Set("role", "proofreader")
						err = app.Save(member)
					case "transfer_owner":
						project.Set("admin", owner.Id)
						err = app.Save(project)
					case "demote_admin":
						actor.Set("role", "user")
						err = app.Save(actor)
					case "logout":
						want = http.StatusUnauthorized
						actor.RefreshTokenKey()
						err = app.Save(actor)
					case "password":
						want = http.StatusUnauthorized
						actor.SetPassword("SyntheticChangedPassword123!")
						err = app.Save(actor)
					case "initial_password":
						actor.Set("must_change_password", true)
						err = app.Save(actor)
					}
					if err != nil {
						t.Fatal(err)
					}
				}
				path := "/api/fangji/projects/" + project.Id + "/pages/" + page.Id + "/content"
				payload := map[string]string{"rowJson": `{"词条":"changed"}`, "headersJson": `["词条"]`, "expectedUpdated": page.GetString("updated")}
				if endpoint == "normalization" {
					path = "/test/normalization/" + page.Id
					payload = map[string]string{"canonical_pronunciation": "a", "basis": "synthetic authority regression"}
				}
				raw, _ := json.Marshal(payload)
				body := &authorityChangeBody{Reader: strings.NewReader(string(raw)), change: changeAuthority}
				request := httptest.NewRequest(http.MethodPost, path, body)
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Authorization", token)
				response := httptest.NewRecorder()
				h.ServeHTTP(response, request)
				if !changed || response.Code != want {
					t.Fatalf("authority changed=%v; response %d, want %d: %s", changed, response.Code, want, response.Body.String())
				}
				saved, err := app.FindRecordById("pages", page.Id)
				if err != nil || saved.GetString("ocr_row_json") != page.GetString("ocr_row_json") || saved.GetString("updated") != page.GetString("updated") {
					t.Fatalf("rejected request changed page: %v", err)
				}
			})
		}
	}
}
