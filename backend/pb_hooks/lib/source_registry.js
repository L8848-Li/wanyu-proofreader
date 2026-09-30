// 来源登记与用途权利。权利结论是人填的元数据，不是自动合规判定。
// decision 不是 allow 时一律阻断：未知不得被读成默认允许。

const PURPOSES = [
  "public_display",
  "internal_research",
  "model_training",
  "commercial_use",
  "redistribution",
  "raw_third_party_transfer"
]

const DECISIONS = ["allow", "deny", "unknown"]
const STATUSES = ["unregistered", "pending_rights", "confirmed", "restricted"]
const ORIGINS = ["original", "derived"]
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

function usageBlocked(decision) {
  return decision !== "allow"
}

function isLogicalId(value) {
  return LOGICAL_ID.test(String(value || ""))
}

function suggestLogicalId(title, format) {
  const basis = `${String(title || "").trim()}\n${String(format || "").trim()}`
  let hash = 2166136261
  for (const ch of Array.from(basis)) {
    hash ^= ch.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `src-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function undecidedPurposes(usages) {
  const decided = new Map()
  for (const usage of usages || []) {
    if (usage && usage.purpose) decided.set(usage.purpose, usage.decision)
  }
  return PURPOSES.filter((purpose) => usageBlocked(decided.get(purpose)))
}

function requireReady(auth) {
  if (!auth || !auth.id) throw new UnauthorizedError("请先登录")
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
}

function requireReader(dao, auth) {
  requireReady(auth)
  const { isPlatformAdmin, managedProjectIds } = require(`${__hooks}/lib/project_access.js`)
  if (isPlatformAdmin(auth)) return
  if (managedProjectIds(dao, auth).length) return
  throw new ForbiddenError("只有平台管理员或项目管理员可以查看来源登记")
}

function requireWriter(dao, auth) {
  requireReady(auth)
  const { isPlatformAdmin } = require(`${__hooks}/lib/project_access.js`)
  if (!isPlatformAdmin(auth)) throw new ForbiddenError("只有平台管理员可以修改来源登记")
}

function textField(value, label, max) {
  const text = String(value || "").trim()
  if (Array.from(text).length > max) throw new BadRequestError(`${label}不能超过 ${max} 个字符`)
  return text
}

function findSource(dao, ref) {
  const key = String(ref || "").trim()
  if (!key) throw new NotFoundError("来源不存在")
  if (/^[a-z0-9]{15}$/.test(key)) {
    try {
      return dao.findRecordById("sources", key)
    } catch {
      // 继续按 logical_id 找。15 位字母数字也可能是人手写的逻辑 ID。
    }
  }
  if (!isLogicalId(key) && !/^[a-z0-9]{15}$/.test(key)) {
    throw new BadRequestError("来源标识无效")
  }
  const rows = dao.findRecordsByFilter("sources", `logical_id = "${key}"`, "", 1, 0)
  if (!rows.length) throw new NotFoundError("来源不存在")
  return rows[0]
}

function usagesOf(dao, sourceId) {
  return dao.findRecordsByFilter("source_usages", `source = "${sourceId}"`, "purpose", 20, 0)
}

function usageJson(record) {
  return {
    id: record.id,
    purpose: record.getString("purpose"),
    decision: record.getString("decision"),
    evidence_ref: record.getString("evidence_ref"),
    decided_by: record.getString("decided_by"),
    decided_at: String(record.get("decided_at") || ""),
    blocked: usageBlocked(record.getString("decision"))
  }
}

function sourceJson(dao, record) {
  const usages = usagesOf(dao, record.id).map(usageJson)
  return {
    id: record.id,
    logical_id: record.getString("logical_id"),
    title: record.getString("title"),
    holder: record.getString("holder"),
    scope: record.getString("scope"),
    format: record.getString("format"),
    original_vs_derived: record.getString("original_vs_derived"),
    status: record.getString("status"),
    record_count: record.getInt("record_count") || 0,
    usages,
    undecided_purposes: undecidedPurposes(usages)
  }
}

function listSources(dao) {
  const records = dao.findRecordsByFilter("sources", 'id != ""', "-created", 200, 0)
  return { items: records.map((record) => sourceJson(dao, record)), total: records.length }
}

function createSource(dao, auth, body) {
  const title = textField(body.title, "标题", 200)
  if (!title) throw new BadRequestError("来源标题不能为空")
  const format = textField(body.format, "格式", 80)
  const requested = textField(body.logical_id, "逻辑 ID", 80)
  const logicalId = requested || suggestLogicalId(title, format)
  if (!isLogicalId(logicalId)) throw new BadRequestError("逻辑 ID 只能包含字母、数字、点、下划线、冒号和连字符")
  const status = String(body.status || "unregistered").trim()
  const origin = String(body.original_vs_derived || "original").trim()
  if (!STATUSES.includes(status)) throw new BadRequestError("来源状态无效")
  if (!ORIGINS.includes(origin)) throw new BadRequestError("原始或派生标记无效")
  const count = body.record_count == null || body.record_count === "" ? 0 : Number(body.record_count)
  if (!Number.isInteger(count) || count < 0 || count > 100000000) {
    throw new BadRequestError("条目数量必须是非负整数")
  }
  const existing = dao.findRecordsByFilter("sources", `logical_id = "${logicalId}"`, "", 1, 0)
  if (existing.length) throw new BadRequestError("这个逻辑 ID 已经登记过")
  const collection = dao.findCollectionByNameOrId("sources")
  const record = new Record(collection)
  record.set("logical_id", logicalId)
  record.set("title", title)
  record.set("holder", textField(body.holder, "权利主体", 200))
  record.set("scope", textField(body.scope, "范围", 200))
  record.set("format", format)
  record.set("original_vs_derived", origin)
  record.set("status", status)
  record.set("record_count", count)
  dao.save(record)
  return sourceJson(dao, record)
}

function updateSource(dao, record, body) {
  const writable = new Set(["title", "holder", "scope", "format", "original_vs_derived", "status", "record_count"])
  for (const key of Object.keys(body || {})) {
    if (!writable.has(key)) throw new BadRequestError("不能修改来源编号或其他未开放的字段")
  }
  if (Object.prototype.hasOwnProperty.call(body, "title")) {
    const title = textField(body.title, "标题", 200)
    if (!title) throw new BadRequestError("来源标题不能为空")
    record.set("title", title)
  }
  if (Object.prototype.hasOwnProperty.call(body, "holder")) record.set("holder", textField(body.holder, "权利主体", 200))
  if (Object.prototype.hasOwnProperty.call(body, "scope")) record.set("scope", textField(body.scope, "范围", 200))
  if (Object.prototype.hasOwnProperty.call(body, "format")) record.set("format", textField(body.format, "格式", 80))
  if (Object.prototype.hasOwnProperty.call(body, "original_vs_derived")) {
    const origin = String(body.original_vs_derived || "").trim()
    if (!ORIGINS.includes(origin)) throw new BadRequestError("原始或派生标记无效")
    record.set("original_vs_derived", origin)
  }
  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const status = String(body.status || "").trim()
    if (!STATUSES.includes(status)) throw new BadRequestError("来源状态无效")
    record.set("status", status)
  }
  if (Object.prototype.hasOwnProperty.call(body, "record_count")) {
    const count = Number(body.record_count)
    if (!Number.isInteger(count) || count < 0 || count > 100000000) {
      throw new BadRequestError("条目数量必须是非负整数")
    }
    record.set("record_count", count)
  }
  dao.save(record)
  return sourceJson(dao, record)
}

function gateFor(dao, sourceId, purpose) {
  if (!PURPOSES.includes(purpose)) throw new BadRequestError("用途无效")
  const rows = dao.findRecordsByFilter(
    "source_usages",
    `source = "${sourceId}" && purpose = "${purpose}"`,
    "",
    1,
    0
  )
  const decision = rows.length ? rows[0].getString("decision") : "unknown"
  return {
    source: sourceId,
    purpose,
    decision: DECISIONS.includes(decision) ? decision : "unknown",
    blocked: usageBlocked(decision)
  }
}

function upsertUsage(dao, auth, source, purpose, body) {
  if (!PURPOSES.includes(purpose)) throw new BadRequestError("用途无效")
  const decision = String(body.decision || "").trim()
  if (!DECISIONS.includes(decision)) throw new BadRequestError("用途结论只能是允许、禁止或未知")
  const evidence = textField(body.evidence_ref, "证据定位", 500)
  const rows = dao.findRecordsByFilter(
    "source_usages",
    `source = "${source.id}" && purpose = "${purpose}"`,
    "",
    1,
    0
  )
  const record = rows.length ? rows[0] : new Record(dao.findCollectionByNameOrId("source_usages"))
  record.set("source", source.id)
  record.set("purpose", purpose)
  record.set("decision", decision)
  record.set("evidence_ref", evidence)
  record.set("decided_by", auth.id)
  record.set("decided_at", new Date().toISOString())
  dao.save(record)
  return usageJson(record)
}

module.exports = {
  PURPOSES,
  DECISIONS,
  STATUSES,
  ORIGINS,
  usageBlocked,
  isLogicalId,
  suggestLogicalId,
  undecidedPurposes,
  requireReader,
  requireWriter,
  findSource,
  listSources,
  createSource,
  updateSource,
  gateFor,
  upsertUsage,
  sourceJson
}
