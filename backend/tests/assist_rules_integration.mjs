import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 规则库是纯函数（不碰 DAO、不 require 别的 lib），所以能在 node 里直接加载做表驱动单测。
const rules = require('../pb_hooks/lib/assist_rules.js')
// 写入侧 lib 也只在函数体内碰 DAO 与 goja 全局，模块本身能在 node 里直接载入，
// 所以游标这种"不需要数据也能证伪"的逻辑可以在不起服务器的这一段钉住。
const writer = require('../pb_hooks/lib/assist_writer.js')
const keyboardDefinition = require('../keyboards/hinghwa-dialect.json')

// ---- 命中区间（evidence.char_offsets）的表驱动断言：不需要起服务 ----
//
// 口径必须与消费端一字不差：码位计、半开区间（frontend/src/lib/fieldHints.js 的
// locateSpan 再把它换算成 UTF-16 选区）。这里钉三件事：
// ① 区间能原样切回被标记的内容（切出来不是那串字符就是偏移了）；
// ② 数码位而不是数 UTF-16（补充平面字符是唯一能把这两者分开的探针）；
// ③ 判据侧已经算出来的位置（R2 的 1-based positions）与新区间互相印证，
//    否则"新字段永远为空"这种退化会一路绿到线上。
const identity = require('../pb_hooks/lib/assist_identity.js')
const spanContext = rules.makeContext({ keyboards: [{ definition: keyboardDefinition }] })

function sliceBySpans(text, [start, end]) {
  return Array.from(String(text)).slice(start, end).join('')
}

function assertWellFormed(label, text, spans) {
  const total = Array.from(String(text)).length
  for (const [start, end] of spans) {
    assert.ok(Number.isInteger(start) && Number.isInteger(end), `${label}: 区间端点必须是整数`)
    assert.ok(start >= 0 && end > start && end <= total,
      `${label}: 区间 [${start},${end}) 越界（共 ${total} 个码位）`)
  }
  for (let i = 0; i + 1 < spans.length; i++) {
    assert.ok(spans[i][1] <= spans[i + 1][0], `${label}: 区间必须互不重叠且按序`)
  }
}

function findOne(row, kind, messageKey) {
  return rules.runPageRules(spanContext, row)
    .find((item) => item.kind === kind && item.message_key === messageKey)
}

// ① + ②：占位符剔除会让下标偏移，补充平面会让码位与 UTF-16 分家。
// 占位符与数字串之间必须留一个分隔符：PLACEHOLDER 是 `@[0-9a-fA-F]{4,6}` 且贪心，
// '@DEAD1234' 会连数字一起吃掉六位十六进制，那样根本不存在长数字串，用例就空了。
const placeholderRow = { 莆田IPA: 'a@DEAD 1234' }
const placeholderHit = findOne(placeholderRow, 'reading_format_invalid', 'long_digit_run')
assert.ok(placeholderHit, `占位符用例应命中 long_digit_run，实得 ${JSON.stringify(placeholderHit)}`)
assert.deepEqual(placeholderHit.evidence.char_offsets, [[7, 11]],
  '区间要回到未剔除占位符的原值上：按剔除后的串算会得出 [[2,6]]，那会把高亮打在 "@DEAD" 上')
assert.equal(sliceBySpans(placeholderRow['莆田IPA'], placeholderHit.evidence.char_offsets[0]), '1234')

const planeRow = { 莆田IPA: '𰻞x9876' }
const planeHit = findOne(planeRow, 'reading_format_invalid', 'long_digit_run')
assert.equal(planeHit.evidence.char_offsets[0][0], 2,
  '𰻞 占 1 个码位但 2 个 UTF-16 单元；这里必须是码位下标 2 而不是 3')
assert.equal(sliceBySpans(planeRow['莆田IPA'], planeHit.evidence.char_offsets[0]), '9876')

const combiningRow = { 拼音: 'a\u0301b' }
const combiningHit = findOne(combiningRow, 'encoding_form_anomaly', 'combining_marks_present')
assert.equal(sliceBySpans(combiningRow['拼音'], combiningHit.evidence.char_offsets[0]), '\u0301')

const repertoireRow = { 释义: '合格\uEE00不合格' }
const repertoireHit = findOne(repertoireRow, 'char_out_of_repertoire', 'non_ipa_range_codepoints')
assert.ok(repertoireHit, '私用区字符应命中 R1')
assert.equal(sliceBySpans(repertoireRow['释义'], repertoireHit.evidence.char_offsets[0]), '\uEE00',
  '区间必须正对着越界字符本身，而不是整格')

// ③：R2 的 1-based positions 与新区间互相印证。
const confusableRow = { 莆田IPA: 'a\u0251a' }
const confusableHit = findOne(confusableRow, 'confusable_substitution', 'confusable_ascii_in_reading')
assert.ok(confusableHit, `键盘里有 ${spanContext.confusables.size} 个可混淆映射，'a' 必须命中 R2`)
const confusableSpans = confusableHit.evidence.char_offsets
assert.ok(confusableSpans.length, '命中了就必须给出区间')
for (const position of confusableHit.params.positions) {
  assert.ok(confusableSpans.some(([start, end]) => position - 1 >= start && position - 1 < end),
    `positions 里的第 ${position} 个字符没有被任何区间覆盖：${JSON.stringify(confusableSpans)}`)
}
assert.deepEqual(confusableSpans, [[0, 1], [2, 3]], '两个 a 各自成一段，\u0251 本身不该被标')

// 空格子没有区间可标：这是刻意为之，必须钉住，否则以后有人误以为漏了实现。
const roleContext = rules.makeContext({ keyboards: [{ definition: keyboardDefinition }], roles: { 词头: 'headword', 释义: 'meaning' } })
const missingHit = rules.runPageRules(roleContext, { 词头: '甲' })
  .find((item) => item.kind === 'missing_field')
assert.ok(missingHit, '标注了 meaning 角色而该列为空，R5 必须命中')
assert.equal(missingHit.evidence.char_offsets, undefined, '空格里没有可标的字符区间')

for (const [label, text, item] of [
  ['long_digit_run', placeholderRow['莆田IPA'], placeholderHit],
  ['combining_marks_present', combiningRow['拼音'], combiningHit]
]) {
  assertWellFormed(label, text, item.evidence.char_offsets)
}

// 身份侧（#178 生产者）：merged_columns 的两类判据都要给区间。
const mergedHeadword = identity.findRowShapeAnomalies({ id: 'p1', row: { 词条: ' 甲、乙丙 ', 释义: 'x' } })
  .find((item) => item.message_key === 'multiple_headwords_in_cell')
assert.ok(mergedHeadword, '两个词头挤在一格应命中 merged_columns')
assert.deepEqual(
  mergedHeadword.evidence.char_offsets.map((span) => sliceBySpans(' 甲、乙丙 ', span)),
  ['甲', '乙丙'], '区间算在未 trim 的原值上，且分隔符不进区间')

const mergedMeaning = identity.findRowShapeAnomalies({ id: 'p2', row: { 词条: '甲', 释义: '解释ŋ32' } })
  .find((item) => item.message_key === 'reading_inside_meaning_row')
assert.ok(mergedMeaning, '释义里混进记音应命中 merged_columns')
assertWellFormed('reading_inside_meaning_row', '解释ŋ32', mergedMeaning.evidence.char_offsets)
assert.equal(mergedMeaning.evidence.char_offsets.map((span) => sliceBySpans('解释ŋ32', span)).join(''), 'ŋ32')

console.log('PASS: 命中区间按码位半开区间产出，占位符与补充平面两种偏移场景都切得回原文')

// ---- 区间基准与读侧复核（#304）：纯函数段，不需要起服务 ----
//
// #293 之后 `ocr_row_json` 可以被管理员随时改写而不触发重算，库里存的 `char_offsets`
// 于是成了旧串的下标。这一段钉读侧判据的边界，重点是**每一格都要能失败**：只写
// 「变了就剥」会让闸门退化成"永远剥区间"，所以该保留的、该剥的、以及剥的理由，分开钉。
const findings = require('../pb_hooks/lib/findings.js')

const faithfulBasis = findings.offsetsBasis('aŋ1234', [[2, 6]])
assert.equal(typeof faithfulBasis.digests[0], 'string', '基准必须是摘要')
assert.notEqual(faithfulBasis.digests[0], '1234',
  '§6 红线：evidence 里不许出现字形序列，摘要必须是不可读的摘要而不是摘录')
assert.notDeepEqual(findings.offsetsBasis('1234aŋ', [[2, 6]]), faithfulBasis,
  '等长移动必须改摘要，否则总长度判据的漏洞原样留着')
assert.deepEqual(findings.offsetsBasis('aŋ', [[5, 9]]), null, '越界区间切出空串：不给基准')
assert.deepEqual(findings.offsetsBasis('', [[0, 1]]), null, '空片段：不给基准')
assert.deepEqual(findings.offsetsBasis('aŋ1234', []), null, '没有区间就没有可盖章的东西')

function probe(evidence, shownRow, field = '莆田IPA') {
  const view = { field, evidence: { ...evidence } }
  return { reason: findings.dropStaleOffsets(view, shownRow), view }
}

const basisOf = (spans) => ({ offsets_basis: faithfulBasis, char_offsets: spans })

// 前提本身要先成立：管理员在数字串**前面**补了一个「9」，旧区间 [2,6) 在新串上切到
// '9123'；而等长改写 `1234aŋ` 切到 '34aŋ'。两种都不越界、不报错，只是标错了地方。
assert.deepEqual(sliceBySpans('aŋ91234', [2, 6]), '9123', '用例前提：前插把区间切到别的字上')
assert.deepEqual(sliceBySpans('1234aŋ', [2, 6]), '34aŋ', '用例前提：等长移动同样切到别的字上')

{
  const faithful = probe(basisOf([[2, 6]]), { 莆田IPA: 'aŋ1234' })
  assert.equal(faithful.reason, '', JSON.stringify(faithful.view))
  assert.deepEqual(faithful.view.evidence.char_offsets, [[2, 6]],
    '基准相符却剥了区间：高亮会凭空全灭')

  // 复审 P2 之一：总码位数相等证明不了命中没动。`aŋ1234` → `1234aŋ` 长度不变，
  // 数字命中已移到 [0,4)，只比长度就会把高亮留在 '34aŋ' 上。
  const sameLengthMoved = probe(basisOf([[2, 6]]), { 莆田IPA: '1234aŋ' })
  assert.equal(sameLengthMoved.reason, 'stale', '等长改写却保留区间：标到了 ' + JSON.stringify(sliceBySpans('1234aŋ', [2, 6])))
  assert.equal(sameLengthMoved.view.evidence.char_offsets, undefined,
    '剥区间必须是真删除，不能留空数组')

  const grown = probe(basisOf([[2, 6]]), { 莆田IPA: 'aŋ91234' })
  assert.equal(grown.reason, 'stale', '串变长却没剥区间：旧下标切到新串上是别的位置')
  assert.equal(sameLengthMoved.view.evidence.offsets_basis, faithfulBasis,
    '只剥区间，基准要留着（重算之外没人再算得出它）')

  // 判据换成片段摘要之后，区间之后的追加**不再误伤**：[2,6) 在新串上仍切到 '1234'，
  // 也就是仍然标在判据命中的那段数字上。旧版按总长度判时会把这种一并剥掉。
  const trailingAppend = probe(basisOf([[2, 6]]), { 莆田IPA: 'aŋ12345' })
  assert.equal(trailingAppend.reason, '', '该保留的被剥了：判据退化成"永远剥区间"')
  assert.deepEqual(sliceBySpans('aŋ12345', [2, 6]), '1234', '被保留的这条确实还切得对')

  const shrunk = probe(basisOf([[2, 6]]), { 莆田IPA: 'aŋ1' })
  assert.equal(shrunk.reason, 'stale', '串变短同样要剥')

  // 复审 P2 之二：没有可验证基准的区间一律保守降级。#293 与本 PR 之间的批次、以及更早
  // 落库的全部批次都在这里——它们在部署后同样会被管理员改写，而库里无从区分。
  const legacy = probe({ char_offsets: [[2, 6]] }, { 莆田IPA: 'aŋ1234' })
  assert.equal(legacy.reason, 'unbaselined', `无基准的批次必须与"原文变了"分开计数：${JSON.stringify(legacy.view)}`)
  assert.equal(legacy.view.evidence.char_offsets, undefined, '无基准 = 剥区间，疑点本身仍在')
  // 本 PR 未合并前那一版盖过整数长度基准，同样按无基准处理（不给它伪装成已验证）。
  const lengthOnly = probe({ char_offsets: [[2, 6]], offsets_basis: 6 }, { 莆田IPA: 'aŋ1234' })
  assert.equal(lengthOnly.reason, 'unbaselined', '旧的整数基准不能算可验证基准')
  // 摘要条数与区间条数不等 = 这份 evidence 不完整，同样不判为忠实。
  assert.equal(probe({ char_offsets: [[2, 6]], offsets_basis: { digests: ['aa', 'bb'] } },
    { 莆田IPA: 'aŋ1234' }).reason, 'unbaselined')

  // 读不到那份串（pages 读失败）⇒ 无法证明忠实，按不忠实处理。
  assert.equal(probe(basisOf([[2, 6]]), null).reason, 'stale',
    '读不到原文却保留区间，等于回到 #304 的症状')
  // 字段整列消失（写回时被换掉列名）⇒ 切出来是空串，与摘要对不上。
  assert.equal(probe(basisOf([[2, 6]]), { 拼音: 'lang2' }).reason, 'stale',
    '该列已经不在原文里，区间无处可标')
  // 本来就没有区间的疑点不进任何计数：否则会把"从没标过"说成"标不了"。
  const noOffsets = probe({ anchor: 'entry' }, { 莆田IPA: 'aŋ12345' })
  assert.equal(noOffsets.reason, '', JSON.stringify(noOffsets.view))
  // 未知原因必须抛，不许静默不计数。
  assert.throws(() => findings.tallyOffsets('whatever', { stale: 0, unbaselined: 0 }))
  assert.deepEqual(findings.tallyOffsets('stale', findings.tallyOffsets('unbaselined',
    { stale: 0, unbaselined: 0 })), { stale: 1, unbaselined: 1 }, '两个计数各归各的')
}

console.log('PASS: 区间基准是片段摘要：等长移动与前插都剥，尾追加保留，无基准另计一笔')

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18091'
const platformEmail = process.env.APP_ADMIN_EMAIL
const platformPassword = process.env.APP_ADMIN_PASSWORD
const superEmail = process.env.PB_SUPER_EMAIL
const superPassword = process.env.PB_SUPER_PASSWORD
if (!platformEmail || !platformPassword || !superEmail || !superPassword) {
  throw new Error('Set APP_ADMIN_EMAIL, APP_ADMIN_PASSWORD, PB_SUPER_EMAIL and PB_SUPER_PASSWORD.')
}

async function request(path, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await response.text()
  let payload = null
  if (raw) { try { payload = JSON.parse(raw) } catch { payload = raw } }
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${raw}`)
  return payload
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'AssistRules123!'
const projectIds = []
const userIds = []
const gateIds = []

const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: platformEmail, password: platformPassword }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: superEmail, password: superPassword }
})

const ctx = rules.makeContext({ keyboards: [{ definition: keyboardDefinition }] })
const keysOf = (findings) => findings.map((item) => item.message_key).sort()

// ===================== 纯函数部分：逐规则 命中 / 不命中 / 边界 =====================

// 先证明混淆表真的从键盘 hint 编译出来了——表空的话 R2 会一条都不报而测试照样"通过"。
assert.ok(ctx.confusables.size >= 2, `confusables table empty: ${[...ctx.confusables.keys()]}`)
assert.ok(ctx.confusables.get('a')?.includes('U+0251'), 'expected a→ɑ from the shipped keyboard')
assert.ok(ctx.repertoire.size > 120, `repertoire too small: ${ctx.repertoire.size}`)

// R1 char_out_of_repertoire
{
  const hit = rules.ruleCharOutOfRepertoire(ctx, { 释义: '甲→乙' })
  assert.deepEqual(keysOf(hit), ['non_ipa_range_codepoints'], JSON.stringify(hit))
  assert.ok(hit[0].params.codepoints.includes('U+2192'), JSON.stringify(hit[0].params))
  assert.equal(hit[0].severity, 'warn')
  assert.deepEqual(rules.ruleCharOutOfRepertoire(ctx, { 莆田IPA: 'ãɒ̃ʔǾ' }), [])
  assert.deepEqual(rules.ruleCharOutOfRepertoire(ctx, { 释义: '' }), [])
  // 边界：启用键盘里的字符即使在放行区段之外也不算集外——∣(U+2223) 属数学符号区。
  assert.ok(!rules.inAllowed(0x2223), 'U+2223 should be outside the allowed ranges')
  assert.ok(ctx.repertoire.has(0x2223), 'U+2223 should be in the shipped keyboard')
  assert.deepEqual(rules.ruleCharOutOfRepertoire(ctx, { 莆田IPA: 'k∣a' }), [])
}

// R2 confusable_substitution
{
  const hit = rules.ruleConfusables(ctx, { 莆田IPA: 'ka55' })
  assert.deepEqual(keysOf(hit), ['confusable_ascii_in_reading'])
  assert.equal(hit[0].params.hit_count, 1)
  assert.deepEqual(hit[0].params.suggestions[0], { found: 'U+0061', suggested: ['U+0251'] })
  // 拼音列用拉丁字母是方案本身规定的，不得报。
  assert.deepEqual(rules.ruleConfusables(ctx, { 拼音: 'ka55' }), [])
  // 用了真正的 ɑ 也不得报。
  assert.deepEqual(rules.ruleConfusables(ctx, { 莆田IPA: 'kɑ55' }), [])
  // 一格里两个 a 只出一条 finding，但列出两个位置。
  const twice = rules.ruleConfusables(ctx, { 仙游IPA: 'pasa' })
  assert.equal(twice.length, 1)
  assert.deepEqual(twice[0].params.positions, [2, 4])
}

// R6 reading_format_invalid
{
  const flat = rules.ruleReadingFormat(ctx, { 莆田IPA: 'ua5333' })
  assert.deepEqual(keysOf(flat), ['long_digit_run'])
  assert.equal(flat[0].severity, 'strong')
  assert.deepEqual(flat[0].params.runs, ['5333'])
  // 合法长调值 533 / 453 不报；单位调号不报。
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 莆田IPA: 'ua533' }), [])
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 莆田IPA: 'oa453' }), [])
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 莆田IPA: 'a2' }), [])
  // 边界：缺字占位符 @20000 带五位数字串，那是登记序号不是压平声调。
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 莆田IPA: 'a@20000' }), [])
  const paired = rules.makeContext({ toneCountFields: ['参照', '本地记音'] })
  for (const row of [
    { 参照: 'ka53', 本地记音: 'ka⁵³' },
    { 参照: 'ka1', 本地记音: 'kʰa55' },
    { 参照: 'ka²¹ a1', 本地记音: 'ka53\tɑ⁵⁵' },
    { 参照: 'ka53 ɑ²¹', 本地记音: 'ka5³' },
    { 参照: 'ka53 ɑ²¹', 本地记音: 'ka53 (见第 23 页)' },
    { 参照: 'ka53 ɑ²¹', 本地记音: 'ka@20000' },
    { 参照: 'ka53 ɑ²¹' }
  ]) assert.deepEqual(rules.ruleReadingFormat(paired, row), [], JSON.stringify(row))
  const mismatch = rules.ruleReadingFormat(paired, { 参照: 'ka53 ɑ²¹', 本地记音: 'kʰa55' })
  assert.deepEqual(keysOf(mismatch), ['tone_token_count_differs'])
  assert.equal(mismatch[0].field, '本地记音')
  assert.deepEqual(mismatch[0].params, { left_field: '参照', right_field: '本地记音', left_count: 2, right_count: 1 })
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 拼音: 'ka1 a2', 莆田IPA: 'kʰa55' }), [])
}

// R3 格级组合符 + 列级编码形式
{
  // NFD 写法（a + U+0303）才带组合符；预合成的 ã (U+00E3) 一个都不带。
  // 这条区分正是 R3 存在的全部理由，所以两种写法都要断言，不能只测一边。
  const marks = rules.ruleCombiningMarks(ctx, { 莆田IPA: 'a\u0303' })
  assert.deepEqual(keysOf(marks), ['combining_marks_present'])
  assert.equal(marks[0].severity, 'info')
  assert.deepEqual(marks[0].params.marks, ['U+0303'])
  assert.deepEqual(rules.ruleCombiningMarks(ctx, { 莆田IPA: '\u00e3' }), [])
  assert.deepEqual(rules.ruleCombiningMarks(ctx, { 莆田IPA: 'ka' }), [])
  assert.deepEqual(rules.ruleCombiningMarks(ctx, { 释义: 'a\u0303' }), [])
  // 只有真正带「形式之差」的值才算数：'ka' 既属 NFC 又属 NFD，是形式中性的，
  // 不能拿它充当 NFC 样本（否则整列中性值也会被误判成一种形式）。
  const nfc = '\u00e3'                  // 预合成 ã
  const nfd = '\u0061\u0303'           // a + 组合鼻化符
  assert.notEqual(nfc, nfd)
  const mixed = rules.ruleColumnForms({ 仙游IPA: [nfc, nfd, nfd, nfd] })
  assert.deepEqual(keysOf(mixed), ['mixed_normalization_forms'])
  assert.equal(mixed[0].params.minority, 'nfc')
  assert.deepEqual(mixed[0].params.nfc, 1)
  assert.deepEqual(mixed[0].params.nfd, 3)
  // 全列同形不报。
  assert.deepEqual(rules.ruleColumnForms({ 仙游IPA: [nfc, nfc] }), [])
  // 中性值 + 单一形式也不报：只有两种形式真的并存才算异常。
  assert.deepEqual(rules.ruleColumnForms({ 仙游IPA: ['ka', nfd, nfd] }), [])
}

// R4 punctuation_mix
{
  const mixed = rules.rulePunctuationMix({ 释义: ['甲（乙）', '丙(丁)'] })
  assert.deepEqual(keysOf(mixed), ['punctuation_width_mixed_in_column'])
  assert.deepEqual(mixed[0].params.pairs[0], { full: 'U+FF08', half: 'U+0028' })
  assert.deepEqual(rules.rulePunctuationMix({ 释义: ['甲（乙）', '丙（丁）'] }), [])
}

// R5 missing_field：无角色必须安全跳过（#170 未落地时的真实状态）
{
  assert.deepEqual(rules.ruleMissingField(ctx, { 词条: '甲', 释义: '' }), [])
  assert.deepEqual(rules.ruleMissingField(rules.makeContext({ roles: {} }), { 词条: '甲' }), [])
  const roleCtx = rules.makeContext({ roles: { 词条: 'headword', 释义: 'meaning', 拼音: 'reading' } })
  const hit = rules.ruleMissingField(roleCtx, { 词条: '甲', 释义: '', 拼音: 'ka1' })
  assert.deepEqual(keysOf(hit), ['required_role_field_empty'])
  assert.equal(hit[0].field, '释义')
  assert.equal(hit[0].severity, 'strong')
  // 非必填角色（region）空着不报。
  assert.deepEqual(rules.ruleMissingField(rules.makeContext({ roles: { 地区: 'region' } }), { 地区: '' }), [])
}

// R7 page_outlier：两个判据各自的阈值都要先达标才报
{
  const monotonic = Array.from({ length: 30 }, (_, i) => ({ order: i + 1, pdfPage: Math.ceil((i + 1) / 2) }))
  assert.deepEqual(rules.rulePageOrderBacktrack(monotonic), [])
  const back = rules.rulePageOrderBacktrack([
    { order: 1, pdfPage: 40 }, { order: 2, pdfPage: 12 }
  ])
  assert.deepEqual(keysOf(back), ['pdf_page_backtrack'])
  assert.equal(back[0].params.backtrack, 28)
  const reset = [26, 2, 2, 3, 4].map((pdfPage, order) => ({ order, pdfPage }))
  assert.equal(rules.rulePageOrderBacktrack(reset).length, 1, '一次回退只记一次')
  // 容差内（回退 1 页）不报——这是 R7 的边界，不是实现细节。
  assert.deepEqual(rules.rulePageOrderBacktrack([{ order: 1, pdfPage: 12 }, { order: 2, pdfPage: 11 }]), [])
  // 样本不足 20 页时密度判据必须沉默，不给假数字。
  const thin = Array.from({ length: 10 }, (_, i) => ({ order: i + 1, pdfPage: 1 }))
  assert.deepEqual(rules.rulePageDensityOutliers(thin), [])
  const dense = []
  for (let page = 1; page <= 24; page += 1) {
    const count = page === 7 ? 30 : 6
    for (let i = 0; i < count; i += 1) dense.push({ order: dense.length + 1, pdfPage: page })
  }
  const outliers = rules.rulePageDensityOutliers(dense)
  assert.deepEqual(keysOf(outliers), ['page_entry_count_outlier'])
  assert.equal(outliers[0].params.entries_on_page, 30)
  assert.equal(outliers[0].params.median_entries, 6)
  assert.deepEqual(rules.rulePageDensityOutliers(
    Array.from({ length: 144 }, (_, i) => ({ order: i + 1, pdfPage: Math.floor(i / 6) + 1 }))), [])
}

// runProjectRules 的挂靠：每条返回值都必须带着**它自己那条目**的 id。
// 上一版签名是 (ctx, rows, columns, entries)，摊平后 finding 里没有任何条目标识，
// 写入端只能一律挂到项目第一条上——于是第 2 条的原样内容片段发给了第 1 条的校对员，
// 而第 2、3 条自己的 hints 变成空（#208 评审阻断 1）。这段不起服务器就能钉住那个形状：
// 只要挂靠再塌回第一条，P1 的空断言与 P2/P3 的等值断言会同时红。
{
  const nfc = 'tʰĩ1'                      // 预合成 ĩ：NFC 样本
  const nfd = 'thin\u0301'                // n + 组合锐音符：同列的 NFD 样本
  const entries = [
    { pageId: 'P1', order: 1, pdfPage: 10, row: { 词条: '天', 拼音: 'thin1', 莆田IPA: nfc, 释义: '天空（京）' } },
    { pageId: 'P2', order: 2, pdfPage: 30, row: { 词条: '甲', 拼音: 'ka1', 莆田IPA: nfd, 释义: '第一(个)' } },
    { pageId: 'P3', order: 3, pdfPage: 12, row: { 词条: '鸭', 拼音: 'ah7', 莆田IPA: 'kaʔ7', 释义: '家禽' } }
  ]
  const out = rules.runProjectRules(ctx, entries)
  assert.ok(out.length > 0, 'fixture must actually produce findings')
  const anchors = [rules.ANCHOR_ENTRY, rules.ANCHOR_COLUMN, rules.ANCHOR_PDF_PAGE]
  for (const item of out) {
    assert.ok(anchors.includes(item.evidence.anchor), JSON.stringify(item.evidence))
    assert.ok(entries.some((entry) => entry.pageId === item.page),
      `finding 挂到了不存在的条目：${JSON.stringify({ m: item.message_key, page: item.page })}`)
  }
  // 逐条规则必须各归各条目：期望值由 runPageRules 现算，不在测试里另写一套。
  const rowScoped = (pageId) => keysOf(out.filter((item) =>
    item.page === pageId && item.evidence.anchor === rules.ANCHOR_ENTRY))
  for (const entry of entries) {
    assert.deepEqual(rowScoped(entry.pageId), keysOf(rules.runPageRules(ctx, entry.row)),
      `row findings of ${entry.pageId}`)
  }
  // 列级与页级疑点的挂靠口径（docs/plans/2026-09-25-assist-rules.md §挂靠）：
  // 列级挂扫描顺序第一条并带 anchor 标记；R7 挂该 PDF 页的第一个条目。
  const columnItems = out.filter((item) => item.evidence.anchor === rules.ANCHOR_COLUMN)
  assert.deepEqual(columnItems.map((item) => item.message_key).sort(),
    ['mixed_normalization_forms', 'punctuation_width_mixed_in_column'],
    JSON.stringify(columnItems.map((item) => item.message_key)))
  // 单条重算靠 PROJECT_ONLY_MESSAGE_KEYS 排除项目级疑点，所以"非格级 anchor 的 key"
  // 必须恰好等于它，而"格级 anchor 的 key"必须恰好等于 CELL_MESSAGE_KEYS：
  // 两份清单要正好划分引擎产出的全部 key，新增规则漏归类就在这里红。
  const anchoredKeys = (scope) => [...new Set(out.filter((item) =>
    item.evidence.anchor === scope).map((item) => item.message_key))].sort()
  // 分类守卫以**源码产出的 key 集合**为基准，不拿"这份 fixture 触发到什么"当基准：
  // 三条目的 fixture 触发不了 page_entry_count_outlier（密度判据要 ≥20 页），
  // 用观测集合做基准会把"没触发"误判成"清单错了"，也会让漏归类的 key 蒙混过去。
  const rulesSource = readFileSync(new URL('../pb_hooks/lib/assist_rules.js', import.meta.url), 'utf8')
  const emittedKeys = [...new Set([...rulesSource.matchAll(
    /finding\(\s*"[a-z_]+"\s*,\s*"[a-z]+"\s*,[^,]+,\s*"([a-z_]+)"/g)].map((m) => m[1]))].sort()
  assert.ok(emittedKeys.length >= 9, `从源码抽出的 key 太少，先怀疑正则：${JSON.stringify(emittedKeys)}`)
  assert.deepEqual(emittedKeys,
    [...new Set([...rules.CELL_MESSAGE_KEYS, ...rules.PROJECT_ONLY_MESSAGE_KEYS])].sort(),
    '引擎产出的 key 必须被格级/项目级两份清单恰好划分，既不能漏也不能多')
  assert.deepEqual(rules.CELL_MESSAGE_KEYS.filter((key) => rules.PROJECT_ONLY_MESSAGE_KEYS.includes(key)), [],
    '两份清单不得重叠')
  // 挂靠方向只断言子集：观测到的 key 必须落在它该落的那份清单里。
  for (const scope of [rules.ANCHOR_COLUMN, rules.ANCHOR_PDF_PAGE]) {
    for (const key of anchoredKeys(scope)) {
      assert.ok(rules.PROJECT_ONLY_MESSAGE_KEYS.includes(key), `${scope} 挂靠的 ${key} 不在项目级清单里`)
    }
  }
  for (const key of anchoredKeys(rules.ANCHOR_ENTRY)) {
    assert.ok(rules.CELL_MESSAGE_KEYS.includes(key), `格级挂靠的 ${key} 不在 CELL 清单里`)
  }
  // 反向也要有：两份清单里若出现源码根本不产的 key（改名/删规则后的残留），必须红。
  for (const key of [...rules.CELL_MESSAGE_KEYS, ...rules.PROJECT_ONLY_MESSAGE_KEYS]) {
    assert.ok(emittedKeys.includes(key), `清单里的 ${key} 已不是引擎产出的 key`)
  }
  // 漏归类在 runProjectRules 里直接抛错，这一段证明确实会抛（不抛就是静默少一条排除项，
  // 症状出现在别处：项目级疑点被单条重算吃掉）。导出的数组与模块内是同一个对象，所以
  // 这里临时摘掉一项就能复现"新增规则忘了登记"，测完必须放回。
  const digitRow = { 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ua5333', 释义: '第一（个）' }
  assert.ok(rules.runPageRules(ctx, digitRow).some((item) => item.message_key === 'long_digit_run'),
    '样本行必须真的产 long_digit_run，否则下面这段是空转')
  const cellKeys = rules.CELL_MESSAGE_KEYS
  const registeredAt = cellKeys.indexOf('long_digit_run')
  const removed = cellKeys.splice(registeredAt, 1)
  assert.deepEqual(removed, ['long_digit_run'], 'CELL 清单里应当有 long_digit_run')
  try {
    assert.throws(() => rules.runProjectRules(ctx, [{ pageId: 'P1', order: 1, pdfPage: 1, row: digitRow }]),
      /未归类/, '未归类的格级 key 必须让 runProjectRules 抛错')
  } finally {
    cellKeys.splice(registeredAt, 0, ...removed)
  }
  assert.deepEqual(cellKeys[registeredAt], 'long_digit_run', '这段守卫自己不许把清单改坏')
  for (const item of columnItems) {
    assert.equal(item.page, 'P1', '列级疑点必须挂在第一条目上')
    // 列级 params 只允许计数与码位标签：它挂在无辜的条目上，绝不能带原样内容片段。
    assert.deepEqual(Object.keys(item.params).sort(),
      item.message_key === 'mixed_normalization_forms' ? ['minority', 'nfc', 'nfd'] : ['pair_count', 'pairs'],
      JSON.stringify(item.params))
    for (const value of Object.values(item.params)) {
      assert.doesNotMatch(JSON.stringify(value), /[^\x20-\x7e]/,
        `列级 params 混进了非 ASCII 字符（原样内容片段）：${JSON.stringify(value)}`)
    }
    // 直接钉住 #175 红线 1 的形状：任何条目的原样单元格内容都不许出现在 params 里。
    for (const entry of entries) {
      for (const value of Object.values(entry.row)) {
        if (!value || /^[\x20-\x7e]*$/.test(value)) continue
        assert.ok(!JSON.stringify(item.params).includes(String(value)),
          `params 泄漏了 ${entry.pageId} 的原样内容：${item.message_key}`)
      }
    }
  }
  const backtracked = out.filter((item) => item.message_key === 'pdf_page_backtrack')
  assert.equal(backtracked.length, 1, JSON.stringify(out.map((item) => item.message_key)))
  assert.equal(backtracked[0].page, 'P3', 'R7 疑点要挂在回退到的那一页（P3 的 pdf_page=12）上')
  assert.equal(backtracked[0].evidence.anchor, rules.ANCHOR_PDF_PAGE)
  assert.equal(backtracked[0].evidence.page, 12, 'evidence.page 仍然是 PDF 页号')
}

// 下线旧批次也必须一块接一块读完。一次读满上限就停是 #208 评审阻断 2 的镜像形状：
// 没被下线的行会永远以「当前批次」的身份留在库里，也就是旧疑点再也撤不下来。
// 上限在本项目的口径下是可及的（保险丝允许 5 万条目，实测 10k 条目产 2.9 万条疑点），
// 所以这不是假想场景。fake dao 在这里模拟 SQL 语义：结果集只含尚未下线的行、
// offset 越过的是本轮决定保留的那些行。
{
  const mkRecord = (id, stamp) => ({
    id,
    superseded: '',
    set(key, value) { if (key === 'superseded_at') this.superseded = String(value) },
    getString(key) { return key === 'produced_at' ? stamp : '' }
  })
  const run = (count, stampOf) => {
    const records = Array.from({ length: count }, (_, i) => mkRecord(`r${i}`, stampOf(i)))
    let reads = 0
    let writes = 0
    const dao = {
      findRecordsByFilter: (collection, filter, sort, limit, offset) => {
        reads += 1
        const current = records.filter((record) => record.superseded === '')
        return current.slice(offset, offset + limit)
      },
      save: () => { writes += 1 }
    }
    return { records, dao, stats: () => ({ reads, writes }) }
  }

  const all = run(5, () => '2026-09-25 00:00:00.001Z')
  const retiredAll = writer.retire(all.dao, null, ['producer = "rule"'], () => true, 'STAMP', { chunk: 2 })
  assert.equal(retiredAll, 5, `五份当前批次必须全部下线，实际 ${retiredAll}`)
  assert.deepEqual(all.records.filter((record) => record.superseded === '').map((record) => record.id), [],
    '不得有行留在当前批次里')
  assert.ok(all.stats().reads >= 3, `chunk=2 时至少要读三块，只读一块就是原来的静默截断：${JSON.stringify(all.stats())}`)
  assert.equal(all.stats().writes, 5, '每行只写一次')

  // 保留最新一批的那条（settleBatch 的形状）：offset 必须按"保留数"前进，否则死循环或漏行。
  const mixed = run(5, (i) => `2026-09-25 00:00:00.00${i}Z`)
  const retiredOld = writer.retire(mixed.dao, null, ['producer = "rule"'],
    (record) => record.getString('produced_at') < '2026-09-25 00:00:00.004Z', 'STAMP', { chunk: 2 })
  assert.equal(retiredOld, 4, `只该下线比它更早的四批：${retiredOld}`)
  assert.equal(mixed.records[4].superseded, '', '最新一批必须留着')
  assert.deepEqual(mixed.records.filter((record) => record.superseded === '').map((record) => record.id), ['r4'])
  assert.ok(mixed.stats().reads < 10, `读取轮数失控（疑似死循环）：${JSON.stringify(mixed.stats())}`)

  // 空作用域：一轮就返回，不做无谓的第二次读。
  const none = run(0, () => 'x')
  assert.equal(writer.retire(none.dao, null, [], () => true, 'STAMP', { chunk: 2 }), 0)
  assert.equal(none.stats().reads, 1)
}

// 全量重算的条目游标：必须翻完整批，超限必须在**任何写入之前**退出。
// 上一版是 PAGE_SCAN_CAP = 5000 的一次性读取 + 按 project 全量下线，第 5001 条往后的
// 当前批次被标 superseded 却没有新批次替换，那些条目从此永久读不到疑点（#208 评审阻断 2）。
{
  const total = 7
  const all = Array.from({ length: total }, (_, i) => ({ id: `pg${i}` }))
  const dao = {
    findRecordsByFilter: (collection, filter, sort, limit, offset) =>
      collection === 'pages' ? all.slice(offset, offset + limit) : (() => { throw new Error(`unexpected ${collection}`) })()
  }
  assert.deepEqual(writer.loadAllPages(dao, 'proj', { chunk: 3 }).map((page) => page.id),
    all.map((page) => page.id), '游标必须按同一顺序翻完全部条目')
  assert.deepEqual(writer.loadAllPages(dao, 'proj', { chunk: total }).map((page) => page.id),
    all.map((page) => page.id), '整批一次读完时也不能漏条目')
  assert.deepEqual(writer.loadAllPages(dao, 'proj', { chunk: 1 }).map((page) => page.id),
    all.map((page) => page.id), 'chunk=1 是游标最容易露馅的形状')
  assert.throws(() => writer.loadAllPages(dao, 'proj', { chunk: 3, refusal: 4 }), /保险丝/)
  assert.ok(writer.PROJECT_SCAN_REFUSAL >= 10000,
    `保险丝必须容得下 #178 验收的 10k 行项目：${writer.PROJECT_SCAN_REFUSAL}`)
  // 保险丝还得真的"约束内存"，不能只是"最后拒算"：数一数抛错之前 dao 交出了多少行。
  // 上面那条 /保险丝/ 断言在"读全再判"的实现下同样会绿——它测的是会不会拒算，
  // 掉的是拒算前读了多少行，而那正是唯一会变的一维（#212 复审阻断）。
  const counted = (total) => {
    const handed = { rows: 0 }
    const rows = Array.from({ length: total }, (_, i) => ({ id: `q${i}` }))
    return {
      handed,
      dao: {
        findRecordsByFilter: (collection, filter, sort, limit, offset) => {
          const slice = collection === 'pages' ? rows.slice(offset, offset + limit) : []
          handed.rows += slice.length
          return slice
        }
      }
    }
  }
  const oversize = counted(20)
  assert.throws(() => writer.loadAllPages(oversize.dao, 'proj', { chunk: 3, refusal: 4 }), /保险丝/)
  assert.ok(oversize.handed.rows <= 4 + 3,
    `拒算前已读出 ${oversize.handed.rows} 行，保险丝没约束住内存（上限应是 refusal + chunk）`)
  // 计数器自己也必须被证明在数：同一份 dao 读全时恰好 20 行，否则上面那条是恒真的。
  const readWhole = counted(20)
  assert.equal(writer.loadAllPages(readWhole.dao, 'proj', { chunk: 3, refusal: 999 }).length, 20)
  assert.equal(readWhole.handed.rows, 20, `计数器没数到真实读取行数：${readWhole.handed.rows}`)
  // 「超限不会写坏数据」靠的是代码顺序：扫描必须先于第一次写。读源码钉住这个顺序，
  // 因为把 supersede 挪到扫描之前以后，任何黑盒断言都要先造出 5 万条目才看得见。
  const writerSource = readFileSync(new URL('../pb_hooks/lib/assist_writer.js', import.meta.url), 'utf8')
  const start = writerSource.indexOf('function recomputeProjectBatch(')
  assert.ok(start >= 0, 'assist_writer.js 里找不到 recomputeProject')
  const projectBody = writerSource.slice(start, writerSource.indexOf('\n}\n', start))
  const scanAt = projectBody.indexOf('loadAllPages(dao, projectId, { budgeted: true })')
  assert.ok(scanAt >= 0, 'recomputeProject 必须用有界分批游标读条目，不能有硬上限')
  assert.ok(!/\b(?:supersede|insertFinding)\(/.test(projectBody), 'prepare 不得直接发布或退役结果')
  const publisher = readFileSync(new URL('../pb_hooks/lib/assist_publication.js', import.meta.url), 'utf8')
  assert.ok(publisher.indexOf('const prepared = prepare(dao, publication.id)') < publisher.indexOf('for (const [items, save, phase]'),
    '完整有界准备必须先于第一块真实finding/event保存；真实故障回滚另由Go/PB用例验证')
}

// 已知取舍（不是 bug，但必须写下来）：R1 的放行集合是「启用键盘字符 ∪ 固定区段」，
// 而 IPA 调号字母 U+02E5..U+02E9（˥˦˧˨˩）既不在莆仙键盘里、也不在放行区段里。
// 莆仙三套方案用数字标调，所以今天这是正确行为；一旦项目改用调号字母记音，
// R1 会把每一条都报成集外字符——届时改的是这里的区段，不是去关掉规则。
{
  const toneLetter = rules.ruleCharOutOfRepertoire(ctx, { 莆田IPA: 'la\u02e5' })
  assert.deepEqual(keysOf(toneLetter), ['non_ipa_range_codepoints'])
  assert.deepEqual(toneLetter[0].params.codepoints, ['U+02E5'])
}

// 反向用例：一批"正常莆仙条目"（含鼻化 ɒ̃、Ǿ、ʔ、数字调号、合法占位符）
// 不得产生任何 R1/R2 命中——#177 的验收要求，误报数在下面量化打印。
{
  const normal = [
    { 词条: '人', 拼音: 'lang2', 莆田IPA: 'lɑŋ2', 仙游IPA: 'lyŋ2', 释义: '人类' },
    { 词条: '天', 拼音: 'thin1', 莆田IPA: 'tʰĩ1', 仙游IPA: 'tʰĩ1', 释义: '天空' },
    // 低元音在莆仙 IPA 里写作 ɑ（U+0251），这正是键盘 hint 存在的原因；
    // 用 ASCII a 会被 R2 命中，那是命中不是误报。
    { 词条: '鸭', 拼音: 'ah7', 莆田IPA: 'ɑʔ7', 仙游IPA: 'ɑʔ7', 释义: '家禽' },
    { 词条: '火', 拼音: 'he2', 莆田IPA: 'hɔ̃53', 仙游IPA: 'he53', 释义: '火焰' },
    { 词条: '雨', 拼音: 'hy3', 莆田IPA: 'hy21', 仙游IPA: 'hɔ̃21', 释义: '降水' },
    { 词条: '黄', 拼音: 'huang2', 莆田IPA: 'huɑŋ533', 仙游IPA: 'hɔŋ533', 释义: '颜色', 备注: '@20000' },
    { 词条: '四', 拼音: 'si4', 莆田IPA: 'sɨ453', 仙游IPA: 'sɨ453', 释义: '数目' },
    // #177 验收点名的三个字符：ɒ̃（组合鼻化）、Ǿ、ʔ。
    { 词条: '花', 拼音: 'ue1', 莆田IPA: 'huɒ̃533', 仙游IPA: 'huǾ533', 释义: '植物', 备注: '带ʔ尾' }
  ]
  const flagged = []
  for (const row of normal) {
    flagged.push(...rules.ruleCharOutOfRepertoire(ctx, row), ...rules.ruleConfusables(ctx, row))
  }
  console.log(`ASSIST_FP_RATE ${JSON.stringify({
    normal_rows: normal.length,
    r1_r2_findings: flagged.length,
    keys: keysOf(flagged)
  })}`)
  assert.deepEqual(flagged, [], `false positives on normal entries: ${JSON.stringify(flagged)}`)
}

console.log('PASS: assist rules unit matrix')

// ===================== 服务端部分：写入、门控联动、只标同生产者、耗时 =====================

async function createUser(label) {
  const email = `${label}-${suffix}@example.com`
  const user = await request('/api/collections/users/records', {
    method: 'POST', token: superAuth.token, body: { email, password, passwordConfirm: password, name: label, role: 'user' }
  })
  userIds.push(user.id)
  const auth = await request('/api/collections/users/auth-with-password', { method: 'POST', body: { identity: email, password } })
  return { ...user, token: auth.token }
}

async function createProject(name, proofreaders, managers = []) {
  const project = await request('/api/fangji/projects', {
    method: 'POST', token: platformAuth.token, expected: 201, body: { name: `${name} ${suffix}` }
  })
  projectIds.push(project.id)
  for (const user of proofreaders) {
    await request(`/api/fangji/projects/${project.id}/members/${user.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'proofreader' } })
  }
  for (const user of managers) {
    await request(`/api/fangji/projects/${project.id}/members/${user.id}`, { method: 'PUT', token: platformAuth.token, body: { role: 'manager' } })
  }
  return project
}

async function createPage(projectId, pageNumber, row) {
  return request('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token,
    body: {
      project: projectId, page_number: pageNumber, pdf_page: pageNumber,
      ocr_row_json: JSON.stringify(row), ocr_text: Object.values(row).join(' '),
      proofread_round: 1, mismatch_count: 0, status: 'pending'
    }
  })
}

async function setGate({ kind, messageKey, gate, version = rules.producerVersionForRule(messageKey) }) {
  const row = await request('/api/collections/assist_rule_gates/records', {
    method: 'POST', token: superAuth.token,
    body: { producer: 'rule', producer_version: version, kind, message_key: messageKey, gate, sample_n: 200, precision_hat: 0.95 }
  })
  gateIds.push(row.id)
  return row
}

const worker = await createUser('assist-worker')
const boss = await createUser('assist-manager')

try {
  const project = await createProject('Assist rules', [worker], [boss])
  // 行数据先命名，期望值由**纯函数**算出：写入路径必须忠实持久化规则输出，
  // 不许在断言里另写一套"我以为规则会报什么"。
  const trappedRow = { 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ua5333', 仙游IPA: 'ka', 释义: '第一（个）测试' }
  const cleanRow = { 词条: '天', 拼音: 'thin1', 莆田IPA: 'tʰĩ1', 仙游IPA: 'tʰĩ1', 释义: '天空' }
  // 三行里必须有**非首条目**也产疑点，否则"其他条目为空"的断言恒真：上一版只有第 1 页
  // 产疑点，于是全项目疑点塌到第一条目上也照样全绿（#208 评审阻断 1 + 测试恒真那条）。
  // paged 行带四样：压平声调(格级 strong，数字串 9999 与 trapped 的 5333 可区分)、
  // NFD 写法(与 clean 的预合成 ĩ 构成列级 R3 的两种形式)、半角括号(与 trapped 的全角构成列级 R4)。
  const pagedRow = { 词条: '人', 拼音: 'lang2', 莆田IPA: 'kʰi\u03032', 仙游IPA: 'zuin9999', 释义: '人类(智人)' }
  const trapped = await createPage(project.id, 1, trappedRow)
  const clean = await createPage(project.id, 2, cleanRow)
  const paged = await createPage(project.id, 3, pagedRow)
  // 第 4 条刻意把 pdf_page 回退到 1：这会触发 R7 的 pdf_page_backtrack，并按挂靠口径
  // 挂在"该 PDF 页的第一个条目"= trapped 上。目的不是测 R7 本身（纯函数段测过），
  // 而是让"单条目重算会不会吃掉挂在 trapped 上的项目级疑点"在 API 层可观测——
  // 上一轮我只排除了列级两条，R7 照样被吃掉（#212 的评审抓到这条）。
  // 三列记音照抄 cleanRow：R2 的混淆表把 IPA 列里的 'a' 当成 ɑ，随手写个 'sai1' 就会
  // 给这条多出两格疑点，"它自己没有格级疑点"这个前提就没了。
  const backRow = { 词条: '山', 拼音: 'thin1', 莆田IPA: 'tʰĩ1', 仙游IPA: 'tʰĩ1', 释义: '山峰' }
  const backPage = await request('/api/collections/pages/records', {
    method: 'POST', token: superAuth.token,
    body: {
      project: project.id, page_number: 4, pdf_page: 1, ocr_row_json: JSON.stringify(backRow),
      ocr_text: Object.values(backRow).join(' '), proofread_round: 1, mismatch_count: 0, status: 'pending'
    }
  })
  const expectedFor = (row) => rules.runPageRules(ctx, row)
    .map((item) => `${item.kind}/${item.message_key}`).sort()
  assert.ok(expectedFor(trappedRow).length >= 4, 'trapped row must exercise several rules')
  assert.ok(expectedFor(pagedRow).length >= 1, 'non-first entry must produce its own findings')
  assert.deepEqual(expectedFor(cleanRow), [], 'clean row must be silent for the comparison to mean anything')
  // 第 4 条也要求"格级全静"，否则"R7 只挂在第一条上"这条断言会被它自己的格级疑点混脏。
  assert.deepEqual(expectedFor(backRow), [], 'backtracking row must be cell-silent')
  assert.deepEqual(expectedFor(trappedRow).filter((key) => key.endsWith('long_digit_run')),
    ['reading_format_invalid/long_digit_run'])
  assert.notDeepEqual(JSON.stringify(expectedFor(trappedRow)), JSON.stringify(expectedFor(pagedRow)),
    '两行的疑点集合必须可区分，否则挂错条目也测不出来')

  const recompute = await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: boss.token })
  await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: worker.token, expected: 403 })
  assert.deepEqual({
    pages: recompute.pages, unanchored: recompute.unanchored,
    superseded: recompute.superseded, settled: recompute.settled
  }, { pages: 4, unanchored: 0, superseded: 0, settled: 0 },
  '首次全量重算：扫完 4 条、无挂靠失败、无旧批次可下线或收尾')
  const managerView = await request(`/api/fangji/projects/${project.id}/findings`, { token: boss.token })
  const keyOf = (item) => `${item.kind}/${item.message.key}`
  const anchorOf = (item) => item.evidence?.anchor ?? ''
  const onEntry = (pageId) => managerView.items.filter((item) =>
    item.page === pageId && anchorOf(item) === rules.ANCHOR_ENTRY).map(keyOf).sort()
  // 逐条疑点各归各条目。这三条断言一起才叫可证伪：挂靠塌回第一条时，trapped 会多出
  // paged 的那份、paged 变空、clean 仍然空——前两条就会红。
  assert.deepEqual(onEntry(trapped.id), expectedFor(trappedRow), JSON.stringify(onEntry(trapped.id)))
  assert.deepEqual(onEntry(paged.id), expectedFor(pagedRow), JSON.stringify(onEntry(paged.id)))
  assert.deepEqual(onEntry(clean.id), [], `clean entry flagged: ${JSON.stringify(onEntry(clean.id))}`)
  const trappedKeys = onEntry(trapped.id)
  assert.ok(trappedKeys.includes('reading_format_invalid/long_digit_run'), JSON.stringify(trappedKeys))
  assert.ok(trappedKeys.includes('confusable_substitution/confusable_ascii_in_reading'), JSON.stringify(trappedKeys))
  assert.ok(trappedKeys.includes('char_out_of_repertoire/non_ipa_range_codepoints'), JSON.stringify(trappedKeys))
  // 区间必须真的穿过 重算 → 入库 → 接口 这条路径，而不只是纯函数的返回值：
  // 上面那些深断言即便全跑在 node 里也证明不了 evidence_json 落库时没被丢掉或改写。
  const spannedItems = managerView.items.filter((item) =>
    item.page === trapped.id && anchorOf(item) === rules.ANCHOR_ENTRY && Array.isArray(item.evidence?.char_offsets))
  assert.deepEqual([...new Set(spannedItems.map(keyOf))].sort(), [
    'char_out_of_repertoire/non_ipa_range_codepoints',
    'confusable_substitution/confusable_ascii_in_reading',
    'reading_format_invalid/long_digit_run',
  ], `三条格级疑点都该带着区间回到接口上：${JSON.stringify(spannedItems.map((i) => [keyOf(i), i.evidence]))}`)
  // 两类判据各产两条（莆田IPA 与 仙游IPA 都含可混淆的 a），条数也要钉住：
  // 只比去重后的种类会让"某一条丢了区间"这件事静默通过。
  assert.equal(spannedItems.length, 4, JSON.stringify(spannedItems.map(keyOf)))
  for (const item of spannedItems) {
    const text = trappedRow[item.field]
    assert.equal(typeof text, 'string', `${keyOf(item)} 的字段 ${item.field} 不在原行里`)
    for (const span of item.evidence.char_offsets) {
      assertWellFormed(keyOf(item), text, [span])
      // 切出来必须是非空实义内容：标到空白上说明下标错位，而这在高亮里看不出来。
      assert.ok(sliceBySpans(text, span).trim().length > 0,
        `${keyOf(item)} 在 ${item.field} 的 ${JSON.stringify(span)} 切出空白：${JSON.stringify(text)}`)
    }
  }
  // 干净条目一条都不该有——包括 info 级与列级挂靠，否则"零信号条目"这个前提就不成立了。
  assert.deepEqual(managerView.items.filter((item) => item.page === clean.id), [],
    `clean entry flagged: ${JSON.stringify(managerView.items.filter((item) => item.page === clean.id))}`)
  // 列级疑点的挂靠口径：只能落在扫描顺序第一条上（#176 规定 page 必填）。
  const columnItems = managerView.items.filter((item) => anchorOf(item) === rules.ANCHOR_COLUMN)
  assert.deepEqual(columnItems.map(keyOf).sort(),
    ['encoding_form_anomaly/mixed_normalization_forms', 'punctuation_mix/punctuation_width_mixed_in_column'],
    JSON.stringify(columnItems.map(keyOf)))
  for (const item of columnItems) {
    assert.equal(item.page, trapped.id, '列级疑点必须且只能挂在第一条目上')
  }
  assert.equal(managerView.items.filter((item) =>
    item.page !== trapped.id && anchorOf(item) === rules.ANCHOR_COLUMN).length, 0,
    '列级疑点只许出现在挂靠的那一条目上')
  assert.deepEqual(managerView.items.filter((item) =>
    ![rules.ANCHOR_ENTRY, rules.ANCHOR_COLUMN, rules.ANCHOR_PDF_PAGE].includes(anchorOf(item))), [],
    '每条落库的疑点都必须带挂靠口径')
  // #175 红线 1 的形状：任何一条疑点的 params 都不许带上别的条目的原样内容。
  const rowJson = { [trapped.id]: JSON.stringify(trappedRow), [clean.id]: JSON.stringify(cleanRow),
    [paged.id]: JSON.stringify(pagedRow), [backPage.id]: JSON.stringify(backRow) }
  const cellText = [trappedRow, cleanRow, pagedRow, backRow].flatMap((row) => Object.values(row))
    .filter((value) => !/^[\x20-\x7e]*$/.test(String(value)))
  for (const item of managerView.items) {
    const serialized = JSON.stringify(item.message.params)
    for (const value of cellText) {
      assert.ok(!serialized.includes(value), `${keyOf(item)} 的 params 带了原样内容片段`)
    }
    for (const run of item.message.params?.runs ?? []) {
      assert.ok((rowJson[item.page] ?? '').includes(run), `${keyOf(item)} 的 ${run} 不属于它挂靠的那一条`)
    }
  }
  for (const item of managerView.items) {
    assert.equal(item.producer, 'rule')
    assert.equal(item.producer_version, rules.producerVersionForRule(item.message.key))
    assert.equal(item.gate, 'off', '新规则必须一入库就对校对端不可见')
  }

  // 与 #176 联动：一条 gate 行都没有时，在手校对员也拿不到任何 hint。
  const claim = await request(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: worker.token })
  assert.equal(claim.id, trapped.id)
  const beforeGate = await request(`/api/fangji/pages/${trapped.id}/findings`, { token: worker.token })
  assert.deepEqual(beforeGate.hints, [])

  await setGate({ kind: 'reading_format_invalid', messageKey: 'long_digit_run', gate: 'strong' })
  await setGate({ kind: 'confusable_substitution', messageKey: 'confusable_ascii_in_reading', gate: 'warn' })
  await setGate({ kind: 'punctuation_mix', messageKey: 'punctuation_width_mixed_in_column', gate: 'warn' })
  await setGate({ kind: 'page_outlier', messageKey: 'pdf_page_backtrack', gate: 'warn' })
  const afterGate = await request(`/api/fangji/pages/${trapped.id}/findings`, { token: worker.token })
  assert.deepEqual(afterGate.hints.map((hint) => hint.message.key), ['long_digit_run'])
  assert.equal(afterGate.hints[0].highlight, true)

  // 评审阻断 1 的后果第 1 层是「在手者拿到别人条目的疑点」，所以必须在**消费端**钉住：
  // 同一个 message_key、同一个 gate 下，两个读者各自只看到自己那一行的数字串。
  const pagedGate = await request(`/api/fangji/pages/${paged.id}/findings`, { token: boss.token })
  assert.deepEqual(pagedGate.hints.map((hint) => hint.message.key), ['long_digit_run'],
    JSON.stringify(pagedGate.hints.map((hint) => hint.message.key)))
  assert.deepEqual(pagedGate.hints[0].message.params.runs, ['9999'],
    `第 3 条的读者只能看到第 3 条自己的数字串：${JSON.stringify(pagedGate.hints[0].message.params)}`)
  assert.deepEqual(afterGate.hints[0].message.params.runs, ['5333'],
    '第 1 条的读者不能拿到第 3 条的内容')

  // Project settings, single-entry recompute and ordinary hints use the same pair.
  {
    const paired = await createProject('Tone pair', [worker], [boss])
    const settings = `/api/fangji/projects/${paired.id}/column-roles`
    const row = await createPage(paired.id, 1, { 对照: 'ka53 lɑŋ²¹', 本地: 'ka⁵³', 异读: 'ka55 lɑŋ²¹' })
    const roles = { 对照: 'reading', 本地: 'reading', 异读: 'reading' }
    const hintURL = `/api/fangji/pages/${row.id}/findings`
    for (const fields of [['对照', '对照'], ['对照', 'unknown'], ['对照']]) {
      await request(settings, { method: 'PUT', token: boss.token, body: { roles, tone_count_fields: fields }, expected: 400 })
    }
    const update = await request(settings, { method: 'PUT', token: boss.token,
      body: { roles, tone_count_fields: ['对照', '本地'] } })
    assert.deepEqual(update.tone_count_fields, ['对照', '本地'])
    await request(settings, { method: 'PUT', token: boss.token, body: { roles } })
    assert.deepEqual((await request(settings, { token: boss.token })).tone_count_fields, ['对照', '本地'])
    await request(`${hintURL}/recompute`, { method: 'POST', token: boss.token })
    const listed = await request(`/api/fangji/projects/${paired.id}/findings`, { token: boss.token })
    const tone = listed.items.find(item => item.message.key === 'tone_token_count_differs')
    assert.equal(tone?.producer_version, rules.RULES_VERSION)
    assert.equal(tone.field, '本地')
    assert.equal(tone.scoring_channel, 'unscored')
    assert.deepEqual(tone.message.params, { left_field: '对照', right_field: '本地', left_count: 2, right_count: 1 })
    assert.deepEqual((await request(hintURL, { token: boss.token })).hints, [])
    await setGate({ kind: 'reading_format_invalid', messageKey: 'tone_token_count_differs', gate: 'warn' })
    assert.deepEqual((await request(hintURL, { token: boss.token })).hints.map(item => item.field), ['本地'])
    await request(settings, { method: 'PUT', token: boss.token, body: { roles, tone_count_fields: ['对照', '异读'] } })
    assert.deepEqual((await request(hintURL, { token: boss.token })).hints, [], '换列立即隐藏旧配对结果')
    await request(`${hintURL}/recompute`, { method: 'POST', token: boss.token })
    assert.deepEqual((await request(`/api/fangji/projects/${paired.id}/findings`, { token: boss.token })).items, [])
  }

  // 重算只下线同 producer 的旧批次：OCR(#125) 与 bundle_import(#124) 的行不能被动。
  const ocrRow = await request('/api/collections/review_findings/records', {
    method: 'POST', token: superAuth.token,
    body: {
      page: trapped.id, project: project.id, field_name: '莆田IPA', kind: 'merged_columns',
      severity: 'strong', message_key: 'column_collapse', params_json: '{}', evidence_json: '{}',
      producer: 'ocr', producer_version: 'ocr-v1', produced_at: '2026-09-01'
    }
  })
  const ruleRowsOf = async (pageId) => {
    const items = []
    let list
    for (let page = 1; ; page++) {
      list = await request(`/api/collections/review_findings/records?page=${page}&perPage=200&sort=created,id&filter=${encodeURIComponent(`page = "${pageId}" && producer = "rule"`)}`, { token: superAuth.token })
      items.push(...list.items)
      if (page >= list.totalPages) break
    }
    // Awaited recomputations are settled before this read; every historical row
    // must be counted even when several concurrent waves exceed one API page.
    assert.equal(items.length, list.totalItems, `读取被分页截断：${items.length}/${list.totalItems}`)
    const pageRecord = await request(`/api/collections/pages/records/${pageId}`, { token: superAuth.token })
    const visible = new Set()
    for (let page = 1; ; page++) {
      const batch = await request(`/api/fangji/projects/${pageRecord.project}/findings?page=${page}&per=200`, { token: platformAuth.token })
      for (const item of batch.items) visible.add(item.id)
      if (!batch.hasMore) break
    }
    // Native records retain original bytes. Business current membership comes
    // from the authoritative current endpoint after publication migration 4700.
    return { ...list, items: items.map(item => ({ ...item, _current: visible.has(item.id) })) }
  }
  const anchorOfRaw = (row) => JSON.parse(row.evidence_json || '{}').anchor ?? ''
  const current = (rows) => rows.filter((row) => row._current === true)
  const entryRows = (rows) => current(rows).filter((row) => anchorOfRaw(row) === rules.ANCHOR_ENTRY)
  const columnRows = (rows) => current(rows).filter((row) => anchorOfRaw(row) === rules.ANCHOR_COLUMN)
  const keysOfRaw = (rows) => rows.map((row) => `${row.kind}/${row.message_key}`).sort()
  const beforeRecompute = await ruleRowsOf(trapped.id)
  assert.deepEqual(keysOfRaw(entryRows(beforeRecompute.items)), expectedFor(trappedRow))
  assert.equal(columnRows(beforeRecompute.items).length, 2, '列级疑点此刻挂在第一条目上')
  await request(`/api/fangji/pages/${trapped.id}/findings/recompute`, { method: 'POST', token: worker.token })
  const afterRuleRows = await ruleRowsOf(trapped.id)
  const freshRuleRows = entryRows(afterRuleRows.items)
  assert.deepEqual(keysOfRaw(freshRuleRows), expectedFor(trappedRow),
    '重算后应当只剩一份当前批次')
  // 单条重算判定不了列级规则，所以它不得顺手抹掉挂在这一条身上的列级疑点：
  // 那些只有项目级重算会重新产出，被抹掉就是静默永久丢失。
  assert.equal(columnRows(afterRuleRows.items).length, 2, '单条重算必须保留列级疑点')
  // R7 的页级疑点也挂在 trapped 上（pdf_page=1 的第一条），单条重算同样不许吃掉它。
  const pageLevelOf = (rows) => current(rows).filter((row) =>
    anchorOfRaw(row) === rules.ANCHOR_PDF_PAGE)
  assert.deepEqual(pageLevelOf(beforeRecompute.items).map((row) => row.message_key), ['pdf_page_backtrack'],
    `全量重算后 trapped 上该有一条页级疑点：${JSON.stringify(beforeRecompute.items.map((r) => [r.message_key, anchorOfRaw(r)]))}`)
  assert.deepEqual(pageLevelOf(afterRuleRows.items).map((row) => row.message_key), ['pdf_page_backtrack'],
    '单条目重算不得吃掉挂在它身上的页级(R7)疑点——它判定不了整页，只有项目重算会再产出')
  const backRows = await ruleRowsOf(backPage.id)
  assert.deepEqual(keysOfRaw(entryRows(backRows.items)), expectedFor(backRow),
    '回退那条的格级疑点各归各条目')
  assert.deepEqual(pageLevelOf(backRows.items).map((row) => row.message_key), [],
    '页级(R7)疑点挂在 pdf_page 的第一条目上，不该分到回退那条自己')
  assert.ok(afterRuleRows.items.filter((row) => !row._current).length >= expectedFor(trappedRow).length,
    '旧批次必须留在库里')
  assert.ok(freshRuleRows.every((row) => row.produced_at !== ''))
  const ocrAfter = await request(`/api/collections/review_findings/records/${ocrRow.id}`, { token: superAuth.token })
  assert.equal(ocrAfter.superseded_at, '', '规则重算不得下线 OCR 生产者的疑点')
  const ruleFinding = freshRuleRows.find((row) => row.message_key === 'long_digit_run')
  assert.equal(ruleFinding.severity, 'strong')

  // Await all HTTP responses, then require one complete current batch. A set
  // comparison alone hides duplicates and cannot establish per-field evidence.
  const findingProjection = (field, kind, severity, key, params, offsets) =>
    JSON.stringify([field, kind, severity, key, params, offsets || null])
  const expectedProjection = rules.runPageRules(ctx, trappedRow).map((item) =>
    findingProjection(item.field, item.kind, item.severity, item.message_key,
      item.params, item.evidence?.char_offsets)).sort()
  for (let wave = 0; wave < 4; wave++) {
    const concurrent = await Promise.all(Array.from({ length: 8 }, () =>
      request(`/api/fangji/pages/${trapped.id}/findings/recompute`, { method: 'POST', token: boss.token })))
    assert.equal(concurrent.length, 8, '并发重算请求不得有失败')
    const raced = await ruleRowsOf(trapped.id)
    const currentEntry = entryRows(raced.items)
    assert.deepEqual(keysOfRaw(currentEntry), expectedFor(trappedRow),
      `并发重算后必须恰好一份完整批次：${JSON.stringify(currentEntry.map((row) => [row.message_key, row.produced_at]))}`)
    const actualProjection = currentEntry.map((row) =>
      findingProjection(row.field_name, row.kind, row.severity, row.message_key,
        JSON.parse(row.params_json), JSON.parse(row.evidence_json).char_offsets)).sort()
    assert.deepEqual(actualProjection, expectedProjection,
      '并发重算不得改变字符规则、所属字段、参数或码位区间')
    const batches = new Set(currentEntry.map((row) => row.produced_at))
    assert.equal(batches.size, 1, '当前批次不得拼接不同重算的残片')
    assert.equal(columnRows(raced.items).length, 2, '并发重算不得波及列级疑点')
    assert.deepEqual(pageLevelOf(raced.items).map((row) => row.message_key), ['pdf_page_backtrack'],
      '并发单条重算必须保留项目级页码疑点')
    assert.ok(raced.totalItems > expectedFor(trappedRow).length + 2 + 5,
      `并发请求的历史批次必须保留：${raced.totalItems}`)
    const preservedOcr = await request(`/api/collections/review_findings/records/${ocrRow.id}`, { token: superAuth.token })
    assert.equal(preservedOcr.superseded_at, '', '规则重算不得下线 OCR 生产者')
    console.log(`ASSIST_CONCURRENCY ${JSON.stringify({
      wave, requests: concurrent.length, current_rows: currentEntry.length,
      distinct_batches: batches.size, exact_character_evidence: true
    })}`)
  }

  // 提交路径：刚提交的那一行要立刻参与判定，而不是等全量重算。
  const submit = await request(`/api/fangji/pages/${trapped.id}/submit`, {
    method: 'POST', token: worker.token,
    body: {
      rowJson: JSON.stringify({ 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ua9999', 仙游IPA: 'ka', 释义: '第一（个）测试' }),
      text: '甲 ka1', leaseToken: claim.leaseToken
    }
  })
  assert.ok(submit)
  const submitted = await ruleRowsOf(trapped.id)
  const runs = current(submitted.items).filter((row) => row.message_key === 'long_digit_run')
  assert.equal(runs.length, 1)
  assert.deepEqual(JSON.parse(runs[0].params_json).runs, ['9999'], '应对刚提交的行重算，而不是导入原文')

  // p95：三种形状都要量（静默行、单疑点行、多疑点行，含真实的下线 + 插入）。
  // 上一轮只测了静默行，那个数字不代表提交路径。
  //
  // 50 ms 这条**不当 CI 断言**：计时含 HTTP 往返与 runner 调度，同一份代码在 GitHub 上
  // 两次跑出 p95 = 11 ms 和 52 ms（见 docs/plans/2026-09-25-assist-rules.md §5），当门禁
  // 就是一支随时会红的旗。#177 验收第 70 行的原话是"p95 < 50 ms，日志或测试记录为证"，
  // 所以这里打印 ASSIST_P95 作为记录、只留一条灾难线（结构性回退会到秒级：整项目重扫、
  // N+1、两两全比都在这个量级），50 ms 由人对着打印数字核。
  const PERF_DISASTER_MS = 500
  const timed = async (label, pageId, findings) => {
    const durations = []
    for (let i = 0; i < 30; i += 1) {
      const startedAt = Date.now()
      await request(`/api/fangji/pages/${pageId}/findings/recompute`, { method: 'POST', token: boss.token })
      durations.push(Date.now() - startedAt)
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95) - 1]
    console.log(`ASSIST_P95 ${JSON.stringify({
      case: label, findings, samples: durations.length,
      p50: durations[Math.floor(durations.length / 2)], p95, max: durations[durations.length - 1],
      acceptance_budget_ms: 50, disaster_gate_ms: PERF_DISASTER_MS
    })}`)
    assert.ok(p95 < PERF_DISASTER_MS,
      `${label} 单条重算 p95 = ${p95} ms，超过灾难线 ${PERF_DISASTER_MS} ms（提交路径被改成整项目扫描级别的开销）`)
    return p95
  }
  await timed('silent_row', clean.id, 0)
  await timed('one_finding', paged.id, expectedFor(pagedRow).length)
  const busy = await timed('many_findings', trapped.id, expectedFor(trappedRow).length)
  assert.ok(busy > 0, '计时必须真的走过 HTTP 往返，不能恒为 0')

  // 评审阻断项（!231）：区间算在**判据行**上、高亮打在**渲染行**（`ocr_row_json`）上时，
  // 两个串可以不一样，下标就会切到空白上——而界面上看不出错了。
  // 这一节把失配变成可证伪的断言：判据行仍是纯函数算出的那份，落库的区间被省略。
  {
    const driftProject = await createProject('Assist rules offsets drift', [worker], [boss])
    // 前端拿去切的那份串：行首多一个空格（OCR 常见形状）
    const shownRow = { 词条: '人', 拼音: 'lang2', 莆田IPA: ' aŋ55', 仙游IPA: ' aŋ55', 释义: '人类' }
    // 第一轮凑够票之后落地的校对行：判据在它上面算
    const judgedRow = { 词条: '人', 拼音: 'lang2', 莆田IPA: 'aŋ55', 仙游IPA: 'aŋ55', 释义: '人类' }
    // 待认领的行不接受 PATCH（hooks 只允许认领），所以建行时一次写齐两份串：
    // ocr_row_json 是前端拿去切的那份，proofread_row_json 是判据用的那份。
    const mk = (pageNumber, shown, judged) => request('/api/collections/pages/records', {
      method: 'POST', token: superAuth.token,
      body: {
        project: driftProject.id, page_number: pageNumber, pdf_page: pageNumber,
        ocr_row_json: JSON.stringify(shown), ocr_text: Object.values(shown).join(' '),
        proofread_row_json: JSON.stringify(judged), proofread_round: 2, mismatch_count: 0,
        status: 'proofread'
      }
    })
    const drift = await mk(1, shownRow, judgedRow)
    // 对照组：校对行与导入行逐字相同 ⇒ 区间必须保留（防止闸门退化成"永远丢"）
    const sameRow = { 词条: '天', 拼音: 'thin1', 莆田IPA: ' aŋ55', 仙游IPA: ' aŋ55', 释义: '天空' }
    const same = await mk(2, sameRow, sameRow)

    // 先在纯函数层确认"失配确实存在"：按判据行算出的下标，拿到渲染行上切到的是空白。
    const judgedFindings = rules.runPageRules(ctx, judgedRow)
    const judgedSpan = judgedFindings.find((item) =>
      item.kind === 'confusable_substitution' && item.evidence?.char_offsets?.length)
    assert.ok(judgedSpan, '判据行上没有可混淆字符，这节测试就没有前提')
    assert.equal(sliceBySpans(shownRow[judgedSpan.field], judgedSpan.evidence.char_offsets[0]).trim(), '',
      '前提不成立：按判据行的区间切渲染行竟然不是空白，那就没有失配可防了')

    const driftRun = await request(`/api/fangji/projects/${driftProject.id}/findings/recompute`, { method: 'POST', token: boss.token })
    assert.ok(driftRun.offsets_dropped >= 1, JSON.stringify(driftRun))
    const driftView = await request(`/api/fangji/projects/${driftProject.id}/findings?per=200`, { token: boss.token })
    const driftItems = driftView.items.filter((item) => item.page === drift.id)
    const confusableOnDrift = driftItems.filter((item) => item.kind === 'confusable_substitution')
    assert.ok(confusableOnDrift.length >= 1,
      `省略区间不许把归因一起丢掉：${JSON.stringify(driftItems.map((i) => [i.kind, i.message.key]))}`)
    for (const item of confusableOnDrift) {
      assert.equal(item.evidence?.char_offsets, undefined,
        `判据行 != 渲染行却带着区间：${JSON.stringify(item.evidence)}`)
    }
    // 对照组保留区间，并且切回的是**渲染行**里的实义内容（不是判据行）。
    const sameItems = (await request(`/api/fangji/projects/${driftProject.id}/findings?per=200`, { token: boss.token }))
      .items.filter((item) => item.page === same.id && item.kind === 'confusable_substitution')
    assert.ok(sameItems.length >= 1, JSON.stringify(sameItems))
    for (const item of sameItems) {
      assert.ok(Array.isArray(item.evidence?.char_offsets), JSON.stringify(item.evidence))
      for (const span of item.evidence.char_offsets) {
        assertWellFormed(keyOf(item), sameRow[item.field], [span])
        assert.ok(sliceBySpans(sameRow[item.field], span).trim().length > 0,
          `${keyOf(item)} 在 ${item.field} 的 ${JSON.stringify(span)} 切出空白：${JSON.stringify(sameRow[item.field])}`)
      }
    }
    // 单条路径（提交后与裁决后各跑一次的那条）共用同一个闸门函数，
    // 它的响应计数与项目路径一致；这里不断言 HTTP 层，是因为该路由要求请求体带
    // 当前租约凭据，用假凭据打一次只会测到权限分支而不是闸门。
    assert.ok(confusableOnDrift.every((item) => shownRow[item.field] !== judgedRow[item.field]),
      `只有"判据行 != 渲染行"的列才该被剥掉区间：${JSON.stringify(confusableOnDrift.map((i) => i.field))}`)
  }

  // #304：管理员写回（#293 的 POST .../pages/{pageId}/content）之后，`ocr_row_json` 变了，
  // 而这一页的疑点批次不会自动重算——库里留下的 `char_offsets` 因此是**旧串**的下标，
  // 校对端 `locateSpan` 拿它切新串，症状是「高亮标在错字上，界面上看起来完全正常」。
  // 这一段走真实路由，把三件事钉在一起：写回后区间被剥、疑点本身仍在、显式重算后区间恢复
  // 且切在**新串**的实义内容上（降级是临时的，不是把高亮功能做没了）。
  {
    const wbProject = await createProject('Assist writeback offsets', [worker], [boss])
    // 校对端只放行 R6（strong 档在上一节已登记，同一个 gate 表全局按
    // producer_version/kind/message_key 生效，所以这里不再插第二行同名登记）；
    // R2 也会命中这格（项目没配键盘时按莆仙词表回退，#238），它档位是 off、
    // 只出现在管理端——两端计数不同正是下面要各钉一条的东西。
    const beforeRow = { 词条: '人', 拼音: 'lang2', 莆田IPA: 'aŋ1234', 释义: '人类' }
    const wbPage = await createPage(wbProject.id, 1, beforeRow)

    const firstRun = await request(`/api/fangji/pages/${wbPage.id}/findings/recompute`,
      { method: 'POST', token: boss.token })
    assert.equal(firstRun.offsets_dropped, 0, JSON.stringify(firstRun))

    const hintKeys = (body) => body.hints.map((hint) => hint.message.key).sort()
    // 基准只在服务端与库里流动（见下面校对端那条断言），所以取证要读原始记录而不是响应。
    const currentFindingRow = async (pageId, key) => {
      const batch = await ruleRowsOf(pageId)
      const items = current(batch.items).filter(item => item.message_key === key)
      assert.equal(items.length, 1,
        `这一页上 ${key} 应当只有一条当前批次：${JSON.stringify(items.map((item) => item.id))}`)
      return items[0]
    }
    const before = await request(`/api/fangji/pages/${wbPage.id}/findings`, { token: boss.token })
    assert.ok(hintKeys(before).includes('long_digit_run'), JSON.stringify(hintKeys(before)))
    const beforeSpan = before.hints.find((hint) => hint.message.key === 'long_digit_run')
    assert.deepEqual(beforeSpan.evidence.char_offsets, [[2, 6]], JSON.stringify(beforeSpan.evidence))
    // 校对端不下发基准：前端只消费 `char_offsets`（fieldHints.js / ProofreadEditorView.vue），
    // 而基准是内容派生的摘要，没有消费者的字段不该为了调试留在给校对员的响应里。
    // 管理端保留它——项目管理员本来就读得到整行内容，与 `scoring_channel` 只给管理端同一立场。
    assert.equal(beforeSpan.evidence.offsets_basis, undefined,
      `校对端把内容派生的基准一起下发了：${JSON.stringify(beforeSpan.evidence)}`)
    assert.equal(before.offsets_stale, 0, '写回之前不该有任何过期计数')
    assert.equal(before.offsets_unbaselined, 0, '这批是盖章之后产的，不该有无基准计数')

    // 复审 P2 之一：基准必须能证明「区间仍然切在同一段内容上」，而不只是长度没变。
    // 盖章发生在 JSVM，这里的期望值由 node 加载同一份实现算出——两边对不上就说明
    // 摘要随引擎漂移，读侧会把所有基准判成过期。
    const stampedRow = await currentFindingRow(wbPage.id, 'long_digit_run')
    const stampedEvidence = JSON.parse(stampedRow.evidence_json)
    assert.deepEqual(stampedEvidence.char_offsets, [[2, 6]], stampedRow.evidence_json)
    assert.deepEqual(stampedEvidence.offsets_basis, findings.offsetsBasis('aŋ1234', [[2, 6]]),
      '写侧闸门要在保留区间的同一支路里盖章基准，否则读侧无从复核（基准与判定同源）')
    assert.notEqual(stampedEvidence.offsets_basis.digests[0], '1234',
      '§6 红线：落在 evidence 里的必须是摘要而不是摘录片段')

    // 复审 P2 之二：#293 与本 PR 之间落库的批次、以及更早的全部批次**没有基准**，而它们在
    // 部署之后照样会被管理员改写。那种行的形状就是「有 char_offsets、无 offsets_basis」。
    // 这种行只能新造、不能把现成的改成那样——先钉住这件事本身：`findings.pb.js` 的守卫连
    // superuser 都挡，所以存量批次永远拿不到回溯补盖的基准，保守降级必须真的发生。
    await request(`/api/collections/review_findings/records/${stampedRow.id}`, {
      method: 'PATCH', token: superAuth.token, expected: 403,
      body: { evidence_json: JSON.stringify({ char_offsets: [[2, 6]] }) }
    })
    const legacyPage = await createPage(wbProject.id, 2, beforeRow)
    await request('/api/collections/review_findings/records', {
      method: 'POST', token: superAuth.token,
      body: {
        page: legacyPage.id, project: wbProject.id, field_name: '莆田IPA',
        kind: 'reading_format_invalid', severity: 'strong', message_key: 'long_digit_run',
        params_json: '{}', evidence_json: JSON.stringify({ char_offsets: [[2, 6]] }),
        producer: 'rule', producer_version: rules.producerVersionForRule('long_digit_run'),
        produced_at: new Date().toISOString().slice(0, 10)
      }
    })

    const legacyView = await request(`/api/fangji/pages/${legacyPage.id}/findings`, { token: boss.token })
    assert.equal(legacyView.hints.length, 1, JSON.stringify(legacyView))
    const legacySpan = legacyView.hints[0]
    assert.equal(legacySpan.evidence.char_offsets, undefined,
      `无基准的旧批次仍下发旧下标：${JSON.stringify(legacySpan.evidence)}`)
    assert.equal(legacySpan.highlight, true, '降级只该影响"画不画高亮"，不该改档位与高亮意图')
    assert.equal(legacyView.offsets_unbaselined, 1, JSON.stringify(legacyView))
    assert.equal(legacyView.offsets_stale, 0, '「没有基准」不许混进「原文变了」那个数')
    // 管理端过同一道复核，两个数也要同一口径（两端各写一套的话早晚只有一端在防）。
    const legacyAdmin = await request(`/api/fangji/projects/${wbProject.id}/findings?per=200`, { token: boss.token })
    assert.equal(legacyAdmin.offsets_unbaselined, 1, JSON.stringify(legacyAdmin.offsets_unbaselined))
    assert.equal(legacyAdmin.offsets_stale, 0, '旧批次不该被算成原文改写')

    // 重算是这条保守降级的恢复出口（写进契约文档 §1.1 的部署步骤）：wbPage 那一条本来就带基准，
    // 重算之后必须仍然带——基准只能由写侧闸门盖，读侧没有第二个地方能算出它。
    await request(`/api/fangji/pages/${wbPage.id}/findings/recompute`, { method: 'POST', token: boss.token })
    const restored = await request(`/api/fangji/pages/${wbPage.id}/findings`, { token: boss.token })
    const restoredSpan = restored.hints.find((hint) => hint.message.key === 'long_digit_run')
    assert.deepEqual(restoredSpan.evidence.char_offsets, [[2, 6]], JSON.stringify(restoredSpan.evidence))
    assert.deepEqual(JSON.parse((await currentFindingRow(wbPage.id, 'long_digit_run')).evidence_json).offsets_basis,
      findings.offsetsBasis('aŋ1234', [[2, 6]]),
      '重算必须把可验证基准补回库里，否则降级就成了永久状态')
    assert.equal(restored.offsets_unbaselined, 0, '重算之后不该还有无基准的区间留着')

    // 管理员在数字串前面补一个「9」：旧区间 [2,6) 从此切到 '9123'，片段摘要对不上。
    // （等长移动已经在纯函数段钉过；这里走真实路由，要的是「改写→不重算→读侧剥」这条链。）
    const afterRow = { 词条: '人', 拼音: 'lang2', 莆田IPA: 'aŋ91234', 释义: '人类' }
    await request(`/api/fangji/projects/${wbProject.id}/pages/${wbPage.id}/content`, {
      method: 'POST', token: boss.token,
      body: {
        rowJson: JSON.stringify(afterRow),
        headersJson: JSON.stringify(['词条', '拼音', '莆田IPA', '释义']),
        expectedUpdated: (await request(`/api/collections/pages/records/${wbPage.id}`, { token: boss.token })).updated
      }
    })

    const after = await request(`/api/fangji/pages/${wbPage.id}/findings`, { token: boss.token })
    const staleSpan = after.hints.find((hint) => hint.message.key === 'long_digit_run')
    assert.ok(staleSpan, `剥区间不许把归因一起剥掉：${JSON.stringify(hintKeys(after))}`)
    assert.equal(staleSpan.evidence.char_offsets, undefined,
      `原文已改写却仍下发旧下标：${JSON.stringify(staleSpan.evidence)}`)
    assert.equal(staleSpan.highlight, true, '降级只该影响"画不画高亮"，不该改档位与高亮意图')
    assert.equal(after.offsets_stale, 1, JSON.stringify({ keys: hintKeys(after), stale: after.offsets_stale }))
    assert.equal(after.offsets_unbaselined, 0, '这一格是"原文变了"，不该同时记成"没有基准"')
    assert.equal(after.hints.length, before.hints.length, '写回复核不得增减疑点条数')

    // 管理端读的是同一份下标，所以必须过同一道复核（两端各写一套判据的话早晚只有一端在防）。
    // R2 留在管理端作抽样；其区间仍按来源核验。
    const adminView = await request(`/api/fangji/projects/${wbProject.id}/findings?per=200`, { token: boss.token })
    const onWbPage = adminView.items.filter((item) => item.page === wbPage.id)
    assert.deepEqual(onWbPage.map((item) => item.message.key).sort(),
      ['confusable_ascii_in_reading', 'long_digit_run'],
      JSON.stringify(onWbPage.map((item) => [item.message.key, item.evidence])))
    const baselinedKeys = onWbPage
      .filter((item) => Array.isArray(item.evidence?.offsets_basis?.digests))
      .map((item) => item.message.key).sort()
    assert.deepEqual(baselinedKeys, ['confusable_ascii_in_reading', 'long_digit_run'])
    // 复审 P2 之要：'aŋ1234' → 'aŋ91234' 只在 index 2 插入，[0,1) 上那个可混淆的 'a' 一个字没动。
    // 按总长度判的旧版会因为 6→7 把两条一起剥；片段摘要只剥真正切到别处的那条。
    // 所以这里必须是「两条带基准、一条过期、一条区间原样保留」，而不是一个笼统的全剥。
    assert.equal(adminView.offsets_stale, 1,
      `带基准的两条里只该有一条对不上：${JSON.stringify(onWbPage.map((item) => [item.message.key, item.evidence]))}`)
    assert.equal(adminView.offsets_unbaselined, 1, '无基准那一条来自上面造的 legacyPage，不该来自这页')
    const keptSpan = onWbPage.find((item) => item.message.key === 'confusable_ascii_in_reading')
    assert.deepEqual(keptSpan.evidence.char_offsets, [[0, 1]],
      `区间仍然忠实却被顺带剥掉：${JSON.stringify(keptSpan.evidence)}`)
    const staleOnAdmin = onWbPage.find((item) => item.message.key === 'long_digit_run')
    assert.equal(staleOnAdmin.evidence.char_offsets, undefined,
      `基准对不上却仍下发旧下标：${JSON.stringify(staleOnAdmin.evidence)}`)

    // 重算是既有出口（提交后、裁决后、这两个管理端口都会跑）：跑一次之后区间重新锚在**新串**上。
    await request(`/api/fangji/pages/${wbPage.id}/findings/recompute`, { method: 'POST', token: boss.token })
    const healed = await request(`/api/fangji/pages/${wbPage.id}/findings`, { token: boss.token })
    const healedSpan = healed.hints.find((hint) => hint.message.key === 'long_digit_run')
    assert.deepEqual(healedSpan.evidence.char_offsets, [[2, 7]],
      `重算后区间要跟着新串走：${JSON.stringify(healedSpan.evidence)}`)
    assert.deepEqual(JSON.parse((await currentFindingRow(wbPage.id, 'long_digit_run')).evidence_json).offsets_basis,
      findings.offsetsBasis(afterRow['莆田IPA'], [[2, 7]]),
      '重算要把基准一起重新锚到新串上，否则下一轮改写又会把新切好的区间判成过期')
    assert.equal(healed.offsets_stale, 0, '重算之后不该还有过期条目留着')
    assert.equal(healed.offsets_unbaselined, 0, '重算之后不该还有无基准条目留着')
    assert.equal(sliceBySpans(afterRow['莆田IPA'], healedSpan.evidence.char_offsets[0]), '91234',
      '高亮必须切回被标记的那段数字串本身，切回空白或别的字都算没修好')

    // 复审 P2 之二点名要的那条链路：旧批次 → 部署新读侧 → 管理员写回。这里对 legacyPage 做
    // 与 wbPage **完全相同的那次编辑**（同一个 `afterRow`），于是同一次改写被两个计数分到两边：
    // 带基准的报 stale，没有基准的仍报 unbaselined。两个数因此不是顺序巧合，而是成因标签。
    await request(`/api/fangji/projects/${wbProject.id}/pages/${legacyPage.id}/content`, {
      method: 'POST', token: boss.token,
      body: {
        rowJson: JSON.stringify(afterRow),
        headersJson: JSON.stringify(['词条', '拼音', '莆田IPA', '释义']),
        expectedUpdated: (await request(`/api/collections/pages/records/${legacyPage.id}`, { token: boss.token })).updated
      }
    })
    const legacyWritten = await request(`/api/fangji/pages/${legacyPage.id}/findings`, { token: boss.token })
    assert.equal(legacyWritten.hints.length, 1, JSON.stringify(legacyWritten))
    assert.equal(legacyWritten.hints[0].evidence.char_offsets, undefined,
      `无基准的旧批次被写回之后仍下发旧下标：${JSON.stringify(legacyWritten.hints[0].evidence)}`)
    assert.equal(legacyWritten.offsets_unbaselined, 1, JSON.stringify(legacyWritten.offsets_unbaselined))
    assert.equal(legacyWritten.offsets_stale, 0,
      '根本没有基准的记录不该被报成"原文变了"——那会把部署日的正常存量说成有人改过内容')
    // 库里这条记录被读三次、被写回一次之后仍然没有基准：盖章只有写侧一个入口
    // （`assist_writer.js:99`），读侧没有任何补章出口。它同时是「写回自动触发重算」那条
    // 收尾路线的哨兵——真接上那条，这里就会变成带基准，本段的降级叙述要跟着重写。
    // 这条是仓库状态断言，没有用变异证明它会红（改动读侧的内存视图不会写回库里）。
    const legacyStored = JSON.parse((await currentFindingRow(legacyPage.id, 'long_digit_run')).evidence_json)
    assert.equal(legacyStored.offsets_basis, undefined,
      `库里这条旧批次已经有了基准，与"只有写侧盖章"不符：${JSON.stringify(legacyStored)}`)
    console.log('PASS: 写回后旧区间被剥且疑点仍在，重算后区间重新锚在新串上，旧批次被写回仍按无基准计数（#304）')
  }

  console.log('Assist rules integration test passed.')
} finally {
  for (const id of gateIds.reverse()) {
    await request(`/api/collections/assist_rule_gates/records/${id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
  }
  for (const projectId of projectIds.reverse()) {
    await request(`/api/fangji/projects/${projectId}`, { method: 'DELETE', token: platformAuth.token, expected: 204 })
  }
  for (const userId of userIds.reverse()) {
    await request(`/api/collections/users/records/${userId}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
  }
}
