// #177 的写入侧：把纯函数规则的输出落成 #176 的 review_findings 批次。
//
// 只追加，不改写：重算准备不可见载荷，短事务发布并为旧有效行写派生退役证明。
// 只标同 producer 是有意的——规则重算不该把 OCR(#125) 或 bundle_import(#124) 的
// 疑点一起下线，三类生产者各有各的批次生命周期。
//
// 新 finding/event 仍普通 DAO Save 并执行验证/hooks；publication 模块只对私有
// 派生表与明确白名单页面字段使用受控 SQL。旧 finding 正文和 superseded_at 不改写。

// 依赖在函数内 require：仓内 lib 之间的互相引用一律发生在调用期，
// 顶层 require 在本机 JSVM 没有先例（.pb.js 的顶层绑定在回调里读不到）。

// Explicit analysis budgets, not truncation. Original source remains intact
// when a batch is refused. Serialized bytes are measured as UTF-8, not UTF-16.
const INPUT_BYTES_LIMIT = 32 * 1024 * 1024
const PREPARATION_BYTES_LIMIT = 64 * 1024 * 1024
const ROW_BYTES_LIMIT = 2 * 1024 * 1024
const PAYLOAD_BYTES_LIMIT = 128 * 1024 * 1024
const ITEM_BYTES_LIMIT = 256 * 1024
const INPUT_FIELDS = ["ocr_row_json", "proofread_row_json", "ocr_text", "row_headers_json"]
const PREPARE_TEXT_FIELDS = [...INPUT_FIELDS, "entry_identity_key", "blocked_reason"]
// Read-only partial Records never go through Save. These are every page field
// consumed by rules, identity, difficulty and source_fidelity.contextFor(false).
const PREPARE_PAGE_FIELDS = ["id", "created", "project", "page_number", "pdf_page", "project_file", "import_job", ...PREPARE_TEXT_FIELDS, "proofread_round", "verification_source_revision"]
function utf8Bytes(value) {
  const text = String(value || "")
  // PocketBase converts a string directly to []byte; unlike its reader branch,
  // this does not have a read limit. Keep the pure-JS fallback for Node tests.
  if (typeof toBytes === "function") return toBytes(text).length
  let bytes = 0
  for (const char of text) { const cp=char.codePointAt(0); bytes += cp<=0x7f?1:cp<=0x7ff?2:cp<=0xffff?3:4 }
  return bytes
}
function findingBudget() {
  let bytes = 0
  return item => {
    const size = utf8Bytes(JSON.stringify(item))
    bytes += size
    if (size > ITEM_BYTES_LIMIT || bytes > PREPARATION_BYTES_LIMIT) refuseBytes()
  }
}
function pageInputBytes(page) { return INPUT_FIELDS.reduce((sum, field) => sum + utf8Bytes(page.getString(field)), 0) }
function pagePrepareBytes(page) { return PREPARE_TEXT_FIELDS.reduce((sum, field) => sum + utf8Bytes(page.getString(field)), 0) }
function refuseBytes() { throw new BadRequestError("辅助分析超过当前安全预算（输入32MiB、单行2MiB、准备64MiB、结果128MiB、单结果256KiB）；未发布新结果，原貌校对与交付不受影响") }
function assertSharedMetadata(dao, project) {
  // Do not parse an unbounded policy or keyboard definition before the budget
  // exists. These SQL length checks return only numbers, not source payloads.
  const row = new DynamicModel({ context: 0, keyboard: 0 })
  dao.db().newQuery(`SELECT length(CAST(COALESCE(p.column_roles_json,'') AS BLOB))+
    COALESCE((SELECT length(CAST(v.spec_json AS BLOB)) FROM verification_policies v WHERE v.id=p.verification_policy),0) AS context,
    COALESCE((SELECT SUM(length(CAST(k.definition_json AS BLOB))) FROM project_keyboards l JOIN keyboards k ON k.id=l.keyboard
      WHERE l.project=p.id AND l.enabled=1 AND k.active=1),0) AS keyboard FROM projects p WHERE p.id={:project}`)
    .bind({ project }).one(row)
  if (row.context > ITEM_BYTES_LIMIT || row.keyboard > ROW_BYTES_LIMIT) refuseBytes()
}

const PRODUCER = "rule"
// 条目游标：每次读 PAGE_SCAN_CHUNK 条，翻完为止——#177 与 #178 都要求 10k 行项目能全量跑通，
// 所以这里**不能有硬上限**：一个 PAGE_SCAN_CAP 常数会把超出部分静默丢掉，报告仍然写得像
// "算完了"，而按 project 全量下线会让第 5001 条往后的当前批次被标 superseded 却没有新批次
// 替换（#208 评审阻断 2）。现在只有两种结局：整批准备并原子发布，或明确拒绝且保留
// 上一完整结果；拒绝时可能保留不可见私有 stage 供有界清理。行数和字节预算都不截断输入。
const PAGE_SCAN_CHUNK = 1000
// 通用分块读取的块大小。
const READ_CHUNK = 1000
// 内存保险丝，不是正确性上限：命中它就抛错，已落库的疑点一条都不动。
// 当前完整迁移/全部 hooks 的规模结果见 assist-publication-main 证据；旧6.1s夹具不代表现实现。
const PROJECT_SCAN_REFUSAL = 50000
// 下线旧批次时的读取块大小（见 retire）。
const RETIRE_CHUNK = 1000

// #177 与 #178 都用 producer = "rule"，但各自只该下线自己那批 kind。
// 不按 kind 收口的话，跑一次 #177 的全量重算会把 #178 的跨行疑点全部标 superseded，
// 反之亦然——两边各自看自己的表都"正常"，串起来才看得见。
const RULE_KINDS = [
  "char_out_of_repertoire", "confusable_substitution", "encoding_form_anomaly",
  "missing_field", "reading_format_invalid", "punctuation_mix", "page_outlier"
]
const IDENTITY_KINDS = ["duplicate_identity", "cross_source_conflict", "merged_columns"]

function kindClause(kinds) {
  return "(" + kinds.map((kind) => `kind = "${kind}"`).join(" || ") + ")"
}

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

// 命中区间的诚实性闸门。#231 的评审阻断项：
// 前端 `locateSpan` 切的是**原文面板**那份串（`pages.ocr_row_json`，见 useStructuredRow.js
// 与 ProofreadEditorView.vue 的 `originalRow`），而判据可能跑在 `proofread_row_json`
// 或提交路径刚传进来的 `rowOverride` 上。两个串一旦不逐字相等，下标就切到错位的位置，
// 最坏的症状是**高亮标在空白上**——而在界面上这看起来完全正常，只能靠断言防。
//
// 取值是「该字段两边完全相等才保留区间」：不做 trim 后比较，因为前端连空格都没删，
// 差一个行首空格就已经错位了（评审给的反例正是 `" aŋ55"` vs `"aŋ55"`）。
// 省略 `char_offsets` 不等于丢掉疑点：前端会降级为"聚焦该字段"（fieldHints.js 的定位降级分支），
// 归因照旧、只是不画高亮。丢了几条要回给调用方（`offsets_dropped`），漏报不许静默。
//
// 逐字相等而保留区间时，顺手把**每个区间所切片段**的摘要记进 `offsets_basis`：#293 之后
// `ocr_row_json` 可以被管理员随时改写，而改写不触发重算，库里留下的下标就成了旧串的下标。
// 读侧（`findings.js` 的 `dropStaleOffsets`）拿这份基准再核一次。基准只能在这里盖章——
// 它是「闸门判定通过」这一事实的副产品，写在规则文件里会让每条规则各自抄一遍。
function dropUnfaithfulOffsets(findings, lookup) {
  const { offsetsBasis, excerptDigest } = require(`${__hooks}/lib/findings.js`)
  let dropped = 0
  for (const item of findings) {
    const source = lookup(item)
    if (source) {
      item.evidence = item.evidence || {}
      item.evidence.analysis_input_version = excerptDigest(JSON.stringify(source.row))
    }
    if (!item.evidence || !Array.isArray(item.evidence.char_offsets)) continue
    // 挂靠本身都解析不出来时不在这里改东西：那种条目由 unanchored 计数负责说。
    if (!source) continue
    const judged = String(source.row?.[item.field] ?? "")
    const shown = String(source.shown?.[item.field] ?? "")
    if (judged === shown) {
      const basis = offsetsBasis(shown, item.evidence.char_offsets)
      // 盖不出可验证基准（空片段或越界区间）就当场摘掉区间：留着一个无从复核的下标，
      // 读侧也只会在「无基准」那条保守分支上剥掉它，不如在这里按不忠实处理并计入 dropped。
      if (!basis) {
        delete item.evidence.char_offsets
        dropped += 1
        continue
      }
      item.evidence.offsets_basis = basis
      continue
    }
    delete item.evidence.char_offsets
    dropped += 1
  }
  return dropped
}

function contextFor(dao, page, storedRoles) {
  const { makeContext } = require(`${__hooks}/lib/assist_rules.js`)
  const { projectConfig: proofProjectConfig } = require(`${__hooks}/lib/keyboards.js`)
  const { loadProjectRoles, rolesForRules, toneCountFieldsFor } = require(`${__hooks}/lib/column_roles.js`)
  const projectId = page.getString("project")
  const stored = storedRoles !== undefined
    ? storedRoles
    : (projectId ? loadProjectRoles(dao, projectId) : {})
  return makeContext({
    projectId,
    // 没有任何有效角色时保持 null。R5 和难度信号因此与未标注时相同，不会按列名猜。
    roles: rolesForRules(stored, rowForRules(page)),
    toneCountFields: projectId ? toneCountFieldsFor(dao.findRecordById("projects", projectId), stored) : [],
    keyboards: projectId ? proofProjectConfig(dao, projectId).items : []
  })
}

// Read-only source metadata is stable throughout a batch transaction. The
// narrow adapter is used only by contextFor(..., false), never for mutations or
// the changing machine snapshot. It also avoids repeated roles/project reads.
function findingContexts(dao) {
  const records = new Map(), queries = new Map(), contexts = new Map()
  const reader = {
    findRecordById(collection, id) {
      const key = JSON.stringify([collection, id])
      if (!records.has(key)) records.set(key, dao.findRecordById(collection, id))
      return records.get(key)
    },
    findRecordsByFilter: (collection, filter, sort, limit, offset) => {
      const key = JSON.stringify([collection, filter, sort, limit, offset])
      if (!queries.has(key)) queries.set(key, dao.findRecordsByFilter(collection, filter, sort, limit, offset))
      return queries.get(key)
    }
  }
  return (page) => {
    if (!contexts.has(page.id)) {
      const { contextFor: verificationContext } = require(`${__hooks}/lib/source_fidelity.js`)
      contexts.set(page.id, JSON.stringify(verificationContext(reader, page, false)))
    }
    return contexts.get(page.id)
  }
}

function insertFinding(dao, collection, page, row, at, producerVersion, contextForPage, publication = "") {
  const record = new Record(collection)
  record.set("assist_publication", publication)
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
  record.set("verification_context_json", contextForPage(page))
  record.set("produced_at", at)
  dao.save(record)
  return record
}

// 旧分块 helper 保留兼容回归；当前发布路径不调用它，而使用私有退休证明。
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

// 分块读完一个过滤条件下的全部行，读到空为止。
//
// 为什么全项目都用它而不是"一次读一个大 limit"：`limit N, offset 0` 的形状一旦
// 结果集超过 N 就会**静默少读**，而少读的那些行照样参与后面的判定，报告写得像算完了。
// #208 的评审阻断 2 与本轮在 recomputeIdentity/refreshDifficulty 里发现的两个
// 上限（5000 条人工结论 / 500 条单页疑点）都是同一个形状，所以收敛到这里一份实现。
// 只适用于"读期间不写"的场景（写会让结果集缩小，那种翻页见 retire）。
//
// `onBatch(rows)` 是给"必须边读边判上限"的调用方留的口子：在**读完每一批之后**回调，
// 从那里抛错就是"读到一半退出"，既不返回部分结果，也不会先把整个结果集吸进内存。
// 不需要上限的调用方（人工结论、单页疑点）不传，语义与之前完全一致。
function readAllInChunks(dao, collection, filter, sort, { chunk = READ_CHUNK, onBatch = null } = {}) {
  const rows = []
  for (let offset = 0; ; offset += chunk) {
    const batch = dao.findRecordsByFilter(collection, filter, sort, chunk, offset)
    for (const record of batch) rows.push(record)
    if (onBatch) onBatch(rows)
    if (batch.length < chunk) return rows
  }
}

// 分批下线作用域内的当前批次。见 retire 的注释：这里防的是"读满一块就停"——
// 剩下的行会以"当前批次"的身份永远留在库里，旧疑点再也下不了线。
function supersede(dao, collection, clauses, at, kinds) {
  return retire(dao, collection, [...clauses, kindClause(kinds)], () => true, at)
}

// 批次替换必须原子提交：旧请求可能在新请求只插入第一条时执行 supersede，
// 因此按 produced_at 收尾既不能恢复被下线的行，也不能保证同毫秒批次唯一。
// 三个写入口共用数据库事务；时间只保留作审计，不再承担并发排序。
// 已处于事务的调用方也必须传其 txApp，PocketBase 会复用它而不是回到全局 $app。
function atomicBatch(app, operation) {
  let result
  app.runInTransaction((tx) => {
    // PocketBase nests by reusing txApp, not by opening a SAVEPOINT. The safe
    // submit wrapper catches analysis errors, so protect this optional work
    // even when the outer business transaction will still commit.
    const name = "assist_" + $security.randomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz")
    tx.db().newQuery(`SAVEPOINT ${name}`).execute()
    try {
      result = operation(tx)
      tx.db().newQuery(`RELEASE SAVEPOINT ${name}`).execute()
    } catch (error) {
      tx.db().newQuery(`ROLLBACK TO SAVEPOINT ${name}`).execute()
      tx.db().newQuery(`RELEASE SAVEPOINT ${name}`).execute()
      throw error
    }
  })
  return result
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
function recomputePage(app, pageId, rowOverride = null, authorize = null) {
  // Small submit/arbiter work stays inside its caller's transaction. An HTTP
  // page recompute gets the same boundary; no staged state escapes on failure.
  return atomicBatch(app, tx => {
    const page = tx.findRecordById("pages", pageId)
    return require(`${__hooks}/lib/assist_publication.js`).execute(tx, "page", page.getString("project"), pageId,
      dao => preparePage(dao, pageId, rowOverride), authorize)
  })
}

function preparedPayload(dao, pages, anchored, events, derivations, kinds, summary, version, projectOnlyKeys = []) {
  const { RULES_VERSION, producerVersionForRule } = require(`${__hooks}/lib/assist_rules.js`)
  const at = nowStamp(), contexts = findingContexts(dao), byId = new Map(pages.map(page => [page.id, page]))
  const contextJson = new Map(), inserted = new Map()
  let inputBytes = 0, preparationBytes = 0, payloadBytes = 0
  const contextBytes = new Map()
  for (const page of pages) {
    const bytes = pagePrepareBytes(page)
    inputBytes += pageInputBytes(page)
    if (bytes > ROW_BYTES_LIMIT || inputBytes > INPUT_BYTES_LIMIT) refuseBytes()
    const context = contexts(page), size = utf8Bytes(context)
    contextJson.set(page.id, context); contextBytes.set(page.id, size); inserted.set(page.id, [])
    preparationBytes += size + bytes
    if (preparationBytes > PREPARATION_BYTES_LIMIT) refuseBytes()
  }
  const stageSizes = { findings: [], events: [], derivations: [], retirements: [] }
  const findingCounts = new Map()
  for (const item of anchored) findingCounts.set(item.page, (findingCounts.get(item.page) || 0) + 1)
  const reserve = (kind, memoryBytes, recordBytes) => {
    preparationBytes += memoryBytes; payloadBytes += recordBytes; stageSizes[kind].push(recordBytes)
    if (recordBytes > ITEM_BYTES_LIMIT || preparationBytes > PREPARATION_BYTES_LIMIT || payloadBytes > PAYLOAD_BYTES_LIMIT) refuseBytes()
  }
  for (const item of anchored) { const size = utf8Bytes(JSON.stringify(item.row)); reserve('findings', size, size + contextBytes.get(item.page) + 512) }
  for (const item of events) { const size = utf8Bytes(JSON.stringify(item)); reserve('events', size, size + contextBytes.get(item.page) + (item.scope ? 0 : (findingCounts.get(item.page) || 0) * 18) + 512) }
  for (const item of derivations) { const size = utf8Bytes(JSON.stringify(item)); reserve('derivations', size, size + 64) }
  summary = { ...summary, input_bytes: inputBytes, preparation_bytes: preparationBytes, estimated_payload_bytes: payloadBytes }
  return {
    findings: anchored, events, derivations, kinds, projectOnlyKeys, summary, stageSizes,
    reserveRetirement(item) {
      const size = utf8Bytes(JSON.stringify(item))
      reserve('retirements', size, size + 128)
      summary.preparation_bytes = preparationBytes
      summary.estimated_payload_bytes = payloadBytes
    },
    saveFinding(tx, item, publication) {
      const page = byId.get(item.page)
      const producerVersion = version === RULES_VERSION ? producerVersionForRule(item.row.message_key) : version
      const record = insertFinding(tx, tx.findCollectionByNameOrId("review_findings"), page, item.row, at, producerVersion,
        value => contextJson.get(value.id), publication)
      inserted.get(page.id).push(record.id)
    },
    saveEvent(tx, item, publication) {
      const page = byId.get(item.page)
      require(`${__hooks}/lib/source_fidelity.js`).appendEvent(tx, {
        project: page.getString("project"), page: page.id, kind: "machine_analysis", actor: "machine", publication,
        context: JSON.parse(contextJson.get(page.id)), payload: {
          producer: PRODUCER, producer_version: version, produced_at: at, input: item.input,
          raw_count: item.raw_count, ...(item.scope ? { scope: item.scope } : { finding_ids: inserted.get(page.id) })
        }
      })
    }
  }
}
function effectiveFindings(dao, project, page = "") {
  const where = page ? $dbx.exp("page={:page}", { page }) : $dbx.exp("project={:project}", { project })
  return require(`${__hooks}/lib/assist_visibility.js`).list(dao, "review_findings", where, "id", "current")
}
function findingSignal(record) { return { kind: record.getString("kind"), severity: record.getString("severity"), field: record.getString("field_name") } }
function derivationRow(page, derived) {
  return { page: page.id, difficulty_tier: derived.tier, difficulty_basis_json: JSON.stringify(derived.basis), difficulty_version: derived.version }
}
function preparePage(dao, pageId, rowOverride) {
  const { runEntryRules, RULES_VERSION, PROJECT_ONLY_MESSAGE_KEYS } = require(`${__hooks}/lib/assist_rules.js`)
  const page = dao.findRecordById("pages", pageId)
  assertSharedMetadata(dao, page.getString("project"))
  const row = rowOverride && Object.keys(rowOverride).length ? rowOverride : rowForRules(page)
  const findings = runEntryRules(contextFor(dao, page), row, pageId)
  const offsetsDropped = dropUnfaithfulOffsets(findings, () => ({ row, shown: parseRow(page.get("ocr_row_json")) }))
  const retained = effectiveFindings(dao, page.getString("project"), page.id).filter(record =>
    record.getString("producer") !== PRODUCER || !RULE_KINDS.includes(record.getString("kind")) || PROJECT_ONLY_MESSAGE_KEYS.includes(record.getString("message_key")))
  const difficulty = derivePageDifficulty(dao, page, [...retained.map(findingSignal), ...findings])
  return preparedPayload(dao, [page], findings.map(item => ({ page: page.id, row: item })),
    [{ page: page.id, input: row, raw_count: findings.length }], [derivationRow(page, difficulty)], RULE_KINDS,
    { page: pageId, findings: findings.length, offsets_dropped: offsetsDropped, producer_version: RULES_VERSION,
      difficulty_tier: difficulty.tier, difficulty_version: difficulty.version }, RULES_VERSION, PROJECT_ONLY_MESSAGE_KEYS)
}

// 分批读全项目的条目；游标翻到某一批不满额为止。超限抛错，调用方因此一条都不会写。
//
// 保险丝必须在读取**过程中**判，不能"读全再判"：这条线要防的就是把整项目的行吸进
// JSVM 内存，读完才判等于先付全额成本再拒算。上一版正是这个形状（#212 复审阻断）。
// 走 readAllInChunks 的 onBatch：命中即抛，最多只会比 refusal 多吸进一批（chunk）的行。
function loadAllPages(dao, projectId, { chunk = PAGE_SCAN_CHUNK, refusal = PROJECT_SCAN_REFUSAL, budgeted = false } = {}) {
  if (budgeted) {
    const bytesSQL = PREPARE_TEXT_FIELDS.map(field => `length(CAST(COALESCE(${field},'') AS BLOB))`).join('+')
    const totals = new DynamicModel({ total: 0, bytes: 0, largest: 0 })
    dao.db().newQuery(`SELECT COUNT(*) AS total,COALESCE(SUM(${bytesSQL}),0) AS bytes,COALESCE(MAX(${bytesSQL}),0) AS largest FROM pages WHERE project={:project}`)
      .bind({ project: projectId }).one(totals)
    if (totals.total >= refusal) throw new Error(`项目条目数 ${totals.total} 已达全量重算保险丝 ${refusal}，拒绝执行（未改动任何疑点）`)
    if (totals.bytes > INPUT_BYTES_LIMIT || totals.largest > ROW_BYTES_LIMIT) refuseBytes()
    const rows = []
    let bytes = 0
    // A concurrent input replacement cannot make one fetched chunk unbounded:
    // filter oversized rows in SQL, then reject a mismatching count, never use a
    // partial result. The final epoch guard rejects any concurrent input change.
    let cursor = null
    for (;;) {
      const part = arrayOf(new Record(dao.findCollectionByNameOrId("pages")))
      const query = dao.recordQuery("pages").select(...PREPARE_PAGE_FIELDS.map(field => "pages." + field)).andWhere($dbx.exp(`project={:project} AND (${bytesSQL})<=${ROW_BYTES_LIMIT}`, { project: projectId }))
      if (cursor) query.andWhere($dbx.exp('page_number>={:number} AND (page_number>{:number} OR (page_number={:number} AND created>{:created}) OR (page_number={:number} AND created={:created} AND id>{:id}))', cursor))
      query.orderBy("page_number", "created", "id").limit(16).all(part)
      for (const page of part) { bytes += pagePrepareBytes(page); if (bytes > INPUT_BYTES_LIMIT) refuseBytes(); rows.push(page) }
      if (rows.length >= refusal) throw new Error(`项目条目数已达全量重算保险丝 ${refusal}，拒绝执行（未改动任何疑点）`)
      if (part.length < 16) break
      const last = part[part.length - 1]
      cursor = { number: last.getInt("page_number"), created: last.getString("created"), id: last.id }
    }
    if (rows.length !== totals.total) throw require(`${__hooks}/lib/assist_publication.js`).conflict()
    return rows
  }
  return readAllInChunks(dao, "pages", `project = "${projectId}"`, "page_number,created", {
    chunk,
    onBatch: (rows) => {
      if (rows.length >= refusal) {
        throw new Error(`项目条目数 ${rows.length} 已达全量重算保险丝 ${refusal}，拒绝执行（未改动任何疑点）`)
      }
    }
  })
}

// 项目级：列级(R3/R4) 与页级(R7) 规则要看到全量才能判，所以只在批处理里跑。
// 返回耗时供 #177 的规模验收引用（10k 行项目的实测值写进 docs/plans/2026-09-25-assist-rules.md）。
function recomputeProject(app, projectId, authorize = null) {
  const startedAt = Date.now()
  const result = require(`${__hooks}/lib/assist_publication.js`).execute(app, "rules", projectId, "",
    dao => recomputeProjectBatch(dao, projectId), authorize)
  return { ...result, duration_ms: Date.now() - startedAt }
}
function recomputeProjectBatch(dao, projectId) {
  const { runProjectRules, makeContext, RULES_VERSION } = require(`${__hooks}/lib/assist_rules.js`)
  const { loadProjectRoles, rolesForRules } = require(`${__hooks}/lib/column_roles.js`)
  assertSharedMetadata(dao, projectId)
  const pages = loadAllPages(dao, projectId, { budgeted: true })
  const storedRoles = loadProjectRoles(dao, projectId)
  const entries = pages.map((page, index) => {
    const row = rowForRules(page)
    return { pageId: page.id, order: index + 1, pdfPage: page.getInt("pdf_page"), row,
      batchId: page.getString("import_job"), fileId: page.getString("project_file"),
      roles: rolesForRules(storedRoles, row) }
  })
  const shared = pages.length ? contextFor(dao, pages[0], storedRoles) : makeContext({ projectId, keyboards: [], roles: null })
  const findings = runProjectRules({ ...shared, roles: null }, entries, findingBudget())
  const byId = new Map(pages.map(page => [page.id, page])), rowByPage = new Map(entries.map(entry => [entry.pageId, entry.row]))
  const offsetsDropped = dropUnfaithfulOffsets(findings, item => byId.has(item.page)
    ? { row: rowByPage.get(item.page), shown: parseRow(byId.get(item.page).get("ocr_row_json")) } : null)
  const anchored = findings.filter(item => byId.has(item.page)).map(item => ({ page: item.page, row: item }))
  const signals = new Map(pages.map(page => [page.id, []]))
  // Tier only consumes these four scalar fields. Loading every historical
  // context/payload via OFFSET made the second 10k run unnecessarily expensive.
  const visibility = require(`${__hooks}/lib/assist_visibility.js`)
  const params = { project: projectId, cursor: "" }
  const excluded = RULE_KINDS.map((kind, i) => { params["kind" + i] = kind; return "{:kind" + i + "}" }).join(",")
  for (;;) {
    const rows = arrayOf(new DynamicModel({ id: "", page: "", kind: "", severity: "", field: "" }))
    dao.db().newQuery(`SELECT id,page,kind,severity,field_name AS field FROM review_findings
      WHERE project={:project} AND id>{:cursor} AND (producer!='rule' OR kind NOT IN (${excluded}))
        AND ${visibility.currentSQL()} ORDER BY id LIMIT 1000`).bind(params).all(rows)
    for (const row of rows) signals.get(row.page)?.push({ kind: row.kind, severity: row.severity, field: row.field })
    if (rows.length < 1000) break
    params.cursor = rows[rows.length - 1].id
  }
  for (const item of anchored) signals.get(item.page).push(item.row)
  const stats = projectShapeStats(pages), tiers = { A: 0, B: 0, C: 0, unknown: 0 }
  const derivations = pages.map(page => { const derived = derivePageDifficulty(dao, page, signals.get(page.id), stats, storedRoles); tiers[derived.tier] += 1; return derivationRow(page, derived) })
  const counts = new Map()
  for (const item of anchored) counts.set(item.page, (counts.get(item.page) || 0) + 1)
  const events = require(`${__hooks}/lib/source_research.js`).enabled()
    ? pages.map(page => ({ page: page.id, input: rowByPage.get(page.id), raw_count: counts.get(page.id) || 0, scope: "project_batch" })) : []
  return preparedPayload(dao, pages, anchored, events, derivations, RULE_KINDS,
    { project: projectId, pages: pages.length, difficulty_tiers: tiers, findings: anchored.length,
      offsets_dropped: offsetsDropped, unanchored: findings.length - anchored.length, producer_version: RULES_VERSION }, RULES_VERSION)
}

// ---------- #180 难度标签 ----------
// 疑点算完之后顺手刷新 tier：#180 只出数据与接口，不新造触发器，
// 复用 #177 的两条路径（单条重算 / 项目全量），tier 才不会出现"疑点是新的、难度是旧的"。
// 例外是 #178 的跨行路径：它一条 tier 都不刷，改由返回值里的 difficulty_stale 说明，
// 跑完要再跑一次项目重算才是新的（理由与代价见 docs/plans/2026-09-25-cross-row-conflicts.md）。
//
// 读的是**全部当前批次疑点，不按 gate 过滤**：信号要的是"机器认为这行有多少问题"，
// 与"校对员被打了几个标"是两件事；blocked_reason 依赖的 merged_columns 更是只有
// OCR(#125)/#178 才产，按 gate 过滤会永远看不到它。
//
// 不对称要写明：本函数取的是**库里那一行**（`rowForRules(page)`），而提交路径传给规则的
// 是校对员刚打的那一行 `rowOverride`。于是刚提交的那一瞬间，形状信号（字段数 / 值长）
// 量的还是旧内容。今天完全无害——单条路径 `projectStats = null`，`field_count_outlier` 与
// `row_shape_outlier` 两条判据都读不到中位数，不会因此给出错的 tier。但将来把 stats 传进
// 单条路径，这里就会静默拿到过期形状，届时要把它改成 (page, rowOverride) 两路取值。
function refreshDifficulty(dao, page, stats = null, storedRoles) {
  const derived = derivePageDifficulty(dao, page, effectiveFindings(dao, page.getString("project"), page.id).map(findingSignal), stats, storedRoles)
  if (page.getString("difficulty_tier") !== derived.tier || page.getString("difficulty_version") !== derived.version || page.getString("difficulty_basis_json") !== JSON.stringify(derived.basis)) {
    page.set("difficulty_tier", derived.tier); page.set("difficulty_basis_json", JSON.stringify(derived.basis)); page.set("difficulty_version", derived.version); dao.save(page)
  }
  return derived
}
function derivePageDifficulty(dao, page, findings, stats = null, storedRoles) {
  const { deriveDifficulty, blockedReasonFromFindings, BLOCKED_BUCKETS } = require(`${__hooks}/lib/assist_difficulty.js`)
  const { loadProjectRoles, rolesForRules } = require(`${__hooks}/lib/column_roles.js`)
  const row = rowForRules(page)
  const valueLengths = Object.values(row).map((value) => Array.from(String(value ?? "")).length)
  // `blocked_reason` 只由人写，机器算出的桶**不 stamp 回库**（见下面为什么）。
  // 这里读的到的值因此就是人的结论：空 = 没人说过（决策 4 的"没测过"必须与"看过但认不出"
  // 可分，两者在库里不再是同一个字符串）。
  const stored = page.getString("blocked_reason")
  const manual = BLOCKED_BUCKETS.includes(stored) ? stored : ""
  const signal = {
    findings,
    // 未标注时 rolesForRules 返回 null，列角色两条信号不产生（不是判成 A）。
    roles: rolesForRules(
      storedRoles !== undefined ? storedRoles : loadProjectRoles(dao, page.getString("project")),
      row
    ),
    pdfPage: Number(page.get("pdf_page")) || 0,
    // 人说过就用人的；没人说过才按本轮疑点现算。算出来的桶只进本轮 derivation
    // （体现为 difficulty_basis_json 里的 column_merge_blocked / glyph_table_blocked），
    // 不写回这一列——写回就会把 #211/#212 评审挡的那条链子接上：
    // `normalizeBlocked("")` 也返回 "unknown"，一旦机器 stamp，这一列从第一次刷新起永久非空，
    // `stored || auto` 从此短路，#188 读到的将"每条都非空、但全是 unknown"；而机器写进去的
    // 真实桶更糟，库里分不出它与人工选的同名值，疑点消失后无法降级，与 #180 第 59 行
    // 「只描述为什么**现在**做不下去」直接冲突。取舍写在 docs/plans/2026-09-25-task-difficulty.md §3。
    blockedReason: manual || blockedReasonFromFindings(findings),
    fieldCount: Object.keys(row).length,
    valueLengths,
    projectStats: stats,
  }
  return deriveDifficulty(signal)
}

// 项目级统计：整行形状离群要拿全项目比，单条路径拿不到，所以只在全量重算里算一次。
function projectShapeStats(pages) {
  const fieldCounts = []
  const lengths = []
  for (const page of pages) {
    const row = rowForRules(page)
    fieldCounts.push(Object.keys(row).length)
    for (const value of Object.values(row)) lengths.push(Array.from(String(value ?? "")).length)
  }
  const median = (list) => {
    const sorted = list.slice().sort((a, b) => a - b)
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN
  }
  const med = median(lengths)
  const deviations = lengths.map((value) => Math.abs(value - med)).sort((a, b) => a - b)
  return {
    medianFieldCount: median(fieldCounts),
    medianValueLength: med,
    madValueLength: deviations.length ? deviations[Math.floor(deviations.length / 2)] : Number.NaN
  }
}

// ---------- #178 跨行检出 ----------
// 只在批处理路径跑（跨行比较是 O(n) 起，绝不挂到提交路径上——#178 正文明确要求）。
// 条目读取复用 #177 那个 loadAllPages：两条批处理路径的扫描语义因此不会各自漂移
// （同名函数在这里定义第二遍会被提升覆盖，#177 那条的保险丝就会静默失效）。

// #178 的跨来源判据要的是**登记来源**（#169 的 sources），不是文件。
// 链路是 pages.import_job → import_jobs.source，回落到 projects.source；两处都没关联时
// 返回空串（= 无从判断，绝不猜测）。按 import_job 缓存，一次项目级重算每个批次只查一遍。
function sourceOfPage(dao, page, projectSource, cache) {
  const jobId = page.getString("import_job")
  if (!jobId) return projectSource
  if (cache.has(jobId)) return cache.get(jobId)
  let resolved = ""
  try {
    resolved = dao.findRecordById("import_jobs", jobId).getString("source")
  } catch {
    resolved = ""
  }
  const value = resolved || projectSource
  cache.set(jobId, value)
  return value
}

function recomputeIdentity(app, projectId, authorize = null) {
  const startedAt = Date.now()
  const result = require(`${__hooks}/lib/assist_publication.js`).execute(app, "identity", projectId, "",
    dao => recomputeIdentityBatch(dao, projectId), authorize)
  return { ...result, difficulty_stale: result.findings > 0 || result.superseded > 0, duration_ms: Date.now() - startedAt }
}

function recomputeIdentityBatch(dao, projectId) {
  const startedAt = new Date()
  const {
    findIdentityConflicts, findRowShapeAnomalies, entryIdentityKey, identityColumns, IDENTITY_VERSION
  } = require(`${__hooks}/lib/assist_identity.js`)
  const { parseStoredRoles } = require(`${__hooks}/lib/column_roles.js`)
  assertSharedMetadata(dao, projectId)
  const pages = loadAllPages(dao, projectId, { budgeted: true })
  let projectSource = ""
  let columns = identityColumns(null)
  try {
    const project = dao.findRecordById("projects", projectId)
    projectSource = project.getString("source")
    columns = identityColumns(parseStoredRoles(project.getString("column_roles_json")))
  } catch {
    projectSource = ""
  }
  const sourceCache = new Map()

  const entries = [], derivations = []
  let backfilled = 0
  for (const page of pages) {
    const row = rowForRules(page)
    const key = entryIdentityKey(row, columns) ?? ""
    if (page.getString("entry_identity_key") !== key) {
      derivations.push({ page: page.id, entry_identity_key: key })
      backfilled += 1
    }
    // 这里曾经把 project_file 当 source 传进去（#169 落地前的替身）。文件不是来源：
    // 同一个来源可以分多个文件导入，不同来源也可以合成一个文件，
    // 用它判"跨来源冲突"会同时造出漏报与误报。
    entries.push({
      id: page.id, project: projectId, row, page,
      source: sourceOfPage(dao, page, projectSource, sourceCache),
      project_file: page.getString("project_file")
    })
  }

  // 人工结论必须读全：少读的那些组会被重新报成冲突，等于静默推翻人的判断——
  // 而 #178 立这条收集合的理由就是"重算时保留人工结论，否则人就再也不信这个队列"。
  // 5000 的上限不是假想：本 issue 自己的 10k 压力 fixture 就有 2500 个身份分组。
  const dismissed = new Set(readAllInChunks(
    dao, "finding_dismissals", `project = "${projectId}" && status = "not_conflict"`, "group_key"
  ).map((row) => row.getString("group_key")))

  let partnerBytes = 0
  const reserveFinding = findingBudget()
  const identityResult = findIdentityConflicts(entries, dismissed, columns, bytes => {
    partnerBytes += bytes
    if (partnerBytes > PREPARATION_BYTES_LIMIT) refuseBytes()
  }, reserveFinding)
  const findings = [...identityResult.findings]
  for (const entry of entries) for (const item of findRowShapeAnomalies(entry, columns)) {
    reserveFinding(item); findings.push(item)
  }
  // #178 的 merged_columns 两类区间也走同一道闸门：跨行检出的 row 来自 rowForRules，
  // 与校对端切的 ocr_row_json 不是同一份串时，宁可只给字段不给高亮。
  const entryById = new Map(entries.map((entry) => [entry.id, entry]))
  const identityOffsetsDropped = dropUnfaithfulOffsets(findings, (item) => {
    const entry = entryById.get(item.evidence?.page)
    if (!entry) return null
    return { row: entry.row, shown: parseRow(entry.page.get("ocr_row_json")) }
  })

  const byId = new Map(entries.map(entry => [entry.id, entry.page]))
  const anchored = findings.filter(item => byId.has(item.evidence?.page)).map(item => ({ page: item.evidence.page, row: item }))
  const inserted = anchored.length, unanchored = findings.length - inserted
  const summary = {
    project: projectId,
    pages: pages.length,
    findings: inserted,
    unanchored,
    backfilled_keys: backfilled,
    offsets_dropped: identityOffsetsDropped,
    dismissed_groups: dismissed.size,
    // 有内容分歧、但来源不足以判成跨来源的组数。它必须出现在响应里：
    // "这一组没报 cross_source" 要么是判据判定不该报，要么是没登记来源可依据，
    // 两者的运维动作完全不同（前者不用管，后者要去补 sources 关联）。
    unattributed_groups: identityResult.unattributed_groups,
    // 可比列一个没配上的组数（角色只标了词头/记音时的常态）。它与 unattributed 是两种
    // 不同的"没报"：前者是"这组根本没在比较"，处置是回去补列角色；后者是"来源不足以判跨来源"。
    uncomparable_groups: identityResult.uncomparable_groups,
    compared_rows: identityResult.compared,
    unkeyed_rows: identityResult.unkeyed,
    // `hardcoded` 意味着这个项目没标够列角色、判据退回了莆仙词表。
    // 换正本时这一栏是 roles 还是 hardcoded，决定了"这批很干净"是真干净还是没在比较。
    identity_column_source: columns.source,
    producer_version: IDENTITY_VERSION,
    // 本路径**不刷 tier**（每页刷一次的 N+1 代价见 docs §耗时那一节），而 duplicate_identity
    // 与 merged_columns 都是 strong、会进判定表。所以这一批之后每一页的 difficulty_tier 描述的是
    // 跨行检出之前的疑点集合。字段让调用方看得见这件事，runbook 是"再跑一次 findings/recompute"。
    difficulty_stale: inserted > 0,
    duration_ms: new Date() - startedAt
  }
  if (unanchored) console.warn("identity_recompute unanchored findings", projectId, unanchored)
  return preparedPayload(dao, pages, anchored, [], derivations, IDENTITY_KINDS, summary, IDENTITY_VERSION)
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
  utf8Bytes,
  safeRecomputePage,
  PRODUCER,
  RETIRE_CHUNK,
  READ_CHUNK,
  readAllInChunks,
  retire,
  PAGE_SCAN_CHUNK,
  PROJECT_SCAN_REFUSAL,
  loadAllPages,
  RULE_KINDS,
  IDENTITY_KINDS,
  rowForRules,
  recomputePage,
  recomputeProject,
  recomputeIdentity,
  refreshDifficulty,
  projectShapeStats
}
