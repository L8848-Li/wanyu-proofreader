package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	pdfmodel "github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/forms"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	maxCSVBytes          = 50 * 1024 * 1024
	maxPDFBytes          = 100 * 1024 * 1024
	batchSize            = 250
	artifactCleanupBatch = 500
	pdfValidator         = "pdfcpu v0.16.4"
)

var importSourceLogicalID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$`)

type importWork struct {
	kind       string
	id         string
	requestID  string
	enqueuedAt time.Time
}

func newRequestID() string {
	random := make([]byte, 12)
	if _, err := rand.Read(random); err == nil {
		return hex.EncodeToString(random)
	}
	return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
}

func ensureRequestID(c *core.RequestEvent) string {
	requestID := strings.TrimSpace(c.Response.Header().Get("X-Request-ID"))
	if !safeRequestID.MatchString(requestID) {
		requestID = strings.TrimSpace(c.Request.Header.Get("X-Request-ID"))
	}
	if !safeRequestID.MatchString(requestID) {
		requestID = newRequestID()
	}
	c.Response.Header().Set("X-Request-ID", requestID)
	return requestID
}

func logUpload(level, event string, fields map[string]any) {
	writeOperation(level, "upload_service", event, fields)
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func logUploadRejected(requestID, kind, projectID, stage, message string, err error) {
	logUpload("warn", "upload_rejected", map[string]any{
		"request_id": requestID,
		"kind":       kind,
		"project_id": projectID,
		"stage":      stage,
		"message":    message,
		"error":      errorText(err),
	})
}

type importService struct {
	app          *pocketbase.PocketBase
	queue        chan importWork
	ocrQueue     chan importWork
	imageQueue   chan importWork
	imageContext context.Context
	imageCancel  context.CancelFunc
	mu           sync.Mutex
	pending      map[string]struct{}
	errorCounts  map[string]int
	pdfUploads   *pdfUploadPool

	// schemes 是启动时载入的拼音规则表（#190）。载入后不变，因此读它不需要加锁。
	schemes *schemeRegistry
}

func newImportService(app *pocketbase.PocketBase) *importService {
	ctx, cancel := context.WithCancel(context.Background())
	return &importService{
		app:          app,
		queue:        make(chan importWork, 1024),
		ocrQueue:     make(chan importWork, 1024),
		imageQueue:   make(chan importWork, 16),
		imageContext: ctx,
		imageCancel:  cancel,
		pending:      map[string]struct{}{},
		errorCounts:  map[string]int{},
	}
}

func (s *importService) register() {
	s.registerChunkUploads()
	s.app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		s.imageCancel()
		return e.Next()
	})
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.POST("/api/fangji/projects/{projectId}/imports/csv/columns", s.csvColumns).Bind(apis.BodyLimit(51*1024*1024), apis.RequireAuth("users"))
		e.Router.POST(
			"/api/fangji/projects/{projectId}/imports/csv",
			s.uploadCSV).Bind(apis.BodyLimit(51*1024*1024),
			apis.RequireAuth("users"))
		e.Router.POST(
			"/api/fangji/imports/{jobId}/commit",
			s.commitCSVImport).Bind(apis.RequireAuth("users"))
		e.Router.POST(
			"/api/fangji/projects/{projectId}/files/pdf",
			s.uploadPDF).Bind(apis.BodyLimit(maxPDFBytes+1024*1024), // Allow multipart framing.
			apis.RequireAuth("users"))

		// Remove abandoned staging before either worker can create new directories.
		s.cleanupPDFImageStaging()
		go s.runPDFImageWorker(s.processPDFImages)
		go s.runWorker()
		go s.runWorkQueue(s.ocrQueue)
		go s.recoverPendingWork()
		return e.Next()
	})
}

func (s *importService) requireProjectManager(c *core.RequestEvent, projectID string) (*core.Record, *core.Record, error) {
	return requireProjectManagerInApp(s.app, c, projectID)
}

func (s *importService) findProject(projectID string) (*core.Record, error) {
	project, err := s.app.FindRecordById("projects", projectID)
	if err != nil || project == nil {
		return nil, apis.NewNotFoundError("项目不存在或已被删除。", err)
	}
	return project, nil
}

func (s *importService) importSourceLink(raw string) (string, string, error) {
	ref := strings.TrimSpace(raw)
	if ref == "" {
		return "", "unknown", nil
	}
	if record, err := s.app.FindRecordById("sources", ref); err == nil && record != nil {
		return record.Id, "linked", nil
	}
	if !importSourceLogicalID.MatchString(ref) {
		return "", "", apis.NewBadRequestError("来源标识无效。请填写已登记的 logical_id，或留空以标记为 source:unknown。", nil)
	}
	records, err := s.app.FindRecordsByFilter("sources", fmt.Sprintf("logical_id = %q", ref), "", 1, 0)
	if err != nil || len(records) == 0 {
		return "", "", apis.NewBadRequestError("找不到要关联的来源。请核对 logical_id，或留空以标记为 source:unknown。", err)
	}
	return records[0].Id, "linked", nil
}

func (s *importService) uploadCSV(c *core.RequestEvent) error {
	requestID := ensureRequestID(c)
	inspectOnly := strings.EqualFold(strings.TrimSpace(c.Request.FormValue("inspect_only")), "true")
	projectID := c.Request.PathValue("projectId")
	auth, _, err := s.requireProjectManager(c, projectID)
	if err != nil {
		logUploadRejected(requestID, "csv", projectID, "authorization", "CSV upload authorization failed", err)
		return err
	}
	logUpload("info", "upload_received", map[string]any{
		"request_id":   requestID,
		"kind":         "csv",
		"project_id":   projectID,
		"user_id":      auth.Id,
		"inspect_only": inspectOnly,
	})

	uploaded, header, err := c.Request.FormFile("file")
	if uploaded != nil {
		defer uploaded.Close()
	}
	if err != nil {
		logUploadRejected(requestID, "csv", projectID, "multipart", "CSV file is missing", err)
		return apis.NewBadRequestError("请选择要导入的 CSV 文件。", err)
	}
	if err := validateUploadHeader(header, ".csv", maxCSVBytes); err != nil {
		logUploadRejected(requestID, "csv", projectID, "header_validation", err.Error(), err)
		return apis.NewBadRequestError(err.Error(), nil)
	}

	hash, err := hashMultipartFile(header)
	if err != nil {
		logUploadRejected(requestID, "csv", projectID, "hash", "CSV hashing failed", err)
		return apis.NewBadRequestError("无法读取上传的 CSV 文件。", err)
	}

	selectedColumn := strings.TrimSpace(c.Request.FormValue("pdf_page_column"))
	if selectedColumn != "" {
		if _, err := uploaded.Seek(0, io.SeekStart); err != nil {
			return apis.NewBadRequestError("无法读取 CSV 表头。", err)
		}
		decoded, _, err := decodedCSVReader(uploaded)
		if err != nil {
			return apis.NewBadRequestError("CSV 编码无法识别，请使用 UTF-8 或 GB18030。", err)
		}
		reader := csv.NewReader(decoded)
		reader.FieldsPerRecord = -1
		headers, err := reader.Read()
		if err != nil {
			return apis.NewBadRequestError(csvReadErrorMessage(err), err)
		}
		selectedColumn, err = canonicalCSVPageColumn(headers, selectedColumn)
		if err != nil {
			return apis.NewBadRequestError(err.Error(), nil)
		}
	}

	projectFileID, pdfPageLimit := s.primaryPDFSnapshot(projectID)
	filter := fmt.Sprintf(
		`project = %q && file_hash = %q && mode = "skip_invalid" && project_file = %q && csv_pdf_page_column = %q && status != "failed"`,
		projectID,
		hash,
		projectFileID,
		selectedColumn,
	)
	existing, findErr := s.app.FindRecordsByFilter("import_jobs", filter, "-created", 1, 0)
	if findErr != nil {
		logUpload("error", "dedup_lookup_failed", map[string]any{
			"request_id": requestID,
			"kind":       "csv",
			"project_id": projectID,
			"file_hash":  hash,
			"error":      findErr.Error(),
		})
	}
	if len(existing) > 0 {
		logUpload("info", "upload_deduplicated", map[string]any{
			"request_id": requestID,
			"kind":       "csv",
			"project_id": projectID,
			"job_id":     existing[0].Id,
			"file_name":  header.Filename,
			"file_size":  header.Size,
			"file_hash":  hash,
		})
		return c.JSON(http.StatusOK, existing[0])
	}

	collection, err := s.app.FindCollectionByNameOrId("import_jobs")
	if err != nil {
		return apis.NewBadRequestError("导入功能尚未完成数据库初始化。", err)
	}
	record := core.NewRecord(collection)
	form := forms.NewRecordUpsert(s.app, record)
	initialStatus := "queued"
	workKind := "csv"
	if inspectOnly {
		initialStatus = "inspecting"
		workKind = "csv_inspect"
	}
	sourceID, sourceLink, err := s.importSourceLink(c.Request.FormValue("source_id"))
	if err != nil {
		logUploadRejected(requestID, "csv", projectID, "source", "CSV source link was rejected", err)
		return err
	}
	payload := map[string]any{
		"project":               projectID,
		"created_by":            auth.Id,
		"original_filename":     header.Filename,
		"file_hash":             hash,
		"file_size":             header.Size,
		"mode":                  "skip_invalid",
		"status":                initialStatus,
		"total_count":           0,
		"processed_count":       0,
		"success_count":         0,
		"failed_count":          0,
		"project_file":          projectFileID,
		"pdf_page_limit":        pdfPageLimit,
		"pdf_snapshot_captured": true,
		"csv_pdf_page_column":   selectedColumn,
		"source_link":           sourceLink,
	}
	if sourceID != "" {
		payload["source"] = sourceID
	}
	form.Load(payload)
	file, err := filesystem.NewFileFromMultipart(header)
	if err != nil {
		return apis.NewBadRequestError("无法读取上传的 CSV 文件。", err)
	}
	record.Set("source_file", file)
	if err := form.Submit(); err != nil {
		// A concurrent duplicate upload may have won the unique index race.
		existing, findErr := s.app.FindRecordsByFilter("import_jobs", filter, "-created", 1, 0)
		if findErr != nil {
			logUpload("error", "dedup_lookup_failed", map[string]any{
				"request_id": requestID,
				"kind":       "csv",
				"project_id": projectID,
				"file_hash":  hash,
				"error":      findErr.Error(),
			})
		}
		if len(existing) > 0 {
			logUpload("info", "upload_deduplicated", map[string]any{
				"request_id": requestID,
				"kind":       "csv",
				"project_id": projectID,
				"job_id":     existing[0].Id,
				"file_name":  header.Filename,
				"file_size":  header.Size,
				"file_hash":  hash,
			})
			return c.JSON(http.StatusOK, existing[0])
		}
		logUploadRejected(requestID, "csv", projectID, "record_create", "CSV import job creation failed", err)
		return apis.NewBadRequestError("创建 CSV 导入作业失败。", err)
	}

	logUpload("info", "upload_accepted", map[string]any{
		"request_id": requestID,
		"kind":       "csv",
		"project_id": projectID,
		"job_id":     record.Id,
		"file_name":  header.Filename,
		"file_size":  header.Size,
		"file_hash":  hash,
	})
	s.enqueue(importWork{kind: workKind, id: record.Id, requestID: requestID})
	return c.JSON(http.StatusAccepted, record)
}

func (s *importService) commitCSVImport(c *core.RequestEvent) error {
	requestID := ensureRequestID(c)
	jobID := c.Request.PathValue("jobId")
	job, err := s.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		logUploadRejected(requestID, "csv", "", "job_lookup", "CSV inspection job was not found", err)
		return apis.NewNotFoundError("CSV 预检作业不存在或已被删除。", err)
	}
	projectID := job.GetString("project")
	if _, _, err := s.requireProjectManager(c, projectID); err != nil {
		logUploadRejected(requestID, "csv", job.GetString("project"), "authorization", "CSV commit authorization failed", err)
		return err
	}
	job, shouldEnqueue, err := s.confirmCSVJob(jobID)
	if err != nil {
		logUploadRejected(requestID, "csv", projectID, "commit_persist", "CSV commit failed", err)
		return err
	}
	logUpload("info", "csv_commit_requested", map[string]any{
		"request_id": requestID,
		"kind":       "csv",
		"job_id":     jobID,
		"project_id": job.GetString("project"),
		"file_name":  job.GetString("original_filename"),
		"file_size":  job.GetInt("file_size"),
		"file_hash":  job.GetString("file_hash"),
	})
	if shouldEnqueue {
		s.enqueue(importWork{kind: "csv", id: jobID, requestID: requestID})
	}
	return c.JSON(http.StatusAccepted, job)
}

// Re-read and change status in the same write transaction. Two confirmations
// must not both save a stale validated snapshot over a worker's progress (or
// re-enqueue a completed batch after the first worker has released its key).
func (s *importService) confirmCSVJob(jobID string) (job *core.Record, enqueue bool, err error) {
	err = s.app.RunInTransaction(func(tx core.App) error {
		var lookupErr error
		job, lookupErr = tx.FindRecordById("import_jobs", jobID)
		if lookupErr != nil {
			return apis.NewNotFoundError("CSV 预检作业不存在或已被删除。", lookupErr)
		}
		if job.GetString("mode") != "skip_invalid" {
			return apis.NewBadRequestError("只有 CSV 预检作业可以确认导入。", nil)
		}
		switch job.GetString("status") {
		case "queued", "processing", "completed", "completed_with_errors":
			// Lost HTTP responses and duplicate clicks name this same operation.
			return nil
		case "validated":
		default:
			return apis.NewBadRequestError("CSV 只有在后端预检通过后才能确认导入。", nil)
		}
		job.Set("status", "queued")
		job.Set("started_at", "")
		job.Set("finished_at", "")
		job.Set("error_code", "")
		job.Set("error_message", "")
		if err := tx.Save(job); err != nil {
			return apis.NewApiError(http.StatusServiceUnavailable, "暂时无法确认 CSV 导入，请重试原作业。", nil)
		}
		enqueue = true
		return nil
	})
	return
}

func (s *importService) uploadPDF(c *core.RequestEvent) error {
	requestID := ensureRequestID(c)
	projectID := c.Request.PathValue("projectId")
	_, _, err := s.requireProjectManager(c, projectID)
	if err != nil {
		logUploadRejected(requestID, "pdf", projectID, "authorization", "PDF upload authorization failed", err)
		return err
	}
	logUpload("info", "upload_received", map[string]any{
		"request_id": requestID,
		"kind":       "pdf",
		"project_id": projectID,
	})

	uploaded, header, err := c.Request.FormFile("file")
	if uploaded != nil {
		defer uploaded.Close()
	}
	if err != nil {
		logUploadRejected(requestID, "pdf", projectID, "multipart", "PDF file is missing", err)
		return apis.NewBadRequestError("请选择要上传的 PDF 文件。", err)
	}
	if err := validateUploadHeader(header, ".pdf", maxPDFBytes); err != nil {
		logUploadRejected(requestID, "pdf", projectID, "header_validation", err.Error(), err)
		return apis.NewBadRequestError(err.Error(), nil)
	}
	validSignature, err := multipartHasPrefix(header, []byte("%PDF-"))
	if err != nil {
		logUploadRejected(requestID, "pdf", projectID, "signature_read", "PDF signature read failed", err)
		return apis.NewBadRequestError("无法读取上传的 PDF 文件。", err)
	}
	if !validSignature {
		logUploadRejected(requestID, "pdf", projectID, "signature_validation", "PDF signature is invalid", nil)
		return apis.NewBadRequestError("文件内容不是有效的 PDF。", nil)
	}
	hash, err := hashMultipartFile(header)
	if err != nil {
		logUploadRejected(requestID, "pdf", projectID, "hash", "PDF hashing failed", err)
		return apis.NewBadRequestError("无法读取上传的 PDF 文件。", err)
	}

	collection, err := s.app.FindCollectionByNameOrId("project_files")
	if err != nil {
		return apis.NewBadRequestError("PDF 文件集合不存在。", err)
	}
	record := core.NewRecord(collection)
	form := forms.NewRecordUpsert(s.app, record)
	form.Load(map[string]any{
		"project":           projectID,
		"original_filename": header.Filename,
		"status":            "processing",
		"file_hash":         hash,
		"file_size":         header.Size,
		"error_code":        "",
		"error_message":     "",
	})
	file, err := filesystem.NewFileFromMultipart(header)
	if err != nil {
		return apis.NewBadRequestError("无法读取上传的 PDF 文件。", err)
	}
	record.Set("file", file)
	if err := form.Submit(); err != nil {
		logUploadRejected(requestID, "pdf", projectID, "record_create", "PDF record creation failed", err)
		return apis.NewBadRequestError("上传 PDF 失败。", err)
	}

	logUpload("info", "upload_accepted", map[string]any{
		"request_id": requestID,
		"kind":       "pdf",
		"project_id": projectID,
		"file_id":    record.Id,
		"file_name":  header.Filename,
		"file_size":  header.Size,
		"file_hash":  hash,
	})
	s.enqueue(importWork{kind: "pdf", id: record.Id, requestID: requestID})
	return c.JSON(http.StatusAccepted, record)
}

func validateUploadHeader(header *multipart.FileHeader, extension string, maxBytes int64) error {
	if header == nil || header.Size <= 0 {
		return errors.New("上传文件为空。")
	}
	if header.Size > maxBytes {
		return fmt.Errorf("文件超过 %d MB 上限。", maxBytes/(1024*1024))
	}
	if !strings.EqualFold(filepath.Ext(header.Filename), extension) {
		return fmt.Errorf("文件扩展名必须为 %s。", extension)
	}
	return nil
}

func hashMultipartFile(header *multipart.FileHeader) (string, error) {
	file, err := header.Open()
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func multipartHasPrefix(header *multipart.FileHeader, expected []byte) (bool, error) {
	file, err := header.Open()
	if err != nil {
		return false, err
	}
	defer file.Close()

	actual := make([]byte, len(expected))
	if _, err := io.ReadFull(file, actual); err != nil {
		return false, nil
	}
	return string(actual) == string(expected), nil
}

func persistBeforeCleanup(persist func() error, cleanup func() error) (persistErr, cleanupErr error) {
	if err := persist(); err != nil {
		return err, nil
	}
	if cleanup == nil {
		return nil, nil
	}
	return nil, cleanup()
}

func (s *importService) processPDF(work importWork) {
	recordID := work.id
	record, err := s.app.FindRecordById("project_files", recordID)
	if err != nil {
		logUpload("error", "pdf_record_lookup_failed", map[string]any{
			"request_id": work.requestID,
			"file_id":    recordID,
			"error":      err.Error(),
		})
		return
	}
	reader, closeFile, err := s.openRecordFile(record, "file")
	if err != nil {
		s.markFatal(work, "PDF_FILE_MISSING", "服务器找不到已上传的 PDF 文件。", err)
		return
	}
	defer closeFile()

	header := make([]byte, 5)
	if _, err := io.ReadFull(reader, header); err != nil || string(header) != "%PDF-" {
		s.markFatal(work, "INVALID_PDF_SIGNATURE", "文件内容不是有效的 PDF。", err)
		return
	}
	pageCount, err := validatePDFStructure(reader)
	if err != nil {
		s.markFatal(work, "PDF_DEEP_VALIDATION_FAILED", "PDF 文件结构损坏、被截断或无法解析。", err)
		return
	}

	// Prepare private single-page sources in the serial import worker.
	pdfCacheMu.Lock()
	_, cacheErr := s.preparePDFPages(record)
	pdfCacheMu.Unlock()
	if cacheErr != nil {
		logUpload("warn", "pdf_cache_prepare_failed", map[string]any{"file_id": recordID, "error": cacheErr.Error()})
	}
	validatedAt := types.NowDateTime()
	projectID := record.GetString("project")
	err = s.app.RunInTransaction(func(txDao core.App) error {
		previous, err := txDao.FindRecordsByFilter(
			"project_files",
			fmt.Sprintf(`project = %q && is_primary = true && id != %q`, projectID, recordID),
			"-created",
			1000,
			0,
		)
		if err != nil {
			return err
		}
		for _, old := range previous {
			old.Set("is_primary", false)
			old.Set("superseded_at", validatedAt)
			if err := txDao.Save(old); err != nil {
				return err
			}
		}
		current, err := txDao.FindRecordById("project_files", recordID)
		if err != nil {
			return err
		}
		current.Set("status", "ready")
		current.Set("error_code", "")
		current.Set("error_message", "")
		current.Set("page_count", pageCount)
		current.Set("validation_tool", pdfValidator)
		current.Set("validated_at", validatedAt)
		current.Set("is_primary", true)
		current.Set("superseded_at", "")
		return txDao.Save(current)
	})
	if err != nil {
		s.markFatal(work, "PDF_STATUS_UPDATE_FAILED", "PDF 已验证，但主文件状态更新失败。", err)
		return
	}
	logUpload("info", "pdf_ready", map[string]any{
		"request_id": work.requestID,
		"kind":       "pdf",
		"file_id":    recordID,
		"project_id": projectID,
		"file_name":  record.GetString("original_filename"),
		"file_size":  record.GetInt("file_size"),
		"file_hash":  record.GetString("file_hash"),
		"page_count": pageCount,
		"validator":  pdfValidator,
	})
	// Publish ready first; page images may take longer and must not block use.
	s.schedulePDFImages(record)
}

func validatePDFStructure(reader io.ReadSeeker) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	return validatePDFStructureContext(ctx, reader)
}

func validatePDFStructureContext(workCtx context.Context, reader io.ReadSeeker) (int, error) {
	if err := workCtx.Err(); err != nil {
		return 0, err
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	pdfapi.DisableConfigDir()
	configuration := pdfmodel.NewDefaultConfiguration()
	configuration.ValidationMode = pdfmodel.ValidationRelaxed
	document, err := pdfapi.ReadAndValidate(workCtx, reader, configuration)
	if err != nil {
		return 0, err
	}
	if document.PageCount < 1 {
		return 0, errors.New("PDF contains no pages")
	}
	return document.PageCount, nil
}

func (s *importService) openRecordFile(record *core.Record, field string) (io.ReadSeeker, func(), error) {
	return openRecordFile(s.app, record, field)
}

func (s *importService) clearJobArtifacts(jobID string) error {
	if err := clearJobArtifacts(s.app, jobID); err != nil {
		return err
	}
	// 旧错误明细已删除：配额必须随数据生命周期重置，正式导入不能沿用预检旧计数。
	s.mu.Lock()
	delete(s.errorCounts, jobID)
	s.mu.Unlock()
	return nil
}

func clearJobArtifacts(dao core.App, jobID string) error {
	return dao.RunInTransaction(func(txDao core.App) error {
		if err := deleteJobPages(txDao, jobID); err != nil {
			return err
		}
		return deleteRecordBatches(txDao, "import_job_errors", fmt.Sprintf("job = %q", jobID))
	})
}

func (s *importService) clearJobPages(jobID string) error {
	return s.app.RunInTransaction(func(txDao core.App) error {
		return deleteJobPages(txDao, jobID)
	})
}

func deleteJobPages(dao core.App, jobID string) error {
	var attemptCount int
	if err := dao.DB().NewQuery(
		`SELECT COUNT(*)
		 FROM proofreading_attempts attempts
		 INNER JOIN pages ON pages.id = attempts.page
		 WHERE pages.import_job = {:jobID}`,
	).Bind(dbx.Params{"jobID": jobID}).Row(&attemptCount); err != nil {
		return err
	}

	filter := fmt.Sprintf("import_job = %q", jobID)
	if err := walkRecordBatches(
		artifactCleanupBatch,
		true,
		func(limit, offset int) ([]*core.Record, error) {
			return dao.FindRecordsByFilter("pages", filter, "id", limit, offset)
		},
		func(pages []*core.Record) error {
			for _, page := range pages {
				if !isDiscardableImportPage(
					page.GetString("status"),
					page.GetString("proofreader"),
					page.GetString("first_proofreader"),
					page.GetString("second_proofreader"),
					attemptCount > 0,
				) {
					return fmt.Errorf("refusing to delete published import page %s during cleanup", page.Id)
				}
			}
			return nil
		},
	); err != nil {
		return err
	}
	return deleteRecordBatches(dao, "pages", filter)
}

func deleteRecordBatches(dao core.App, collection, filter string) error {
	return walkRecordBatches(
		artifactCleanupBatch,
		false,
		func(limit, offset int) ([]*core.Record, error) {
			return dao.FindRecordsByFilter(collection, filter, "id", limit, offset)
		},
		func(records []*core.Record) error {
			for _, record := range records {
				if err := dao.Delete(record); err != nil {
					return err
				}
			}
			return nil
		},
	)
}

func walkRecordBatches(
	batchSize int,
	advanceOffset bool,
	fetch func(limit, offset int) ([]*core.Record, error),
	visit func([]*core.Record) error,
) error {
	if batchSize <= 0 {
		return errors.New("record batch size must be positive")
	}
	offset := 0
	for {
		records, err := fetch(batchSize, offset)
		if err != nil {
			return err
		}
		if len(records) == 0 {
			return nil
		}
		if err := visit(records); err != nil {
			return err
		}
		if len(records) < batchSize {
			return nil
		}
		if advanceOffset {
			offset += len(records)
		}
	}
}

func isDiscardableImportPage(status, proofreader, firstProofreader, secondProofreader string, hasAttempts bool) bool {
	return status == "importing" &&
		proofreader == "" &&
		firstProofreader == "" &&
		secondProofreader == "" &&
		!hasAttempts
}

func (s *importService) primaryPDFSnapshot(projectID string) (string, int) {
	id, pages, err := s.primaryPDFSnapshotWithError(projectID)
	if err != nil {
		logUpload("error", "primary_pdf_lookup_failed", map[string]any{"project_id": projectID, "error": err.Error()})
	}
	return id, pages
}

// OCR needs the read error separately: an uncertain retry must not become a
// parameter-rejected 400 which would let a client discard its request identity.
func (s *importService) primaryPDFSnapshotWithError(projectID string) (string, int, error) {
	records, err := s.app.FindRecordsByFilter("project_files", fmt.Sprintf(`project = %q && status = "ready" && is_primary = true`, projectID), "-created", 1, 0)
	if err != nil {
		return "", 0, err
	}
	if len(records) == 0 {
		return "", 0, nil
	}
	return records[0].Id, records[0].GetInt("page_count"), nil
}
