// #177 的写入侧：把纯函数规则的输出落成 #176 的 review_findings 批次。
//
// 只追加，不改写：重算 = 插入新批次 + 把**同 producer 的**旧批次标 superseded_at。
// 只标同 producer 是有意的——规则重算不该把 OCR(#125) 或 bundle_import(#124) 的
// 疑点一起下线，三类生产者各有各的批次生命周期。
//
// 这里全部走 DAO（$app.save），不经过 API，因此 #176 的 onRecordUpdateRequest
// 只覆写守卫不会拦它；对应地，本文件只允许两种写：插入、以及把 superseded_at 从空改成非空。

// 依赖在函数内 require：仓内 lib 之间的互相引用一律发生在调用期，
// 顶层 require 在本机 JSVM 没有先例（.pb.js 的顶层绑定在回调里读不到）。

const PRODUCER = "rule"
const PAGE_SCAN_CAP = 5000

function nowStamp() {
  return new Date().toISOString()
}

function parseRow(raw) {
  const text = String(raw || "")
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") return parsed
  } catch {
    return {}
  }
  return {}
}

// 校对员刚提交的内容优先；没有就退回导入原文。
// 不用 pages.proofread_row_json 之外的字段推断轮次，也不把他人结果算进上下文。
function rowForRules(page) {
  const canonical = parseRow(page.get("proofread_row_json"))
  if (Object.keys(canonical).length) return canonical
  return parseRow(page.get("ocr_row_json"))
}

function contextFor(dao, page) {
  const { makeContext } = require(`${__hooks}/lib/assist_rules.js`)
  const { projectConfig: proofProjectConfig } = require(`${__hooks}/lib/keyboards.js`)
  const projectId = page.getString("project")
  return makeContext({
    projectId,
    // 列角色(#170) 未落地前一律传 null：R5 会安全跳过，不会拿列名猜角色。
    roles: null,
    keyboards: projectId ? proofProjectConfig(dao, projectId).items : []
  })
}

function insertFinding(dao, collection, page, row, at, producerVersion) {
  const record = new Record(collection)
  record.set("project", page.getString("project"))
  record.set("page", page.id)
  record.set("field_name", row.field || "")
  record.set("kind", row.kind)
  record.set("severity", row.severity)
  record.set("message_key", row.message_key)
  record.set("params_json", JSON.stringify(row.params ?? {}))
  record.set("evidence_json", JSON.stringify(row.evidence ?? {}))
  record.set("producer", PRODUCER)
  record.set("producer_version", producerVersion)
  record.set("produced_at", at)
  dao.save(record)
  return record
}

// 把该范围内、同 producer 的当前批次全部下线。只写 superseded_at，其余字段一个都不碰。
function supersede(dao, collection, clauses, at) {
  const stale = dao.findRecordsByFilter(
    "review_findings",
    [...clauses, 'superseded_at = ""'].join(" && "),
    "created",
    100000,
    0
  )
  for (const record of stale) {
    record.set("superseded_at", at)
    dao.save(record)
  }
  return stale.length
}

// rowOverride：提交路径传进来的「校对员刚打的那一行」。
// 不传就用库里的当前值——pages.proofread_row_json 只在凑够票数后才写，
// 第一遍提交时若不用 override，规则算的还是导入原文，等于没算刚提交的内容。
function recomputePage(dao, pageId, rowOverride = null) {
  const { runPageRules, RULES_VERSION } = require(`${__hooks}/lib/assist_rules.js`)
  const collection = dao.findCollectionByNameOrId("review_findings")
  const page = dao.findRecordById("pages", pageId)
  const at = nowStamp()
  const row = rowOverride && Object.keys(rowOverride).length ? rowOverride : rowForRules(page)
  const findings = runPageRules(contextFor(dao, page), row)
  const superseded = supersede(dao, collection,
    [`page = "${pageId}"`, `producer = "${PRODUCER}"`], at)
  for (const item of findings) insertFinding(dao, collection, page, item, at, RULES_VERSION)
  return { page: pageId, findings: findings.length, superseded, producer_version: RULES_VERSION }
}

// 项目级：列级(R3/R4) 与页级(R7) 规则要看到全量才能判，所以只在批处理里跑。
// 返回耗时供 #177 的规模验收引用（10k 行项目的实测值写进 docs/plans/2026-09-25-assist-rules.md）。
function recomputeProject(dao, projectId) {
  const { runProjectRules, makeContext, RULES_VERSION } = require(`${__hooks}/lib/assist_rules.js`)
  const startedAt = new Date()
  const collection = dao.findCollectionByNameOrId("review_findings")
  const pages = dao.findRecordsByFilter(
    "pages",
    `project = "${projectId}"`,
    "page_number,created",
    PAGE_SCAN_CAP,
    0
  )
  const rows = []
  const columns = {}
  const entries = []
  for (const page of pages) {
    const row = rowForRules(page)
    rows.push(row)
    for (const [field, value] of Object.entries(row)) {
      if (!columns[field]) columns[field] = []
      columns[field].push(value)
    }
    entries.push({ page, order: entries.length + 1, pdfPage: Number(page.get("pdf_page")) || 0 })
  }
  const samplePage = pages.length ? pages[0] : null
  const ctx = samplePage
    ? contextFor(dao, samplePage)
    : makeContext({ projectId, keyboards: [], roles: null })
  const findings = runProjectRules(ctx, rows, columns, entries)
  const at = nowStamp()
  const superseded = supersede(dao, collection,
    [`project = "${projectId}"`, `producer = "${PRODUCER}"`], at)
  const byId = new Map(entries.map((entry) => [entry.page.id, entry.page]))
  let inserted = 0
  for (const item of findings) {
    // 项目级 finding 也要落在某个条目上：R7 带 evidence.page，其余按出现顺序挂靠。
    const anchor = (item.evidence && item.evidence.page
      ? pages.find((page) => (Number(page.get("pdf_page")) || 0) === item.evidence.page)
      : null) ?? byId.get(entries[0]?.page.id) ?? samplePage
    if (!anchor) continue
    insertFinding(dao, collection, anchor, item, at, RULES_VERSION)
    inserted += 1
  }
  return {
    project: projectId,
    pages: pages.length,
    findings: inserted,
    superseded,
    duration_ms: new Date() - startedAt,
    producer_version: RULES_VERSION,
    truncated: pages.length >= PAGE_SCAN_CAP
  }
}

// 提交/仲裁路径用的安全包装：疑点生产失败绝不能把已落库的提交变成错误。
// 失败必须留下日志（不静默成「没有疑点」），管理端可用 findings/recompute 补算。
function safeRecomputePage(dao, pageId, row, label) {
  try {
    const startedAt = Date.now()
    const summary = recomputePage(dao, pageId, row)
    console.log(label, JSON.stringify({ ...summary, duration_ms: Date.now() - startedAt }))
    return summary
  } catch (error) {
    console.warn(label + " failed", pageId, String(error))
    return null
  }
}

module.exports = {
  safeRecomputePage,
  PRODUCER,
  PAGE_SCAN_CAP,
  rowForRules,
  recomputePage,
  recomputeProject
}
