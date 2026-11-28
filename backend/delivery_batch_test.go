package main

import (
	"os"
	"testing"

	"github.com/dop251/goja"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

type countingReader struct {
	recordReader
	calls map[string]int
}

func (c *countingReader) FindRecordsByFilter(collection any, filter, sort string, limit, offset int, params ...dbx.Params) ([]*core.Record, error) {
	if name, ok := collection.(string); ok {
		c.calls[name]++
	}
	return c.recordReader.FindRecordsByFilter(collection, filter, sort, limit, offset, params...)
}

func (c *countingReader) FindFirstRecordByFilter(collection any, filter string, params ...dbx.Params) (*core.Record, error) {
	if name, ok := collection.(string); ok {
		c.calls[name]++
	}
	return c.recordReader.FindFirstRecordByFilter(collection, filter, params...)
}

func deliveryBatchFixture(t *testing.T) (core.App, string) {
	t.Helper()
	app := newSchemaTestApp(t)
	for _, path := range []string{
		"pb_migrations/1789200000_source_registry.js",
		"pb_migrations/1792281600_release_deliveries.js",
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		vm := goja.New()
		jsvm.BindCore(vm)
		var up func(core.App) error
		vm.Set("migrate", func(apply, _ func(core.App) error) { up = apply })
		if _, err := vm.RunString(string(raw)); err != nil {
			t.Fatal(err)
		}
		if err := app.RunInTransaction(up); err != nil {
			t.Fatal(err)
		}
	}
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticDeliveryPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	sources, _ := app.FindCollectionByNameOrId("sources")
	source := core.NewRecord(sources)
	source.Set("logical_id", "synthetic-delivery-source")
	source.Set("title", "Synthetic delivery source")
	source.Set("status", "confirmed")
	source.Set("original_vs_derived", "original")
	if err := app.Save(source); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Delivery batch fixture")
	project.Set("admin", owner.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	project.Set("source", source.Id)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	usages, _ := app.FindCollectionByNameOrId("source_usages")
	for _, purpose := range []string{"public_display", "internal_research", "raw_third_party_transfer"} {
		usage := core.NewRecord(usages)
		usage.Set("source", source.Id)
		usage.Set("purpose", purpose)
		usage.Set("decision", "allow")
		if err := app.Save(usage); err != nil {
			t.Fatal(err)
		}
	}
	// 直接 SQL 插入绕过 archive 文件必填校验；视图逻辑不读取档案文件。
	insertDelivery := func(id, purpose string, version int) {
		t.Helper()
		_, err := app.DB().NewQuery(`INSERT INTO release_deliveries
			(id, project, operator, package_id, sha256, purpose, recipient, source_ref, import_job, snapshot, version, archive, created)
			VALUES ({:id}, {:project}, {:operator}, {:package}, {:sha}, {:purpose}, 'Synthetic recipient', 'synthetic-delivery-source', '', '{}', {:version}, 'fixture.zip', '2026-11-20 00:00:00.000Z')`).
			Bind(dbx.Params{
				"id": id, "project": project.Id, "operator": owner.Id,
				"package": "pkg-" + id, "sha": "synthetic-sha-" + id,
				"purpose": purpose, "version": version,
			}).Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	insertEvent := func(id, delivery, kind string, sequence int, payload string) {
		t.Helper()
		_, err := app.DB().NewQuery(`INSERT INTO release_events
			(id, delivery, actor, payload, kind, sequence, created)
			VALUES ({:id}, {:delivery}, 'synthetic-actor', {:payload}, {:kind}, {:sequence}, '2026-11-20 01:00:00.000Z')`).
			Bind(dbx.Params{"id": id, "delivery": delivery, "payload": payload, "kind": kind, "sequence": sequence}).Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	insertDelivery("dlvbatch0000001", "public_display", 1)
	insertDelivery("dlvbatch0000002", "public_display", 2)
	insertDelivery("dlvbatch0000003", "internal_research", 1)
	insertEvent("evbatch00000001", "dlvbatch0000001", "receipt", 1, `{"status":"success"}`)
	insertEvent("evbatch00000002", "dlvbatch0000002", "return", 1, `{"status":"partial_conflict"}`)
	insertEvent("evbatch00000003", "dlvbatch0000003", "withdrawal", 1, `{}`)
	return app, project.Id
}

func TestDeliveryListEventsQueryDoesNotScaleWithDeliveries(t *testing.T) {
	app, projectID := deliveryBatchFixture(t)
	reader := &countingReader{recordReader: app, calls: map[string]int{}}
	items, metrics, err := buildDeliveryList(reader, projectID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("items=%d want=3", len(items))
	}
	if reader.calls["release_events"] != 1 {
		t.Fatalf("release_events queries=%d want=1（事件应一次取齐按 delivery 分组）", reader.calls["release_events"])
	}
	// 权利查询按 (source, purpose) 缓存：2 个用途 × 2 次结论 × 各 1 次来源/用途查询。
	if reader.calls["sources"] > 4 || reader.calls["source_usages"] > 4 {
		t.Fatalf("rights queries sources=%d usages=%d want<=4（应按用途缓存）", reader.calls["sources"], reader.calls["source_usages"])
	}
	states := metrics["receipt_states"].(map[string]int)
	if states["success"] != 1 {
		t.Fatalf("receipt success=%d want=1", states["success"])
	}
	if metrics["withdrawn_packages"] != 1 {
		t.Fatalf("withdrawn=%v want=1", metrics["withdrawn_packages"])
	}
	if metrics["rights_impacted_packages"] != 0 {
		t.Fatalf("rights_impacted=%v want=0（fixture 全部 allow）", metrics["rights_impacted_packages"])
	}
}

func TestDeliveryImpactsEventsQueryDoesNotScaleWithDeliveries(t *testing.T) {
	app, projectID := deliveryBatchFixture(t)
	reader := &countingReader{recordReader: app, calls: map[string]int{}}
	items, err := buildDeliveryImpacts(reader, projectID, "synthetic-delivery-source")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("items=%d want=3", len(items))
	}
	if reader.calls["release_events"] != 1 {
		t.Fatalf("release_events queries=%d want=1（事件应一次取齐按 delivery 分组）", reader.calls["release_events"])
	}
	if reader.calls["sources"] > 4 || reader.calls["source_usages"] > 4 {
		t.Fatalf("rights queries sources=%d usages=%d want<=4（影响预览应按用途缓存）", reader.calls["sources"], reader.calls["source_usages"])
	}
	for _, item := range items {
		if item["rights_blocked"] != false {
			t.Fatalf("fixture 全部 allow，rights_blocked=%v want=false", item["rights_blocked"])
		}
	}
}
