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
// 全量重算的条目游标：每次读 PAGE_SCAN_CHUNK 条，翻完为止。
// 上一版是 PAGE_SCAN_CAP = 5000 的一次性读取 + 按 project 全量下线，于是第 5001 条
// 往后的当前批次被标 superseded 却没有新批次替换，那些条目从此永久读不到疑点
// （#208 评审阻断 2）。现在只有两种结局：整批扫完，或在**任何写入之前**抛错拒算。
const PAGE_SCAN_CHUNK = 1000
// 内存保险丝，不是正确性上限：命中它就抛错，已落库的疑点一条都不动。
// 10k 行项目的实测耗时见 docs/plans/2026-09-25-assist-rules.md §6。
const PROJECT_SCAN_REFUSAL = 50000
// 下线旧批次时的读取块大小（见 retire）。
const RETIRE_CHUNK = 1000

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

// 逐块下线，读到空为止。
//
// 为什么不是"一次读 10 万条然后遍历"：那是 #208 评审阻断 2 的镜像形状。读满上限之后
// 剩下的行不会被下线，于是它们永远以「当前批次」的身份留在库里——校对端读到的是早该失效的
// 疑点。这个上限在本项目的口径下是**可及的**：扫描保险丝允许 5 万条目，而实测 10k 条目
// 产出 2.9 万条疑点（约 3.5 万条目就越过 10 万行）。
//
// offset 用「本轮决定保留的行数」而不是「已处理行数」：被下线的行会从结果集里消失，
// 只有留下的那些需要被再次越过；用错就会漏行或死循环。
// 这里不设熔断：每轮要么下线至少一行（结果集缩小）要么越过一行（有上界），一定终止；
// 中途抛错反而制造"下线了一半"的状态，而那正是这段代码要防的事。
function retire(dao, collection, clauses, shouldRetire, stamp, { chunk = RETIRE_CHUNK } = {}) {
  let retired = 0
  let skipped = 0
  for (;;) {
    const batch = dao.findRecordsByFilter(
      "review_findings",
      [...clauses, 'superseded_at = ""'].join(" && "),
      "created",
      chunk,
      skipped
    )
    if (!batch.length) return retired
    for (const record of batch) {
      if (!shouldRetire(record)) { skipped += 1; continue }
      record.set("superseded_at", stamp)
      dao.save(record)
      retired += 1
    }
    if (batch.length < chunk) return retired
  }
}

// 把该范围内、同 producer 的当前批次全部下线。只写 superseded_at，其余字段一个都不碰。
// 分批下线作用域内的当前批次。见 retire 的注释：这里防的是"读满一块就停"——
// 剩下的行会以"当前批次"的身份永远留在库里，旧疑点再也下不了线。
function supersede(dao, collection, clauses, at) {
  return retire(dao, collection, clauses, () => true, at)
}

// 插入之后的收尾：只下线**严格更早**的批次。
//
// 为什么必须有这一步：JSVM 不保证重算请求之间不交错（DAO 调用点就会让出运行时），实测
// 同一页面 8 个并发重算会留下「A 下线 → B 下线 → A 插入 → B 插入」的形状。
// 2026-09-25 的记录：库里 52 行里出现过 produced_at=.771 的一批被 .784/.787 陆续标掉，
// 最后只剩 2 行当前批次——**残缺的一批比重复更难发现**，校对端看到的就是"疑点变少了"。
//
// 所以收尾的判据是"比我这一批早"，不是"不是我的"：
// - 较新的批次永远不会被较旧的收尾抹掉 ⇒ 不会归零、不会残缺，最多同毫秒的几批并存；
// - 同毫秒互不杀伤（`<` 排除相等），最坏是短暂重复 hint，任何一次后续重算都会清掉；
// - 全局最后一个开始的请求那一批一定完整在册。
// 比较用 stampKey 归一化后的字符串：DAO 写回的日期串是 "2026-09-25 13:52:21.771Z"
// （空格分隔），而 nowStamp() 给的是 ISO 的 "T" 形式，直接比字符串会永远判成"更新"，
// 让整步收尾静默失效。
function stampKey(value) {
  return String(value ?? "").replace("T", " ").replace(/Z$/, "").slice(0, 23)
}

function settleBatch(dao, collection, clauses, at) {
  const mine = stampKey(at)
  return retire(dao, collection, clauses, (record) =>
    stampKey(record.getString("produced_at")) < mine, at)
}

// 单条目重算的作用域：本条目 + 本生产者，**但要排除项目级 key（列级 + 页级）**。
// 这些疑点按挂靠口径也落在某条条目上，而单条重算只判定格级规则；不排除就会让
// "给某一条补算"顺手抹掉挂在它身上的项目级疑点，而那些只有项目重算会再产出。
function pageScope(pageId, projectOnlyKeys) {
  return [
    `page = "${pageId}"`,
    `producer = "${PRODUCER}"`,
    ...projectOnlyKeys.map((key) => `message_key != "${key}"`)
  ]
}

// rowOverride：提交路径传进来的「校对员刚打的那一行」。
// 不传就用库里的当前值——pages.proofread_row_json 只在凑够票数后才写，
// 第一遍提交时若不用 override，规则算的还是导入原文，等于没算刚提交的内容。
function recomputePage(dao, pageId, rowOverride = null) {
  const { runEntryRules, RULES_VERSION, PROJECT_ONLY_MESSAGE_KEYS } = require(`${__hooks}/lib/assist_rules.js`)
  const collection = dao.findCollectionByNameOrId("review_findings")
  const page = dao.findRecordById("pages", pageId)
  const at = nowStamp()
  const row = rowOverride && Object.keys(rowOverride).length ? rowOverride : rowForRules(page)
  const findings = runEntryRules(contextFor(dao, page), row, pageId)
  const scope = pageScope(pageId, PROJECT_ONLY_MESSAGE_KEYS)
  const superseded = supersede(dao, collection, scope, at)
  for (const item of findings) insertFinding(dao, collection, page, item, at, RULES_VERSION)
  const settled = settleBatch(dao, collection, scope, at)
  return {
    page: pageId, findings: findings.length, superseded, settled,
    producer_version: RULES_VERSION
  }
}

// 分批读全项目的条目；游标翻到某一批不满额为止。超限抛错，调用方因此一条都不会写。
function loadAllPages(dao, projectId, { chunk = PAGE_SCAN_CHUNK, refusal = PROJECT_SCAN_REFUSAL } = {}) {
  const pages = []
  for (let offset = 0; ; offset += chunk) {
    const batch = dao.findRecordsByFilter(
      "pages", `project = "${projectId}"`, "page_number,created", chunk, offset)
    for (const page of batch) pages.push(page)
    if (batch.length < chunk) return pages
    if (pages.length >= refusal) {
      throw new Error(`项目条目数 ${pages.length} 已达全量重算保险丝 ${refusal}，拒绝执行（未改动任何疑点）`)
    }
  }
}

// 项目级：列级(R3/R4) 与页级(R7) 规则要看到全量才能判，所以只在批处理里跑。
// 返回耗时供 #177 的规模验收引用（10k 行项目的实测值写进 docs/plans/2026-09-25-assist-rules.md）。
function recomputeProject(dao, projectId) {
  const { runProjectRules, makeContext, RULES_VERSION } = require(`${__hooks}/lib/assist_rules.js`)
  const startedAt = new Date()
  const collection = dao.findCollectionByNameOrId("review_findings")
  const pages = loadAllPages(dao, projectId)
  // 条目与行内容一起传给规则：挂靠由规则侧决定（见 assist_rules.js 的挂靠口径注释）。
  const entries = pages.map((page, index) => ({
    pageId: page.id,
    order: index + 1,
    pdfPage: Number(page.get("pdf_page")) || 0,
    row: rowForRules(page)
  }))
  const ctx = pages.length
    ? contextFor(dao, pages[0])
    : makeContext({ projectId, keyboards: [], roles: null })
  const findings = runProjectRules(ctx, entries)
  const at = nowStamp()
  // 下线仍然按 project 收口：游标已经保证「要么整批扫完、要么写入前抛错」，
  // 被扫到的集合恒等于全项目，所以这里不需要再按条目列表拼 filter。
  const superseded = supersede(dao, collection,
    [`project = "${projectId}"`, `producer = "${PRODUCER}"`], at)
  const byId = new Map(pages.map((page) => [page.id, page]))
  const projectScope = [`project = "${projectId}"`, `producer = "${PRODUCER}"`]
  let inserted = 0
  let unanchored = 0
  for (const item of findings) {
    const anchor = byId.get(item.page)
    if (!anchor) {
      // 挂靠解析不出来就跳过并计数，绝不退化成"挂到第一条"——那正是上一轮的缺陷形状。
      unanchored += 1
      continue
    }
    insertFinding(dao, collection, anchor, item, at, RULES_VERSION)
    inserted += 1
  }
  const settled = settleBatch(dao, collection, projectScope, at)
  if (unanchored) console.warn("assist_recompute unanchored findings", projectId, unanchored)
  return {
    project: projectId,
    pages: pages.length,
    findings: inserted,
    unanchored,
    superseded,
    settled,
    duration_ms: new Date() - startedAt,
    producer_version: RULES_VERSION
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
  RETIRE_CHUNK,
  retire,
  PAGE_SCAN_CHUNK,
  PROJECT_SCAN_REFUSAL,
  loadAllPages,
  rowForRules,
  recomputePage,
  recomputeProject
}
