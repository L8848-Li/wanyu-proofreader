package main

import (
	"encoding/json"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func renumberFixture(t *testing.T, numbers []int) (core.App, string) {
	t.Helper()
	app := newSchemaTestApp(t)
	users, _ := app.FindCollectionByNameOrId("users")
	owner := core.NewRecord(users)
	owner.Set("role", "platform_admin")
	owner.SetPassword("SyntheticRenumberPassword123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Renumber fixture")
	project.Set("admin", owner.Id)
	project.Set("access_mode", "members_only")
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	pages, _ := app.FindCollectionByNameOrId("pages")
	for _, number := range numbers {
		page := core.NewRecord(pages)
		page.Set("project", project.Id)
		page.Set("page_number", number)
		page.Set("status", "pending")
		if err := app.Save(page); err != nil {
			t.Fatal(err)
		}
	}
	return app, project.Id
}

func runRenumber(t *testing.T, app core.App, projectID string) (int, int, []int) {
	t.Helper()
	value, err := runAssistScript(app, `
		const { renumberProjectPages } = require(__hooks + "/lib/page_renumber.js")
		let saves = 0
		const counting = {
			findRecordsByFilter: (...args) => dao.findRecordsByFilter(...args),
			save: (record) => { saves++; return dao.save(record) }
		}
		const writes = renumberProjectPages(counting, "`+projectID+`")
		const after = dao.findRecordsByFilter("pages", 'project = "`+projectID+`"', "page_number", 100, 0).map((p) => p.getInt("page_number"))
		JSON.stringify({ writes, saves, after })
	`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Writes int   `json:"writes"`
		Saves  int   `json:"saves"`
		After  []int `json:"after"`
	}
	if err := json.Unmarshal([]byte(value.String()), &result); err != nil {
		t.Fatal(err)
	}
	return result.Writes, result.Saves, result.After
}

func TestRenumberProjectPagesSinglePassSkipsUnchanged(t *testing.T) {
	// 删掉第 3 页后剩 1,2,4,5：只有 4→3、5→4 两行需要写。
	app, projectID := renumberFixture(t, []int{1, 2, 4, 5})
	writes, saves, after := runRenumber(t, app, projectID)
	if writes != 2 || saves != 2 {
		t.Fatalf("writes=%d saves=%d want=2（未变化行不写，每页至多一次）", writes, saves)
	}
	if len(after) != 4 || after[0] != 1 || after[1] != 2 || after[2] != 3 || after[3] != 4 {
		t.Fatalf("after=%v want=[1 2 3 4]", after)
	}
}

func TestRenumberProjectPagesHandlesHeadDeletionWithoutCollision(t *testing.T) {
	// 删掉第 1 页后剩 2,3,4：升序单遍 2→1、3→2、4→3，唯一索引下不得撞号。
	app, projectID := renumberFixture(t, []int{2, 3, 4})
	writes, saves, after := runRenumber(t, app, projectID)
	if writes != 3 || saves != 3 {
		t.Fatalf("writes=%d saves=%d want=3", writes, saves)
	}
	if len(after) != 3 || after[0] != 1 || after[1] != 2 || after[2] != 3 {
		t.Fatalf("after=%v want=[1 2 3]", after)
	}
}
