// Assist configuration has its own lifecycle, independent of source verification.
function replaceProjectAssistEpoch(app, fields) {
  const changed = fields.map(name => `OLD.${name} IS NOT NEW.${name}`).join(" OR ")
  app.db().newQuery("DROP TRIGGER _assist_epoch_projects_update").execute()
  app.db().newQuery(`CREATE TRIGGER _assist_epoch_projects_update AFTER UPDATE ON projects
    WHEN ${changed} BEGIN
      UPDATE _assist_basis_epochs SET revision=revision+1 WHERE scope='project:'||OLD.id;
    END`).execute()
}

migrate(app => {
  const projects = app.findCollectionByNameOrId("projects")
  projects.fields.add(new TextField({ name: "assist_tone_count_fields_json", max: 4096, hidden: true }))
  app.save(projects)
  replaceProjectAssistEpoch(app, ["source", "column_roles_json", "verification_policy", "assist_tone_count_fields_json"])
}, app => {
  replaceProjectAssistEpoch(app, ["source", "column_roles_json", "verification_policy"])
  const projects = app.findCollectionByNameOrId("projects")
  projects.fields.removeByName("assist_tone_count_fields_json")
  app.save(projects)
})
