// #177 确定性规则引擎（L0）。
//
// 分工：本文件只使用规则上下文和输入行，不碰 DAO。
// 需要键盘/角色的上下文由调用方（backend/pb_hooks/assist.pb.js）构造后传进来。
// 好处是每条规则都能在 node 里直接跑单测，不必起服务器。
//
// 移植基准是 #201 入仓的 scripts/corpus_probe/detectors.py（不是 W2 的本机缓存脚本）；
// severity 沿用其 README:59-68 那张「检测函数 → kind → 默认严重度」表的口径。
//
// 边界：本文件只定 finding 的 severity（疑点自身属性）。规则能不能进校对端由
// assist_rule_gates 的 gate 决定，见 docs/plans/2026-09-25-assist-rule-thresholds.md §2；
// 两者不可互相推导，所以这里不出现 gate 字样。

const hooksRoot = typeof globalThis.__hooks === "string" ? globalThis.__hooks : ""
const comparison = require(hooksRoot ? `${hooksRoot}/lib/source_comparison.js` : "./source_comparison.js")
const RULES_VERSION = "l0-v2"
const LEGACY_RULES_VERSION = "l0-v1"
const TONE_COUNT_MESSAGE_KEY = "tone_token_count_differs"
const CONFUSABLE_MESSAGE_KEY = "confusable_ascii_in_reading"
const BATCH_MESSAGE_KEYS = [
  "mixed_normalization_forms", "punctuation_width_mixed_in_column",
  "pdf_page_backtrack", "page_entry_count_outlier"
]
const ADMINISTRATIVE_MESSAGE_KEYS = [...BATCH_MESSAGE_KEYS, CONFUSABLE_MESSAGE_KEY]

// 莆仙三套方案里合法的三位以上调值只有这两个（detectors.py:28 的 shipped 行为）。
// 原型 anomaly_probe.py 的 13 值 LEGAL 集合在 #201 移植时被刻意删除；
// 引进来会把「≥3 位且非 533/453」放宽，与已入仓且有正反用例的行为不一致。
const LEGAL_LONG_TONES = ["533", "453"]
const PLACEHOLDER = /@[0-9a-fA-F]{4,6}/g
const READING_FIELDS = ["拼音", "莆田IPA", "仙游IPA"]
const IPA_FIELDS = ["莆田IPA", "仙游IPA"]
const MEANING_FIELDS = ["释义"]
const REQUIRED_ROLES = ["headword", "reading", "meaning"]

// R1 的放行区段 = detectors.py 的 ALLOWED_NON_REPERTOIRE_RANGES 同义：
// 记音列出现汉字属结构问题（merged_columns），不是「校对员打出了打不出的字符」；
// 非 BMP 汉字已有自己的 kind（outside_unicode_set），不在这里二次报。
const ALLOWED_RANGES = [
  [0x0020, 0x007e], // ASCII 可见
  [0x00a0, 0x02af], // 拉丁扩展 + IPA
  [0x0300, 0x036f], // 组合附加符
  [0x2000, 0x206f], // 通用标点
  [0x3000, 0x303f], // CJK 符号与标点（含 〔〕）
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 统一表意
  [0xf900, 0xfaff], // 兼容表意
  [0x20000, 0x2fa1f] // 全部非 BMP 汉字块
]

// R7 的两个判据阈值必须先写定再实现（#177 正文的前置要求；改动要走新 PR，
// 并在 docs/plans/2026-09-25-assist-rules.md 的 R7 节同步）：
//   · 单调性：pdf_page 相比条目顺序回退超过容差 → 一条异常；
//   · 密度：某页条目数 > max(中位数 + 最小增量, 中位数 × 倍数) → 离群；
//     中位数至少要有 MIN_PAGES 页样本，样本不足直接跳过（不给假数字）。
const PAGE_ORDER_BACKTRACK_TOLERANCE = 1
const PAGE_DENSITY_MEDIAN_MULTIPLIER = 3
const PAGE_DENSITY_MIN_EXTRA = 8
const PAGE_DENSITY_MIN_PAGES = 20

function inAllowed(code) {
  return ALLOWED_RANGES.some(([low, high]) => code >= low && code <= high)
}

function codepointLabel(code) {
  return `U+${Number(code).toString(16).toUpperCase().padStart(4, "0")}`
}

function isEmpty(value) {
  return String(value ?? "").trim() === ""
}

// 键盘字符并集：只取码位。组合符序列（如 ã = a+U+0303）拆成逐个码位收进集合，
// 否则记音里合法的鼻化标记会被 R1 报成集外字符。
function repertoireOf(keyboards) {
  const allowed = new Set()
  for (const item of keyboards ?? []) {
    for (const section of item?.definition?.sections ?? []) {
      for (const key of section?.keys ?? []) {
        for (const ch of Array.from(String(key?.value ?? ""))) allowed.add(ch.codePointAt(0))
      }
    }
  }
  return allowed
}

// R2 的混淆表编译自键盘 hint（#175 想法 1）。hint 文本同时给出目标码位和
// 「长得像的那个 ASCII」，例如「插入 ɑ（音标，区别于普通 a；U+0251）」。
// 解析不出来就不收：宁可少一条规则，也不凭猜测造表。
function confusablesOf(keyboards) {
  const byLookalike = new Map()
  for (const item of keyboards ?? []) {
    for (const section of item?.definition?.sections ?? []) {
      for (const key of section?.keys ?? []) {
        const value = String(key?.value ?? "")
        const hint = String(key?.hint ?? "")
        const chars = Array.from(value)
        if (!hint || chars.length !== 1) continue
        const target = chars[0].codePointAt(0)
        if (target <= 0x7e) continue
        if (!hint.includes("区别于")) continue
        // hint 里的码位写法是补零的（U+0251 而不是 U+251），所以要按数值比对，
        // 不能拿 target.toString(16) 去匹配字符串——那样每个补零的键都会被跳过。
        const declared = [...hint.matchAll(/U\+([0-9a-fA-F]{1,6})/g)].map((m) => parseInt(m[1], 16))
        if (!declared.includes(target)) continue
        const inside = (hint.match(/[（(]([^）)]*)[）)]/)?.[1] ?? "")
          // hint 里自带 U+0251 这样的码位写法，不先摘掉会把 U、+、0、2、5、1
          // 当成"长得像的 ASCII"收进表里。
          .replace(/U\+[0-9a-fA-F]{4,6}/g, "")
        const lookalikes = new Set()
        for (const ch of inside) {
          const code = ch.codePointAt(0)
          if (code >= 0x21 && code <= 0x7e) lookalikes.add(ch)
        }
        for (const ascii of lookalikes) {
          const bucket = byLookalike.get(ascii) ?? []
          if (!bucket.includes(codepointLabel(target))) bucket.push(codepointLabel(target))
          byLookalike.set(ascii, bucket)
        }
      }
    }
  }
  return byLookalike
}

function makeContext({ projectId = "", keyboards = [], roles = null, toneCountFields = [], readingFields = READING_FIELDS,
  meaningFields = MEANING_FIELDS, ipaFields = IPA_FIELDS } = {}) {
  return {
    projectId,
    producerVersion: RULES_VERSION,
    repertoire: repertoireOf(keyboards),
    confusables: confusablesOf(keyboards),
    readingFields: [...readingFields],
    meaningFields: [...meaningFields],
    ipaFields: [...ipaFields],
    toneCountFields: [...toneCountFields],
    roles
  }
}

// ---- 命中区间（evidence.char_offsets）----
//
// 口径：`[[start, end), …]`，按**码位**计、半开区间，必须与消费端一字不差
// （`frontend/src/lib/fieldHints.js` 的 `locateSpan` 同口径，再由它换算 UTF-16 选区）。
// 两端各按各的直觉写（一端含尾、一端不含；一数码位、一端 UTF-16）时的症状是高亮整体
// 偏移一格，或遇到补充平面字符（𰻞、PUA 缺字）时错位——那不报错，只像"标错了地方"。
//
// 判据、离线打分和写入端共用这里的区间口径。
function mergeSpans(indices) {
  const merged = []
  let start = null
  let previous = null
  for (const index of [...indices].sort((a, b) => a - b)) {
    if (start === null) {
      start = index
    } else if (index !== previous + 1) {
      merged.push([start, previous + 1])
      start = index
    }
    previous = index
  }
  if (start !== null) merged.push([start, previous + 1])
  return merged
}

// 逐码位判据 → 区间；`minLength` 丢掉短于判据门槛的碎片
// （R6 的靶子是三位以上的数字串，标出一个孤立数字会把人引向错的地方）。
function predicateSpans(text, isHit, minLength = 1) {
  const indices = []
  let index = 0
  for (const ch of Array.from(String(text ?? ""))) {
    if (isHit(ch)) indices.push(index)
    index += 1
  }
  return mergeSpans(indices).filter(([start, end]) => end - start >= minLength)
}

// 命中内容是在"加工过的串"上判出来的（R6 先剔除缺字占位符）时，把它们定位回**原始值**。
// 任一串找不到就整体返回空数组，绝不给近似位置：猜出来的区间会把高亮打在错的字上，
// 比没有区间更糟——没有区间时前端只降级为"聚焦该字段"。
function literalSpans(text, needles) {
  const source = String(text ?? "")
  const merged = []
  let cursor = 0
  for (const needle of needles ?? []) {
    const token = String(needle)
    const utf16Start = source.indexOf(token, cursor)
    if (utf16Start < 0) return []
    const start = Array.from(source.slice(0, utf16Start)).length
    const end = start + Array.from(token).length
    const last = merged[merged.length - 1]
    if (last && start === last[1]) last[1] = end
    else merged.push([start, end])
    cursor = utf16Start + token.length
  }
  return merged
}

// 有区间才挂区间；空数组留在 evidence 里只会让前端多做一次无谓降级判断。
const spanEvidence = (spans) => (spans.length ? { char_offsets: spans } : {})

const finding = (kind, severity, field, message_key, params = {}, evidence = {}) =>
  ({ kind, severity, field, message_key, params, evidence })

// ---- R1 char_out_of_repertoire ----
function ruleCharOutOfRepertoire(ctx, row) {
  const out = []
  for (const [field, value] of Object.entries(row ?? {})) {
    if (isEmpty(value)) continue
    const seen = new Set()
    for (const ch of Array.from(String(value))) {
      const code = ch.codePointAt(0)
      if (!inAllowed(code) && !ctx.repertoire.has(code)) seen.add(code)
    }
    if (!seen.size) continue
    out.push(finding("char_out_of_repertoire", "warn", field, "non_ipa_range_codepoints",
      { codepoints: [...seen].sort((a, b) => a - b).map(codepointLabel) },
      spanEvidence(predicateSpans(value, (ch) => {
        const code = ch.codePointAt(0)
        return !inAllowed(code) && !ctx.repertoire.has(code)
      }))))
  }
  return out
}

// ---- R2 confusable_substitution ----
function ruleConfusables(ctx, row) {
  const out = []
  if (!ctx.confusables.size) return out
  for (const [field, value] of Object.entries(row ?? {})) {
    // 只查 IPA 列：`拼音` 用拉丁字母是方案本身规定的，把 a 当 ɑ 的误报会淹没真信号。
    if (isEmpty(value) || !ctx.ipaFields.includes(field)) continue
    const hits = []
    let position = 0
    for (const ch of Array.from(String(value))) {
      position += 1
      const suggested = ctx.confusables.get(ch)
      if (suggested) hits.push({ found: codepointLabel(ch.codePointAt(0)), position, suggested })
    }
    if (!hits.length) continue
    // 同一格只报一条并列出所有位置：一格里三个 a 不该产出三条 finding。
    out.push(finding("confusable_substitution", "warn", field, "confusable_ascii_in_reading", {
      suggestions: hits.map((hit) => ({ found: hit.found, suggested: hit.suggested })),
      positions: hits.map((hit) => hit.position),
      hit_count: hits.length
    }, spanEvidence(predicateSpans(value, (ch) => ctx.confusables.get(ch)))))
  }
  return out
}

// Mn（非间距组合标记）——对齐 detectors.py 的 unicodedata.category(c) == "Mn"。
// 只覆盖记音实际用到的组合符区段，为的是零新依赖（不引 Unicode 属性库）。
function isCombining(ch) {
  const code = ch.codePointAt(0)
  return code >= 0x300 && code <= 0x36f
}

// ---- R3 encoding_form_anomaly（格级；列级见 ruleColumnForms）----
function ruleCombiningMarks(ctx, row) {
  const out = []
  for (const [field, value] of Object.entries(row ?? {})) {
    if (isEmpty(value) || !ctx.readingFields.includes(field)) continue
    const marks = new Set()
    for (const ch of Array.from(String(value))) {
      if (isCombining(ch)) marks.add(ch.codePointAt(0))
    }
    if (!marks.size) continue
    out.push(finding("encoding_form_anomaly", "info", field, "combining_marks_present",
      { marks: [...marks].sort((a, b) => a - b).map(codepointLabel) },
      spanEvidence(predicateSpans(value, isCombining))))
  }
  return out
}

// 列级：同一列 NFC 与 NFD 并存时报少数派。需要整列，所以只在批处理路径跑。
// 只提示，**不改写任何值**（#177 非目标）。
function ruleColumnForms(columns) {
  const out = []
  for (const [field, values] of Object.entries(columns ?? {})) {
    let nfc = 0
    let nfd = 0
    for (const value of values ?? []) {
      if (isEmpty(value)) continue
      const text = String(value)
      const inNfc = text === text.normalize("NFC")
      const inNfd = text === text.normalize("NFD")
      if (inNfc && !inNfd) nfc += 1
      else if (inNfd && !inNfc) nfd += 1
    }
    if (!nfc || !nfd) continue
    out.push(finding("encoding_form_anomaly", "warn", field, "mixed_normalization_forms",
      { minority: nfc >= nfd ? "nfd" : "nfc", nfc, nfd }))
  }
  return out
}

// ---- R4 punctuation_mix（列级：同列全/半角混用）----
const PUNCT_PAIRS = [["（", "("], ["）", ")"], ["；", ";"], ["［", "["], ["］", "]"],
  ["【", "["], ["】", "]"], ["，", ","]]

function rulePunctuationMix(columns) {
  const out = []
  for (const [field, values] of Object.entries(columns ?? {})) {
    const used = new Set()
    for (const value of values ?? []) {
      for (const ch of Array.from(String(value ?? ""))) used.add(ch)
    }
    const pairs = PUNCT_PAIRS
      .filter(([full, half]) => used.has(full) && used.has(half))
      .map(([full, half]) => ({ full: codepointLabel(full.codePointAt(0)),
        half: codepointLabel(half.codePointAt(0)) }))
    if (!pairs.length) continue
    out.push(finding("punctuation_mix", "warn", field, "punctuation_width_mixed_in_column",
      { pairs, pair_count: pairs.length }))
  }
  return out
}

// ---- R5 missing_field（依赖 #170 的列角色；无角色时安全跳过）----
function ruleMissingField(ctx, row) {
  const out = []
  const roles = ctx.roles
  if (!roles || !Object.keys(roles).length) return out
  for (const [field, role] of Object.entries(roles)) {
    if (!REQUIRED_ROLES.includes(role)) continue
    if (isEmpty(row?.[field])) out.push(finding("missing_field", "strong", field,
      "required_role_field_empty", { role }))
  }
  return out
}

// ---- R6 reading_format_invalid ----
function toneSyllableCount(value) {
  return comparison.validToneForm(value) ? String(value).trim().split(/\s+/).length : null
}

function ruleReadingFormat(ctx, row) {
  const out = []
  for (const [field, value] of Object.entries(row ?? {})) {
    if (!ctx.readingFields.includes(field) || isEmpty(value)) continue
    const stripped = String(value).replace(PLACEHOLDER, "")
    // 占位符里的十六进制先剔除：@20000 带五位数字串，那是缺字登记序号不是压平声调，
    // 两条都报会让同一格挂上两个 strong。
    const runs = (stripped.match(/\d{3,}/g) ?? []).filter((run) => !LEGAL_LONG_TONES.includes(run))
    if (runs.length) {
      // 区间回到**原始值**上算：runs 是在剔除占位符之后的串上匹配的，
      // 直接拿那份串的下标会整体偏移。匹配不上就只给消息不给区间。
      out.push(finding("reading_format_invalid", "strong", field, "long_digit_run",
        { runs, run_count: runs.length }, spanEvidence(literalSpans(value, runs))))
    }
  }
  if (ctx.toneCountFields.length !== 2) return out
  const [left, right] = ctx.toneCountFields
  const leftCount = toneSyllableCount(row?.[left])
  const rightCount = toneSyllableCount(row?.[right])
  if (leftCount !== null && rightCount !== null && leftCount !== rightCount) {
    out.push(finding("reading_format_invalid", "warn", right, "tone_token_count_differs",
      { left_field: left, right_field: right, left_count: leftCount, right_count: rightCount }))
  }
  return out
}

// ---- R7 page_outlier（项目级）----
function rulePageOrderBacktrack(entries) {
  const out = []
  let previous = 0
  for (const entry of entries.slice().sort((a, b) => a.order - b.order)) {
    const page = Number(entry.pdfPage) || 0
    if (page <= 0) continue
    if (page < previous - PAGE_ORDER_BACKTRACK_TOLERANCE) {
      out.push(finding("page_outlier", "warn", "", "pdf_page_backtrack", {
        from_page: previous, to_page: page, backtrack: previous - page
      }, { page }))
    }
    previous = page
  }
  return out
}

function rulePageDensityOutliers(entries) {
  const perPage = new Map()
  for (const entry of entries ?? []) {
    const page = Number(entry.pdfPage) || 0
    if (page > 0) perPage.set(page, (perPage.get(page) ?? 0) + 1)
  }
  if (perPage.size < PAGE_DENSITY_MIN_PAGES) return []
  const counts = [...perPage.values()].sort((a, b) => a - b)
  const median = counts[Math.floor(counts.length / 2)]
  const ceiling = Math.max(median * PAGE_DENSITY_MEDIAN_MULTIPLIER, median + PAGE_DENSITY_MIN_EXTRA)
  const out = []
  for (const [page, count] of [...perPage].sort((a, b) => a[0] - b[0])) {
    if (count <= ceiling) continue
    out.push(finding("page_outlier", "warn", "", "page_entry_count_outlier",
      { entries_on_page: count, median_entries: median, ceiling }, { page }))
  }
  return out
}

// 单条目格级规则：导入与提交路径都只跑这一组，必须便宜。
function runPageRules(ctx, row) {
  // 因果抑制（同格结构损坏时不再重复报集外字符）留到 #178：
  // merged_columns 由 #178/#125 产出，本文件的规则一条都不产它，
  // 现在写抑制逻辑是一段没有触发路径的死代码。
  return [
    ...ruleCharOutOfRepertoire(ctx, row),
    ...ruleConfusables(ctx, row),
    ...ruleCombiningMarks(ctx, row),
    ...ruleReadingFormat(ctx, row),
    ...ruleMissingField(ctx, row)
  ]
}

// 单条目路径用的入口：格级规则 + 挂靠标记。挂哪一条目由调用方给，本函数不猜。
function runEntryRules(ctx, row, pageId) {
  return runPageRules(ctx, row).map((item) => anchored(item, pageId, ANCHOR_ENTRY))
}

// 项目级批处理：逐条格级规则，加上各导入批次的列级与 PDF 页级规则。
//
// entries = [{ pageId, order, pdfPage, row }]：条目归属与行内容**必须一起来**。
// 上一版把 rows / columns / entries 分三个参数传，摊平后 finding 里没有任何条目
// 标识，写入端只能猜挂靠——结果是除 R7 以外的全部疑点都落到项目第一条条目上，
// 别人的原样内容片段就发到了这一条的在手校对员手上（#208 评审阻断 1）。
// 现在本函数负责决定挂靠，返回值每条都带 page(条目 id)，写入端只认这个字段。
// 列由条目现攒，避免「第 i 行对不上第 i 个条目」这类错位还有存在的空间。
//
// 挂靠口径（#176 规定 review_findings.page 必填，所以列级疑点也必须落在某一条上）：
// - 格级/行级(R1/R2/R3格级/R5/R6) → 它所属的条目，scope=entry；
// - 列级(R3列级/R4) → 批次扫描顺序第一条，scope=column_first_entry。列级 params 只有
//   计数与码位标签、不含任何原样内容片段（assist_rules_integration.mjs 钉住了这一点），
//   真正的消费方是管理端批次报告；这条取舍写进 docs/plans/2026-09-25-assist-rules.md；
// - 页级(R7) → 该 PDF 页扫描顺序里的第一个条目，scope=pdf_page_first_entry；
//   解析不出条目就返回 page=""，由写入端跳过并计数，绝不退化成"挂到第一条"。
const ANCHOR_ENTRY = "entry"
const ANCHOR_COLUMN = "column_first_entry"
const ANCHOR_PDF_PAGE = "pdf_page_first_entry"
// 只有**项目级**规则才会产出的 message_key：列级(R3 列级 / R4) 与页级(R7 两个判据)。
// 单条目重算只能重新判定格级规则，所以下线旧批次时必须把这两类一起排除——否则
// "给某一条补算"会顺手抹掉挂在它身上的项目级疑点，而那些只有项目级重算才会重新产出。
// 上一轮我只排除了列级两条、漏了 R7：同一件事在页级上照样成立（#212 的评审抓到这条，
// 并据此判定链上先不许合入）。现在的划分是"格级 / 项目级"两类，
// assist_rules_integration.mjs 断言两者恰好覆盖引擎产出的全部 key 且互不相交，
// 所以新增规则时必须归类，漏归类会在 runProjectRules 里直接抛错。
const CELL_MESSAGE_KEYS = [
  "non_ipa_range_codepoints", "confusable_ascii_in_reading", "combining_marks_present",
  "long_digit_run", "tone_token_count_differs", "required_role_field_empty"
]
const PROJECT_ONLY_MESSAGE_KEYS = BATCH_MESSAGE_KEYS

function producerVersionForRule(messageKey) {
  return messageKey === TONE_COUNT_MESSAGE_KEY || PROJECT_ONLY_MESSAGE_KEYS.includes(messageKey)
    ? RULES_VERSION : LEGACY_RULES_VERSION
}

function anchored(item, pageId, scope, batchId = "") {
  return {
    ...item,
    page: pageId ?? "",
    evidence: { ...(item.evidence ?? {}), anchor: scope, ...(batchId ? { batch: batchId } : {}) }
  }
}

function columnsOf(entries) {
  const columns = Object.create(null)
  for (const entry of entries) {
    for (const [field, value] of Object.entries(entry.row ?? {})) {
      if (!columns[field]) columns[field] = []
      columns[field].push(value)
    }
  }
  return columns
}

function groupBy(entries, keyFor) {
  const groups = new Map()
  for (const entry of entries) {
    const key = keyFor(entry)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }
  return groups.values()
}

function runProjectRules(ctx, entries, reserveFinding = null) {
  const list = entries ?? []
  const out = []
  const append = item => { if (reserveFinding) reserveFinding(item); out.push(item) }
  for (const entry of list) {
    // 项目级只算一次共享上下文，但「这一列在不在当前行里」必须按条判断。
    // 不传 roles 的旧调用仍用共享 ctx，避免把未出现的列并进每一行。
    const entryCtx = Object.prototype.hasOwnProperty.call(entry, "roles")
      ? { ...ctx, roles: entry.roles }
      : ctx
    for (const item of runPageRules(entryCtx, entry.row)) {
      if (!CELL_MESSAGE_KEYS.includes(item.message_key)) {
        // 新增格级规则却没登记进 CELL_MESSAGE_KEYS：不挡就会静默漏掉，而且症状出现在
        // 别处（项目级疑点被单条重算吃掉），所以在这里直接抛错。
        throw new Error(`规则产出 ${item.message_key} 未归类到 CELL/PROJECT_ONLY key 清单`)
      }
      append(anchored(item, entry.pageId, ANCHOR_ENTRY))
    }
  }
  for (const batch of groupBy(list, entry => entry.batchId ? `batch:${entry.batchId}` : `legacy:${entry.fileId || ""}`)) {
    const { pageId, batchId } = batch[0]
    const columns = columnsOf(batch)
    for (const item of [...ruleColumnForms(columns), ...rulePunctuationMix(columns)]) {
      append(anchored(item, pageId, ANCHOR_COLUMN, batchId))
    }
    // A batch can contain entries bound to different PDFs. Their page numbers
    // share no numbering scheme, even when the import job is the same.
    for (const source of groupBy(batch, entry => entry.fileId || "")) {
      const firstOnPage = new Map()
      for (const entry of source) {
        const pdfPage = Number(entry.pdfPage) || 0
        if (!firstOnPage.has(pdfPage)) firstOnPage.set(pdfPage, entry.pageId)
      }
      for (const item of [...rulePageOrderBacktrack(source), ...rulePageDensityOutliers(source)]) {
        append(anchored(item, firstOnPage.get(item.evidence.page), ANCHOR_PDF_PAGE, batchId))
      }
    }
  }
  return out
}

module.exports = {
  RULES_VERSION,
  LEGACY_RULES_VERSION,
  TONE_COUNT_MESSAGE_KEY,
  CONFUSABLE_MESSAGE_KEY,
  producerVersionForRule,
  ADMINISTRATIVE_MESSAGE_KEYS,
  PLACEHOLDER,
  ANCHOR_ENTRY,
  ANCHOR_COLUMN,
  ANCHOR_PDF_PAGE,
  CELL_MESSAGE_KEYS,
  PROJECT_ONLY_MESSAGE_KEYS,
  LEGAL_LONG_TONES,
  READING_FIELDS,
  IPA_FIELDS,
  MEANING_FIELDS,
  REQUIRED_ROLES,
  ALLOWED_RANGES,
  PUNCT_PAIRS,
  PAGE_ORDER_BACKTRACK_TOLERANCE,
  PAGE_DENSITY_MEDIAN_MULTIPLIER,
  PAGE_DENSITY_MIN_EXTRA,
  PAGE_DENSITY_MIN_PAGES,
  codepointLabel,
  literalSpans,
  mergeSpans,
  predicateSpans,
  isEmpty,
  inAllowed,
  isCombining,
  repertoireOf,
  confusablesOf,
  makeContext,
  ruleCharOutOfRepertoire,
  ruleConfusables,
  ruleColumnForms,
  rulePunctuationMix,
  ruleMissingField,
  ruleReadingFormat,
  rulePageOrderBacktrack,
  rulePageDensityOutliers,
  ruleCombiningMarks,
  runPageRules,
  runEntryRules,
  runProjectRules
}
