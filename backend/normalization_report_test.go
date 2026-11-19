package main

import (
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// Historical conversions can target different columns within one project.
// Persist the old states directly: the public page API correctly forbids changing
// conversion evidence just to construct a fixture.
func TestNormalizationReportPreservesHistoricalColumnsAndMissingSnapshot(t *testing.T) {
	app, _, first := newAssistVisibilityFixture(t, newAssistVisibilityApp(t))
	projectID := first.GetString("project")
	type evidence struct {
		ID     string `db:"id"`
		Column string `db:"normalization_source_column"`
		Value  string `db:"normalization_source_snapshot"`
	}
	expected := []evidence{
		{Column: "旧记音", Value: "ma533"},
		{Column: "新记音", Value: "ma533"},
		{Column: "旧记音", Value: ""},
	}
	for i, entry := range expected {
		page := first
		if i != 0 {
			page = core.NewRecord(first.Collection())
			page.Set("project", projectID)
			page.Set("status", "pending")
		}
		page.Set("page_number", i+1)
		page.Set("row_headers_json", `["旧记音","新记音"]`)
		page.Set("ocr_row_json", `{"旧记音":"live-reading","新记音":"current-reading"}`)
		page.Set("normalization_source_column", entry.Column)
		page.Set("normalization_source_snapshot", entry.Value)
		page.Set("normalization_status", "UNSUPPORTED")
		if err := app.Save(page); err != nil {
			t.Fatal(err)
		}
		expected[i].ID = page.Id
	}
	var got []evidence
	err := app.DB().NewQuery("SELECT id, normalization_source_column, normalization_source_snapshot FROM (" + normalizationReportSQL + ") ORDER BY page_number,id").
		Bind(dbx.Params{"project": projectID, "status": "UNSUPPORTED", "both": false}).All(&got)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(expected) {
		t.Fatalf("got %d rows, want %d", len(got), len(expected))
	}
	for i, item := range got {
		if item != expected[i] {
			t.Errorf("row %d: got %+v, want %+v", i, item, expected[i])
		}
	}
}
