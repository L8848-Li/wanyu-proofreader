import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 规则库是纯函数（不碰 DAO、不 require 别的 lib），所以能在 node 里直接加载做表驱动单测。
const rules = require('../pb_hooks/lib/assist_rules.js')
const keyboardDefinition = require('../keyboards/hinghwa-dialect.json')

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
  // 55 是两位调值，不触发 long_digit_run；只该报两列调号数量不等。
  const mismatch = rules.ruleReadingFormat(ctx, { 拼音: 'ka1', 莆田IPA: 'kʰa55' })
  assert.deepEqual(keysOf(mismatch), ['tone_token_count_differs'])
  assert.deepEqual(mismatch[0].params, { pinyin_count: 1, ipa_count: 2 })
  // 缺列不猜：只有拼音列时不报调号数量不等。
  assert.deepEqual(rules.ruleReadingFormat(ctx, { 拼音: 'ka1' }), [])
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

async function setGate({ version = rules.RULES_VERSION, kind, messageKey, gate }) {
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
  const pagedRow = { 词条: '人', 拼音: 'lang2', 莆田IPA: 'lɑŋ2', 仙游IPA: 'lyŋ2', 释义: '人类' }
  const trapped = await createPage(project.id, 1, trappedRow)
  const clean = await createPage(project.id, 2, cleanRow)
  const paged = await createPage(project.id, 3, pagedRow)
  const expectedFor = (row) => rules.runPageRules(ctx, row)
    .map((item) => `${item.kind}/${item.message_key}`).sort()
  assert.ok(expectedFor(trappedRow).length >= 4, 'trapped row must exercise several rules')
  assert.deepEqual(expectedFor(cleanRow), [], 'clean row must be silent for the comparison to mean anything')

  await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: worker.token, expected: 403 })
  await request(`/api/fangji/projects/${project.id}/findings/recompute`, { method: 'POST', token: boss.token })

  const managerView = await request(`/api/fangji/projects/${project.id}/findings`, { token: boss.token })
  const trappedKeys = managerView.items.filter((item) => item.page === trapped.id)
    .map((item) => `${item.kind}/${item.message.key}`).sort()
  assert.deepEqual(trappedKeys, expectedFor(trappedRow))
  assert.ok(trappedKeys.includes('reading_format_invalid/long_digit_run'), JSON.stringify(trappedKeys))
  assert.ok(trappedKeys.includes('confusable_substitution/confusable_ascii_in_reading'), JSON.stringify(trappedKeys))
  assert.ok(trappedKeys.includes('char_out_of_repertoire/non_ipa_range_codepoints'), JSON.stringify(trappedKeys))
  // 干净条目一条都不该有——包括 info 级，否则"零信号条目"这个前提就不成立了。
  assert.deepEqual(managerView.items.filter((item) => item.page === clean.id), [],
    `clean entry flagged: ${JSON.stringify(managerView.items.filter((item) => item.page === clean.id))}`)
  for (const item of managerView.items) {
    assert.equal(item.producer, 'rule')
    assert.equal(item.producer_version, rules.RULES_VERSION)
    assert.equal(item.gate, 'off', '新规则必须一入库就对校对端不可见')
  }

  // 与 #176 联动：一条 gate 行都没有时，在手校对员也拿不到任何 hint。
  const claim = await request(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: worker.token })
  assert.equal(claim.id, trapped.id)
  const beforeGate = await request(`/api/fangji/pages/${trapped.id}/findings`, { token: worker.token })
  assert.deepEqual(beforeGate.hints, [])

  await setGate({ kind: 'reading_format_invalid', messageKey: 'long_digit_run', gate: 'strong' })
  const afterGate = await request(`/api/fangji/pages/${trapped.id}/findings`, { token: worker.token })
  assert.deepEqual(afterGate.hints.map((hint) => hint.message.key), ['long_digit_run'])
  assert.equal(afterGate.hints[0].highlight, true)

  // 重算只下线同 producer 的旧批次：OCR(#125) 与 bundle_import(#124) 的行不能被动。
  const ocrRow = await request('/api/collections/review_findings/records', {
    method: 'POST', token: superAuth.token,
    body: {
      page: trapped.id, project: project.id, field_name: '莆田IPA', kind: 'merged_columns',
      severity: 'strong', message_key: 'column_collapse', params_json: '{}', evidence_json: '{}',
      producer: 'ocr', producer_version: 'ocr-v1', produced_at: '2026-09-01'
    }
  })
  const ruleRowsOf = (pageId) => request(`/api/collections/review_findings/records?filter=${encodeURIComponent(`page = "${pageId}" && producer = "rule"`)}`, { token: superAuth.token })
  const beforeRecompute = await ruleRowsOf(trapped.id)
  const beforeCurrent = beforeRecompute.items.filter((row) => row.superseded_at === '')
  assert.deepEqual(beforeCurrent.map((row) => `${row.kind}/${row.message_key}`).sort(), expectedFor(trappedRow))
  await request(`/api/fangji/pages/${trapped.id}/findings/recompute`, { method: 'POST', token: worker.token })
  const afterRuleRows = await ruleRowsOf(trapped.id)
  const freshRuleRows = afterRuleRows.items.filter((row) => row.superseded_at === '')
  assert.deepEqual(freshRuleRows.map((row) => `${row.kind}/${row.message_key}`).sort(), expectedFor(trappedRow),
    '重算后应当只剩一份当前批次')
  assert.ok(afterRuleRows.items.filter((row) => row.superseded_at !== '').length >= expectedFor(trappedRow).length,
    '旧批次必须留在库里')
  assert.ok(freshRuleRows.every((row) => row.produced_at !== ''))
  const ocrAfter = await request(`/api/collections/review_findings/records/${ocrRow.id}`, { token: superAuth.token })
  assert.equal(ocrAfter.superseded_at, '', '规则重算不得下线 OCR 生产者的疑点')
  const ruleFinding = freshRuleRows.find((row) => row.message_key === 'long_digit_run')
  assert.equal(ruleFinding.severity, 'strong')

  // 提交路径：刚提交的那一行要立刻参与判定，而不是等全量重算。
  const submit = await request(`/api/fangji/pages/${trapped.id}/submit`, {
    method: 'POST', token: worker.token,
    body: {
      rowJson: JSON.stringify({ 词条: '甲', 拼音: 'ka1', 莆田IPA: 'ua9999', 仙游IPA: 'ka', 释义: '第一（个）测试' }),
      text: '甲 ka1', leaseToken: claim.leaseToken
    }
  })
  assert.ok(submit)
  const submitted = await request(`/api/collections/review_findings/records?filter=${encodeURIComponent(`page = "${trapped.id}" && producer = "rule" && superseded_at = ""`)}`, { token: superAuth.token })
  const runs = submitted.items.filter((row) => row.message_key === 'long_digit_run')
  assert.equal(runs.length, 1)
  assert.deepEqual(JSON.parse(runs[0].params_json).runs, ['9999'], '应对刚提交的行重算，而不是导入原文')

  // p95：单条重算必须够便宜（#177 验收：提交路径不回退，基准 p95 < 50 ms）。
  const durations = []
  for (let i = 0; i < 30; i += 1) {
    const startedAt = Date.now()
    await request(`/api/fangji/pages/${paged.id}/findings/recompute`, { method: 'POST', token: boss.token })
    durations.push(Date.now() - startedAt)
  }
  durations.sort((a, b) => a - b)
  const p95 = durations[Math.floor(durations.length * 0.95) - 1]
  console.log(`ASSIST_P95 ${JSON.stringify({ samples: durations.length, p50: durations[Math.floor(durations.length / 2)], p95, max: durations[durations.length - 1] })}`)
  assert.ok(p95 < 50, `single-entry recompute p95 = ${p95} ms (>= 50ms)`)

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
