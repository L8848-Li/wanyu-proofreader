package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// 队列满时，完成上传的入队等待（有意背压，见 import_queue.go）不得持 p.mu：
// 否则其他用户的创建/分片/取消/查询全部被同一把锁挡死。
func TestCompletePDFUploadAdmissionDoesNotHoldPoolLock(t *testing.T) {
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	projects, _ := app.FindCollectionByNameOrId("projects")
	tokens := []string{}
	owners := []*core.Record{}
	for i := 0; i < 2; i++ {
		u := core.NewRecord(users)
		u.Set("username", fmt.Sprintf("lock-user-%d", i))
		u.Set("role", "platform_admin")
		u.SetPassword("UploadLockTest12345!")
		if err := app.Save(u); err != nil {
			t.Fatal(err)
		}
		token, _ := u.NewAuthToken()
		tokens = append(tokens, token)
		owners = append(owners, u)
	}
	project := core.NewRecord(projects)
	project.Set("name", "Upload lock fixture")
	project.Set("access_mode", "public")
	project.Set("required_proofreads", 2)
	project.Set("admin", owners[0].Id)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	s := newImportService(app)
	s.registerChunkUploads()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	defer app.OnTerminate().Trigger(&core.TerminateEvent{App: app})
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	// 与 TestChunkUploadHTTP 相同，harness 不调用 s.register()，没有 worker 消费队列；
	// 直接把队列塞满即可稳定复现 admission 背压（生产中是作业积压导致同样状态）。
	for i := 0; i < cap(s.queue); i++ {
		s.queue <- importWork{kind: "pdf", id: fmt.Sprintf("blocker%09d", i)}
	}

	base := "/api/fangji/projects/" + project.Id + "/pdf-uploads"
	do := func(method, url, token string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, url, bytes.NewReader(body))
		r.Header.Set("Authorization", token)
		if method == "PUT" {
			r.Header.Set("Content-Type", "application/octet-stream")
		} else {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	pdf := append(minimalTestPDF(2), bytes.Repeat([]byte("\n"), int(pdfChunkBytes))...)
	pdfHash := fmt.Sprintf("%x", sha256.Sum256(pdf))
	createBody, _ := json.Marshal(map[string]any{"name": "lock.pdf", "size": len(pdf), "requestId": "lock-request-0001", "contentHash": pdfHash})
	w := do("POST", base, tokens[0], createBody)
	if w.Code != 201 {
		t.Fatalf("create status=%d body=%s", w.Code, w.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	id := created.ID
	if w := do("PUT", base+"/"+id+"/chunks/0", tokens[0], pdf[:pdfChunkBytes]); w.Code != 204 {
		t.Fatalf("chunk0 status=%d body=%s", w.Code, w.Body.String())
	}
	if w := do("PUT", base+"/"+id+"/chunks/1", tokens[0], pdf[pdfChunkBytes:]); w.Code != 204 {
		t.Fatalf("chunk1 status=%d body=%s", w.Code, w.Body.String())
	}

	completeDone := make(chan int, 1)
	go func() { completeDone <- do("POST", base+"/"+id+"/complete", tokens[0], nil).Code }()

	// 记录落库先于入队；落库后 complete 应卡在队列 admission 上。
	completeID := pdfCompleteRecordID(id)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := app.FindRecordById("project_files", completeID); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completion did not persist the record")
		}
		time.Sleep(5 * time.Millisecond)
	}

	probeDone := make(chan int, 1)
	go func() {
		probeBody, _ := json.Marshal(map[string]any{"name": "probe.pdf", "size": 1, "requestId": "probe-request-0001", "contentHash": fmt.Sprintf("%x", sha256.Sum256([]byte("probe")))})
		probeDone <- do("POST", base, tokens[1], probeBody).Code
	}()
	select {
	case code := <-probeDone:
		if code != 201 {
			t.Fatalf("probe create status=%d want=201", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("队列满时完成上传持 p.mu 阻塞了其他用户的上传操作")
	}

	<-s.queue // 放行 admission
	select {
	case code := <-completeDone:
		if code != 202 {
			t.Fatalf("complete status=%d want=202", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("completion did not finish after admission")
	}
}
