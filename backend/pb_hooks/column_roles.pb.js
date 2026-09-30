/// <reference path="../pb_data/types.d.ts" />

// 列角色读写。不在顶层声明 const，避免和别的 .pb.js 撞名。

routerAdd("GET", "/api/fangji/projects/{projectId}/column-roles", (c) => {
  const { assertId, requireManager } = require(`${__hooks}/lib/project_access.js`)
  const { columnRoleView } = require(`${__hooks}/lib/column_roles.js`)
  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = assertId(c.request.pathValue("projectId"), "项目")
  requireManager($app, projectId, auth)
  return c.json(200, columnRoleView($app, projectId))
}, $apis.requireAuth("users"))

routerAdd("PUT", "/api/fangji/projects/{projectId}/column-roles", (c) => {
  const { assertId, requireManager } = require(`${__hooks}/lib/project_access.js`)
  const { validateRoleMap, saveColumnRoles } = require(`${__hooks}/lib/column_roles.js`)
  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = assertId(c.request.pathValue("projectId"), "项目")
  const roles = validateRoleMap((c.requestInfo().body || {}).roles)
  let view = null
  $app.runInTransaction((txDao) => {
    const { project } = requireManager(txDao, projectId, auth)
    view = saveColumnRoles(txDao, project, roles)
  })
  return c.json(200, view)
}, $apis.requireAuth("users"))
