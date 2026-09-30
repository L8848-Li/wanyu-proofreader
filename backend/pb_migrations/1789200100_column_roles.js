// #170 列角色是项目上的元数据。down 只删这一列，不改 pages 里的原文或校对结果。
// 初始快照 1788940000_initial_schema.js 的 down 仍会拒绝执行；要撤掉更早的迁移，先备份 pb_data。

migrate((app) => {
  const projects = app.findCollectionByNameOrId("projects")
  if (!projects.fields.getByName("column_roles_json")) {
    projects.fields.add(new TextField({ name: "column_roles_json", required: false }))
    app.save(projects)
  }
}, (app) => {
  const projects = app.findCollectionByNameOrId("projects")
  if (projects.fields.getByName("column_roles_json")) {
    projects.fields.removeByName("column_roles_json")
    app.save(projects)
  }
})
