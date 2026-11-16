// Source judgments are explicit human records. Workflow agreement never creates
// a judgment. All events are append-only and carry the input they apply to.
const comparison = require(`${__hooks}/lib/source_comparison.js`)
const DEFAULT_INSTRUCTIONS = "逐字段对照本条来源 PDF，未提示字段同样核对。原文没有内容时保留空白；原文有内容时补抄。无法判断时提交问题并保存未完成工作。"
const ISSUE_STATES = ["new", "in_progress", "technical", "resolved", "reopened"]
const REPORT_TYPES = ["input_display", "hint", "source_location", "unreadable", "other"]

function parse(raw, fallback = {}) {
  try { const value = JSON.parse(String(raw || "")); return value === null ? fallback : value } catch { return fallback }
}
function hash(raw) { return $security.sha256(String(raw)) }
function list(dao, name, filter, sort = "created,id") {
  const out = []
  for (let offset = 0; ; offset += 500) {
    const rows = dao.findRecordsByFilter(name, filter, sort, 500, offset)
    out.push(...rows)
    if (rows.length < 500) return out
  }
}
function policyFor(dao, projectId) {
  const project = dao.findRecordById("projects", projectId)
  const id = project.getString("verification_policy")
  if (!id) return null
  const policy = dao.findRecordById("verification_policies", id)
  if (policy.getString("project") !== projectId) throw new Error("核验约定项目不匹配")
  return { ...parse(policy.getString("spec_json")), id, created: String(policy.get("created")), actor: policy.getString("actor"), reason: policy.getString("reason") }
}
function fileSnapshot(file) {
  return file ? { id: file.id, file: file.getString("file"), hash: file.getString("file_hash"), name: file.getString("original_filename"), pages: file.getInt("page_count") } : null
}
function sourceFile(dao, page) {
  const id = page.getString("project_file")
  if (id) {
    try { return dao.findRecordById("project_files", id) } catch { return null }
  }
  return dao.findRecordsByFilter("project_files", `project = "${page.getString("project")}" && is_primary = true && status = "ready"`, "", 1, 0)[0] || null
}
function importedRow(page) { return parse(page.getString("ocr_row_json"), null) || { 内容: page.getString("ocr_text") } }
function machineSnapshot(dao, page) {
  const visibility = require(`${__hooks}/lib/assist_visibility.js`)
  const findings = visibility.list(dao, "review_findings", $dbx.exp("page = {:page}", { page: page.id }), "id", "current")
  const gates = list(dao, "assist_rule_gates", "", "id").map(row => ({
    producer: row.getString("producer"), version: row.getString("producer_version"), kind: row.getString("kind"), key: row.getString("message_key"), gate: row.getString("gate")
  }))
  const { projectConfig } = require(`${__hooks}/lib/keyboards.js`)
  const config = projectConfig(dao, page.getString("project"))
  const keyboards = { defaultKeyboardId: config.defaultKeyboardId, items: config.items.map(item => ({ id: item.recordId, keyboardId: item.keyboardId, version: item.schemaVersion, definition_hash: hash(JSON.stringify(item.definition)) })) }
  const analysis = visibility.records(dao, "verification_events", $dbx.exp("page = {:page} AND kind = 'machine_analysis'", { page: page.id }), "-created,-id", 1, 0, "events")[0]
  return {
    engine_versions: [comparison.VERSION, require(`${__hooks}/lib/assist_rules.js`).RULES_VERSION, require(`${__hooks}/lib/assist_identity.js`).IDENTITY_VERSION],
    analysis: analysis ? { id: analysis.id, at: String(analysis.get("created")), producer_version: parse(analysis.getString("payload_json")).producer_version, raw_count: parse(analysis.getString("payload_json")).raw_count, input_basis: parse(analysis.getString("context_json")).basis } : { status: "no_execution_record" },
    finding_ids: findings.map(row => row.id),
    versions: [...new Set([`rule:${require(`${__hooks}/lib/assist_rules.js`).RULES_VERSION}`, ...findings.map(row => `${row.getString("producer")}:${row.getString("producer_version")}`)])].sort(),
    gates,
    keyboards
  }
}
function contextFor(dao, page, withMachine = true, shared = null) {
  const projectId = page.getString("project")
  const policy = shared ? shared.policy : policyFor(dao, projectId)
  const source = fileSnapshot(shared ? (page.getString("project_file") ? shared.files.get(page.getString("project_file")) : shared.primary) : sourceFile(dao, page))
  const input = importedRow(page)
  const roles = shared ? shared.roles : require(`${__hooks}/lib/column_roles.js`).loadProjectRoles(dao, projectId)
  const roleVersion = hash(JSON.stringify(roles))
  const policyCompatible = !policy || policy.reading_fields.every(field => roles[field] === "reading")
  const sourceApproved = Boolean(source && policy?.sources?.some(item => item.id === source.id && item.hash === source.hash && item.file === source.file))
  const sourceVersion = hash(JSON.stringify(source))
  const inputVersion = hash(JSON.stringify([page.getString("ocr_row_json"), page.getString("ocr_text"), page.getString("row_headers_json")]))
  const round = page.getInt("proofread_round") || 1
  const pdfPage = page.getInt("pdf_page") || page.getInt("page_number")
  const revision = page.getInt("verification_source_revision")
  const basis = hash(JSON.stringify([projectId, policy?.id || "legacy", sourceVersion, pdfPage, inputVersion, round, revision, roleVersion]))
  const machine = withMachine ? machineSnapshot(dao, page) : null
  return {
    project: projectId, page: page.id, round, policy_id: policy?.id || "", policy,
    source, source_approved: sourceApproved, policy_compatible: policyCompatible, source_revision: revision, role_version: roleVersion, source_version: sourceVersion, pdf_page: pdfPage,
    input_version: inputVersion, input, basis,
    input_raw: { row_json: page.getString("ocr_row_json"), text: page.getString("ocr_text"), headers_json: page.getString("row_headers_json") },
    machine,
    scope_key: machine ? hash(JSON.stringify([projectId, policy?.id || "", sourceVersion, roleVersion, machine.versions, machine.gates, machine.keyboards])) : ""
  }
}
function assertContext(body, context) {
  if (String(body?.basis || "") !== context.basis) throw new BadRequestError("来源、导入文本或核验约定已变化，请重新打开本条并复核后保存")
}
function proofreaderContext(context) {
  const { round, machine, ...safe } = context
  return safe
}
function appendEvent(dao, { project, page = "", kind, ref = "", field = "", actor, context, payload = {}, publication = "" }) {
  if (publication && kind !== "machine_analysis") throw new Error("Only machine analysis can be staged")
  const event = new Record(dao.findCollectionByNameOrId("verification_events"))
  event.set("project", project)
  event.set("page", page)
  event.set("kind", kind)
  event.set("ref", ref)
  event.set("field_name", field)
  event.set("actor", actor)
  event.set("context_json", JSON.stringify(context || {}))
  event.set("payload_json", JSON.stringify(payload))
  if (publication) event.set("assist_publication", publication)
  dao.save(event)
  return event
}
function eventView(event) {
  return { id: event.id, project: event.getString("project"), page: event.getString("page"), kind: event.getString("kind"), ref: event.getString("ref"), field: event.getString("field_name"), actor: event.getString("actor"), at: String(event.get("created")), context: parse(event.getString("context_json")), payload: parse(event.getString("payload_json")) }
}
function eventsFor(dao, pageId, kind = "") {
  const where = $dbx.exp(`page = {:page}${kind ? " AND kind = {:kind}" : ""}`, { page: pageId, kind })
  return require(`${__hooks}/lib/assist_visibility.js`).list(dao, "verification_events", where, "created,id", "events").map(eventView)
}
function savePolicy(dao, project, actor, body) {
  const roles = require(`${__hooks}/lib/column_roles.js`).loadProjectRoles(dao, project.id)
  const fields = body.reading_fields
  if (!Array.isArray(fields) || fields.length > 200 || fields.some(field => typeof field !== "string" || roles[field] !== "reading")) {
    throw new BadRequestError("声调等价字段必须是已明确标为记音角色的项目字段")
  }
  if (!String(body.reason || "").trim()) throw new BadRequestError("请说明本次设置或变更依据")
  const instructions = String(body.instructions || DEFAULT_INSTRUCTIONS).trim()
  if (instructions.length > 10000) throw new BadRequestError("核验说明过长")
  const spec = {
    instructions, reading_fields: [...new Set(fields)], tone_equivalence: body.tone_equivalence === true,
    syllable_boundary: "whitespace_separated_tone_suffix", column_roles: roles,
    comparison_version: comparison.VERSION,
    sources: list(dao, "project_files", `project = "${project.id}" && status = "ready"`, "id").map(fileSnapshot)
  }
  if (!spec.sources.length) throw new BadRequestError("请先为项目添加可用的来源 PDF")
  const record = new Record(dao.findCollectionByNameOrId("verification_policies"))
  record.set("project", project.id)
  record.set("spec_json", JSON.stringify(spec))
  record.set("actor", actor)
  record.set("reason", String(body.reason).trim())
  dao.save(record)
  const previous = project.getString("verification_policy")
  project.set("verification_policy", record.id)
  dao.save(project)
  if (previous) for (const page of list(dao, "pages", `project = "${project.id}" && status = "approved" && verification_basis = ""`)) {
    page.set("verification_needs_recheck", true); dao.save(page)
    appendEvent(dao, { project: project.id, page: page.id, kind: "legacy_basis_invalidated", actor, payload: { previous_policy: previous, policy: record.id, reason: body.reason } })
  }
  return policyFor(dao, project.id)
}
function ownDraft(dao, pageId, user) {
  return dao.findRecordsByFilter("proofreading_drafts", `page = "${pageId}" && user = "${user}"`, "", 1, 0)[0] || null
}
function draftView(draft, current) {
  if (!draft) return null
  const context = parse(draft.getString("context_json"))
  return { id: draft.id, page: draft.getString("page"), row: parse(draft.getString("row_json")), actions: parse(draft.getString("actions_json"), []), incomplete: parse(draft.getString("incomplete_json"), []), context, stale: context.basis !== current.basis, at: String(draft.get("updated")) }
}
function validateRow(row, context, allowEmpty = false) {
  if (!row || Array.isArray(row) || typeof row !== "object") throw new BadRequestError("内容必须为完整字段对象")
  const keys = Object.keys(context.input).sort()
  const actual = Object.keys(row).sort()
  if (keys.length !== actual.length || keys.some((key, i) => key !== actual[i] || typeof row[key] !== "string")) throw new BadRequestError("请保留全部原有字段并填写文本；原文无内容的字段可以留白")
  if (JSON.stringify(row).length > 2 * 1024 * 1024) throw new BadRequestError("内容过大")
  if (!allowEmpty && !keys.some(key => row[key].trim())) throw new BadRequestError("整条内容为空时请提交问题，由管理员确认空记录／不适用")
  return row
}
function validateActions(actions, context, row, incompleteAllowed = true) {
  if (actions === undefined) return []
  if (!Array.isArray(actions) || actions.length > 400) throw new BadRequestError("字段处理记录无效")
  return actions.map(item => {
    const field = String(item.field || "")
    if (!Object.prototype.hasOwnProperty.call(context.input, field)) throw new BadRequestError("处理记录字段不属于本条")
    if (!["kept", "modified", "incomplete"].includes(item.action) || (!incompleteAllowed && item.action === "incomplete")) throw new BadRequestError("仍有未完成字段，请保存草稿后继续核对")
    if (item.action !== "incomplete" && item.action !== (context.input[field] === row[field] ? "kept" : "modified")) throw new BadRequestError("处理方式与实际字段修改不一致")
    const findingIds = Array.isArray(item.finding_ids) ? item.finding_ids : []
    if (findingIds.some(id => !context.machine?.finding_ids.includes(id))) throw new BadRequestError("关联提示已失效，请重新查看提示")
    return { field, action: item.action, reason: String(item.reason || "source_checked").slice(0, 100), note: String(item.note || "").slice(0, 2000), finding_ids: findingIds }
  })
}
function saveDraft(dao, page, actor, body) {
  const context = contextFor(dao, page)
  assertContext(body, context)
  const row = validateRow(body.row, context, true)
  const actions = validateActions(body.actions, context, row)
  const incomplete = body.incomplete || []
  if (!Array.isArray(incomplete) || incomplete.some(field => !Object.prototype.hasOwnProperty.call(row, field))) throw new BadRequestError("未完成字段无效")
  let draft = ownDraft(dao, page.id, actor)
  if (draft && parse(draft.getString("context_json")).basis !== context.basis) appendEvent(dao, { project: context.project, page: page.id, kind: "draft_superseded", ref: draft.id, actor, context: parse(draft.getString("context_json")), payload: { row: parse(draft.getString("row_json")), actions: parse(draft.getString("actions_json"), []), incomplete: parse(draft.getString("incomplete_json"), []) } })
  if (!draft) draft = new Record(dao.findCollectionByNameOrId("proofreading_drafts"))
  draft.set("project", page.getString("project"))
  draft.set("page", page.id)
  draft.set("user", actor)
  draft.set("context_json", JSON.stringify(context))
  draft.set("row_json", JSON.stringify(row))
  draft.set("actions_json", JSON.stringify(actions))
  draft.set("incomplete_json", JSON.stringify(incomplete))
  dao.save(draft)
  return draftView(draft, context)
}
function reportIssue(dao, page, actor, body) {
  const context = contextFor(dao, page)
  const session = require(`${__hooks}/lib/source_research.js`).sessionForPage(dao, page.id, actor)
  if (session) context.machine.finding_ids = [...new Set([...context.machine.finding_ids, ...parse(session.getString("snapshot_json")).hints.map(hint => hint.id)])]
  assertContext(body, context)
  const field = String(body.field || "")
  if (field && !Object.prototype.hasOwnProperty.call(context.input, field)) throw new BadRequestError("报告字段不属于本条")
  if (!REPORT_TYPES.includes(body.category)) throw new BadRequestError("请选择问题类型")
  const description = String(body.description || "").trim()
  if (!description || description.length > 4000) throw new BadRequestError("请简要描述问题（最多 4000 字）")
  const finding = String(body.finding || "")
  if (finding && !context.machine.finding_ids.includes(finding)) throw new BadRequestError("提示已变化，请重新查看后报告")
  if (body.draft) saveDraft(dao, page, actor, { ...body.draft, basis: body.basis })
  const issue = new Record(dao.findCollectionByNameOrId("problem_issues"))
  issue.set("project", context.project)
  issue.set("scope_key", context.scope_key)
  issue.set("status", "new")
  issue.set("cause", description)
  dao.save(issue)
  const report = new Record(dao.findCollectionByNameOrId("problem_reports"))
  for (const [key, value] of Object.entries({ project: context.project, page: page.id, issue: issue.id, reporter: actor, field_name: field, finding, category: body.category, description, blocking: body.blocking === true, context_json: JSON.stringify(context) })) report.set(key, value)
  dao.save(report)
  appendEvent(dao, { project: context.project, page: page.id, kind: "report_created", ref: report.id, field, actor, context, payload: { issue: issue.id, blocking: body.blocking === true } })
  return reportView(dao, report, context)
}
function issueView(issue) {
  return { id: issue.id, project: issue.getString("project"), status: issue.getString("status"), cause: issue.getString("cause"), owner: issue.getString("owner"), external_ref: issue.getString("external_ref"), feedback: issue.getString("feedback"), public_note: issue.getString("public_note"), impact: issue.getString("impact"), scope_key: issue.getString("scope_key"), resolution: parse(issue.getString("resolution_json")), updated: String(issue.get("updated")) }
}
function reportView(dao, report, current, managerView = false) {
  const issue = dao.findRecordById("problem_issues", report.getString("issue"))
  const context = parse(report.getString("context_json"))
  const page = dao.findRecordById("pages", report.getString("page"))
  const latest = current || contextFor(dao, page)
  const resolved = parse(issue.getString("resolution_json"))[report.id]
  const fullIssue = issueView(issue)
  const safeIssue = { id: fullIssue.id, status: fullIssue.status, feedback: fullIssue.feedback, impact: fullIssue.impact, public_note: fullIssue.public_note, updated: fullIssue.updated }
  return { id: report.id, project: report.getString("project"), page: page.id, page_number: page.getInt("page_number"), field: report.getString("field_name"), finding: report.getString("finding"), category: report.getString("category"), description: report.getString("description"), blocking: report.getBool("blocking"), blocking_unresolved: report.getBool("blocking") && (issue.getString("status") !== "resolved" || !resolved || resolved.scope_key !== latest.scope_key), created: String(report.get("created")), issue: managerView ? fullIssue : safeIssue, stale: context.basis !== latest.basis || (resolved ? resolved.scope_key !== latest.scope_key : context.scope_key !== latest.scope_key),
    // Only the original import/source versions are returned. No draft or other
    // proofreader identity/answer is part of a public issue response.
    context: { policy_id: context.policy_id, pdf_page: context.pdf_page, source: context.source, basis: context.basis }
  }
}
function reportsFor(dao, projectId, user = "") {
  return list(dao, "problem_reports", `project = "${projectId}"${user ? ` && reporter = "${user}"` : ""}`).map(row => reportView(dao, row, null, !user))
}
function blockingReports(dao, pageId, user = "", prepared = null) {
  const reports = prepared ? prepared.reports : list(dao, "problem_reports", `page = "${pageId}" && blocking = true${user ? ` && reporter = "${user}"` : ""}`)
  return reports.filter(row => {
    const issue = prepared ? prepared.issues.get(row.getString("issue")) : dao.findRecordById("problem_issues", row.getString("issue"))
    if (!issue) throw new Error("Problem issue missing")
    if (issue.getString("status") !== "resolved") return true
    const resolved = parse(issue.getString("resolution_json"))[row.id]
    const current = prepared ? prepared.machineContext() : contextFor(dao, dao.findRecordById("pages", pageId))
    return !resolved || resolved.scope_key !== current.scope_key
  })
}
function updateIssue(dao, project, actor, issueId, body) {
  const issue = dao.findRecordById("problem_issues", issueId)
  if (issue.getString("project") !== project) throw new ForbiddenError("问题不属于本项目")
  if (!ISSUE_STATES.includes(body.status)) throw new BadRequestError("处理状态无效")
  if (!String(body.feedback || "").trim()) throw new BadRequestError("请填写具体处理或受理反馈")
  if (body.status === "resolved" && (!String(body.impact || "").trim() || !String(body.cause || "").trim())) throw new BadRequestError("完成处理时请说明共同原因、实际处理和影响范围")
  if (body.status === "technical" && !String(body.owner || body.external_ref || "").trim()) throw new BadRequestError("转技术处理时请填写负责人或跟进位置")
  const before = issueView(issue)
  if (body.status === "resolved") {
    const resolution = {}
    for (const report of list(dao, "problem_reports", `issue = "${issue.id}"`)) {
      const context = contextFor(dao, dao.findRecordById("pages", report.getString("page")))
      resolution[report.id] = { basis: context.basis, scope_key: context.scope_key }
    }
    issue.set("resolution_json", JSON.stringify(resolution))
  }
  for (const key of ["status", "cause", "owner", "external_ref", "feedback", "public_note", "impact"]) issue.set(key, String(body[key] || "").slice(0, ["feedback", "public_note"].includes(key) ? 4000 : 2000))
  dao.save(issue)
  appendEvent(dao, { project, kind: "issue_updated", ref: issue.id, actor, payload: { before, after: issueView(issue) } })
  return issueView(issue)
}
function moveReports(dao, project, actor, ids, issueId, note) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !String(note || "").trim()) throw new BadRequestError("请选择报告并说明合并或拆分依据")
  const reports = ids.map(id => dao.findRecordById("problem_reports", id))
  if (reports.some(report => report.getString("project") !== project)) throw new ForbiddenError("不能跨项目合并报告")
  const scope = parse(reports[0].getString("context_json")).scope_key
  if (reports.some(report => parse(report.getString("context_json")).scope_key !== scope)) throw new BadRequestError("来源、约定或适用配置版本不同，不能合并")
  let issue = issueId ? dao.findRecordById("problem_issues", issueId) : null
  if (!issue) {
    issue = new Record(dao.findCollectionByNameOrId("problem_issues"))
    issue.set("project", project); issue.set("scope_key", scope); issue.set("status", "new"); issue.set("cause", String(note).slice(0, 2000)); dao.save(issue)
  }
  if (issue.getString("project") !== project || issue.getString("scope_key") !== scope) throw new BadRequestError("处理事项的来源或配置版本不同")
  for (const report of reports) {
    const before = report.getString("issue")
    report.set("issue", issue.id); dao.save(report)
    appendEvent(dao, { project, page: report.getString("page"), kind: "report_moved", ref: report.id, actor, context: parse(report.getString("context_json")), payload: { before, issue: issue.id, note } })
  }
  return issueView(issue)
}
function recordSubmission(dao, page, attempt, actor, body) {
  const context = contextFor(dao, page)
  const research = require(`${__hooks}/lib/source_research.js`)
  if (!research.canClaimMaterial(dao, page, actor)) throw new ForbiddenError("当前研究职责不允许提交该材料的普通校对")
  const session = research.sessionForPage(dao, page.id, actor)
  if (research.enabled() && !session && dao.findRecordsByFilter("research_sessions", `page = "${page.id}" && user = "${actor}" && role = "proofreader"`, "", 1, 0).length) throw new BadRequestError("该材料研究会话已结束，请管理员重新安排后再提交")
  if (session) context.research_session = { session_id: session.id, study: session.getString("study"), condition: session.getString("condition"), participant: session.getString("participant") }
  if (session) context.machine.finding_ids = [...new Set([...context.machine.finding_ids, ...parse(session.getString("snapshot_json")).hints.map(hint => hint.id)])]
  if (context.policy) {
    assertContext(body, context)
    if (body.sourceChecked !== true) throw new BadRequestError("请明确确认已逐字段对照本条来源 PDF")
    if (!context.source || context.pdf_page < 1 || context.pdf_page > context.source.pages) throw new BadRequestError("来源 PDF 或物理页无效，请报告来源定位问题")
    if (!context.source_approved) throw new BadRequestError("当前来源尚未纳入此版项目约定，请管理员保存新版本后继续")
    if (!context.policy_compatible) throw new BadRequestError("记音字段角色已变化，请管理员更新核验约定")
  }
  if (blockingReports(dao, page.id, actor).length) throw new BadRequestError("你报告的阻塞问题尚未处理，请保存未完成工作")
  if (Array.isArray(body.incomplete) && body.incomplete.length) throw new BadRequestError("仍有未完成字段，请保存草稿")
  const row = parse(attempt.getString("row_json"))
  const actions = validateActions(body.actions, context, row, false)
  attempt.set("verification_context_json", JSON.stringify(context))
  attempt.set("source_checked", body.sourceChecked === true)
  for (const field of Object.keys(row)) {
    const supplied = actions.find(item => item.field === field)
    const changed = context.input[field] !== row[field]
    if (!changed && !supplied) continue
    appendEvent(dao, { project: context.project, page: page.id, kind: "field_action", ref: attempt.id, field, actor, context, payload: supplied || { action: "modified", reason: "source_checked", finding_ids: [] } })
  }
  appendEvent(dao, { project: context.project, page: page.id, kind: "submission", ref: attempt.id, actor, context, payload: { source_checked: body.sourceChecked === true, fields: Object.keys(row), row } })
  const draft = ownDraft(dao, page.id, actor)
  if (draft) dao.delete(draft)
  research.recordSubmission(dao, page, actor, attempt, body)
  return context
}
function latestJudgments(dao, page, context, prepared = null) {
  const latest = new Map()
  for (const event of prepared || eventsFor(dao, page.id, "judgment")) {
    const key = `${event.ref}\u0000${event.field}`
    if ((event.payload.revision || 0) >= (latest.get(key)?.payload.revision || 0)) latest.set(key, event)
  }
  return [...latest.values()].map(event => ({ ...event, stale: event.context.basis !== context.basis }))
}
function latestAdoption(history, context) {
  return history.filter(event => event.kind === "final_adoption" && event.context.basis === context.basis)
    .sort((a, b) => (b.payload.revision || 0) - (a.payload.revision || 0))[0] || null
}
function activeReviewProgress(page, context, history) {
  const status = page.getString("status")
  const stage = status === "arbitration" ? "arbitration" : ["approved", "proofread"].includes(status) ? "verification" : ""
  if (!stage || page.getBool("source_empty")) return null
  const progress = history.filter(event => event.kind === "review_progress" && event.context.basis === context.basis && event.payload.stage === stage)
    .sort((a, b) => (b.payload.revision || 0) - (a.payload.revision || 0) || b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0]
  if (!progress) return null
  if (progress.payload.progress_version === 1) {
    if (progress.payload.completed || progress.payload.base_status !== status
      || progress.payload.base_final_row_json !== page.getString("proofread_row_json")
      || progress.payload.base_adoption_id !== (latestAdoption(history, context)?.id || "")) return null
  } else {
    // Older events lack a lifecycle snapshot. A later completion or adoption
    // closes them; retain the history without restoring it over a newer result.
    if (history.some(event => event.context.basis === context.basis && event.at >= progress.at
      && ((event.kind === "review_completed" && event.payload.stage === stage) || ["final_adoption", "verified_final_updated"].includes(event.kind)))) return null
  }
  return progress
}
function saveJudgments(dao, page, actor, body, stage) {
  const context = contextFor(dao, page)
  assertContext(body, context)
  if (!context.policy || !context.source_approved || !context.policy_compatible || context.pdf_page < 1 || context.pdf_page > context.source.pages) throw new BadRequestError("请先设置包含当前有效来源和记音字段的版本化核验约定")
  if (!Array.isArray(body.judgments) || body.judgments.length > 1000) throw new BadRequestError("字段判断记录无效")
  const attempts = require(`${__hooks}/lib/proofreading_workflow.js`).proofreadAttempts(dao, page)
  const byId = new Map(attempts.map(attempt => [attempt.id, attempt]))
  const finalRow = body.row || parse(page.getString("proofread_row_json"), null) || context.input
  validateRow(finalRow, context, true)
  const saved = []
  const latest = latestJudgments(dao, page, context)
  const seen = new Set()
  for (const item of body.judgments) {
    const ref = String(item.attempt || "final")
    const field = String(item.field || "")
    if (!Object.prototype.hasOwnProperty.call(context.input, field) || (ref !== "final" && !byId.has(ref))) throw new BadRequestError("判断对象不属于本轮字段或提交")
    const key = `${ref}\u0000${field}`
    if (seen.has(key)) throw new BadRequestError("同一字段判断重复")
    seen.add(key)
    if (!["correct", "incorrect", "pending", "withdrawn"].includes(item.state)) throw new BadRequestError("只能记录正确、错误、待核实或撤回")
    if (!String(item.reason || "").trim()) throw new BadRequestError("请填写来源依据或待处理原因")
    if (!String(item.location || "").trim()) throw new BadRequestError("请填写来源页内位置，如词条或行号")
    const previous = latest.find(event => event.ref === ref && event.field === field)
    if (item.replaces !== undefined && item.replaces !== (previous?.id || "")) throw new BadRequestError("该判断已被更新，请刷新后重试")
    const value = String(ref === "final" ? finalRow[field] : parse(byId.get(ref).getString("row_json"))[field])
    const event = appendEvent(dao, { project: context.project, page: page.id, kind: "judgment", ref, field, actor, context, payload: { state: item.state, correct: item.state === "correct" ? true : item.state === "incorrect" ? false : null, value, reason: String(item.reason).slice(0, 2000), location: String(item.location).slice(0, 1000), stage, replaces: previous?.id || "", revision: (previous?.payload.revision || 0) + 1 } })
    saved.push(eventView(event))
  }
  const history = eventsFor(dao, page.id)
  const revision = history.filter(event => event.kind === "review_progress").reduce((max, event) => Math.max(max, event.payload.revision || 0), 0) + 1
  appendEvent(dao, { project: context.project, page: page.id, kind: "review_progress", actor, context, payload: { row: finalRow, selections: body.selections || {}, note: String(body.note || "").slice(0, 4000), stage, deferred: body.defer === true, progress_version: 1, revision, completed: body.complete === true, base_status: page.getString("status"), base_final_row_json: page.getString("proofread_row_json"), base_adoption_id: latestAdoption(history, context)?.id || "" } })
  if (body.defer === true || saved.some(event => ["pending", "withdrawn"].includes(event.payload.state) || (event.ref === "final" && event.payload.state === "incorrect"))) page.set("verification_hold", true)
  if (body.complete === true) {
    if ((page.getBool("verification_needs_recheck") || (page.getString("verification_basis") && page.getString("verification_basis") !== context.basis)) && body.sourceChecked !== true) throw new BadRequestError("依据已变更，请明确确认已逐字段复核当前来源后再完成")
    const judgments = latestJudgments(dao, page, context)
    if (judgments.some(event => !event.stale && ["pending", "withdrawn"].includes(event.payload.state))) throw new BadRequestError("仍有待核实或已撤回判断，请补录后完成")
    if (judgments.some(event => !event.stale && event.ref === "final" && event.payload.state === "incorrect")) throw new BadRequestError("最终采用值仍有来源错误，请修正后再完成")
    page.set("verification_hold", false)
    page.set("verification_needs_recheck", false)
    page.set("verification_basis", context.basis)
    page.set("verification_context_json", JSON.stringify(context))
    appendEvent(dao, { project: context.project, page: page.id, kind: "review_completed", actor, context, payload: { stage, source_checked: body.sourceChecked === true, note: body.note || "" } })
  }
  dao.save(page)
  return saved
}
function assertArbitration(dao, page, row) {
  const context = contextFor(dao, page, false)
  if (!context.policy) return
  const attempts = require(`${__hooks}/lib/proofreading_workflow.js`).proofreadAttempts(dao, page)
  const required = Object.keys(context.input).filter(field => {
    const values = attempts.map(attempt => parse(attempt.getString("row_json"))[field])
    return new Set(values.map(value => comparison.fieldKey(value, field, context.policy))).size > 1 || String(row[field]) !== String(context.input[field])
  })
  const judgments = latestJudgments(dao, page, context)
  for (const field of required) {
    for (const ref of ["final", ...attempts.map(attempt => attempt.id)]) {
      const event = judgments.find(event => !event.stale && event.ref === ref && event.field === field)
      if (!event || !["correct", "incorrect"].includes(event.payload.state)) throw new BadRequestError(`请先记录“${field}”的各份提交及最终值来源正误；看不清时保存进度并暂缓`)
      if (ref === "final" && (event.payload.state !== "correct" || event.payload.value !== String(row[field]))) throw new BadRequestError(`最终“${field}”必须有支持当前实际值的正确判断`)
    }
  }
  if (blockingReports(dao, page.id).length) throw new BadRequestError("本条仍有阻塞性问题，请暂缓完成")
}
function recordAdoption(dao, page, actor, row, selections, automaticAttempt = "") {
  const context = contextFor(dao, page, false)
  const attempts = require(`${__hooks}/lib/proofreading_workflow.js`).proofreadAttempts(dao, page)
  const previous = eventsFor(dao, page.id, "final_adoption").filter(event => event.context.basis === context.basis).sort((a, b) => (a.payload.revision || 0) - (b.payload.revision || 0)).slice(-1)[0]
  const byField = {}
  for (const field of Object.keys(row)) {
    const source = String(selections?.[field] || "matching")
    if (source.startsWith("attempt:")) {
      const id = source.slice(8)
      const attempt = attempts.find(attempt => attempt.id === id)
      if (!attempt || parse(attempt.getString("row_json"))[field] !== row[field]) throw new BadRequestError("采用记录与最终实际值不一致")
      byField[field] = id
    } else if (automaticAttempt) byField[field] = automaticAttempt
    else if (["matching", "existing_final"].includes(source) && previous?.payload.row?.[field] === row[field]) byField[field] = previous.payload.by_field?.[field] || null
    else byField[field] = null
  }
  appendEvent(dao, { project: context.project, page: page.id, kind: "final_adoption", actor, context, payload: { row, by_field: byField, selections: selections || {}, automatic: Boolean(automaticAttempt), revision: (previous?.payload.revision || 0) + 1 } })
}
function completion(dao, page, current, prepared = null) {
  const context = current || contextFor(dao, page, false)
  const judgments = latestJudgments(dao, page, context, prepared?.judgments)
  const required = Object.keys(context.input)
  const finalRow = parse(page.getString("proofread_row_json"), null)
  const covered = judgments.filter(event => event.ref === "final" && !event.stale && ["correct", "incorrect"].includes(event.payload.state) && finalRow && event.payload.value === String(finalRow[event.field]))
  const finalComplete = required.length > 0 && required.every(field => covered.some(event => event.field === field))
  const basis = page.getString("verification_basis")
  const attempts = prepared ? prepared.attempts : require(`${__hooks}/lib/proofreading_workflow.js`).proofreadAttempts(dao, page)
  const revalidated = (prepared ? prepared.reviews : eventsFor(dao, page.id, "review_completed")).some(event => event.context.basis === context.basis && event.payload.source_checked === true)
  const staleAttempts = attempts.some(attempt => {
    const previous = parse(attempt.getString("verification_context_json"))
    return previous.basis && previous.basis !== context.basis
  })
  const stale = Boolean(page.getBool("verification_needs_recheck") || (basis && basis !== context.basis) || (staleAttempts && !revalidated))
  const declared = attempts.length > 0 && attempts.every(attempt => attempt.getBool("source_checked"))
  const blocking = blockingReports(dao, page.id, "", prepared).length
  const hold = page.getBool("verification_hold")
  return { business_complete: page.getString("status") === "approved" && !page.getBool("source_empty") && !stale && !blocking && !hold,
    workflow_status: page.getString("status"), source_empty: page.getBool("source_empty"), needs_review: stale,
    blocking_reports: blocking, pending_review: hold, basis_recorded: Boolean(basis),
    declaration: revalidated ? "manager_recheck_declaration" : declared ? "proofreader_declaration" : "legacy_unrecorded", source_judged_fields: covered.map(event => event.field),
    source_judgment: finalComplete ? (covered.some(event => event.payload.correct === false) ? "incorrect" : "correct") : "partial_or_unrecorded",
    field_denominator: covered.length, required_fields: required.length, independent_reference: "separate_research_record" }
}

// The caller supplies at most 250 pages from one read snapshot. Reuse the same
// completion predicate with batched evidence; never substitute cached page flags
// for source/policy versions, current-round attempts or resolved report bases.
function countPendingReviews(dao, pages) {
  let count = 0
  const detailed = []
  for (const page of pages) {
    if (!["approved", "proofread", "arbitration"].includes(page.getString("status"))) continue
    if ((page.getString("status") !== "approved" && !page.getBool("source_empty"))
      || page.getBool("verification_hold") || page.getBool("verification_needs_recheck")) count++
    else detailed.push(page)
  }
  if (!detailed.length) return count
  const project = detailed[0].getString("project")
  if (detailed.length > 250 || detailed.some(page => page.getString("project") !== project)) throw new Error("Invalid source review batch")
  const byPage = rows => {
    const index = new Map()
    for (const row of rows) {
      const id = row.getString("page")
      if (!index.has(id)) index.set(id, [])
      index.get(id).push(row)
    }
    return index
  }
  const read = (collection, field, ids, where = null, sort = "created,id", columns = null) => {
    const rows = []
    for (let offset = 0; offset < ids.length; offset += 200) {
      const query = dao.recordQuery(collection).andWhere($dbx.in(field, ...ids.slice(offset, offset + 200)))
      if (columns) query.select(...columns)
      if (where) query.andWhere(where)
      for (const field of sort.split(",").filter(Boolean)) query.andOrderBy(field)
      const result = arrayOf(new Record)
      query.all(result)
      rows.push(...result)
    }
    return rows
  }
  const ids = detailed.map(page => page.id)
  const currentRound = $dbx.exp("kind='proofread' AND round=COALESCE(NULLIF((SELECT p.proofread_round FROM pages p WHERE p.id=proofreading_attempts.page),0),1)")
  const attempts = byPage(read("proofreading_attempts", "page", ids, currentRound, "pass_no,created", ["id", "page", "round", "verification_context_json", "source_checked"]))
  const reports = byPage(read("problem_reports", "page", ids, $dbx.exp("blocking=1"), "created,id", ["id", "page", "issue"]))
  const issueIds = [...new Set([...reports.values()].flat().map(row => row.getString("issue")))]
  const issues = new Map(read("problem_issues", "id", issueIds).map(row => [row.id, row]))
  const visibility = require(`${__hooks}/lib/assist_visibility.js`)
  const events = new Map()
  for (let offset = 0; offset < ids.length; offset += 200) {
    const where = $dbx.and($dbx.in("page", ...ids.slice(offset, offset + 200)), $dbx.exp("kind IN ('judgment','review_completed')"))
    for (const event of visibility.list(dao, "verification_events", where, "created,id", "events")) {
      const id = event.getString("page")
      if (!events.has(id)) events.set(id, [])
      events.get(id).push(eventView(event))
    }
  }
  const fileIds = [...new Set(detailed.map(page => page.getString("project_file")).filter(Boolean))]
  const shared = {
    policy: policyFor(dao, project),
    roles: require(`${__hooks}/lib/column_roles.js`).loadProjectRoles(dao, project),
    files: new Map(read("project_files", "id", fileIds).map(file => [file.id, file])),
    primary: dao.findRecordsByFilter("project_files", "project={:project} && is_primary=true && status='ready'", "", 1, 0, { project })[0] || null
  }
  for (const page of detailed) {
    const history = events.get(page.id) || []
    let machineContext = null
    const prepared = {
      attempts: (attempts.get(page.id) || []).filter(row => row.getInt("round") === (page.getInt("proofread_round") || 1)).slice(0, 1000),
      judgments: history.filter(event => event.kind === "judgment"),
      reviews: history.filter(event => event.kind === "review_completed"),
      reports: reports.get(page.id) || [], issues,
      machineContext: () => machineContext || (machineContext = contextFor(dao, page, true, shared))
    }
    const item = completion(dao, page, contextFor(dao, page, false, shared), prepared)
    if ((!item.business_complete && !item.source_empty) || item.needs_review || item.pending_review) count++
  }
  return count
}

module.exports = { comparison, DEFAULT_INSTRUCTIONS, ISSUE_STATES, REPORT_TYPES, parse, hash, list, policyFor, fileSnapshot, contextFor, proofreaderContext, assertContext, appendEvent, eventView, eventsFor, savePolicy, ownDraft, draftView, validateRow, saveDraft, reportIssue, issueView, reportView, reportsFor, blockingReports, updateIssue, moveReports, recordSubmission, latestJudgments, activeReviewProgress, saveJudgments, assertArbitration, recordAdoption, completion, countPendingReviews }
