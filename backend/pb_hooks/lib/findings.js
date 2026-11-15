// #176 机器疑点的读取与门控。
//
// 这里的口径全部来自 docs/plans/2026-09-25-assist-rule-thresholds.md §2，改语义要同时改那份文件：
// - `gate` 是放行范围的「下限」，不是「恰好」：warn 与 strong 两档放行的集合相同，
//   差别只在 strong 是否高亮；
// - `info` 永不进校对端，只作管理端统计；
// - 登记表缺行按 `off` 处理（新规则初始一律 off，先有数据才有档位）。

// #176 期望结果 5：除 superseded_at 之外的字段一律不可改。
// 放在 lib 里而不是 hook 文件的顶层——PocketBase 的 JSVM 只在文件求值时保留顶层绑定，
// 回调真正执行时读不到同文件的顶层 const（会抛 ReferenceError）。
const IMMUTABLE_FINDING_FIELDS = [
  "project",
  "page",
  "field_name",
  "round",
  "kind",
  "severity",
  "message_key",
  "params_json",
  "evidence_json",
  "producer",
  "producer_version",
  "produced_at"
  , "verification_context_json", "assist_publication"
]

const GATE_RELEASES = {
  off: [],
  warn: ["warn", "strong"],
  strong: ["warn", "strong"]
}
const DEFAULT_GATE = "off"
// 一次读取里最多带回的 finding 条数；门控与统计页都不能把这张表当成无界来源。
// 校对端与统计端共用这一个上限：两个口各写一个数，早晚会只剩一个被人记得改。
// 超出时响应里带 truncated，绝不静默少给。
const MAX_PAGE_SIZE = 200
const MAX_GATE_ROWS = 2000
const FINDING_KINDS = [
  "char_out_of_repertoire", "confusable_substitution", "encoding_form_anomaly",
  "missing_field", "reading_format_invalid", "punctuation_mix", "page_outlier",
  "duplicate_identity", "cross_source_conflict", "merged_columns"
]
const PRODUCERS = ["rule", "ocr", "bundle_import"]

// 查询参数必须是**白名单值**，不能被拼进过滤表达式。
// 这两个参数直接来自 URL；拼进 filter 文本后，kind 里塞 `x") || (producer = "ocr`
// 会让 `&&` 的高优先级把后半段变成一条不受 project、也不受 superseded_at 约束的析取分支
// —— 任意项目的 manager 就能读全库疑点。枚举字段用白名单比转义引号更严也更短。
function enumParam(value, allowed) {
  const text = String(value ?? "").trim()
  return allowed.includes(text) ? text : ""
}

function identityOf(record) {
  return [
    record.getString("producer"),
    record.getString("producer_version"),
    record.getString("kind"),
    record.getString("message_key")
  ].join("\u0000")
}

// 返回 { map, truncated }：截断与否必须是可判定的返回值，不能只留一条 console.warn。
// 校对端与管理端都靠它把「读不全」这件事如实告诉调用方——否则某条规则突然不显示
// 就成了查不出来的幽灵（#228 验收标准第 7 条）。
function gateMap(dao, limit = MAX_GATE_ROWS) {
  const rows = dao.findRecordsByFilter("assist_rule_gates", "", "", limit + 1, 0)
  const truncated = rows.length > limit
  if (truncated) {
    console.warn(`assist_rule_gates 读取被截断在 ${limit} 行，超出的规则一律按 off 处理`)
  }
  const map = new Map()
  for (const row of rows.slice(0, limit)) map.set(identityOf(row), row)
  return { map, truncated }
}

function gateOf(gates, record) {
  const row = gates.get(identityOf(record))
  if (!row) return { gate: DEFAULT_GATE, row: null }
  const gate = row.getString("gate")
  // 登记表里出现未知值时按最保守的 off 处理，而不是放行。
  return { gate: GATE_RELEASES[gate] ? gate : DEFAULT_GATE, row }
}

function parseJson(value, fallback) {
  const text = String(value ?? "")
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" ? parsed : fallback
  } catch {
    return fallback
  }
}

// ---- 命中区间的读侧复核（#304）----
//
// `evidence.char_offsets` 是「判据当时跑的那份串」上的码位下标。写入侧的诚实性闸门
// （`assist_writer.js` 的 `dropUnfaithfulOffsets`）只在**落库那一刻**确认它和校对端要切的
// `ocr_row_json` 逐字相等，并把**每个区间所切片段**的摘要记进 `offsets_basis`（见下方
// 「基准为什么是片段摘要」）。
// #293 的管理侧写回路让 `ocr_row_json` 此后可以随时被改写（2026-10-06 裁定不做版本化、
// 不触发重算），旧下标于是会切到新串的错位处——最坏症状是那段注释自己写的
// 「高亮标在空白上，而在界面上看起来完全正常」：不报错、不 500、无日志。
//
// 这里用同一个基准再核一次，对不上就把区间摘掉。摘区间**不等于**丢疑点：
// `locateSpan`（`frontend/src/lib/fieldHints.js:163`）见不到区间就降级为「聚焦该字段」，
// 归因照旧——这是 `assist_writer.js:73-74` 已经写明的既有降级语义，不新造契约。
// 剥掉的条数按原因分两个数回给调用方：`offsets_stale` 是原文确实变了或读不到，
// `offsets_unbaselined` 是这批根本没有可验证基准。漏标不许静默，两种原因也不许混成一个数
// ——部署当天那个数会很大，把它读成「原文被大面积改写」就是假的告警。
//
// 基准为什么是片段摘要而不是总长度：总码位数相等证明不了命中没动（#304 复审 P2）。管理员
// 写回支持整格改写，`aŋ1234` → `1234aŋ` 长度不变而数字命中已从 [2,6) 移到 [0,4)，只比长度
// 会把高亮留在 `34aŋ` 上。取「每个区间所切片段的摘要」则位置或内容任一变化都改摘要。
// 存摘要而不是片段本身，是 §6 的红线：`evidence_json` 只允许结构信息，字形序列是内容。
//
// 摘要必须能在 JSVM 与 node 下算出同一个值：写侧在 JSVM 盖章、读侧在 JSVM 复核，而纯函数
// 回归段直接 `require` 本文件跑（不起服务）。所以这里不用 `$security.sha256`（node 下没有），
// 也不用 BigInt（goja 支持面不同），只用 `Math.imul` 的 32 位运算拼成 128 位。
const FNV_SEEDS = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]

function excerptDigest(text) {
  const units = String(text)
  return FNV_SEEDS.map((seed) => {
    let hash = seed >>> 0
    for (let i = 0; i < units.length; i++) {
      hash = Math.imul(hash ^ units.charCodeAt(i), 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
  }).join("")
}

// 空片段不给基准：它和「区间掉出串外」切出来的空串无法区分，盖章会把后者伪装成已验证。
// 返回 null 让调用方走「无可验证基准」那条保守分支，读侧一律剥。
function offsetsBasis(text, spans) {
  if (!Array.isArray(spans) || !spans.length) return null
  const chars = Array.from(String(text ?? ""))
  const digests = []
  for (const span of spans) {
    if (!Array.isArray(span)) return null
    const excerpt = chars.slice(span[0], span[1]).join("")
    if (!excerpt) return null
    digests.push(excerptDigest(excerpt))
  }
  return { digests }
}

// 返回 ""（区间忠实，保留）| "stale"（原文变了/读不到/形状对不上）|
// "unbaselined"（没有可验证的基准，含本修复之前落库的全部批次）。
function dropStaleOffsets(view, shownRow) {
  const evidence = view.evidence
  if (!Array.isArray(evidence?.char_offsets)) return ""
  const basis = evidence.offsets_basis
  const usable = basis && typeof basis === "object" && Array.isArray(basis.digests) &&
    basis.digests.length === evidence.char_offsets.length &&
    basis.digests.every((digest) => typeof digest === "string" && digest.length)
  if (!usable) {
    stripOffsets(evidence)
    return "unbaselined"
  }
  // 读不到那份串时无法证明区间忠实，按不忠实处理；字段整列消失同理（切出来是空串）。
  if (shownRow === null || shownRow === undefined) {
    stripOffsets(evidence)
    return "stale"
  }
  const chars = Array.from(String(shownRow[view.field] ?? ""))
  const faithful = evidence.char_offsets.every((span, index) => {
    if (!Array.isArray(span)) return false
    const excerpt = chars.slice(span[0], span[1]).join("")
    return excerpt !== "" && excerptDigest(excerpt) === basis.digests[index]
  })
  if (faithful) return ""
  stripOffsets(evidence)
  return "stale"
}

function stripOffsets(evidence) {
  delete evidence.char_offsets
}

// 两个只读口共用同一份计数：各写一套的话，早晚只有一端在防这件事。
// 未知原因直接抛——静默不计数就是把「漏标」重新变成无声的，本仓不接受这种形状。
function tallyOffsets(reason, counts) {
  if (reason === "") return counts
  if (reason !== "stale" && reason !== "unbaselined") {
    throw new Error(`unknown offset staleness reason: ${reason}`)
  }
  counts[reason] += 1
  return counts
}

// A publication becomes visible atomically. Retirements are derived tombstones;
// superseded_at alone no longer identifies the complete current batch.
function currentRecords(dao, where, sort, limit, offset) {
  return require(`${__hooks}/lib/assist_visibility.js`).records(dao, "review_findings", where, sort, limit, offset, "current")
}

function hintView(record, gate) {
  return {
    id: record.id,
    field: record.getString("field_name"),
    kind: record.getString("kind"),
    severity: record.getString("severity"),
    message: {
      key: record.getString("message_key"),
      params: parseJson(record.get("params_json"), {})
    },
    // 校对端只需要知道要不要高亮；档位本身不下发，避免把它当置信度读。
    highlight: record.getString("severity") === "strong" && gate === "strong",
    evidence: parseJson(record.get("evidence_json"), {})
  }
}

// 疑点挂靠条目的定位信息（只含条目号与 PDF 页号，不含单元格正文——契约 §6）。
//
// 管理端此前只下发 `page`（记录 id），而 id 在人眼里不可读，管理员看完一批疑点
// 仍然不知道去哪一条核对。取不到就留 null：`page` 是指向 pages 的 relation 且
// cascadeDelete=true，条目删除会连带删掉疑点，所以库里不存在悬挂引用，
// null 只可能是"该条没有 pdf_page（CSV 直接导入）"或读取异常，两者都由前端说成未知。
// 同一次请求里一批疑点常挂在同几条上，所以带 cache，不做 N 次重复查库。
//
// 返回对象里额外挂一个 `shown`（该条导入原文的行对象），只给读侧复核区间用（#304），
// **绝不下发**：statisticsView 逐字段挑选输出，不做展开，所以它不会漏进响应。
function locatorOf(app, pageId, cache) {
  const unknown = { page_number: null, pdf_page: null, shown: null }
  const id = String(pageId ?? "")
  if (!id) return unknown
  if (cache && cache.has(id)) return cache.get(id)
  let value = unknown
  try {
    const entry = app.findRecordById("pages", id)
    // number 字段未填时 goja 读到 null/""，而 pdf_page 的 min=1 ⇒ 0 一律当「未挂靠」。
    const asOrdinal = (raw) => {
      const n = Number(raw)
      return Number.isInteger(n) && n > 0 ? n : null
    }
    value = {
      page_number: asOrdinal(entry.get("page_number")),
      pdf_page: asOrdinal(entry.get("pdf_page")),
      shown: parseJson(entry.get("ocr_row_json"), null)
    }
  } catch {
    value = unknown
  }
  if (cache) cache.set(id, value)
  return value
}

// 管理端口不下发 highlight：档位才是它要表达的东西，高亮是校对端的事。
// 注意不要写成 highlight: undefined —— goja 会把 undefined 转成 null 落进响应里。
function statisticsView(record, gate, row, locator) {
  const view = hintView(record, gate)
  const coverage = require(`${__hooks}/lib/rule_coverage.js`)
  const { PROJECT_ONLY_MESSAGE_KEYS, CONFUSABLE_MESSAGE_KEY, TONE_COUNT_MESSAGE_KEY, RULES_VERSION } = require(`${__hooks}/lib/assist_rules.js`)
  const producer = record.getString("producer")
  const version = record.getString("producer_version")
  const key = view.message.key
  const audience = producer !== "rule" ? "entry"
    : PROJECT_ONLY_MESSAGE_KEYS.includes(key) ? "batch"
    : key === CONFUSABLE_MESSAGE_KEY || (key === TONE_COUNT_MESSAGE_KEY && version !== RULES_VERSION) ? "diagnostic"
    : "entry"
  return {
    id: record.id,
    field: view.field,
    kind: view.kind,
    severity: view.severity,
    message: view.message,
    evidence: view.evidence,
    page: record.getString("page"),
    page_number: locator.page_number,
    pdf_page: locator.pdf_page,
    project: record.getString("project"),
    producer,
    producer_version: version,
    audience,
    produced_at: record.getString("produced_at"),
    gate,
    // #254：`off` 有两种，界面必须说得出是哪一种——"有通道、等证据"与
    // "现有通道量不到精度"读起来都像"再等等"，但后者永远等不到。
    // 通道只下发给管理端：hintView（校对口）不带它，校对员不需要知道
    // 自己手上这条能不能打分，那是放行侧的事。
    scoring_channel: coverage.channelOf({
      producer_version: record.getString("producer_version"),
      kind: record.getString("kind"),
      message_key: record.getString("message_key")
    }),
    gate_sample_n: row ? row.getInt("sample_n") : 0,
    gate_precision_hat: row ? Number(row.get("precision_hat") || 0) : null
  }
}

// 校对端：按 gate 与 severity 双重过滤后的 hints（#176 期望结果 4）。
//
// `suppressed_by_gate` 是「本条目上有 warn/strong 级疑点，但所在规则档位没放行」的条数。
// 它存在的唯一理由是把「没下发」与「没疑点」这两件事在字段级分开（#228 验收标准第 6 条）：
// 只有 hints 数组时，gate 全 off 与这批资料真的干净，在响应里长得一模一样，
// 而后者会被读成「这批可以放心」。它只是一个计数，不含规则身份、不含内容，
// 因此不触碰盲校纪律（校对端仍看不到别人的结果、轮次与档位）。
//
// `offsets_stale` / `offsets_unbaselined` 说的又是另一件事：疑点仍然下发，只是**区间**画不
// 得——前者是原文已改写或对不上，后者是这批根本没有可验证基准（#304，见 §1.1）。
function hintsForPage(dao, pageId) {
  const { map: gates, truncated: gateTruncated } = gateMap(dao)
  const hints = []
  let suppressed = 0
  const offsets = { stale: 0, unbaselined: 0 }
  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const page = dao.findRecordById("pages", pageId)
  const shownRow = parseJson(page.get("ocr_row_json"), null)
  const projectId = page.getString("project")
  const policy = fidelity.policyFor(dao, projectId)
  const { parseStoredRoles, toneCountFieldsFor } = require(`${__hooks}/lib/column_roles.js`)
  const project = dao.findRecordById("projects", projectId)
  const [left = "", right = ""] = toneCountFieldsFor(project, parseStoredRoles(project.getString("column_roles_json")))
  const { RULES_VERSION, TONE_COUNT_MESSAGE_KEY, ADMINISTRATIVE_MESSAGE_KEYS } = require(`${__hooks}/lib/assist_rules.js`)
  // Filter before the cap so diagnostic rows cannot crowd out actionable hints.
  const administrative = ADMINISTRATIVE_MESSAGE_KEYS.map(key => `'${key}'`).join(",")
  const records = currentRecords(dao, $dbx.exp(`page = {:page} AND (producer != 'rule' OR (
    message_key NOT IN (${administrative}) AND (message_key != {:toneKey} OR (
      producer_version = {:version} AND {:left} != '' AND CASE WHEN json_valid(params_json) THEN
        json_extract(params_json, '$.left_field') = {:left} AND json_extract(params_json, '$.right_field') = {:right}
      ELSE 0 END))))`, { page: pageId, toneKey: TONE_COUNT_MESSAGE_KEY, version: RULES_VERSION, left, right }),
  "kind,message_key", MAX_PAGE_SIZE + 1, 0)
  const inputVersion = excerptDigest(JSON.stringify(shownRow))
  for (const record of records.slice(0, MAX_PAGE_SIZE)) {
    const { gate } = gateOf(gates, record)
    const severity = record.getString("severity")
    if (!GATE_RELEASES[gate].includes(severity)) {
      // info 级本来就不进校对端（门槛文件 §2），不该混进「被门控挡住」这个数字里。
      if (gate === "off" && GATE_RELEASES.warn.includes(severity)) suppressed += 1
      continue
    }
    const view = hintView(record, gate)
    const analyzedVersion = view.evidence?.analysis_input_version || ""
    view.input_status = !analyzedVersion ? "legacy_unrecorded" : analyzedVersion === inputVersion ? "imported_value" : "different_input"
    if (record.getString("message_key") === "long_digit_run" && policy?.tone_equivalence && policy.reading_fields?.includes(view.field)
      && fidelity.comparison.validToneForm(shownRow?.[view.field]) && view.input_status !== "different_input") {
      view.message = { key: "tone_layout_allowed", params: {} }
    }
    view.action = "compare_source_pdf"
    tallyOffsets(dropStaleOffsets(view, shownRow), offsets)
    if (view.input_status === "different_input" && Array.isArray(view.evidence?.char_offsets)) { stripOffsets(view.evidence); offsets.stale += 1 }
    // 基准是内容派生的摘要（片段摘要，§1.1），校对端没有它的消费者，所以下发前摘掉——
    // 与上面 `scoring_channel` 只给管理端同一个立场。它留在库里供管理端和重算复核用。
    if (view.evidence) delete view.evidence.offsets_basis
    hints.push(view)
  }
  return {
    hints,
    truncated: records.length > MAX_PAGE_SIZE,
    suppressed_by_gate: suppressed,
    offsets_stale: offsets.stale,
    offsets_unbaselined: offsets.unbaselined,
    gate_rows_truncated: gateTruncated
    , input_version: inputVersion, candidate_count: records.length, counts_are_lower_bounds: records.length > MAX_PAGE_SIZE
  }
}

// 管理端：不做门控过滤，info 与 off 一律可见——门槛文件 §2 要求 off 只挡校对端，
// 「仍计算、仍写库、只在管理端统计」依赖这个读取口。
function listForProject(dao, projectId, { page = 1, per = 50, kind = "", producer = "", batch = "" } = {}) {
  const clauses = ["project = {:project}"]
  const params = { project: projectId }
  if (batch) {
    const { assertId } = require(`${__hooks}/lib/project_access.js`)
    params.batch = assertId(batch, "导入批次")
    const job = dao.findRecordsByFilter("import_jobs", "id = {:batch} && project = {:project}", "", 1, 0, params)[0]
    if (!job) throw new NotFoundError("导入批次不存在")
    const { PROJECT_ONLY_MESSAGE_KEYS, RULES_VERSION } = require(`${__hooks}/lib/assist_rules.js`)
    params.batchRuleVersion = RULES_VERSION
    clauses.push("producer = 'rule' AND producer_version = {:batchRuleVersion}",
      `message_key IN (${PROJECT_ONLY_MESSAGE_KEYS.map(key => `'${key}'`).join(",")})`,
      `CASE WHEN json_valid(evidence_json) THEN json_extract(evidence_json, '$.batch') = {:batch} ELSE 0 END`,
      "EXISTS (SELECT 1 FROM pages p WHERE p.id=review_findings.page AND p.project={:project} AND p.import_job={:batch})")
  }
  const safeKind = enumParam(kind, FINDING_KINDS)
  const safeProducer = enumParam(producer, PRODUCERS)
  if (safeKind) { clauses.push("kind = {:kind}"); params.kind = safeKind }
  if (safeProducer) { clauses.push("producer = {:producer}"); params.producer = safeProducer }
  const size = Number.isFinite(Number(per)) ? Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(per) || 50))) : 50
  const requestedPage = Math.trunc(Number(page))
  const index = Number.isSafeInteger(requestedPage) && Number.isSafeInteger((requestedPage - 1) * size) ? Math.max(1, requestedPage) : 1
  const { map: gates, truncated: gateTruncated } = gateMap(dao)
  // 多取一条用来判断是否还有下一页，不依赖 count 查询。
  const records = currentRecords(dao, $dbx.exp(clauses.join(" AND "), params), "-produced_at,kind,message_key", size + 1, (index - 1) * size)
  const locatorCache = new Map()
  const offsets = { stale: 0, unbaselined: 0 }
  const items = records.slice(0, size).map((record) => {
    const { gate, row } = gateOf(gates, record)
    const locator = locatorOf(dao, record.getString("page"), locatorCache)
    const item = statisticsView(record, gate, row, locator)
    // 管理端展示「命中区间」用的是同一份下标，所以也要过同一道复核（#304）：
    // 两端各写一套判据的话，早晚只有一端在防这件事。
    tallyOffsets(dropStaleOffsets(item, locator.shown), offsets)
    return item
  })
  return {
    items,
    hasMore: records.length > size,
    page: index,
    per: size,
    offsets_stale: offsets.stale,
    offsets_unbaselined: offsets.unbaselined,
    gate_rows_truncated: gateTruncated
  }
}

module.exports = {
  DEFAULT_GATE,
  FINDING_KINDS,
  PRODUCERS,
  enumParam,
  IMMUTABLE_FINDING_FIELDS,
  GATE_RELEASES,
  MAX_PAGE_SIZE,
  identityOf,
  gateOf,
  gateMap,
  locatorOf,
  offsetsBasis,
  excerptDigest,
  dropStaleOffsets,
  tallyOffsets,
  hintsForPage,
  hintView,
  listForProject
}
