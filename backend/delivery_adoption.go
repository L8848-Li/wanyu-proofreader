package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"fangji/backend/reviewbundle"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/router"
)

// All authority reads use the transaction passed by the caller. Never consult
// the outer application's connection from inside a snapshot/write transaction.
func requireAdoptionManagerInApp(app core.App, c *core.RequestEvent, projectID string) (*core.Record, *core.Record, error) {
	return requireProjectManagerInApp(app, c, projectID)
}

type adoptionDeliveryInput struct {
	BatchID             string `json:"adoption_batch_id"`
	ExpectedScopeDigest string `json:"expected_scope_digest"`
	Reviewer            string `json:"reviewer"`
	Previous            string `json:"previous"`
	ChangeReason        string `json:"change_reason"`
	PreviewSHA          string `json:"preview_sha256"`
	RequestID           string `json:"request_id"`
}

func deliveryProblem(status int, code, message, next string) *router.ApiError {
	err := apis.NewApiError(status, message, nil)
	err.Data["reasonCode"] = code
	err.Data["nextAction"] = next
	return err
}

func (s *deliveryService) adoptionDeliveryHandoff(app core.App, projectID string, input adoptionDeliveryInput) (deliveryHandoff, error) {
	var h deliveryHandoff
	batch, err := app.FindRecordById("adoption_batches", input.BatchID)
	if err != nil || batch.GetString("project") != projectID {
		return h, apis.NewNotFoundError("编选批次不存在。", nil)
	}
	if batch.GetString("status") != adoptionBatchConfirmed {
		return h, deliveryProblem(400, "ADOPTION_NOT_CONFIRMED", "先确认编选范围再准备交付。", "返回编选批次，核对并确认范围。")
	}
	rule, err := parseAdoptionRule(json.RawMessage(batch.GetString("rule_json")))
	if err != nil {
		return h, err
	}
	computation, err := computeAdoption(app, projectID, batch.GetString("purpose"), batch.Id, rule)
	if err != nil {
		return h, err
	}
	stored := batch.GetString("scope_digest")
	if stored == "" || input.ExpectedScopeDigest != stored || stored != adoptionScopeDigest(computation) || adoptionCountsDrifted(batch, computation) != "" {
		problem := deliveryProblem(409, "ADOPTION_SCOPE_CHANGED", "编选范围已变更或缺少确认摘要，请新建并确认编选批次。", "重新计算并人工确认编选范围。")
		// A permission change can invalidate the confirmation before the snapshot
		// read. Expose the same destination while preserving the stale-scope error.
		if len(rule.ImportJobs) == 1 {
			if job, jobErr := deliveryImportJob(app, projectID, rule.ImportJobs[0]); jobErr == nil {
				if source, sourceErr := app.FindRecordById("sources", job.GetString("source")); sourceErr == nil {
					if blocked := deliverySourceRightsProblem(app, source, batch.GetString("purpose")); blocked != nil {
						problem.Data["sourceId"] = blocked.Data["sourceId"]
						problem.Data["purpose"] = blocked.Data["purpose"]
					}
				}
			}
		}
		return h, problem
	}
	// The digest covers the ENTIRE project. Only afterwards may the adapter
	// narrow declarations to a single complete imported bundle, including its
	// excluded and pending rows. A selected-only manifest is not an authority.
	rows, err := adoptionRows(app, projectID, batch.GetString("purpose"))
	if err != nil {
		return h, err
	}
	if len(rule.ImportJobs) != 1 || rule.ImportJobs[0] == "" {
		return h, deliveryProblem(400, "UNSUPPORTED_IMPORT_SCOPE", "交付要求编选规则显式指定一个完整 ReviewBundle 导入批次，请新建并确认对应编选。", "选择恰好一个完整 Bundle 入站作业；跨批次与 CSV/OCR 暂不支持直接出包。")
	}
	h.ImportJob = rule.ImportJobs[0]
	belongs := map[string]bool{}
	for _, row := range rows {
		if row.ImportJob == h.ImportJob {
			belongs[row.PageID] = true
		}
	}
	for _, entry := range computation.Entries {
		if !belongs[entry.PageID] {
			continue
		}
		scope := "excluded"
		if entry.Pending {
			scope = "pending"
			h.Expected.Pending++
		} else if entry.Decision == adoptionDecisionSelect {
			scope = "adopted"
			h.Expected.Adopted++
		} else {
			h.Expected.Excluded++
		}
		h.Entries = append(h.Entries, deliveryEntry{PageID: entry.PageID, Scope: scope, Reason: entry.Reason})
	}
	h.NativeBatch = batch
	h.SelectionRef = batch.Id
	h.SelectionRule = "sha256:" + reviewbundle.Digest([]byte(batch.GetString("rule_json")))
	h.ConfirmedBy = batch.GetString("confirmed_by")
	h.Recipient = batch.GetString("recipient")
	h.Purpose = batch.GetString("purpose")
	h.Reviewer = strings.TrimSpace(input.Reviewer)
	h.Previous = input.Previous
	h.ChangeReason = strings.TrimSpace(input.ChangeReason)
	h.PreviewSHA = input.PreviewSHA
	return h, nil
}

func (s *deliveryService) adoptionDeliveryPreflight(c *core.RequestEvent) error {
	if os.Getenv("FANGJI_NATIVE_DELIVERY_ENABLED") == "0" {
		return apis.NewApiError(http.StatusServiceUnavailable, "编选直接出包暂未开放，请使用原有交接清单流程。", nil)
	}
	var input adoptionDeliveryInput
	if err := c.BindBody(&input); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", err)
	}
	var snap reviewbundle.DeliverySnapshot
	var selection map[string]any
	var projectCounts map[string]any
	err := s.app.RunInTransaction(func(app core.App) error {
		auth, _, err := requireAdoptionManagerInApp(app, c, c.Request.PathValue("projectId"))
		if err != nil {
			return err
		}
		h, err := s.adoptionDeliveryHandoff(app, c.Request.PathValue("projectId"), input)
		if err != nil {
			return err
		}
		selection = map[string]any{"id": h.NativeBatch.Id, "confirmed_at": h.NativeBatch.GetString("confirmed_at"), "scope_digest": h.NativeBatch.GetString("scope_digest"), "confirmed_by": h.NativeBatch.GetString("confirmed_by")}
		projectCounts = map[string]any{"total": h.NativeBatch.GetInt("total_count"), "selected": h.NativeBatch.GetInt("selected_count"), "excluded": h.NativeBatch.GetInt("excluded_count"), "pending": h.NativeBatch.GetInt("pending_count")}
		snap, err = s.readDeliverySnapshot(app, c.Request.PathValue("projectId"), auth.Id, h)
		return err
	})
	if err != nil {
		return deliveryInputError(err)
	}
	r := reviewbundle.Reconcile(snap)
	blockers := []map[string]string{}
	_, buildErr := reviewbundle.BuildDelivery(snap, "2000-01-01T00:00:00Z")
	if buildErr != nil {
		r.Status = "inconsistent"
		r.Problems = append(r.Problems, buildErr.Error())
		blockers = append(blockers, map[string]string{"code": "DELIVERY_RECONCILIATION_FAILED", "message": buildErr.Error(), "nextAction": "处理对账问题，再重新检查。"})
	}
	return c.JSON(http.StatusOK, map[string]any{"selection": selection, "selection_project_counts": projectCounts, "package_scope_counts": r.Counts, "reconciliation": r, "blockers": blockers, "preview_sha256": reviewbundle.SnapshotDigest(snap), "can_generate": buildErr == nil, "release_decision": "human_required", "selection_authority": snap.SelectionAuthority, "selection_scope_digest": snap.SelectionScopeDigest, "import_job": snap.ImportJob, "source": map[string]string{"system": snap.SourceSystem, "id": snap.SourceID, "version": snap.SourceVersion, "rights_ref": snap.RightsRef}, "previous": snap.Previous, "version": snap.Version, "dependency_gaps": []string{"接收方试导入与双方交接确认仍须完成"}})
}

var deliveryRequestUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

func (s *deliveryService) createAdoptionDelivery(c *core.RequestEvent) error {
	if os.Getenv("FANGJI_NATIVE_DELIVERY_ENABLED") == "0" {
		return apis.NewApiError(http.StatusServiceUnavailable, "编选直接出包暂未开放，请使用原有交接清单流程。", nil)
	}
	var input adoptionDeliveryInput
	if err := c.BindBody(&input); err != nil {
		return apis.NewBadRequestError("请求内容无法解析。", err)
	}
	if !deliveryRequestUUID.MatchString(input.RequestID) {
		return apis.NewBadRequestError("request_id 必须是 UUID；重试须复用同一值。", nil)
	}
	input.RequestID = strings.ToLower(input.RequestID)
	input.Reviewer = strings.TrimSpace(input.Reviewer)
	input.ChangeReason = strings.TrimSpace(input.ChangeReason)
	fingerprintJSON, _ := json.Marshal(input)
	fingerprint := reviewbundle.Digest(fingerprintJSON)
	var record *core.Record
	var events []*core.Record
	replay := false
	err := s.app.RunInTransaction(func(app core.App) error {
		projectID := c.Request.PathValue("projectId")
		auth, _, err := requireAdoptionManagerInApp(app, c, projectID)
		if err != nil {
			return err
		}
		// Authorization precedes replay. Replay precedes recomputing the latest
		// version or live selection: a successful request remains retryable.
		existing, err := app.FindFirstRecordByFilter("release_deliveries", "project = {:project} && operator = {:operator} && request_id = {:request}", dbx.Params{"project": projectID, "operator": auth.Id, "request": input.RequestID})
		if err == nil {
			if existing.GetString("request_fingerprint") != fingerprint {
				return deliveryProblem(409, "DELIVERY_REQUEST_REUSED", "此 request_id 已用于不同请求。", "核对已有包；有意改变请求时重新检查并生成新的确认编号。")
			}
			record = existing
			replay = true
			events, err = deliveryEvents(app, record.Id)
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		h, err := s.adoptionDeliveryHandoff(app, projectID, input)
		if err != nil {
			return err
		}
		snap, err := s.readDeliverySnapshot(app, projectID, auth.Id, h)
		if err != nil {
			return err
		}
		if input.PreviewSHA == "" || input.PreviewSHA != reviewbundle.SnapshotDigest(snap) {
			return deliveryProblem(409, "DELIVERY_PREVIEW_CHANGED", "检查结果已过期或缺失，请重新检查并由人确认出包。", "重新预检，核对正文、来源、选择与前包后确认。")
		}
		record, err = saveDeliveryArchive(app, snap, input.RequestID, fingerprint, c)
		return err
	})
	if err != nil {
		return deliveryInputError(err)
	}
	status := http.StatusCreated
	if replay {
		status = http.StatusOK
	}
	view := deliveryView(record, events)
	view["replayed"] = replay
	return c.JSON(status, view)
}

func deliveryInputError(err error) error {
	// Preserve typed 401/403/404/409 instead of flattening authority failures.
	var status interface{ StatusCode() int }
	if errors.As(err, &status) {
		return err
	}
	var apiErr *router.ApiError
	if errors.As(err, &apiErr) {
		return err
	}
	return apis.NewBadRequestError(err.Error(), nil)
}

func saveDeliveryArchive(app core.App, snap reviewbundle.DeliverySnapshot, requestID, fingerprint string, request ...*core.RequestEvent) (*core.Record, error) {
	archive, err := reviewbundle.BuildDelivery(snap, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	collection, err := app.FindCollectionByNameOrId("release_deliveries")
	if err != nil {
		return nil, err
	}
	record := core.NewRecord(collection)
	file, err := filesystem.NewFileFromBytes(archive, "ReviewResultBundle.zip")
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return nil, err
	}
	reconciliation, err := json.Marshal(reviewbundle.Reconcile(snap))
	if err != nil {
		return nil, err
	}
	for key, value := range map[string]any{"reconciliation_json": string(reconciliation), "project": snap.Project, "operator": snap.Operator, "package_id": "delivery-" + reviewbundle.SnapshotDigest(snap)[:32], "sha256": reviewbundle.Digest(archive), "purpose": snap.Purpose, "recipient": snap.Recipient, "source_ref": snap.RightsRef, "import_job": snap.ImportJob, "previous": snap.Previous, "version": snap.Version, "snapshot": string(data), "archive": file, "request_id": requestID, "request_fingerprint": fingerprint} {
		record.Set(key, value)
	}
	err = app.Save(record)
	if err == nil && len(request) > 0 {
		err = appendSecurityEvent(app, request[0], "delivery.created", "success", snap.Operator, "", snap.Project, map[string]any{"count": len(snap.Entries), "resource_type": "release_delivery", "resource_id": record.Id})
	}
	if err != nil {
		// A later model hook can fail after PocketBase has uploaded the file. Its
		// transactional error interceptor assumes execute handled cleanup; that
		// assumption does not cover a failure after e.Next() in a model hook.
		// This record/file is newly allocated by this call, never historical data.
		if app.IsTransactional() {
			storage, openErr := app.NewFilesystem()
			if openErr != nil {
				return nil, errors.Join(err, openErr)
			}
			cleanupErr := storage.Delete(path.Join(record.BaseFilesPath(), file.Name))
			closeErr := storage.Close()
			return nil, errors.Join(err, cleanupErr, closeErr)
		}
		return nil, err
	}
	return record, nil
}

// Bound expensive snapshot/build requests without a second job system. SQLite
// already serializes commits; the gate limits work waiting to enter them. Two
// slots per project allow the common concurrent retry to reach replay lookup.
var deliveryPreparationSlots = struct {
	sync.Mutex
	total    int
	projects map[string]int
}{projects: map[string]int{}}

func (s *deliveryService) limitDeliveryPreparation(next func(*core.RequestEvent) error) func(*core.RequestEvent) error {
	return func(c *core.RequestEvent) error {
		projectID := c.Request.PathValue("projectId")
		if _, err := s.deliveryManager(c, projectID); err != nil {
			return err
		}
		key := s.app.DataDir() + "\x00" + projectID
		deliveryPreparationSlots.Lock()
		if deliveryPreparationSlots.total >= 8 || deliveryPreparationSlots.projects[key] >= 2 {
			deliveryPreparationSlots.Unlock()
			c.Response.Header().Set("Retry-After", "2")
			return apis.NewApiError(http.StatusTooManyRequests, "本项目正在核查或生成交付包，请稍后重试。", nil)
		}
		deliveryPreparationSlots.total++
		deliveryPreparationSlots.projects[key]++
		deliveryPreparationSlots.Unlock()
		defer func() {
			deliveryPreparationSlots.Lock()
			defer deliveryPreparationSlots.Unlock()
			deliveryPreparationSlots.total--
			deliveryPreparationSlots.projects[key]--
			if deliveryPreparationSlots.projects[key] == 0 {
				delete(deliveryPreparationSlots.projects, key)
			}
		}()
		return next(c)
	}
}
