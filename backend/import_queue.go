package main

import (
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func (s *importService) enqueue(work importWork) {
	if work.requestID == "" {
		work.requestID = "recovery-" + work.id
	}
	if work.enqueuedAt.IsZero() {
		work.enqueuedAt = time.Now()
	}
	key := work.kind + ":" + work.id
	s.mu.Lock()
	if _, exists := s.pending[key]; exists {
		s.mu.Unlock()
		logUpload("info", "work_deduplicated", map[string]any{
			"request_id": work.requestID,
			"kind":       work.kind,
			"record_id":  work.id,
		})
		return
	}
	s.pending[key] = struct{}{}
	s.mu.Unlock()
	logUpload("info", "work_queued", map[string]any{
		"request_id": work.requestID,
		"kind":       work.kind,
		"record_id":  work.id,
	})
	if work.kind == "ocr" && s.ocrQueue != nil {
		s.ocrQueue <- work
	} else {
		s.queue <- work
	}
}

func (s *importService) finishWork(work importWork) {
	s.mu.Lock()
	delete(s.pending, work.kind+":"+work.id)
	s.mu.Unlock()
}

// workRoute 把「谁能处理这个 kind」与「它失败时终态写到哪个集合」放在同一处。
//
// 这两件事以前分别写在 runWorker 的 switch 与 markFatal 的 if 链里，两边可以各自漂：
// 只给 runWorker 加一个 kind，panic 兜底就会去错的集合里找记录，查不到时只留一条
// fatal_record_lookup_failed 日志，作业永远停在 processing——conversion 遇到这个还有
// 二次代价（idx_conversion_jobs_active 是 `status IN ('queued','processing')` 的部分唯一
// 索引，该项目此后每次发起转换都拿 409，管理员只能靠重启进程恢复，见 markFatal）。
// 合成一张表后，「能入队但没有兜底」这个状态不存在了。
//
// #190 的 conversion 与导入共用这一条**串行**队列，是刻意的：一条 worker、先进先出，
// 所以同一时刻只有一个作业在跑，一次转换不会和一次导入抢同一批 pages。代价是排队——
// 一本两万条的转换排在一次全量导入后面，要等前面那条跑完才开始，管理端看到的
// 「已排队」就是这件事。触发拆分的判据不是「队列里有两种作业」，而是 #94 的实测：
// 两万条转换与两万条导入同时在场、排队时长真的成了用户能感觉到的问题时，再按 kind
// 分池。owner 明确不要求现在拆（#289 评审），所以这里保留共用，把语义写下来。
type workRoute struct {
	process func(*importService, importWork)
	// collection 是失败终态要写的集合；空串表示这个 kind 的作业记录形状与 import_jobs
	// 不同，由它自己的收尾函数处理（conversion → markConversionFatal）。
	collection string
}

// 在 init 里赋值而不是写成带初始化表达式的 var：表里的方法表达式会引用那些方法，
// 而其中几个方法体又调 markFatal，markFatal 又读这张表——写成 var 初始化式就是一条
// 包级初始化环（编译期报 initialization cycle），init 函数体不参与那个依赖分析。
var workRoutes map[string]workRoute

func init() {
	workRoutes = map[string]workRoute{
		"csv_inspect":  {(*importService).processCSVInspection, "import_jobs"},
		"csv":          {(*importService).processCSV, "import_jobs"},
		"pdf":          {(*importService).processPDF, "project_files"},
		"ocr":          {(*importService).processOCR, "import_jobs"},
		"bundle":       {(*importService).processBundle, "import_jobs"},
		"conversion":   {(*importService).processConversion, ""},
		"batch_report": {(*importService).processBatchReport, "batch_report_exports"},
	}
}

func (s *importService) runWorker() { s.runWorkQueue(s.queue) }

func (s *importService) runWorkQueue(queue <-chan importWork) {
	// OCR shares the image worker's shutdown context. Leave its durable backlog
	// queued for recovery instead of draining it with an already-cancelled client.
	var stopped <-chan struct{}
	if queue == s.ocrQueue && s.imageContext != nil {
		stopped = s.imageContext.Done()
	}
	for {
		var work importWork
		select {
		case <-stopped:
			return
		case next, open := <-queue:
			if !open {
				return
			}
			work = next
		}
		// A buffered job and cancellation can both be ready in the select above.
		select {
		case <-stopped:
			return
		default:
		}
		func() {
			startedAt := time.Now()
			logUpload("info", "work_started", map[string]any{
				"request_id":    work.requestID,
				"kind":          work.kind,
				"record_id":     work.id,
				"queue_wait_ms": startedAt.Sub(work.enqueuedAt).Milliseconds(),
			})
			defer s.finishWork(work)
			defer func() {
				result, errorCode := "unknown", ""
				if route, ok := workRoutes[work.kind]; ok {
					collection := route.collection
					if work.kind == "conversion" {
						collection = "conversion_jobs"
					}
					if record, err := s.app.FindRecordById(collection, work.id); err == nil {
						result, errorCode = record.GetString("status"), record.GetString("error_code")
					}
				}
				logUpload("info", "work_finished", map[string]any{
					"request_id":  work.requestID,
					"kind":        work.kind,
					"record_id":   work.id,
					"duration_ms": time.Since(startedAt).Milliseconds(),
					"result":      result,
					"error_code":  errorCode,
				})
			}()
			defer func() {
				if recovered := recover(); recovered != nil {
					panicErr := fmt.Errorf("%v", recovered)
					logUpload("error", "worker_panic", map[string]any{
						"request_id": work.requestID,
						"kind":       work.kind,
						"record_id":  work.id,
						"error":      panicErr.Error(),
					})
					s.markFatal(work, "WORKER_PANIC", "服务器处理文件时发生内部错误。", panicErr)
				}
			}()
			route, known := workRoutes[work.kind]
			if !known {
				// 队列里的 kind 只由 enqueue 写入，落到这里说明表与 enqueue 漂了。
				// 不能静默跳过：那样作业会永远停在 queued，而且没有任何日志解释。
				logUpload("error", "worker_unknown_kind", map[string]any{
					"request_id": work.requestID,
					"kind":       work.kind,
					"record_id":  work.id,
				})
				return
			}
			route.process(s, work)
		}()
	}
}

// Keyset pagination stays stable as workers change statuses while recovery runs.
// Offset pagination would skip records when completed jobs leave the predicate.
func (s *importService) walkPendingWork(collection, filter string, pageSize int, visit func(*core.Record)) (int, error) {
	if pageSize < 1 {
		return 0, fmt.Errorf("recovery page size must be positive")
	}
	var afterCreated, afterID string
	count := 0
	for {
		query := "(" + filter + ")"
		params := dbx.Params{}
		if afterID != "" {
			query += ` && (created > {:afterCreated} || (created = {:afterCreated} && id > {:afterID}))`
			params["afterCreated"], params["afterID"] = afterCreated, afterID
		}
		records, err := s.app.FindRecordsByFilter(collection, query, "created,id", pageSize, 0, params)
		if err != nil {
			return count, err
		}
		if len(records) == pageSize {
			last := records[len(records)-1]
			afterID = last.Id
			// PocketBase normalizes date precision when loading a record. Use
			// the database's exact ordering value for legacy date strings too;
			// a no-millisecond timestamp must not repeatedly match itself.
			if err := s.app.DB().Select("created").From(collection).Where(dbx.HashExp{"id": last.Id}).Row(&afterCreated); err != nil {
				if !errors.Is(err, sql.ErrNoRows) {
					return count, err
				}
				afterCreated = last.GetString("created")
			}
		}
		for _, record := range records {
			visit(record)
			count++
		}
		if len(records) < pageSize {
			return count, nil
		}
	}
}

func (s *importService) recoverPendingWork() {
	type recoveryScan struct {
		collection, filter, kind string
	}
	scans := []recoveryScan{
		{"import_jobs", `(status="queued" || status="processing" || status="inspecting") && mode!="ocr"`, "csv"},
		{"import_jobs", `(status="queued" || status="processing" || status="inspecting") && mode="ocr"`, "ocr"},
		{"conversion_jobs", `status="queued" || status="processing"`, "conversion"},
		{"project_files", `status="processing"`, "pdf"},
		{"batch_report_exports", `status="queued" || status="processing"`, "batch_report"},
	}
	counts := make([]int, len(scans))
	runScan := func(index int) {
		scan := scans[index]
		count, err := s.walkPendingWork(scan.collection, scan.filter, 250, func(record *core.Record) {
			kind := scan.kind
			if kind == "csv" {
				if record.GetString("mode") == "bundle" {
					kind = "bundle"
				} else if record.GetString("status") == "inspecting" {
					kind = "csv_inspect"
				}
			}
			s.enqueue(importWork{kind: kind, id: record.Id, requestID: "recovery-" + record.Id})
		})
		counts[index] = count
		if err != nil {
			logUpload("error", "recovery_query_failed", map[string]any{"kind": scan.kind, "error": err.Error()})
		}
	}
	// OCR has its own worker/queue: its discovery may run independently even
	// while admission into the shared queue is blocked by an import backlog.
	var pending sync.WaitGroup
	pending.Go(func() { runScan(1) })
	// Preserve the original shared-worker recovery order. A conversion scans
	// only published pages, so admitting it ahead of an older queued import
	// could complete the conversion before that import publishes its rows.
	for _, index := range []int{0, 2, 3, 4} {
		runScan(index)
	}
	pending.Wait()
	logUpload("info", "recovery_scan_completed", map[string]any{
		"csv_jobs": counts[0], "ocr_jobs": counts[1], "conversions": counts[2], "pdf_files": counts[3], "batch_reports": counts[4],
	})
}

func (s *importService) markFatal(work importWork, code, message string, cause error) {
	s.mu.Lock()
	delete(s.errorCounts, work.id)
	s.mu.Unlock()
	// 集合从 workRoutes 读，与 runWorker 的分派同一份事实（见 workRoutes 的注释）。
	// conversion 那一格是空串：它的记录在 conversion_jobs，形状与 import_jobs 不同
	// （有自己的 finished_at 与错误列语义），整支交给它自己的收尾函数。
	route, known := workRoutes[work.kind]
	if !known {
		logUpload("error", "fatal_unknown_kind", map[string]any{
			"request_id": work.requestID,
			"kind":       work.kind,
			"record_id":  work.id,
			"error_code": code,
			"cause":      errorText(cause),
		})
		return
	}
	if route.collection == "" {
		s.markConversionFatal(work, code, message, cause)
		return
	}
	record, err := s.app.FindRecordById(route.collection, work.id)
	if err != nil {
		logUpload("error", "fatal_record_lookup_failed", map[string]any{
			"request_id": work.requestID,
			"kind":       work.kind,
			"record_id":  work.id,
			"error_code": code,
			"error":      err.Error(),
			"cause":      errorText(cause),
		})
		return
	}
	record.Set("status", "failed")
	if work.kind == "pdf" {
		record.Set("status", "error")
	}
	record.Set("error_code", code)
	record.Set("error_message", message)
	if work.kind == "csv" || work.kind == "csv_inspect" || work.kind == "ocr" || work.kind == "bundle" {
		record.Set("finished_at", types.NowDateTime())
	}
	var cleanup func() error
	if work.kind == "csv" || work.kind == "ocr" || work.kind == "bundle" {
		cleanup = func() error {
			return s.clearJobPages(work.id)
		}
	}
	persistErr, cleanupErr := persistBeforeCleanup(
		func() error { return s.app.Save(record) },
		cleanup,
	)
	if persistErr != nil {
		logUpload("error", "fatal_status_persist_failed", map[string]any{
			"request_id": work.requestID,
			"kind":       work.kind,
			"record_id":  work.id,
			"project_id": record.GetString("project"),
			"error_code": code,
			"error":      persistErr.Error(),
		})
		return
	}
	if cleanupErr != nil {
		message += " 暂存条目自动清理失败，请联系管理员处理。"
		record.Set("error_message", message)
		logUpload("error", "failed_csv_staging_cleanup_failed", map[string]any{
			"request_id": work.requestID,
			"job_id":     work.id,
			"error_code": code,
			"error":      cleanupErr.Error(),
		})
		if err := s.app.Save(record); err != nil {
			logUpload("error", "fatal_cleanup_message_persist_failed", map[string]any{
				"request_id": work.requestID,
				"kind":       work.kind,
				"record_id":  work.id,
				"project_id": record.GetString("project"),
				"error_code": code,
				"error":      err.Error(),
			})
		}
	}
	logUpload("error", "work_failed", map[string]any{
		"request_id":    work.requestID,
		"kind":          work.kind,
		"record_id":     work.id,
		"project_id":    record.GetString("project"),
		"file_name":     record.GetString("original_filename"),
		"file_size":     record.GetInt("file_size"),
		"file_hash":     record.GetString("file_hash"),
		"error_code":    code,
		"message":       message,
		"error":         errorText(cause),
		"cleanup_error": errorText(cleanupErr),
	})
}
