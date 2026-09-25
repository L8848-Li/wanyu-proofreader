import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildLabels, scoreRules, stripSecrets, wilsonInterval, suggestGate } from '../../scripts/assist/lib/labeling.mjs'
import { readDataset, loadFromSqlite, loadFromRecords } from '../../scripts/assist/weak_labels.mjs'
import { defaultRuleSet } from '../../scripts/assist/score_rules.mjs'

const require = createRequire(import.meta.url)
const keyboard = require('../keyboards/hinghwa-dialect.json')

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18091'
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST', body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST', body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})

async function request(url, { method = 'GET', token = '', body, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await response.text()
  let payload = null
  if (raw) { try { payload = JSON.parse(raw) } catch { payload = raw } }
  assert.equal(response.status, expected, `${method} ${url}: ${response.status} ${raw}`)
  return payload
}

// ---------- 注入的 5 类已知陷阱（#179 验收：数字必须与手算一致）----------
// 手算表（作用域见 labeling.mjs 的 SCOPES；负例只有两处：A1/莆田IPA 与 A4/释义）
//   A1 把 ɑ 打成 a            → R2 命中且是负例(TP)；R3 无组合符；R1 无集外字符
//   A2 真人保留了 ASCII a      → R2 命中但是正例(FP)
//   A3 submitted 是 NFD 写法    → 与 final NFC 等价 ⇒ reason_code=unicode_equivalent，不算负例
//   A4 释义漏填                → R5 命中且是负例(TP)
// 由此：
//   R2 hits=3 (A1,A2,A3) tp=1 fp=2 → precision=1/3；作用域 ipa 的负例=1 → recall=1
//   R3 hits=1 (A3)       tp=0 fp=1 → precision=0；  ipa 负例=1 未命中 → recall=0
//   R1 hits=0 → precision n/a；     作用域 all 的负例=2 → recall=0
//   R6a/R6b hits=0 → precision n/a；作用域 reading 的负例=1 → recall=0
//   R5 hits=1 (A4)   tp=1 fp=0 → precision=1；role 作用域负例=2，命中 1 → recall=0.5
const fixture = require('../tests/fixtures/assist_traps.json')
const { pages, attempts, roles } = fixture
const submitted = Object.fromEntries(attempts.map((item) => [item.id, JSON.parse(item.row_json)]))
const rows = Object.fromEntries(pages.map((item) => [item.id, JSON.parse(item.final_row_json)]))

const labels = buildLabels({ pages, attempts })
const byPair = new Map(labels.map((item) => [`${item.attempt}/${item.field}`, item]))

assert.equal(labels.length, 16, '每份提交 4 个字段')
assert.equal(byPair.get('A1/莆田IPA').accepted, false, 'a 代 ɑ 必须是负例')
assert.equal(byPair.get('A1/词条').accepted, true)
assert.equal(byPair.get('A4/释义').accepted, false, '空释义必须是负例')
assert.equal(byPair.get('A3/莆田IPA').reason_code, 'unicode_equivalent', 'NFD/NFC 差量不得当成真实分歧')
assert.equal(byPair.get('A3/莆田IPA').accepted, true)
assert.equal(labels.filter((item) => !item.accepted).length, 2)

// 脱敏（#179 验收：仓库 diff 内无未授权语料正文；工具默认输出同样不许带正文）
const serialized = JSON.stringify(stripSecrets(labels))
for (const value of ['kɑ55', 'ka55', '第一', '丙', 'ã', '第四']) {
  assert.equal(serialized.includes(value), false, `脱敏输出里出现了正文片段 ${value}`)
}
assert.ok(serialized.includes('U+0303'), '码位属于结构信息，应当保留')

// ---------- 打分：逐条对上手算的期望值 ----------
const scored = scoreRules(labels, defaultRuleSet({ keyboards: [{ definition: keyboard }], roles }))
for (const [name, want] of Object.entries(fixture.expected)) {
  const item = scored.scored.find((entry) => entry.rule.startsWith(name))
  assert.ok(item, `规则 ${name} 没有出现在打分结果里`)
  for (const key of ['hits', 'tp', 'fp', 'fn', 'precision', 'recall']) {
    assert.equal(item[key], want[key], `${name}.${key} 与手算不符：${JSON.stringify(item)}`)
  }
  assert.equal(item.gate.gate, want.gate, name)
  assert.equal(item.gate.basis, want.basis, name)
}
assert.equal(scored.unicode_equivalent_excluded, fixture.unicode_equivalent_excluded, '伪分歧要被单独计数')
assert.deepEqual(stripSecrets(labels).filter((item) => !item.accepted)
  .map((item) => `${item.attempt}/${item.field}`).sort(), [...fixture.negative_pairs].sort())

// ---------- 打分覆盖度：引擎产出的每条规则都要被量到，或写明为什么不量 ----------
// `score_rules.mjs` 自己的注释就写了「#177 新增规则时这里要跟上，否则那条规则永远不会
// 出现在基线报告里（这是最容易漏的一步）」，而 #212 的评审独立抓到了同一形状
// （kind 集合手抄、当下一致但没人守）。所以这里从 assist_rules.js 抽出全部
// finding(kind, …, message_key) 身份，与打分表双向对账。
{
  const source = readFileSync(new URL('../../backend/pb_hooks/lib/assist_rules.js', import.meta.url), 'utf8')
  const emitted = [...new Set([...source.matchAll(
    /finding\(\s*"([a-z_]+)"\s*,\s*"[a-z]+"\s*,[^,]+,\s*"([a-z_]+)"/g)].map((m) => `${m[1]}/${m[2]}`))].sort()
  assert.ok(emitted.length >= 9, `从 assist_rules.js 抽出的规则身份太少，先怀疑正则：${JSON.stringify(emitted)}`)
  // 弱标注是 (提交, 字段) 粒度，整列/整项目判据天然对不上：明确列为不打分，而不是悄悄漏掉。
  const notScored = [
    'encoding_form_anomaly/mixed_normalization_forms',
    'punctuation_mix/punctuation_width_mixed_in_column',
    'page_outlier/pdf_page_backtrack',
    'page_outlier/page_entry_count_outlier'
  ]
  const ruleSet = defaultRuleSet({ keyboards: [{ definition: keyboard }], roles })
  const scoredSet = ruleSet.map((rule) => `${rule.kind}/${rule.message_key}`)
  assert.deepEqual(emitted.filter((id) => !scoredSet.includes(id) && !notScored.includes(id)), [],
    '引擎新增的规则身份没进基线打分表')
  assert.deepEqual(scoredSet.filter((id) => !emitted.includes(id)), [],
    '打分表里留着引擎不再产出的规则身份')
  // 豁免名单自己也不能变宽：既在名单里又仍在打分，说明有人在用名单掩盖漏掉的规则；
  // 名单里的身份若已不是引擎产出的，也必须删掉。这两条是上一轮变异测试逼出来的。
  assert.deepEqual(scoredSet.filter((id) => notScored.includes(id)), [],
    '一条规则不可能既被打分又被声明为不打分')
  for (const id of notScored) {
    assert.ok(emitted.includes(id), `n/a 名单里的 ${id} 已不是引擎产出的身份，应从名单删掉`)
  }
  assert.equal(new Set(notScored).size, notScored.length, '豁免名单有重复项')
}

// Wilson 单独校一次：手算 centre 0.426917 ± half 0.365408 = [0.061509, 0.792325]，
// 模块按 4 位小数取整。第一版我把它抄成 3dp 字面量，那是抄错不是实现错。
assert.deepEqual(scored.scored.find((e) => e.rule.startsWith('R2')).wilson, { lower: 0.0615, upper: 0.7923 })

// 没有列角色时 R5 根本不该参与打分（不是 0 分，是不存在）
const noRoles = scoreRules(labels, defaultRuleSet({ keyboards: [{ definition: keyboard }] }))
assert.equal(noRoles.scored.some((item) => item.rule.startsWith('R5')), false)
assert.equal(noRoles.scored.length, 5)

// ---------- 门槛判据本身 ----------
assert.deepEqual(suggestGate(0, 0), { gate: 'off', basis: 'n/a', note: '无命中样本，证据不足以下结论' })
assert.equal(suggestGate(100, 0.95).gate, 'strong')
assert.equal(suggestGate(99, 0.99).gate, 'off', 'n 差一个都不许升 strong')
assert.equal(suggestGate(150, 0.65).gate, 'warn')
// 门槛文件 §2 明写「两档的 n_min 不要求单调」：n=149 不满足 warn 的 150，
// 但满足 strong 的 100 与 0.90 ⇒ 跳档直取 strong 是规定行为，不是漏洞。
assert.equal(suggestGate(149, 0.99).gate, 'strong')
assert.equal(suggestGate(149, 0.65).gate, 'off', '149 例不足以升 warn，也远不到 strong 的精度')
assert.equal(suggestGate(149, 0.65).basis, 'n/a')
assert.equal(suggestGate(200, 0.85).gate, 'warn', '够 warn 的 n 但 p̂ 不到 0.90')
assert.equal(suggestGate(200, 0.55).gate, 'off', '两档精度都不达标')
assert.equal(suggestGate(200, 0.55).basis.startsWith('p̂=0.5500 未达任何档'), true,
  '只有 n 达标之后，「精度不足」这个结论才允许出现')
assert.equal(suggestGate(200, 0.55).note, '有证据表明精度不足')

// ---------- 读取路径与真实库的列名一致（跨实现互校）----------
const memory = new DatabaseSync(':memory:')
memory.exec(`CREATE TABLE pages (id TEXT PRIMARY KEY, project TEXT, proofread_row_json TEXT, status TEXT)`)
memory.exec(`CREATE TABLE proofreading_attempts (id TEXT PRIMARY KEY, page TEXT, project TEXT,
  round INTEGER, pass_no INTEGER, kind TEXT, proofreader TEXT, row_json TEXT, submitted_at TEXT)`)
for (const page of pages) {
  memory.prepare('INSERT INTO pages VALUES (?, ?, ?, ?)').run(page.id, page.project, page.final_row_json, page.status)
}
for (const attempt of attempts) {
  memory.prepare('INSERT INTO proofreading_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(attempt.id, attempt.page, attempt.project, attempt.round, 1, attempt.kind, attempt.proofreader, attempt.row_json, attempt.submitted_at)
}
const fromSqlite = buildLabels(readDataset(memory))
assert.deepEqual(stripSecrets(fromSqlite), stripSecrets(labels), 'SQL 读到的数据必须与 JSON 导出等价')
memory.close()

const exportPath = path.join(tmpdir(), `assist-records-${Date.now()}.json`)
writeFileSync(exportPath, JSON.stringify({ pages, attempts }))
assert.deepEqual(buildLabels(loadFromRecords(exportPath)).length, labels.length)
const dbPath = path.join(tmpdir(), `assist-db-${Date.now()}.db`)
const disk = new DatabaseSync(dbPath)
disk.exec(`CREATE TABLE pages (id TEXT PRIMARY KEY, project TEXT, proofread_row_json TEXT, status TEXT)`)
disk.exec(`CREATE TABLE proofreading_attempts (id TEXT PRIMARY KEY, page TEXT, project TEXT,
  round INTEGER, pass_no INTEGER, kind TEXT, proofreader TEXT, row_json TEXT, submitted_at TEXT)`)
disk.close()
assert.deepEqual(loadFromSqlite(dbPath), { pages: [], attempts: [] }, '空库应读到空集合而不是报错')
unlinkSync(dbPath)
unlinkSync(exportPath)

// ---------- 真库形状：用 PocketBase 的真实列建记录再读回，防止列名写错而静默空跑 ----------
const project = await request('/api/fangji/projects', {
  method: 'POST', token: platformAuth.token, expected: 201,
  body: { name: `assist-baseline-${Date.now()}` }
})
// proofreader 是指向 users 的 relation，塞 superuser id 会被外键校验拒绝。
const volunteer = await request('/api/collections/users/records', {
  method: 'POST', token: superAuth.token,
  body: { email: `assist-${Date.now()}@example.com`, password: 'AssistBaseline123!',
    passwordConfirm: 'AssistBaseline123!', name: 'assist', role: 'user' }
})
const page = await request('/api/collections/pages/records', {
  method: 'POST', token: superAuth.token,
  body: {
    project: project.id, page_number: 1, pdf_page: 1, status: 'arbitration',
    proofread_round: 1, mismatch_count: 1,
    ocr_row_json: JSON.stringify(rows.P1), proofread_row_json: JSON.stringify(rows.P1)
  }
})
const attempt = await request('/api/collections/proofreading_attempts/records', {
  method: 'POST', token: superAuth.token,
  body: {
    page: page.id, project: project.id, proofreader: volunteer.id,
    round: 1, pass_no: 1, kind: 'proofread', outcome: 'mismatched',
    row_json: JSON.stringify(submitted.A1), submitted_at: '2026-09-20 10:00:00.000Z'
  }
})
const livePages = await request(`/api/collections/pages/records?filter=${encodeURIComponent(`project = "${project.id}"`)}`, { token: superAuth.token })
const liveAttempts = await request(`/api/collections/proofreading_attempts/records?filter=${encodeURIComponent(`project = "${project.id}"`)}`, { token: superAuth.token })
const liveLabels = buildLabels({
  pages: livePages.items.map((item) => ({ id: item.id, project: item.project, final_row_json: item.proofread_row_json })),
  attempts: liveAttempts.items.map((item) => ({
    id: item.id, page: item.page, project: item.project, round: item.round,
    kind: item.kind, proofreader: item.proofreader, row_json: item.row_json
  }))
})
assert.equal(liveLabels.length, 4)
assert.equal(liveLabels.filter((item) => !item.accepted).length, 1)
assert.equal(liveLabels.find((item) => item.field === '莆田IPA').accepted, false,
  '真实 PocketBase 记录必须能还原出同一处 a/ɑ 分歧')
assert.equal(liveLabels[0].attempt, attempt.id)
const liveScored = scoreRules(liveLabels, defaultRuleSet({ keyboards: [{ definition: keyboard }] }))
assert.equal(liveScored.scored.find((item) => item.rule.startsWith('R2')).tp, 1)
assert.equal(liveScored.unicode_equivalent_excluded, 0)

await request(`/api/collections/proofreading_attempts/records/${attempt.id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
await request(`/api/collections/pages/records/${page.id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })
await request(`/api/fangji/projects/${project.id}`, { method: 'DELETE', token: platformAuth.token, expected: 204 })
await request(`/api/collections/users/records/${volunteer.id}`, { method: 'DELETE', token: superAuth.token, expected: 204 })

console.log('Assist baseline spike integration test passed.')
