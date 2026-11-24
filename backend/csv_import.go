package main

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

type csvPage struct {
	sourceBindingJSON string
	ocrCellsJSON      string
	ocrAbstained      bool
	line              int
	pdfPage           int
	rowJSON           string
	headersJSON       string
	entryText         string
}

type csvCounters struct {
	total     int
	processed int
	success   int
	failed    int
}

type csvInspection struct {
	Encoding         string               `json:"encoding"`
	Headers          []string             `json:"headers"`
	PDFPageField     string               `json:"pdf_page_field"`
	TotalRows        int                  `json:"total_rows"`
	ValidRows        int                  `json:"valid_rows"`
	InvalidRows      int                  `json:"invalid_rows"`
	MinPDFPage       int                  `json:"min_pdf_page"`
	MaxPDFPage       int                  `json:"max_pdf_page"`
	Preview          []map[string]string  `json:"preview"`
	PreviewLocations []csvPreviewLocation `json:"preview_locations"`
	PreviewLimit     int                  `json:"preview_limit"`
	PreviewKind      string               `json:"preview_kind"`
}

const (
	csvInspectionPreviewLimit = 20
	// A complete preview is persisted or rejected; source cells are never shortened.
	// The migration's character limit also admits every report within this byte cap.
	maxCSVInspectionBytes = 512 * 1024
)

var errCSVInspectionTooLarge = errors.New("CSV inspection exceeds the 512 KiB serialized budget")

func marshalCSVInspection(inspection csvInspection) ([]byte, error) {
	// Reject oversized string data before encoding. JSON escaping can expand text
	// up to sixfold, so also check the final bytes; neither check changes the text.
	remaining := maxCSVInspectionBytes
	consume := func(value string) bool {
		if len(value) > remaining {
			return false
		}
		remaining -= len(value)
		return true
	}
	if !consume(inspection.Encoding) || !consume(inspection.PDFPageField) || !consume(inspection.PreviewKind) {
		return nil, errCSVInspectionTooLarge
	}
	for _, header := range inspection.Headers {
		if !consume(header) {
			return nil, errCSVInspectionTooLarge
		}
	}
	for _, row := range inspection.Preview {
		for header, value := range row {
			if !consume(header) || !consume(value) {
				return nil, errCSVInspectionTooLarge
			}
		}
	}
	encoded, err := json.Marshal(inspection)
	if err != nil {
		return nil, err
	}
	if len(encoded) > maxCSVInspectionBytes {
		return nil, errCSVInspectionTooLarge
	}
	return encoded, nil
}

type csvPreviewLocation struct {
	CSVLine int `json:"csv_line"`
	PDFPage int `json:"pdf_page"`
}

func (s *importService) processCSVInspection(work importWork) {
	job, err := s.app.FindRecordById("import_jobs", work.id)
	if err != nil {
		logUpload("error", "csv_inspection_job_lookup_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     work.id,
			"error":      err.Error(),
		})
		return
	}
	job.Set("status", "inspecting")
	job.Set("started_at", types.NowDateTime())
	job.Set("finished_at", "")
	job.Set("error_code", "")
	job.Set("error_message", "")
	job.Set("inspection_json", "")
	projectFileID := job.GetString("project_file")
	pdfPageLimit := job.GetInt("pdf_page_limit")
	if !job.GetBool("pdf_snapshot_captured") {
		projectFileID, pdfPageLimit = s.primaryPDFSnapshot(job.GetString("project"))
		job.Set("project_file", projectFileID)
		job.Set("pdf_page_limit", pdfPageLimit)
		job.Set("pdf_snapshot_captured", true)
	}
	if err := s.app.Save(job); err != nil {
		logUpload("error", "csv_inspection_start_persist_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     work.id,
			"error":      err.Error(),
		})
		return
	}
	if err := s.clearJobArtifacts(work.id); err != nil {
		s.markFatal(work, "JOB_RECOVERY_CLEANUP_FAILED", "无法清理该作业上次未完成的预检结果。", err)
		return
	}

	file, closeFile, err := s.openRecordFile(job, "source_file")
	if err != nil {
		s.markFatal(work, "CSV_FILE_MISSING", "服务器找不到已上传的 CSV 文件。", err)
		return
	}
	defer closeFile()
	decoded, encodingName, err := decodedCSVReader(file)
	if err != nil {
		s.markFatal(work, "CSV_ENCODING_ERROR", "CSV 编码无法识别，请使用 UTF-8 或 GB18030。", err)
		return
	}
	csvReader := csv.NewReader(decoded)
	csvReader.FieldsPerRecord = -1
	csvReader.ReuseRecord = false
	rawHeaders, err := csvReader.Read()
	if err != nil {
		s.markFatal(work, "CSV_HEADER_INVALID", csvReadErrorMessage(err), err)
		return
	}
	headers, pdfIndex, pdfPageField, err := resolveCSVHeadersWithColumn(rawHeaders, job.GetString("csv_pdf_page_column"))
	if err != nil {
		s.markFatal(work, "CSV_HEADER_INVALID", err.Error(), err)
		return
	}

	inspection := csvInspection{
		Encoding:         encodingName,
		Headers:          headers,
		PDFPageField:     pdfPageField,
		Preview:          make([]map[string]string, 0, csvInspectionPreviewLimit),
		PreviewLocations: make([]csvPreviewLocation, 0, csvInspectionPreviewLimit),
		PreviewLimit:     csvInspectionPreviewLimit,
		PreviewKind:      "first_valid_rows",
	}
	for {
		values, readErr := csvReader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		inspection.TotalRows++
		if readErr != nil {
			inspection.InvalidRows++
			line := csvErrorLine(readErr)
			s.addJobError(work.id, line, "", "CSV_PARSE_ERROR", csvReadErrorMessage(readErr), "", false)
			continue
		}
		line, _ := csvReader.FieldPos(0)
		page, validationErr := buildCSVPageWithLimit(headers, values, pdfIndex, line, pdfPageLimit)
		if validationErr != nil {
			inspection.InvalidRows++
			s.addJobError(
				work.id,
				validationErr.line,
				validationErr.column,
				validationErr.code,
				validationErr.message,
				validationErr.rawValue,
				false,
			)
			continue
		}
		inspection.ValidRows++
		if inspection.MinPDFPage == 0 || page.pdfPage < inspection.MinPDFPage {
			inspection.MinPDFPage = page.pdfPage
		}
		if page.pdfPage > inspection.MaxPDFPage {
			inspection.MaxPDFPage = page.pdfPage
		}
		if len(inspection.Preview) < csvInspectionPreviewLimit {
			row := make(map[string]string, len(headers))
			for index, header := range headers {
				if index < len(values) {
					row[header] = values[index]
				}
			}
			inspection.Preview = append(inspection.Preview, row)
			inspection.PreviewLocations = append(inspection.PreviewLocations, csvPreviewLocation{CSVLine: line, PDFPage: page.pdfPage})
		}
	}
	encodedInspection, err := marshalCSVInspection(inspection)
	if errors.Is(err, errCSVInspectionTooLarge) {
		s.markFatal(work, "CSV_PREVIEW_TOO_LARGE", "前 20 条有效记录的完整预检结果超过 512 KiB，无法生成预览。上传原件已保留，请拆分材料后重新预检。", err)
		return
	}
	if err != nil {
		s.markFatal(work, "CSV_INSPECTION_SERIALIZE_FAILED", "无法保存 CSV 预检结果。", err)
		return
	}
	job.Set("status", "validated")
	job.Set("total_count", inspection.TotalRows)
	job.Set("processed_count", inspection.TotalRows)
	job.Set("success_count", inspection.ValidRows)
	job.Set("failed_count", inspection.InvalidRows)
	job.Set("error_message", fmt.Sprintf("检测编码：%s；页码字段：%s", encodingName, pdfPageField))
	job.Set("inspection_json", string(encodedInspection))
	job.Set("finished_at", types.NowDateTime())
	if err := s.app.Save(job); err != nil {
		s.markFatal(work, "CSV_INSPECTION_FINALIZE_FAILED", "CSV 已预检，但预检结果保存失败。", err)
		return
	}
	logUpload("info", "csv_inspection_completed", map[string]any{
		"request_id":     work.requestID,
		"job_id":         work.id,
		"project_id":     job.GetString("project"),
		"file_name":      job.GetString("original_filename"),
		"encoding":       inspection.Encoding,
		"pdf_page_field": inspection.PDFPageField,
		"total_count":    inspection.TotalRows,
		"valid_count":    inspection.ValidRows,
		"invalid_count":  inspection.InvalidRows,
	})
}

func (s *importService) processCSV(work importWork) {
	jobID := work.id
	job, err := s.app.FindRecordById("import_jobs", jobID)
	if err != nil {
		logUpload("error", "csv_job_lookup_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     jobID,
			"error":      err.Error(),
		})
		return
	}
	job.Set("status", "processing")
	job.Set("started_at", types.NowDateTime())
	job.Set("finished_at", "")
	job.Set("error_code", "")
	job.Set("error_message", "")
	job.Set("total_count", 0)
	job.Set("processed_count", 0)
	job.Set("success_count", 0)
	job.Set("failed_count", 0)
	if err := s.app.Save(job); err != nil {
		logUpload("error", "csv_job_start_persist_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     jobID,
			"project_id": job.GetString("project"),
			"error":      err.Error(),
		})
		return
	}
	if err := s.clearJobArtifacts(jobID); err != nil {
		s.markFatal(
			work,
			"JOB_RECOVERY_CLEANUP_FAILED",
			"无法清理该作业上次未完成的导入结果。",
			err,
		)
		return
	}

	file, closeFile, err := s.openRecordFile(job, "source_file")
	if err != nil {
		s.markFatal(work, "CSV_FILE_MISSING", "服务器找不到已上传的 CSV 文件。", err)
		return
	}
	defer closeFile()

	decoded, encodingName, err := decodedCSVReader(file)
	if err != nil {
		s.markFatal(work, "CSV_ENCODING_ERROR", "CSV 编码无法识别，请使用 UTF-8 或 GB18030。", err)
		return
	}

	csvReader := csv.NewReader(decoded)
	csvReader.FieldsPerRecord = -1
	csvReader.ReuseRecord = false

	headers, err := csvReader.Read()
	if err != nil {
		s.markFatal(work, "CSV_HEADER_INVALID", csvReadErrorMessage(err), err)
		return
	}
	headers, pdfIndex, _, headerErr := resolveCSVHeadersWithColumn(headers, job.GetString("csv_pdf_page_column"))
	if headerErr != nil {
		s.markFatal(work, "CSV_HEADER_INVALID", headerErr.Error(), headerErr)
		return
	}

	projectFileID := job.GetString("project_file")
	pdfPageLimit := job.GetInt("pdf_page_limit")
	if !job.GetBool("pdf_snapshot_captured") && job.GetString("inspection_json") != "" {
		s.markFatal(
			work,
			"PDF_SNAPSHOT_MISSING",
			"该 CSV 预检创建于 PDF 快照功能启用前，请重新上传并预检 CSV。",
			errors.New("legacy inspected job has no PDF snapshot"),
		)
		return
	}
	if !job.GetBool("pdf_snapshot_captured") {
		projectFileID, pdfPageLimit = s.primaryPDFSnapshot(job.GetString("project"))
		job.Set("project_file", projectFileID)
		job.Set("pdf_page_limit", pdfPageLimit)
		job.Set("pdf_snapshot_captured", true)
		if err := s.app.Save(job); err != nil {
			s.markFatal(work, "PDF_SNAPSHOT_PERSIST_FAILED", "CSV 导入无法固定当前主 PDF。", err)
			return
		}
	}
	if pdfPageLimit > 0 {
		projectFile, lookupErr := s.app.FindRecordById("project_files", projectFileID)
		if lookupErr != nil || projectFile.GetString("project") != job.GetString("project") || projectFile.GetString("status") != "ready" {
			if lookupErr == nil {
				lookupErr = errors.New("snapshotted PDF no longer belongs to the project or is not ready")
			}
			s.markFatal(work, "PDF_SNAPSHOT_UNAVAILABLE", "CSV 预检使用的 PDF 已不可用，请重新上传并预检 CSV。", lookupErr)
			return
		}
	}

	nextPageNumber := s.nextProjectPageNumber(job.GetString("project"))
	sourceSystem, sourceID, sourceVersion := s.csvLinkedSource(job)
	counters := &csvCounters{}
	batch := make([]csvPage, 0, batchSize)

	for {
		values, readErr := csvReader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			line := csvErrorLine(readErr)
			counters.total++
			counters.processed++
			counters.failed++
			s.addJobError(jobID, line, "", "CSV_PARSE_ERROR", csvReadErrorMessage(readErr), "", false)
			continue
		}

		line, _ := csvReader.FieldPos(0)
		counters.total++
		page, validationErr := buildCSVPageWithLimit(headers, values, pdfIndex, line, pdfPageLimit)
		if validationErr != nil {
			counters.processed++
			counters.failed++
			s.addJobError(
				jobID,
				validationErr.line,
				validationErr.column,
				validationErr.code,
				validationErr.message,
				validationErr.rawValue,
				false,
			)
			continue
		}
		batch = append(batch, page)

		if len(batch) >= batchSize {
			nextPageNumber = s.flushCSVBatch(job, batch, nextPageNumber, counters, sourceSystem, sourceID, sourceVersion)
			batch = batch[:0]
			s.updateJobProgress(job, counters, encodingName)
		}
	}

	if len(batch) > 0 {
		nextPageNumber = s.flushCSVBatch(job, batch, nextPageNumber, counters, sourceSystem, sourceID, sourceVersion)
		_ = nextPageNumber
	}

	status := "completed"
	if counters.failed > 0 {
		status = "completed_with_errors"
	}
	job.Set("status", status)
	job.Set("total_count", counters.total)
	job.Set("processed_count", counters.processed)
	job.Set("success_count", counters.success)
	job.Set("failed_count", counters.failed)
	job.Set("error_code", "")
	job.Set("error_message", fmt.Sprintf("检测编码：%s", encodingName))
	job.Set("finished_at", types.NowDateTime())
	if err := s.app.RunInTransaction(func(txDao core.App) error {
		if _, err := txDao.DB().NewQuery(
			`UPDATE pages
			 SET status = 'pending', updated = strftime('%Y-%m-%d %H:%M:%fZ')
			 WHERE import_job = {:jobID} AND status = 'importing'`,
		).Bind(dbx.Params{"jobID": jobID}).Execute(); err != nil {
			return err
		}
		return txDao.Save(job)
	}); err != nil {
		s.markFatal(work, "JOB_FINALIZE_FAILED", "条目已处理，但作业状态更新失败。", err)
		return
	}
	s.mu.Lock()
	delete(s.errorCounts, jobID)
	s.mu.Unlock()
	logUpload("info", "csv_completed", map[string]any{
		"request_id":    work.requestID,
		"kind":          "csv",
		"job_id":        jobID,
		"project_id":    job.GetString("project"),
		"file_name":     job.GetString("original_filename"),
		"file_size":     job.GetInt("file_size"),
		"file_hash":     job.GetString("file_hash"),
		"encoding":      encodingName,
		"total_count":   counters.total,
		"success_count": counters.success,
		"failed_count":  counters.failed,
	})
}

func decodedCSVReader(reader io.ReadSeeker) (io.Reader, string, error) {
	isUTF8, hasBOM, err := inspectUTF8(reader)
	if err != nil {
		return nil, "", err
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return nil, "", err
	}
	if isUTF8 {
		if hasBOM {
			if _, err := reader.Seek(3, io.SeekStart); err != nil {
				return nil, "", err
			}
		}
		return reader, "UTF-8", nil
	}
	return transform.NewReader(reader, simplifiedchinese.GB18030.NewDecoder()), "GB18030", nil
}

func inspectUTF8(reader io.Reader) (valid bool, bom bool, err error) {
	buffer := make([]byte, 64*1024)
	pending := make([]byte, 0, utf8.UTFMax)
	first := true

	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			data := make([]byte, 0, len(pending)+n)
			data = append(data, pending...)
			data = append(data, buffer[:n]...)
			pending = pending[:0]

			if first {
				first = false
				bom = len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf
				if bom {
					data = data[3:]
				}
			}

			for len(data) > 0 {
				if !utf8.FullRune(data) {
					pending = append(pending, data...)
					break
				}
				r, size := utf8.DecodeRune(data)
				if r == utf8.RuneError && size == 1 {
					return false, bom, nil
				}
				data = data[size:]
			}
		}
		if errors.Is(readErr, io.EOF) {
			return len(pending) == 0, bom, nil
		}
		if readErr != nil {
			return false, bom, readErr
		}
	}
}

func validateCSVHeaders(raw []string) ([]string, int, error) {
	headers, pdfIndex, _, err := resolveCSVHeaders(raw)
	return headers, pdfIndex, err
}

var pdfPageHeaderAliases = []string{"PDF页码", "page", "pdf_page", "页码"}

func csvHeaderColumns(raw []string) ([]string, []int, error) {
	if len(raw) == 0 {
		return nil, nil, errors.New("CSV 缺少表头。")
	}
	headers := make([]string, len(raw))
	seen := map[string]struct{}{}
	aliasIndexes := make([]int, 0, 1)
	for i, value := range raw {
		header := strings.TrimSpace(strings.TrimPrefix(value, "\ufeff"))
		if header == "" {
			return nil, nil, fmt.Errorf("第 %d 列表头为空。", i+1)
		}
		if _, exists := seen[header]; exists {
			return nil, nil, fmt.Errorf("表头 %q 重复。", header)
		}
		seen[header] = struct{}{}
		headers[i] = header
		for _, alias := range pdfPageHeaderAliases {
			if strings.EqualFold(header, alias) {
				aliasIndexes = append(aliasIndexes, i)
				break
			}
		}
	}
	return headers, aliasIndexes, nil
}

func resolveCSVHeaders(raw []string) ([]string, int, string, error) {
	return resolveCSVHeadersWithColumn(raw, "")
}

func resolveCSVHeadersWithColumn(raw []string, selected string) ([]string, int, string, error) {
	headers, aliasIndexes, err := csvHeaderColumns(raw)
	if err != nil {
		return nil, -1, "", err
	}
	if selected != "" {
		for index, header := range headers {
			if header == selected {
				return headers, index, header, nil
			}
		}
		return nil, -1, "", fmt.Errorf("所选页码列 %q 不在该 CSV 的表头中，请重新选择。", selected)
	}
	if len(aliasIndexes) == 0 {
		return nil, -1, "", fmt.Errorf(
			"CSV 缺少页码字段；支持 PDF页码、page、pdf_page 或 页码。检测到的表头：%s。",
			strings.Join(headers, "、"),
		)
	}
	if len(aliasIndexes) > 1 {
		aliases := make([]string, 0, len(aliasIndexes))
		for _, index := range aliasIndexes {
			aliases = append(aliases, headers[index])
		}
		return nil, -1, "", fmt.Errorf("检测到多个页码字段：%s；请只保留一个。", strings.Join(aliases, "、"))
	}
	pdfIndex := aliasIndexes[0]
	return headers, pdfIndex, headers[pdfIndex], nil
}

type rowValidationError struct {
	line     int
	column   string
	code     string
	message  string
	rawValue string
}

func buildCSVPage(headers, values []string, pdfIndex, line int) (csvPage, *rowValidationError) {
	if len(values) != len(headers) {
		return csvPage{}, &rowValidationError{
			line:    line,
			code:    "COLUMN_COUNT_MISMATCH",
			message: fmt.Sprintf("本行有 %d 列，表头有 %d 列。", len(values), len(headers)),
		}
	}

	rawPDFPage := strings.TrimSpace(values[pdfIndex])
	pdfPage, err := strconv.Atoi(rawPDFPage)
	if err != nil || pdfPage <= 0 {
		return csvPage{}, &rowValidationError{
			line:     line,
			column:   headers[pdfIndex],
			code:     "INVALID_PDF_PAGE",
			message:  "PDF页码必须是正整数。",
			rawValue: truncateText(rawPDFPage, 200),
		}
	}

	structured := make(map[string]string, len(headers)-1)
	parts := make([]string, 0, len(headers)-1)
	orderedHeaders := make([]string, 0, len(headers)-1)
	for index, header := range headers {
		if index == pdfIndex {
			continue
		}
		value := strings.TrimSpace(values[index])
		structured[header] = value
		orderedHeaders = append(orderedHeaders, header)
		if value != "" {
			parts = append(parts, value)
		}
	}
	if len(parts) == 0 {
		return csvPage{}, &rowValidationError{
			line:    line,
			code:    "EMPTY_CONTENT",
			message: "去掉 PDF页码 后内容不能为空。",
		}
	}

	headersJSON, _ := json.Marshal(orderedHeaders)
	rowJSON, err := json.Marshal(structured)
	if err != nil {
		return csvPage{}, &rowValidationError{
			line:    line,
			code:    "ROW_SERIALIZE_ERROR",
			message: "无法序列化本行内容。",
		}
	}
	return csvPage{
		line:        line,
		pdfPage:     pdfPage,
		rowJSON:     string(rowJSON),
		headersJSON: string(headersJSON),
		entryText:   strings.Join(parts, " "),
	}, nil
}

func buildCSVPageWithLimit(headers, values []string, pdfIndex, line, maxPDFPage int) (csvPage, *rowValidationError) {
	page, validationErr := buildCSVPage(headers, values, pdfIndex, line)
	if validationErr != nil {
		return csvPage{}, validationErr
	}
	if maxPDFPage > 0 && page.pdfPage > maxPDFPage {
		return csvPage{}, &rowValidationError{
			line:     line,
			column:   headers[pdfIndex],
			code:     "PDF_PAGE_OUT_OF_RANGE",
			message:  fmt.Sprintf("PDF页码超出当前主 PDF 的页数上限（%d 页）。", maxPDFPage),
			rawValue: strconv.Itoa(page.pdfPage),
		}
	}
	return page, nil
}

func (s *importService) nextProjectPageNumber(projectID string) int {
	records, err := s.app.FindRecordsByFilter(
		"pages",
		fmt.Sprintf("project = %q", projectID),
		"-page_number",
		1,
		0,
	)
	if err != nil || len(records) == 0 {
		return 1
	}
	return records[0].GetInt("page_number") + 1
}

// allocateProjectPageNumber must run inside the caller's write transaction.
// OCR and CSV use separate workers, so a number read before entering that
// transaction may already belong to the other writer by the time it is saved.
func allocateProjectPageNumber(tx core.App, projectID string, minimum int) (int, error) {
	var next struct {
		Number int `db:"number"`
	}
	if err := tx.DB().NewQuery("SELECT COALESCE(MAX(page_number),0)+1 AS number FROM pages WHERE project={:project}").Bind(dbx.Params{"project": projectID}).One(&next); err != nil {
		return 0, err
	}
	return max(next.Number, minimum), nil
}

func (s *importService) csvLinkedSource(job *core.Record) (string, string, string) {
	if job.GetString("source_link") != "linked" {
		return "", "", ""
	}
	sourceID := strings.TrimSpace(job.GetString("source"))
	if sourceID == "" {
		return "", "", ""
	}
	record, err := s.app.FindRecordById("sources", sourceID)
	if err != nil {
		return "", "", ""
	}
	logicalID := strings.TrimSpace(record.GetString("logical_id"))
	if logicalID == "" {
		return "", "", ""
	}
	// 版本用本批作业号：同一来源可以再进下一批，行号只在这一批里唯一。
	return "source_registry", logicalID, job.Id
}

func (s *importService) flushCSVBatch(
	job *core.Record,
	rows []csvPage,
	nextPageNumber int,
	counters *csvCounters,
	sourceSystem, sourceID, sourceVersion string,
) int {
	projectID := job.GetString("project")
	projectFileID := job.GetString("project_file")
	err := s.app.RunInTransaction(func(txDao core.App) error {
		allocated, err := allocateProjectPageNumber(txDao, projectID, nextPageNumber)
		if err != nil {
			return err
		}
		nextPageNumber = allocated
		for index, row := range rows {
			if err := savePage(txDao, job.Id, projectID, projectFileID, nextPageNumber+index, row, sourceSystem, sourceID, sourceVersion); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		counters.processed += len(rows)
		counters.success += len(rows)
		return nextPageNumber + len(rows)
	}
	logUpload("warn", "csv_batch_transaction_failed", map[string]any{
		"kind":       "csv",
		"job_id":     job.Id,
		"project_id": projectID,
		"batch_size": len(rows),
		"error":      err.Error(),
	})

	// Fall back to individual writes so one unexpected database error doesn't
	// prevent later valid rows from importing.
	for _, row := range rows {
		err := s.app.RunInTransaction(func(tx core.App) error {
			allocated, err := allocateProjectPageNumber(tx, projectID, nextPageNumber)
			if err != nil {
				return err
			}
			nextPageNumber = allocated
			return savePage(tx, job.Id, projectID, projectFileID, allocated, row, sourceSystem, sourceID, sourceVersion)
		})
		if err != nil {
			counters.failed++
			s.addJobError(
				job.Id,
				row.line,
				"",
				"DATABASE_WRITE_ERROR",
				"该行通过格式校验，但写入数据库失败。",
				truncateText(err.Error(), 500),
				true,
			)
		} else {
			counters.success++
			nextPageNumber++
		}
		counters.processed++
	}
	return nextPageNumber
}

// 缺字占位符 @N（如 @98969）：CSV 里源库对未登记字形的登记序号，不是码位、也不是字形。
// 口径与 assist_rules.js 的 PLACEHOLDER 一致（@ + 4~6 位十六进制数字）。
var glyphPlaceholderRe = regexp.MustCompile(`@[0-9a-fA-F]{4,6}`)

func savePage(dao core.App, jobID, projectID, projectFileID string, pageNumber int, row csvPage, sourceSystem, sourceID, sourceVersion string) error {
	collection, err := dao.FindCollectionByNameOrId("pages")
	if err != nil {
		return err
	}
	record := core.NewRecord(collection)
	record.Set("project", projectID)
	record.Set("import_job", jobID)
	record.Set("project_file", projectFileID)
	record.Set("page_number", pageNumber)
	record.Set("pdf_page", row.pdfPage)
	if sourceSystem != "" && sourceID != "" && sourceVersion != "" && row.line > 0 {
		record.Set("source_system", sourceSystem)
		record.Set("source_id", sourceID)
		record.Set("source_version", sourceVersion)
		record.Set("source_entry_id", strconv.Itoa(row.line))
	}
	record.Set("ocr_row_json", row.rowJSON)
	if row.sourceBindingJSON != "" {
		record.Set("ocr_source_binding_json", row.sourceBindingJSON)
	}
	if row.ocrCellsJSON != "" {
		record.Set("ocr_cells_json", row.ocrCellsJSON)
	}
	if row.ocrAbstained {
		record.Set("missing_glyph", true)
	}
	record.Set("row_headers_json", row.headersJSON)
	record.Set("ocr_text", row.entryText)
	record.Set("proofread_round", 1)
	record.Set("mismatch_count", 0)
	record.Set("status", "importing")
	// 含缺字占位符的行置 missing_glyph=true（自动状态，供 A7.3 的缺字待登记队列单独领取）。
	// 不写 blocked_reason：那是只有人工写入口的结论字段，自动写会污染难度推导与 D 工序。
	if glyphPlaceholderRe.MatchString(row.entryText) {
		record.Set("missing_glyph", true)
	}
	return dao.Save(record)
}

// 坏 CSV 的每一坏行都落一条错误记录曾无上限：50MB 坏文件可产生百万级写入。
// 上限对全作业生效（含重试前已落库的行），超限写一条可见的截断标记；
// 失败总数仍由 counters 全量统计，错误定位能力保留前 1000 行。
const maxImportJobErrorRows = 1000

func (s *importService) addJobError(
	jobID string,
	rowNumber int,
	columnName string,
	code string,
	message string,
	rawValue string,
	retryable bool,
) {
	s.mu.Lock()
	if s.errorCounts == nil {
		s.errorCounts = map[string]int{}
	}
	count, seen := s.errorCounts[jobID]
	s.mu.Unlock()
	if !seen {
		if n, err := s.app.CountRecords("import_job_errors", dbx.HashExp{"job": jobID}); err == nil {
			count = int(n)
		}
	}
	count++
	s.mu.Lock()
	s.errorCounts[jobID] = count
	s.mu.Unlock()
	if count > maxImportJobErrorRows+1 {
		return
	}
	collection, err := s.app.FindCollectionByNameOrId("import_job_errors")
	if err != nil {
		logUpload("error", "csv_error_collection_lookup_failed", map[string]any{
			"kind":       "csv",
			"job_id":     jobID,
			"row_number": rowNumber,
			"error_code": code,
			"error":      err.Error(),
		})
		return
	}
	record := core.NewRecord(collection)
	record.Set("job", jobID)
	record.Set("row_number", rowNumber)
	record.Set("column_name", columnName)
	record.Set("error_code", code)
	record.Set("message", message)
	record.Set("raw_value", truncateText(rawValue, 1000))
	record.Set("retryable", retryable)
	if count == maxImportJobErrorRows+1 {
		record.Set("column_name", "")
		record.Set("error_code", "ERROR_ROWS_TRUNCATED")
		record.Set("message", fmt.Sprintf("错误行记录已达上限 %d 条，后续错误未逐条落库；失败总数仍按全量统计。请修复已列出的问题后重新导入。", maxImportJobErrorRows))
		record.Set("raw_value", "")
		record.Set("retryable", false)
	}
	if err := s.app.Save(record); err != nil {
		logUpload("error", "csv_error_persist_failed", map[string]any{
			"kind":       "csv",
			"job_id":     jobID,
			"row_number": rowNumber,
			"error_code": code,
			"error":      err.Error(),
		})
	}
}

func (s *importService) updateJobProgress(job *core.Record, counters *csvCounters, encodingName string) {
	job.Set("processed_count", counters.processed)
	job.Set("success_count", counters.success)
	job.Set("failed_count", counters.failed)
	job.Set("error_message", fmt.Sprintf("检测编码：%s", encodingName))
	if err := s.app.Save(job); err != nil {
		logUpload("error", "csv_progress_persist_failed", map[string]any{
			"kind":            "csv",
			"job_id":          job.Id,
			"project_id":      job.GetString("project"),
			"processed_count": counters.processed,
			"success_count":   counters.success,
			"failed_count":    counters.failed,
			"error":           err.Error(),
		})
	}
}

func csvErrorLine(err error) int {
	var parseError *csv.ParseError
	if errors.As(err, &parseError) {
		return parseError.Line
	}
	return 0
}

func csvReadErrorMessage(err error) string {
	var parseError *csv.ParseError
	if errors.As(err, &parseError) {
		return fmt.Sprintf("第 %d 行、第 %d 列 CSV 格式错误：%s。", parseError.Line, parseError.Column, parseError.Err)
	}
	return "CSV 格式错误。"
}

func truncateText(value string, maxRunes int) string {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes]) + "…"
}
