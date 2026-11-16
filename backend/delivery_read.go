package main

import (
	"encoding/json"
	"fangji/backend/reviewbundle"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"net/http"
)

func (s *deliveryService) getDelivery(c *core.RequestEvent) error {
	record, err := s.loadManagedDelivery(c)
	if err != nil {
		return err
	}
	events, err := deliveryEvents(s.app, record.Id)
	if err != nil {
		return err
	}
	view := deliveryView(record, events)
	view["project"] = record.GetString("project")
	pending := map[string]bool{}
	for _, id := range deliveryPendingActions(events) {
		pending[id] = true
	}
	pendingViews := []map[string]any{}
	for _, event := range view["events"].([]map[string]any) {
		if pending[event["id"].(string)] {
			pendingViews = append(pendingViews, event)
		}
	}
	view["pending_action_events"] = pendingViews
	view["legacy_cross_job_previous"] = false
	if previous := record.GetString("previous"); previous != "" {
		old, err := s.app.FindRecordById("release_deliveries", previous)
		if err == nil {
			view["legacy_cross_job_previous"] = old.GetString("import_job") != record.GetString("import_job")
		}
	}
	view["rights_blocked"] = deliveryRights(s.app, record.GetString("source_ref"), record.GetString("purpose")) != nil || deliveryRights(s.app, record.GetString("source_ref"), "raw_third_party_transfer") != nil
	delete(view, "events")
	return c.JSON(http.StatusOK, view)
}

func (s *deliveryService) listDeliveryEvents(c *core.RequestEvent) error {
	record, err := s.loadManagedDelivery(c)
	if err != nil {
		return err
	}
	page, perPage := pageArgument(c.Request.URL.Query().Get("page"), 1, 1000000), pageArgument(c.Request.URL.Query().Get("perPage"), 25, 100)
	var result map[string]any
	err = withRecordReadSnapshot(c.Request.Context(), s.app, func(app recordReader) error {
		if _, _, err := requireProjectManagerInApp(app, c, record.GetString("project")); err != nil {
			return err
		}
		total, err := app.CountRecords("release_events", dbx.HashExp{"delivery": record.Id})
		if err != nil {
			return err
		}
		totalPages := max(1, (int(total)+perPage-1)/perPage)
		page = min(page, totalPages)
		records, err := app.FindRecordsByFilter("release_events", "delivery = {:delivery}", "-sequence,-id", perPage, (page-1)*perPage, dbx.Params{"delivery": record.Id})
		if err != nil {
			return err
		}
		views := make([]map[string]any, 0, len(records))
		for _, event := range records {
			var payload map[string]any
			_ = json.Unmarshal([]byte(event.GetString("payload")), &payload)
			views = append(views, map[string]any{"id": event.Id, "sequence": event.GetInt("sequence"), "kind": event.GetString("kind"), "actor": event.GetString("actor"), "created": event.GetString("created"), "payload": payload})
		}
		result = map[string]any{"events": views, "page": page, "perPage": perPage, "totalItems": total, "totalPages": totalPages}
		return nil
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, result)
}

// Paged callers load only the current page's immutable content snapshots.
// Global counters use small cached reconciliation results and event metadata.
// Legacy archives remain byte-for-byte unchanged; missing caches are read from
// their snapshot, never silently rewritten as a migration side effect.
func (s *deliveryService) listPagedDeliveries(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	page := pageArgument(c.Request.URL.Query().Get("page"), 1, 1000000)
	perPage := pageArgument(c.Request.URL.Query().Get("perPage"), 25, 100)
	var result map[string]any
	err := withRecordReadSnapshot(c.Request.Context(), s.app, func(app recordReader) error {
		if _, _, err := requireProjectManagerInApp(app, c, projectID); err != nil {
			return err
		}
		metadata := []*core.Record{}
		if err := app.RecordQuery("release_deliveries").Select("id", "source_ref", "purpose", "reconciliation_json").AndWhere(dbx.HashExp{"project": projectID}).All(&metadata); err != nil {
			return err
		}
		total := len(metadata)
		totalPages := max(1, (total+perPage-1)/perPage)
		page = min(page, totalPages)
		records, err := app.FindRecordsByFilter("release_deliveries", "project = {:project}", "-created,-id", perPage, (page-1)*perPage, dbx.Params{"project": projectID})
		if err != nil {
			return err
		}
		events, err := app.FindRecordsByFilter("release_events", "delivery.project = {:project}", "sequence,id", 0, 0, dbx.Params{"project": projectID})
		if err != nil {
			return err
		}
		byDelivery := map[string][]*core.Record{}
		for _, event := range events {
			id := event.GetString("delivery")
			byDelivery[id] = append(byDelivery[id], event)
		}
		states := map[string]int{"awaiting_receipt": 0, "success": 0, "partial_conflict": 0, "failed_rolled_back": 0}
		reconciliations := map[string]int{"consistent": 0, "inconsistent": 0}
		withdrawn, rightsImpacted, pendingNotices := 0, 0, 0
		awaitingReceipts := 0
		rights := map[string]bool{}
		blockedByID := map[string]bool{}
		for _, record := range metadata {
			key := record.GetString("source_ref") + "\n" + record.GetString("purpose")
			blocked, known := rights[key]
			if !known {
				blocked = deliveryRights(app, record.GetString("source_ref"), record.GetString("purpose")) != nil || deliveryRights(app, record.GetString("source_ref"), "raw_third_party_transfer") != nil
				rights[key] = blocked
			}
			blockedByID[record.Id] = blocked
			if blocked {
				rightsImpacted++
			}
			state, stopped, notified := "awaiting_receipt", false, false
			for _, event := range byDelivery[record.Id] {
				switch event.GetString("kind") {
				case "receipt":
					var payload deliveryEventInput
					if json.Unmarshal([]byte(event.GetString("payload")), &payload) == nil {
						state = payload.Status
					}
				case "withdrawal":
					stopped = true
					notified = false
				case "notice":
					notified = true
				}
			}
			states[state]++
			if deliveryWorkflowState(state, stopped, byDelivery[record.Id]) == "awaiting_receipt" {
				awaitingReceipts++
			}
			if stopped {
				withdrawn++
				if !notified {
					pendingNotices++
				}
			}
			var reconciliation reviewbundle.Reconciliation
			if json.Unmarshal([]byte(record.GetString("reconciliation_json")), &reconciliation) != nil || reconciliation.Status == "" {
				legacy, err := app.FindRecordById("release_deliveries", record.Id)
				if err != nil {
					return err
				}
				var snap reviewbundle.DeliverySnapshot
				_ = json.Unmarshal([]byte(legacy.GetString("snapshot")), &snap)
				reconciliation = reviewbundle.Reconcile(snap)
			}
			reconciliations[reconciliation.Status]++
		}
		items := make([]map[string]any, 0, len(records))
		for _, record := range records {
			view := deliveryView(record, byDelivery[record.Id])
			delete(view, "events")
			view["rights_blocked"] = blockedByID[record.Id]
			items = append(items, view)
		}
		result = map[string]any{"items": items, "page": page, "perPage": perPage, "totalItems": total, "totalPages": totalPages, "metrics": map[string]any{"scope": "generated_packages_only", "reconciliation_scope": "immutable_package_snapshot", "rights_scope": "current_source_permissions", "package_count": total, "receipt_states": states, "awaiting_receipt_packages": awaitingReceipts, "withdrawn_packages": withdrawn, "rights_impacted_packages": rightsImpacted, "pending_consumer_notices": pendingNotices, "reconciliation_states": reconciliations}, "dependency_gaps": []string{"接收方试导入与双方交接确认", "未保存失败检查次数与全生产线周吞吐"}}
		return nil
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, result)
}
