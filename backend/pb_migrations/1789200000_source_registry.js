// #169 来源登记与用途权利。
//
// 回滚：本文件的 down() 会删掉 source_usages、sources，以及 projects.source、
// import_jobs.source、import_jobs.source_link。登记内容会一起丢掉。
// 初始快照 1788940000_initial_schema.js 的 down() 会直接拒绝，并要求先做完整备份
// 或换新数据目录。所以执行本迁移之前必须先备份 pb_data；不能靠把初始快照回滚来撤掉它。
//
// 幂等：集合或字段已经在时跳过，避免重复 import 换掉记录 id。

const SOURCE_INDEX = "CREATE UNIQUE INDEX idx_sources_logical_id ON sources (logical_id)"
const USAGE_INDEX = "CREATE UNIQUE INDEX idx_source_usages_purpose ON source_usages (source, purpose)"

const text = (name, required, id, max) => ({
  autogeneratePattern: "", hidden: false, id, max, min: required ? 1 : 0,
  name, pattern: name === "logical_id" ? "^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$" : "",
  presentable: false, primaryKey: false, required, system: false, type: "text"
})

const autoTimes = [
  { hidden: false, id: "autodate2990389176", name: "created", onCreate: true, onUpdate: false, presentable: false, system: false, type: "autodate" },
  { hidden: false, id: "autodate3332085495", name: "updated", onCreate: true, onUpdate: true, presentable: false, system: false, type: "autodate" }
]

const sourcesSpec = () => ({
  name: "sources",
  type: "base",
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [SOURCE_INDEX],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    text("logical_id", true, "srlogical1", 80),
    text("title", true, "srtitle001", 200),
    text("holder", false, "srholder01", 200),
    text("scope", false, "srscope001", 200),
    text("format", false, "srformat01", 80),
    { hidden: false, id: "srorigin01", maxSelect: 1, name: "original_vs_derived", presentable: false, required: true, system: false, type: "select", values: ["original", "derived"] },
    { hidden: false, id: "srstatus01", maxSelect: 1, name: "status", presentable: false, required: true, system: false, type: "select", values: ["unregistered", "pending_rights", "confirmed", "restricted"] },
    { hidden: false, id: "srcount001", max: null, min: 0, name: "record_count", onlyInt: true, presentable: false, required: false, system: false, type: "number" },
    ...autoTimes
  ]
})

const usagesSpec = (sourcesId, usersId) => ({
  name: "source_usages",
  type: "base",
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [USAGE_INDEX],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    { cascadeDelete: true, collectionId: sourcesId, hidden: false, id: "susource01", maxSelect: 1, minSelect: 0, name: "source", presentable: false, required: true, system: false, type: "relation" },
    { hidden: false, id: "supurpose1", maxSelect: 1, name: "purpose", presentable: false, required: true, system: false, type: "select", values: ["public_display", "internal_research", "model_training", "commercial_use", "redistribution", "raw_third_party_transfer"] },
    { hidden: false, id: "sudecision", maxSelect: 1, name: "decision", presentable: false, required: true, system: false, type: "select", values: ["allow", "deny", "unknown"] },
    text("evidence_ref", false, "suevidenc1", 500),
    { cascadeDelete: false, collectionId: usersId, hidden: false, id: "sudecided1", maxSelect: 1, minSelect: 0, name: "decided_by", presentable: false, required: false, system: false, type: "relation" },
    { hidden: false, id: "sudecidat1", max: "", min: "", name: "decided_at", presentable: false, required: false, system: false, type: "date" },
    ...autoTimes
  ]
})

const exists = (app, name) => {
  try {
    app.findCollectionByNameOrId(name)
    return true
  } catch {
    return false
  }
}

migrate((app) => {
  if (!exists(app, "sources")) app.importCollections([sourcesSpec()], false)
  const sources = app.findCollectionByNameOrId("sources")
  if (!exists(app, "source_usages")) {
    const users = app.findCollectionByNameOrId("users")
    app.importCollections([usagesSpec(sources.id, users.id)], false)
  }

  const projects = app.findCollectionByNameOrId("projects")
  if (!projects.fields.getByName("source")) {
    projects.fields.add(new RelationField({
      name: "source",
      collectionId: sources.id,
      cascadeDelete: false,
      maxSelect: 1,
      required: false
    }))
    app.save(projects)
  }

  const jobs = app.findCollectionByNameOrId("import_jobs")
  let jobsChanged = false
  if (!jobs.fields.getByName("source")) {
    jobs.fields.add(new RelationField({
      name: "source",
      collectionId: sources.id,
      cascadeDelete: false,
      maxSelect: 1,
      required: false
    }))
    jobsChanged = true
  }
  if (!jobs.fields.getByName("source_link")) {
    jobs.fields.add(new SelectField({
      name: "source_link",
      maxSelect: 1,
      required: false,
      values: ["linked", "unknown"]
    }))
    jobsChanged = true
  }
  if (jobsChanged) app.save(jobs)
}, (app) => {
  const jobs = app.findCollectionByNameOrId("import_jobs")
  if (jobs.fields.getByName("source")) jobs.fields.removeByName("source")
  if (jobs.fields.getByName("source_link")) jobs.fields.removeByName("source_link")
  app.save(jobs)

  const projects = app.findCollectionByNameOrId("projects")
  if (projects.fields.getByName("source")) {
    projects.fields.removeByName("source")
    app.save(projects)
  }

  if (exists(app, "source_usages")) app.delete(app.findCollectionByNameOrId("source_usages"))
  if (exists(app, "sources")) app.delete(app.findCollectionByNameOrId("sources"))
})
