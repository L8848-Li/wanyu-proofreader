package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/forms"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

const pdfChunkBytes int64 = 1024 * 1024
const pdfUploadTTL = time.Hour
const pdfStagingBudget int64 = 1024 * 1024 * 1024
const pdfUploadMetaName = "meta.json"

type pdfUploadSession struct {
	id, owner, project, name, dir, recordID, contentHash, requestID string
	size                                                            int64
	touched                                                         time.Time
	hashes                                                          map[int][32]byte
	canceled, released                                              bool
}

type pdfUploadMeta struct {
	ID, Owner, Project, Name, ContentHash, RecordID, RequestID string
	Size                                                       int64
	Touched                                                    time.Time
	Hashes                                                     map[string]string
	Canceled, Released                                         bool
}

type pdfUploadPool struct {
	mu       sync.Mutex
	root     string
	sessions map[string]*pdfUploadSession
}

func (s *importService) registerChunkUploads() {
	s.pdfUploads = &pdfUploadPool{sessions: map[string]*pdfUploadSession{}}
	pool := s.pdfUploads
	stop := make(chan struct{})
	s.app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error { close(stop); return e.Next() })
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		pool.root = filepath.Join(s.app.DataDir(), "pdf-upload-staging-v1")
		if err := pool.restore(); err != nil {
			return err
		}
		base := "/api/fangji/projects/{projectId}/pdf-uploads"
		e.Router.POST(base, func(c *core.RequestEvent) error { return s.createPDFUpload(c, pool) }).Bind(apis.RequireAuth("users"), apis.BodyLimit(4096))
		e.Router.GET(base, func(c *core.RequestEvent) error { return s.listPDFUploads(c, pool) }).Bind(apis.RequireAuth("users"))
		e.Router.GET(base+"/{uploadId}", func(c *core.RequestEvent) error { return s.getPDFUpload(c, pool) }).Bind(apis.RequireAuth("users"))
		e.Router.PUT(base+"/{uploadId}/chunks/{index}", func(c *core.RequestEvent) error { return s.putPDFChunk(c, pool) }).Bind(apis.RequireAuth("users"), apis.BodyLimit(pdfChunkBytes))
		e.Router.POST(base+"/{uploadId}/complete", func(c *core.RequestEvent) error { return s.completePDFUpload(c, pool) }).Bind(apis.RequireAuth("users"), apis.BodyLimit(4096))
		e.Router.DELETE(base+"/{uploadId}", func(c *core.RequestEvent) error { return s.cancelPDFUpload(c, pool) }).Bind(apis.RequireAuth("users"))
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-stop:
					return
				case now := <-ticker.C:
					pool.mu.Lock()
					pool.cleanup(now)
					pool.mu.Unlock()
				}
			}
		}()
		return e.Next()
	})
}

func (p *pdfUploadPool) restore() error {
	if err := os.MkdirAll(p.root, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(p.root)
	if err != nil {
		return err
	}
	if p.sessions == nil {
		p.sessions = map[string]*pdfUploadSession{}
	}
	now := time.Now()
	for _, entry := range entries {
		dir := filepath.Join(p.root, entry.Name())
		if !entry.IsDir() {
			_ = os.Remove(dir)
			continue
		}
		u, err := loadPDFUploadSession(dir)
		if err != nil || !u.touched.Add(pdfUploadTTL).After(now) {
			_ = os.RemoveAll(dir)
			continue
		}
		p.sessions[u.id] = u
	}
	return nil
}

func loadPDFUploadSession(dir string) (*pdfUploadSession, error) {
	raw, err := os.ReadFile(filepath.Join(dir, pdfUploadMetaName))
	if err != nil {
		return nil, err
	}
	var meta pdfUploadMeta
	if err := json.Unmarshal(raw, &meta); err != nil || meta.ID == "" || filepath.Base(dir) != meta.ID {
		return nil, errors.New("invalid upload metadata")
	}
	if !contentHashOK(meta.ContentHash) || meta.Size <= 0 {
		return nil, errors.New("invalid upload identity")
	}
	u := &pdfUploadSession{
		id: meta.ID, owner: meta.Owner, project: meta.Project, name: meta.Name, dir: dir,
		recordID: meta.RecordID, contentHash: strings.ToLower(meta.ContentHash), requestID: meta.RequestID,
		size: meta.Size, touched: meta.Touched, hashes: map[int][32]byte{}, canceled: meta.Canceled, released: meta.Released,
	}
	for key, value := range meta.Hashes {
		index, err := strconv.Atoi(key)
		decoded, decodeErr := hex.DecodeString(value)
		if err != nil || index < 0 || decodeErr != nil || len(decoded) != 32 {
			continue
		}
		var hash [32]byte
		copy(hash[:], decoded)
		part := filepath.Join(dir, fmt.Sprintf("%d.part", index))
		data, readErr := os.ReadFile(part)
		if readErr != nil || sha256.Sum256(data) != hash {
			continue
		}
		u.hashes[index] = hash
	}
	return u, nil
}

func (u *pdfUploadSession) persist() error {
	if u == nil || u.dir == "" {
		return nil
	}
	hashes := map[string]string{}
	for index, hash := range u.hashes {
		hashes[strconv.Itoa(index)] = fmt.Sprintf("%x", hash)
	}
	raw, err := json.Marshal(pdfUploadMeta{
		ID: u.id, Owner: u.owner, Project: u.project, Name: u.name, ContentHash: u.contentHash,
		RecordID: u.recordID, RequestID: u.requestID, Size: u.size, Touched: u.touched,
		Hashes: hashes, Canceled: u.canceled, Released: u.released,
	})
	if err != nil {
		return err
	}
	tmp := filepath.Join(u.dir, pdfUploadMetaName+".tmp")
	if err := os.WriteFile(tmp, raw, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(u.dir, pdfUploadMetaName))
}

func removeUploadParts(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	ok := true
	for _, entry := range entries {
		if entry.Name() == pdfUploadMetaName {
			continue
		}
		if os.RemoveAll(filepath.Join(dir, entry.Name())) != nil {
			ok = false
		}
	}
	return ok
}

func (p *pdfUploadPool) cleanup(now time.Time) {
	for id, u := range p.sessions {
		if !u.touched.Add(pdfUploadTTL).After(now) {
			if os.RemoveAll(u.dir) == nil {
				delete(p.sessions, id)
			}
		}
	}
}

func contentHashOK(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func receivedIndexes(u *pdfUploadSession) []int {
	out := make([]int, 0, len(u.hashes))
	for index := range u.hashes {
		out = append(out, index)
	}
	sort.Ints(out)
	return out
}

func sessionView(u *pdfUploadSession) map[string]any {
	status := "active"
	if u.canceled {
		status = "canceled"
	} else if u.recordID != "" {
		status = "complete"
	}
	return map[string]any{
		"id":          u.id,
		"chunkSize":   pdfChunkBytes,
		"name":        u.name,
		"size":        u.size,
		"contentHash": u.contentHash,
		"received":    receivedIndexes(u),
		"expiresAt":   u.touched.Add(pdfUploadTTL).UTC().Format(time.RFC3339),
		"status":      status,
	}
}

func pdfCompleteRecordID(sessionID string) string {
	sum := sha256.Sum256([]byte("pdf-complete\x00" + sessionID))
	return hex.EncodeToString(sum[:])[:15]
}

func (s *importService) authorizePDFUpload(c *core.RequestEvent) error {
	if c.Auth == nil || c.Auth.GetBool("must_change_password") {
		return apis.NewForbiddenError("请先登录并完成初始密码修改。", nil)
	}
	_, _, err := s.requireProjectManager(c, c.Request.PathValue("projectId"))
	return err
}

func (p *pdfUploadPool) session(c *core.RequestEvent) (*pdfUploadSession, error) {
	u := p.sessions[c.Request.PathValue("uploadId")]
	if u == nil || u.owner != c.Auth.Id || u.project != c.Request.PathValue("projectId") {
		return nil, apis.NewNotFoundError("上传会话不存在，请重新选择文件上传。", nil)
	}
	if !u.touched.Add(pdfUploadTTL).After(time.Now()) {
		return nil, apis.NewApiError(http.StatusGone, "上传已过期，请重新上传。", nil)
	}
	if u.canceled {
		return nil, apis.NewApiError(http.StatusGone, "上传已取消。", nil)
	}
	return u, nil
}

func (p *pdfUploadPool) activeByIdentity(owner, project, hash string) *pdfUploadSession {
	for _, u := range p.sessions {
		if u.owner == owner && u.project == project && u.contentHash == hash && !u.canceled && u.recordID == "" && u.touched.Add(pdfUploadTTL).After(time.Now()) {
			return u
		}
	}
	return nil
}

func (p *pdfUploadPool) ownerActive(owner string) *pdfUploadSession {
	for _, u := range p.sessions {
		if u.owner == owner && !u.canceled && u.recordID == "" && u.touched.Add(pdfUploadTTL).After(time.Now()) {
			return u
		}
	}
	return nil
}

func (s *importService) createPDFUpload(c *core.RequestEvent, p *pdfUploadPool) error {
	if err := s.authorizePDFUpload(c); err != nil {
		return err
	}
	var body struct {
		Name        string `json:"name"`
		Size        int64  `json:"size"`
		RequestID   string `json:"requestId"`
		ContentHash string `json:"contentHash"`
	}
	if err := c.BindBody(&body); err != nil {
		return apis.NewBadRequestError("上传参数无效。", nil)
	}
	contentHash := strings.ToLower(strings.TrimSpace(body.ContentHash))
	if len(body.RequestID) < 16 || len(body.RequestID) > 80 || !contentHashOK(contentHash) {
		return apis.NewBadRequestError("上传参数无效。", nil)
	}
	if body.Size <= 0 || body.Size > maxPDFBytes || len(body.Name) > 255 || !strings.EqualFold(filepath.Ext(body.Name), ".pdf") {
		return apis.NewBadRequestError("请选择不超过 100 MiB 的 PDF 文件。", nil)
	}
	id := fmt.Sprintf("%x", sha256.Sum256([]byte(c.Auth.Id+"\x00"+body.RequestID)))
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cleanup(time.Now())
	if u := p.sessions[id]; u != nil {
		if u.project != c.Request.PathValue("projectId") || u.name != body.Name || u.size != body.Size || u.contentHash != contentHash || u.canceled {
			return apis.NewApiError(409, "上传会话参数冲突。", nil)
		}
		u.touched = time.Now()
		_ = u.persist()
		return c.JSON(200, sessionView(u))
	}
	if u := p.activeByIdentity(c.Auth.Id, c.Request.PathValue("projectId"), contentHash); u != nil {
		if u.name != body.Name || u.size != body.Size {
			return apis.NewApiError(409, "上传会话参数冲突。", nil)
		}
		u.touched = time.Now()
		_ = u.persist()
		return c.JSON(200, sessionView(u))
	}
	if active := p.ownerActive(c.Auth.Id); active != nil {
		if active.project == c.Request.PathValue("projectId") && active.name == body.Name && active.size == body.Size {
			return apis.NewApiError(409, "与未完成上传的文件不一致，请选择原来的 PDF 或取消后重新上传。", nil)
		}
		return apis.NewApiError(429, "已有上传进行中，请取消或完成后再试。", nil)
	}
	active := 0
	var reserved int64
	for _, u := range p.sessions {
		if !u.released {
			reserved += 2 * u.size
		}
		if u.recordID != "" || u.canceled {
			continue
		}
		active++
	}
	if active >= 4 || reserved+2*body.Size > pdfStagingBudget {
		return apis.NewApiError(429, "上传服务繁忙，请稍后重试。", nil)
	}
	if len(p.sessions) >= 1024 {
		return apis.NewApiError(429, "上传会话过多，请稍后重试。", nil)
	}
	dir := filepath.Join(p.root, id)
	if err := os.Mkdir(dir, 0700); err != nil {
		return apis.NewApiError(500, "无法准备上传空间。", nil)
	}
	u := &pdfUploadSession{
		id: id, owner: c.Auth.Id, project: c.Request.PathValue("projectId"), name: body.Name,
		size: body.Size, contentHash: contentHash, requestID: body.RequestID, dir: dir,
		touched: time.Now(), hashes: map[int][32]byte{},
	}
	if err := u.persist(); err != nil {
		_ = os.RemoveAll(dir)
		return apis.NewApiError(500, "无法准备上传空间。", nil)
	}
	p.sessions[id] = u
	return c.JSON(201, sessionView(u))
}

func (s *importService) listPDFUploads(c *core.RequestEvent, p *pdfUploadPool) error {
	if err := s.authorizePDFUpload(c); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cleanup(time.Now())
	project := c.Request.PathValue("projectId")
	items := make([]map[string]any, 0)
	for _, u := range p.sessions {
		if u.owner == c.Auth.Id && u.project == project && u.recordID == "" && !u.canceled {
			items = append(items, sessionView(u))
		}
	}
	return c.JSON(200, map[string]any{"items": items})
}

func (s *importService) getPDFUpload(c *core.RequestEvent, p *pdfUploadPool) error {
	if err := s.authorizePDFUpload(c); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	u, err := p.session(c)
	if err != nil {
		return err
	}
	return c.JSON(200, sessionView(u))
}

func (s *importService) putPDFChunk(c *core.RequestEvent, p *pdfUploadPool) error {
	if err := s.authorizePDFUpload(c); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(c.Request.Body, pdfChunkBytes+1))
	if err != nil {
		return apis.NewBadRequestError("读取分片失败。", nil)
	}
	index, err := strconv.Atoi(c.Request.PathValue("index"))
	if err != nil || index < 0 || len(data) == 0 || int64(len(data)) > pdfChunkBytes {
		return apis.NewBadRequestError("分片无效。", nil)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	u, err := p.session(c)
	if err != nil {
		return err
	}
	if int64(index) >= (u.size+pdfChunkBytes-1)/pdfChunkBytes {
		return apis.NewBadRequestError("分片编号无效。", nil)
	}
	expected := min(pdfChunkBytes, u.size-int64(index)*pdfChunkBytes)
	if int64(len(data)) != expected {
		return apis.NewBadRequestError("分片长度不符。", nil)
	}
	hash := sha256.Sum256(data)
	if previous, ok := u.hashes[index]; ok {
		if previous != hash {
			return apis.NewApiError(409, "重复分片内容不一致。", nil)
		}
		u.touched = time.Now()
		_ = u.persist()
		return c.NoContent(204)
	}
	if u.recordID != "" {
		return apis.NewApiError(409, "上传已完成。", nil)
	}
	name := filepath.Join(u.dir, fmt.Sprintf("%d.part", index))
	if err := os.WriteFile(name, data, 0600); err != nil {
		_ = os.Remove(name)
		return apis.NewApiError(500, "保存分片失败。", nil)
	}
	u.hashes[index] = hash
	u.touched = time.Now()
	if err := u.persist(); err != nil {
		delete(u.hashes, index)
		_ = os.Remove(name)
		return apis.NewApiError(500, "保存分片失败。", nil)
	}
	return c.NoContent(204)
}

func (s *importService) completePDFUpload(c *core.RequestEvent, p *pdfUploadPool) error {
	if err := s.authorizePDFUpload(c); err != nil {
		return err
	}
	record, fresh, err := s.finishPDFUpload(c, p)
	if err != nil {
		return err
	}
	if fresh {
		// 入队是有意背压（见 import_queue.go），队列满时可能等很久；
		// 绝不能持 p.mu 等，否则所有用户的上传/取消/查询都被同一把锁挡死。
		s.enqueue(importWork{kind: "pdf", id: record.Id, requestID: newRequestID()})
		return c.JSON(202, record)
	}
	return c.JSON(200, record)
}

func (s *importService) finishPDFUpload(c *core.RequestEvent, p *pdfUploadPool) (*core.Record, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	u, err := p.session(c)
	if err != nil {
		return nil, false, err
	}
	if u.recordID != "" {
		record, err := s.app.FindRecordById("project_files", u.recordID)
		if err != nil {
			return nil, false, apis.NewNotFoundError("已上传文件不存在。", nil)
		}
		u.touched = time.Now()
		_ = u.persist()
		return record, false, nil
	}
	if len(u.hashes) != int((u.size+pdfChunkBytes-1)/pdfChunkBytes) {
		return nil, false, apis.NewApiError(409, "分片尚未上传完整。", nil)
	}
	completeID := pdfCompleteRecordID(u.id)
	if existing, err := s.app.FindRecordById("project_files", completeID); err == nil {
		u.recordID = existing.Id
		u.touched = time.Now()
		u.released = removeUploadParts(u.dir)
		_ = u.persist()
		return existing, false, nil
	}
	assembled := filepath.Join(u.dir, "assembled.pdf")
	hash, err := assemblePDFUpload(u, assembled)
	if err != nil {
		_ = os.Remove(assembled)
		return nil, false, apis.NewBadRequestError("分片校验或合并失败，请重新上传。", nil)
	}
	defer os.Remove(assembled)
	if hash != u.contentHash {
		return nil, false, apis.NewBadRequestError("文件内容与声明的身份不一致，请重新选择原 PDF。", nil)
	}
	file, err := filesystem.NewFileFromPath(assembled)
	if err != nil {
		return nil, false, apis.NewApiError(500, "读取合并文件失败。", nil)
	}
	record, err := s.saveUploadedPDF(u.project, u.name, u.size, hash, file, completeID)
	if err != nil {
		if existing, findErr := s.app.FindRecordById("project_files", completeID); findErr == nil {
			u.recordID = existing.Id
			u.touched = time.Now()
			u.released = removeUploadParts(u.dir)
			_ = u.persist()
			return existing, false, nil
		}
		return nil, false, err
	}
	u.recordID = record.Id
	u.touched = time.Now()
	u.released = removeUploadParts(u.dir)
	_ = u.persist()
	return record, true, nil
}

func assemblePDFUpload(u *pdfUploadSession, dest string) (string, error) {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return "", err
	}
	defer out.Close()
	full := sha256.New()
	var total int64
	for i := 0; i < len(u.hashes); i++ {
		data, err := os.ReadFile(filepath.Join(u.dir, fmt.Sprintf("%d.part", i)))
		if err != nil {
			return "", err
		}
		if sha256.Sum256(data) != u.hashes[i] {
			return "", errors.New("chunk hash mismatch")
		}
		if i == 0 && !strings.HasPrefix(string(data), "%PDF-") {
			return "", errors.New("not a PDF")
		}
		n, err := io.MultiWriter(out, full).Write(data)
		total += int64(n)
		if err != nil {
			return "", err
		}
	}
	if total != u.size {
		return "", errors.New("length mismatch")
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", full.Sum(nil)), nil
}

func (s *importService) cancelPDFUpload(c *core.RequestEvent, p *pdfUploadPool) error {
	if err := s.authorizePDFUpload(c); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	u := p.sessions[c.Request.PathValue("uploadId")]
	if u == nil || u.owner != c.Auth.Id || u.project != c.Request.PathValue("projectId") {
		return apis.NewNotFoundError("上传会话不存在。", nil)
	}
	if err := os.RemoveAll(u.dir); err != nil {
		return apis.NewApiError(500, "清理上传失败，请重试。", nil)
	}
	u.released = true
	if u.recordID == "" {
		u.canceled = true
	}
	u.touched = time.Now()
	u.dir = ""
	return c.NoContent(204)
}

func (s *importService) saveUploadedPDF(projectID, name string, size int64, hash string, file *filesystem.File, recordID string) (*core.Record, error) {
	collection, err := s.app.FindCollectionByNameOrId("project_files")
	if err != nil {
		return nil, err
	}
	record := core.NewRecord(collection)
	if recordID != "" {
		record.Id = recordID
	}
	form := forms.NewRecordUpsert(s.app, record)
	form.Load(map[string]any{"project": projectID, "original_filename": name, "status": "processing", "file_hash": hash, "file_size": size, "error_code": "", "error_message": ""})
	record.Set("file", file)
	if err := form.Submit(); err != nil {
		return nil, apis.NewBadRequestError("保存 PDF 失败。", err)
	}
	return record, nil
}
