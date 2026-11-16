package main

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestManagerTodoDeliveryActionsCloseWithoutReopeningReceipt(t *testing.T) {
	deliveries := core.NewBaseCollection("release_deliveries")
	deliveries.Fields.Add(&core.TextField{Name: "snapshot"}, &core.AutodateField{Name: "created"})
	record := core.NewRecord(deliveries)
	record.Set("snapshot", `{}`)
	record.Set("created", "2026-11-01 00:00:00.000Z")
	eventsCollection := core.NewBaseCollection("release_events")
	eventsCollection.Fields.Add(&core.TextField{Name: "kind"}, &core.TextField{Name: "payload"}, &core.AutodateField{Name: "created"})
	event := func(id, kind, payload string) *core.Record {
		r := core.NewRecord(eventsCollection)
		r.Id = id
		r.Set("kind", kind)
		r.Set("payload", payload)
		r.Set("created", "2026-11-02 00:00:00.000Z")
		return r
	}
	if deliveryView(record, nil)["workflow_state"] != "awaiting_receipt" {
		t.Fatal("new package workflow should await receipt")
	}
	if !todoDeliveryState(record, nil).Awaiting {
		t.Fatal("new delivery should await receipt")
	}
	returned := event("return", "return", `{}`)
	solved := event("solved", "resolution", `{"resolves":"return"}`)
	state := todoDeliveryState(record, []*core.Record{returned})
	if state.Awaiting || state.PendingActions != 1 {
		t.Fatalf("returned delivery: %+v", state)
	}
	if view := deliveryView(record, []*core.Record{returned, solved}); view["workflow_state"] != "returned_resolved" || view["awaiting_receipt"] != false || view["receipt_state"] != "awaiting_receipt" || view["waiting_seconds"] != int64(0) {
		t.Fatalf("resolved return retains receipt history without waiting: %+v", view)
	}
	state = todoDeliveryState(record, []*core.Record{returned, solved})
	if state.Awaiting || state.PendingActions != 0 {
		t.Fatalf("resolved return must leave both queues: %+v", state)
	}
	conflict := event("conflict", "receipt", `{"status":"partial_conflict"}`)
	resolved := event("resolved", "resolution", `{"resolves":"conflict"}`)
	state = todoDeliveryState(record, []*core.Record{conflict, resolved})
	if state.Awaiting || state.PendingActions != 0 {
		t.Fatalf("resolved conflict: %+v", state)
	}
	withdrawn := event("withdrawn", "withdrawal", `{}`)
	state = todoDeliveryState(record, []*core.Record{withdrawn})
	if state.Awaiting || !state.NeedsNotice {
		t.Fatalf("withdrawal needs notice, not receipt: %+v", state)
	}
	state = todoDeliveryState(record, []*core.Record{withdrawn, event("notice", "notice", `{}`)})
	if state.NeedsNotice || state.Awaiting {
		t.Fatalf("notified withdrawal: %+v", state)
	}
}

func TestManagerTodoMissingStartDoesNotReportPartialWait(t *testing.T) {
	row := newManagerTodo(todoProject{ID: "synthetic"}, "arbitration")
	now := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	row.setWaiting("2026-11-01 00:00:00.000Z", true, now, "known subset")
	if row.OldestAt != nil || row.WaitingSeconds != nil {
		t.Fatal("one unknown start must keep group wait unknown")
	}
	row.setWaiting("2026-11-11 00:00:00.000Z", false, now, "known")
	if row.WaitingSeconds == nil || *row.WaitingSeconds != 86400 {
		t.Fatal("known start should measure elapsed seconds")
	}
}

func TestManagerTodoProblemsExcludeClosedAndUnreportedIssues(t *testing.T) {
	app, owner, page := newAssistVisibilityFixture(t, newAssistVisibilityApp(t))
	issueCollection, _ := app.FindCollectionByNameOrId("problem_issues")
	reports, _ := app.FindCollectionByNameOrId("problem_reports")
	addIssue := func(status string, reported bool) *core.Record {
		r := core.NewRecord(issueCollection)
		r.Set("project", page.GetString("project"))
		r.Set("status", status)
		if err := app.Save(r); err != nil {
			t.Fatal(err)
		}
		if reported {
			report := core.NewRecord(reports)
			report.Set("project", page.GetString("project"))
			report.Set("page", page.Id)
			report.Set("issue", r.Id)
			report.Set("reporter", owner.Id)
			if err := app.Save(report); err != nil {
				t.Fatal(err)
			}
		}
		return r
	}
	active := addIssue("in_progress", true)
	addIssue("resolved", true)
	addIssue("new", false)
	service := &projectQueryService{}
	check := func(want int) {
		row := newManagerTodo(todoProject{ID: page.GetString("project")}, "source_problems")
		if err := service.fillManagerTodo(app, &row, time.Now(), nil, nil); err != nil {
			t.Fatal(err)
		}
		if *row.Count != want {
			t.Fatalf("want %d active reported issues, got %d", want, *row.Count)
		}
		if want > 0 && row.Target.Query["issue"] != active.Id {
			t.Fatal("target must identify counted issue")
		}
	}
	check(1)
	active.Set("status", "resolved")
	if err := app.Save(active); err != nil {
		t.Fatal(err)
	}
	check(0)
	review, err := newTodoSourceReview(app, "pb_hooks")
	if err != nil {
		t.Fatal(err)
	}
	if pending, err := review([]*core.Record{page}); err != nil || pending != 0 {
		t.Fatalf("row without review entry point must wait for proofreading: %v %v", pending, err)
	}
	page.Set("status", "approved")
	page.Set("verification_basis", "old-source-version")
	if pending, err := review([]*core.Record{page}); err != nil || pending != 1 {
		t.Fatalf("changed source basis must require review: %v %v", pending, err)
	}
}
