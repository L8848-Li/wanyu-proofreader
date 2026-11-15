package main

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// Sensitive writes call this inside their write transaction. Both the account
// generation and project authority must still match when the write takes place.
func requireProjectManagerInApp(app core.App, c *core.RequestEvent, projectID string) (*core.Record, *core.Record, error) {
	if c.Auth == nil {
		return nil, nil, apis.NewUnauthorizedError("登录状态已失效，请重新登录。", nil)
	}
	auth, err := app.FindRecordById("users", c.Auth.Id)
	if err != nil || auth.TokenKey() != c.Auth.TokenKey() {
		return nil, nil, apis.NewUnauthorizedError("登录状态已变化，请重新登录。", nil)
	}
	if auth.GetBool("must_change_password") {
		return nil, nil, apis.NewForbiddenError("首次登录请先修改密码。", nil)
	}
	project, err := app.FindRecordById("projects", projectID)
	if err != nil {
		return nil, nil, apis.NewNotFoundError("项目不存在或已被删除。", err)
	}
	if auth.GetString("role") == "platform_admin" || project.GetString("admin") == auth.Id {
		return auth, project, nil
	}
	count, err := app.CountRecords("project_memberships", dbx.HashExp{"project": projectID, "user": auth.Id, "role": "manager"})
	if err != nil {
		return nil, nil, err
	}
	if count == 0 {
		return nil, nil, apis.NewForbiddenError("只有项目所有者或管理员可以管理项目。", nil)
	}
	return auth, project, nil
}
