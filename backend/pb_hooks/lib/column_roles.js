// #170 项目列角色。角色是元数据，不搬运、不改写条目内容。
// 未标注或无法识别的值一律是 unspecified。消费方看到的「没有有效角色」必须是 null，
// 这样现有规则和难度信号与今天完全一致。

const ROLES = ["headword", "reading", "meaning", "region", "example", "note", "unspecified"]

function normalizeRole(value) {
  return ROLES.includes(value) ? value : "unspecified"
}

function parseStoredRoles(raw) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(String(raw))
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {}
    const roles = {}
    for (const [name, role] of Object.entries(parsed)) {
      const key = String(name || "")
      if (!key) continue
      roles[key] = normalizeRole(role)
    }
    return roles
  } catch {
    return {}
  }
}

function resolveColumnRoles(stored, headers) {
  const present = []
  const seen = new Set()
  for (const header of headers || []) {
    const name = String(header || "")
    if (!name || seen.has(name)) continue
    seen.add(name)
    present.push(name)
  }
  const roles = {}
  const columns = []
  for (const name of present) {
    const role = normalizeRole(stored?.[name])
    roles[name] = role
    columns.push({ name, role, present: true })
  }
  const stale = []
  for (const [name, role] of Object.entries(stored || {})) {
    if (seen.has(name)) continue
    const normalized = normalizeRole(role)
    if (normalized === "unspecified") continue
    roles[name] = normalized
    stale.push(name)
    columns.push({ name, role: normalized, present: false })
  }
  return { roles, columns, stale }
}

function rolesForRules(stored, row) {
  const out = {}
  for (const [field, role] of Object.entries(stored || {})) {
    if (role === "unspecified" || !ROLES.includes(role)) continue
    if (!Object.prototype.hasOwnProperty.call(row || {}, field)) continue
    out[field] = role
  }
  return Object.keys(out).length ? out : null
}

function validateRoleMap(body) {
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw new BadRequestError("列角色必须是列名到角色的映射")
  }
  const entries = Object.entries(body)
  if (entries.length > 200) throw new BadRequestError("一次最多标注 200 列")
  const roles = {}
  for (const [name, role] of entries) {
    const key = String(name || "").trim()
    if (!key || Array.from(key).length > 200) throw new BadRequestError("列名无效")
    if (!ROLES.includes(role)) throw new BadRequestError(`列「${key}」的角色无效`)
    roles[key] = role
  }
  return roles
}

function loadProjectRoles(dao, projectId) {
  const project = dao.findRecordById("projects", projectId)
  return parseStoredRoles(project.getString("column_roles_json"))
}

function headersForProject(dao, projectId) {
  const headers = []
  const seen = new Set()
  const chunk = 1000
  for (let offset = 0; ; offset += chunk) {
    const pages = dao.findRecordsByFilter(
      "pages",
      `project = "${projectId}"`,
      "page_number,created",
      chunk,
      offset
    )
    for (const page of pages) {
      let parsed = []
      try {
        parsed = JSON.parse(page.getString("row_headers_json") || "[]")
      } catch {
        parsed = []
      }
      if (!Array.isArray(parsed)) continue
      for (const header of parsed) {
        const name = String(header || "")
        if (!name || seen.has(name)) continue
        seen.add(name)
        headers.push(name)
      }
    }
    if (pages.length < chunk) break
  }
  return { headers, truncated: false }
}

function columnRoleView(dao, projectId) {
  const project = dao.findRecordById("projects", projectId)
  const stored = parseStoredRoles(project.getString("column_roles_json"))
  const { headers, truncated } = headersForProject(dao, projectId)
  return { ...resolveColumnRoles(stored, headers), headers_truncated: truncated }
}

function saveColumnRoles(dao, project, roles) {
  project.set("column_roles_json", JSON.stringify(roles))
  dao.save(project)
  return columnRoleView(dao, project.id)
}

module.exports = {
  ROLES,
  normalizeRole,
  parseStoredRoles,
  resolveColumnRoles,
  rolesForRules,
  validateRoleMap,
  loadProjectRoles,
  columnRoleView,
  saveColumnRoles
}
