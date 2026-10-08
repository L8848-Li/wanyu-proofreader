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
// `ocr_row_json` 逐字相等，并把那份串的码位数记进 `offsets_basis`。
// #293 的管理侧写回路让 `ocr_row_json` 此后可以随时被改写（2026-10-06 裁定不做版本化、
// 不触发重算），旧下标于是会切到新串的错位处——最坏症状是那段注释自己写的
// 「高亮标在空白上，而在界面上看起来完全正常」：不报错、不 500、无日志。
//
// 这里用同一个基准再核一次，对不上就把区间摘掉。摘区间**不等于**丢疑点：
// `locateSpan`（`frontend/src/lib/fieldHints.js:163`）见不到区间就降级为「聚焦该字段」，
// 归因照旧——这是 `assist_writer.js:73-74` 已经写明的既有降级语义，不新造契约。
// 被剥掉的条数经 `offsets_stale` 回给调用方，漏标不许静默。
function offsetsBasis(text) {
  return Array.from(String(text ?? "")).length
}

// 基准长度是**可判定的下界**：等长的原地改写（换掉一个字）看不出来，区间仍指向同一位置，
// 而那不会把高亮画到空白上——位置没错，只是被标的内容可能已被修正。这类残留由显式重算
// （提交后、裁决后、管理端两个口）纠正，不在读侧猜内容：读侧一旦开始猜，就会造出
// 「看起来标对了但标的不是判据命中的那一处」这种比不标更难查的错。
function dropStaleOffsets(view, shownRow) {
  const evidence = view.evidence
  if (!Array.isArray(evidence?.char_offsets)) return false
  const basis = evidence.offsets_basis
  // 没有基准的历史批次不判：写回面出现之前 `ocr_row_json` 是 create-only（#304 正文核过），
  // 不存在能让区间失配的后置改写路径，把它们的区间一律剥掉只会凭空削弱现成的定位帮助。
  if (typeof basis !== "number") return false
  // 读不到那份串时无法证明区间仍然忠实，按不忠实处理；字段本身缺失同理（长度 0 对不上）。
  if (shownRow === null || shownRow === undefined) return stripOffsets(evidence)
  return offsetsBasis(String(shownRow[view.field] ?? "")) === basis
    ? false
    : stripOffsets(evidence)
}

function stripOffsets(evidence) {
  delete evidence.char_offsets
  return true
}

// 校对端一次请求只看一条条目，所以这里单取一次 pages；管理端复用 locatorOf 的缓存。
function shownRowOf(dao, pageId) {
  const id = String(pageId ?? "")
  if (!id) return null
  try {
    return parseJson(dao.findRecordById("pages", id).get("ocr_row_json"), null)
  } catch {
    return null
  }
}

// 当前批次：未被 superseded 的那一批。重算只写新批次并标旧批次，
// 所以「未 superseded」本身就定义了当前批次（#176 期望结果 5）。
function currentRecords(dao, filter, sort, limit, offset) {
  const parts = [`superseded_at = ""`]
  if (filter) parts.push(`(${filter})`)
  return dao.findRecordsByFilter("review_findings", parts.join(" && "), sort, limit, offset)
}

function hintView(record, gate) {
  return {
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
    producer: record.getString("producer"),
    producer_version: record.getString("producer_version"),
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
// `offsets_stale` 同理，说的是另一件事：疑点仍然下发，只是**区间**因为原文已被改写
// 而不再可信，前端因此只聚焦字段、不画高亮（#304）。
function hintsForPage(dao, pageId) {
  const { map: gates, truncated: gateTruncated } = gateMap(dao)
  const shownRow = shownRowOf(dao, pageId)
  const records = currentRecords(dao, `page = "${pageId}"`, "kind,message_key", MAX_PAGE_SIZE + 1, 0)
  const hints = []
  let suppressed = 0
  let stale = 0
  for (const record of records) {
    const { gate } = gateOf(gates, record)
    const severity = record.getString("severity")
    if (!GATE_RELEASES[gate].includes(severity)) {
      // info 级本来就不进校对端（门槛文件 §2），不该混进「被门控挡住」这个数字里。
      if (gate === "off" && GATE_RELEASES.warn.includes(severity)) suppressed += 1
      continue
    }
    const view = hintView(record, gate)
    if (dropStaleOffsets(view, shownRow)) stale += 1
    hints.push(view)
  }
  return {
    hints,
    truncated: records.length > MAX_PAGE_SIZE,
    suppressed_by_gate: suppressed,
    offsets_stale: stale,
    gate_rows_truncated: gateTruncated
  }
}

// 管理端：不做门控过滤，info 与 off 一律可见——门槛文件 §2 要求 off 只挡校对端，
// 「仍计算、仍写库、只在管理端统计」依赖这个读取口。
function listForProject(dao, projectId, { page = 1, per = 50, kind = "", producer = "" } = {}) {
  const clauses = [`project = "${projectId}"`]
  const safeKind = enumParam(kind, FINDING_KINDS)
  const safeProducer = enumParam(producer, PRODUCERS)
  if (safeKind) clauses.push(`kind = "${safeKind}"`)
  if (safeProducer) clauses.push(`producer = "${safeProducer}"`)
  const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(per) || 50))
  const index = Math.max(1, Number(page) || 1)
  const { map: gates, truncated: gateTruncated } = gateMap(dao)
  // 多取一条用来判断是否还有下一页，不依赖 count 查询。
  const records = currentRecords(dao, clauses.join(" && "), "-produced_at,kind,message_key", size + 1, (index - 1) * size)
  const locatorCache = new Map()
  let stale = 0
  const items = records.slice(0, size).map((record) => {
    const { gate, row } = gateOf(gates, record)
    const locator = locatorOf(dao, record.getString("page"), locatorCache)
    const item = statisticsView(record, gate, row, locator)
    // 管理端展示「命中区间」用的是同一份下标，所以也要过同一道复核（#304）：
    // 两端各写一套判据的话，早晚只有一端在防这件事。
    if (dropStaleOffsets(item, locator.shown)) stale += 1
    return item
  })
  return {
    items,
    hasMore: records.length > size,
    page: index,
    per: size,
    offsets_stale: stale,
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
  dropStaleOffsets,
  shownRowOf,
  hintsForPage,
  listForProject
}
