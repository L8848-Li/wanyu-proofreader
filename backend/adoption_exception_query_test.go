package main

import (
	"os"
	"testing"

	"github.com/dop251/goja"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func adoptionExceptionFixture(t *testing.T) (core.App, *core.Collection, string, string) {
	t.Helper()
	app := newSchemaTestApp(t)
	for _, path := range []string{
		"pb_migrations/1789200000_source_registry.js",
		"pb_migrations/1792886400_adoption_batches.js",
		"pb_migrations/1792972800_adoption_events.js",
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
	owner.SetPassword("SyntheticExceptionPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Exception query fixture")
	project.Set("admin", owner.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	page := core.NewRecord(pages)
	page.Set("project", project.Id)
	page.Set("page_number", 1)
	page.Set("status", "approved")
	if err := app.Save(page); err != nil {
		t.Fatal(err)
	}
	batches, _ := app.FindCollectionByNameOrId("adoption_batches")
	batch := core.NewRecord(batches)
	batch.Set("project", project.Id)
	batch.Set("purpose", "public_display")
	batch.Set("recipient", "Synthetic recipient")
	batch.Set("status", "draft")
	batch.Set("rule_json", `{"statuses":["approved"]}`)
	batch.Set("total_count", 0)
	batch.Set("excluded_count", 0)
	batch.Set("reasons_json", `[]`)
	if err := app.Save(batch); err != nil {
		t.Fatal(err)
	}
	collection, err := app.FindCollectionByNameOrId("adoption_exceptions")
	if err != nil {
		t.Fatal(err)
	}
	return app, collection, batch.Id, page.Id
}

func TestFindOrInitAdoptionExceptionReusesExistingRow(t *testing.T) {
	app, collection, batchID, pageID := adoptionExceptionFixture(t)
	item, err := findOrInitAdoptionException(app, collection, batchID, pageID)
	if err != nil {
		t.Fatal(err)
	}
	item.Set("decision", "select")
	item.Set("note", "synthetic fixture")
	if err := app.Save(item); err != nil {
		t.Fatal(err)
	}
	again, err := findOrInitAdoptionException(app, collection, batchID, pageID)
	if err != nil {
		t.Fatal(err)
	}
	if again.Id != item.Id {
		t.Fatalf("existing exception not reused: got %s want %s", again.Id, item.Id)
	}
}

func TestFindOrInitAdoptionExceptionPropagatesQueryError(t *testing.T) {
	app, collection, batchID, pageID := adoptionExceptionFixture(t)
	// 模拟读库失败：集合元数据仍在（FindCollectionByNameOrId 成功），底层表没了。
	// 旧实现吞掉 findErr 走新建，随后撞 (batch, page) 唯一索引，真实故障被伪装成保存失败。
	if _, err := app.DB().NewQuery("DROP TABLE adoption_exceptions").Execute(); err != nil {
		t.Fatal(err)
	}
	item, err := findOrInitAdoptionException(app, collection, batchID, pageID)
	if err == nil {
		t.Fatalf("query failure was swallowed: got record %v, want the read error", item)
	}
}
