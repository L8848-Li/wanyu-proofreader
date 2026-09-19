#!/usr/bin/env node
// Fill a running instance with a reviewable demo: one project, a CSV imported
// through the real job pipeline, two agreeing submissions and one divergence
// left in arbitration, so a new developer or a pilot reviewer sees the whole
// workflow without hand-creating anything.
//
//   docker compose -f docker-compose.dev.yml up --build
//   node backend/tests/seed_demo.mjs
//
// Each run seeds a fresh, self-contained demo; FANGJI_DEMO_SUFFIX=demo reuses
// the same accounts and only adds another project.
import assert from 'node:assert/strict'

const base = (process.argv.find((arg) => arg.startsWith('--url=')) || '').split('=')[1]
  || process.env.PB_URL || 'http://127.0.0.1:8090'
const platformEmail = process.env.APP_ADMIN_EMAIL || 'admin@example.com'
const platformPassword = process.env.APP_ADMIN_PASSWORD || 'change-me-please'
const superEmail = process.env.PB_SUPER_EMAIL || process.env.PB_ADMIN_EMAIL || 'pb-admin@example.com'
const superPassword = process.env.PB_SUPER_PASSWORD || process.env.PB_ADMIN_PASSWORD || 'change-me-please-too'

const DEMO_PASSWORD = process.env.FANGJI_DEMO_PASSWORD || 'Demo12345678!'
const suffix = process.env.FANGJI_DEMO_SUFFIX || Date.now().toString(36)
const projectName = process.env.FANGJI_DEMO_PROJECT || `演示项目 · 莆仙校对 ${suffix}`

async function request(path, { method = 'GET', token, body, expected = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token || '', ...(form || !body ? {} : { 'Content-Type': 'application/json' }) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  })
  const raw = await response.text()
  let payload = null
  if (raw) {
    try { payload = JSON.parse(raw) } catch { payload = raw }
  }
  assert.equal(response.status, expected, `${method} ${path} -> ${response.status} ${raw}`)
  return payload
}

const csv = [
  '词条,PDF页码,读音,释义,备注',
  `徛,1,kiā,站、立,莆仙常用动词`,
  `䏝,2,lia̍h,肉,生僻字，验证扩展汉字显示`,
  '食,3,ia̍h,吃,',
  '啜,4,toh,抿、小口饮,',
  '囝,5,kiâ,孩子,',
  '爹,6,tia,父亲,与普通话义不同',
  '妈,7,má,母亲,',
  '祖,8,choó,祖父,',
  '身,9,sin,身体,',
  '目,10,ba̍k,眼睛,',
  '齿,11,khiú,牙齿,',
  '手,12,chiú,手臂,',
  '心,13,sim,心脏,引申为心思'
].join('\n')

const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: superEmail, password: superPassword }
})
const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: platformEmail, password: platformPassword }
})

async function ensureUser(label, email) {
  const existing = await request(`/api/collections/users/records?filter=${encodeURIComponent(`email="${email}"`)}`,
    { token: superAuth.token })
  if (existing.items.length) {
    console.log(`  reuse ${label.padEnd(10)} ${email}`)
    return existing.items[0]
  }
  const user = await request('/api/collections/users/records', {
    method: 'POST',
    token: superAuth.token,
    body: { email, password: DEMO_PASSWORD, passwordConfirm: DEMO_PASSWORD, name: label, role: 'user',
            must_change_password: false, verified: true }
  })
  console.log(`  create ${label.padEnd(10)} ${email}`)
  return user
}

console.log(`seeding ${base}`)
const staff = await ensureUser('演示管理员', `demo-manager-${suffix}@example.com`)
const staffAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: staff.email, password: DEMO_PASSWORD }
})
const proofreaders = []
for (const [index, label] of ['校对员甲', '校对员乙'].entries()) {
  const user = await ensureUser(label, `demo-reader${index + 1}-${suffix}@example.com`)
  proofreaders.push({ ...user, token: (await request('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: user.email, password: DEMO_PASSWORD }
  })).token })
}

// Project creation is platform-whitelisted, so the bootstrap admin creates it.
const project = await request('/api/fangji/projects', {
  method: 'POST',
  token: platformAuth.token,
  expected: 201,
  body: { name: projectName, description: '由 seed_demo.mjs 创建的演示项目，可安全删除。', status: 'active' }
})
await request(`/api/fangji/projects/${project.id}/members/${staff.id}`, {
  method: 'PUT', token: platformAuth.token, body: { role: 'manager' }
})
for (const reader of proofreaders) {
  await request(`/api/fangji/projects/${project.id}/members/${reader.id}`, {
    method: 'PUT', token: staffAuth.token, body: { role: 'proofreader' }
  })
}

const form = new FormData()
form.set('file', new Blob([csv], { type: 'text/csv' }), 'demo.csv')
const job = await request(`/api/fangji/projects/${project.id}/imports/csv`, {
  method: 'POST', token: staffAuth.token, expected: 202, body: form
})
let settled = null
for (let attempt = 0; attempt < 200; attempt++) {
  settled = await request(`/api/collections/import_jobs/records/${job.id}`, { token: staffAuth.token })
  if (['completed', 'failed'].includes(settled.status)) break
  await new Promise((resolve) => setTimeout(resolve, 100))
}
assert.equal(settled.status, 'completed', `import job did not finish: ${JSON.stringify(settled.error_json || settled)}`)

const pages = await request(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}&perPage=50&sort=page_number`,
  { token: staffAuth.token })
assert.ok(pages.items.length >= 5, `expected imported pages, got ${pages.items.length}`)
console.log(`  imported ${pages.items.length} entries`)

async function submit(page, reader, overrides) {
  // Submissions must carry exactly the original field set, so start from the
  // imported row and only overwrite the values under review.
  const row = { ...JSON.parse(page.ocr_row_json || '{}'), ...overrides }
  const claim = await request(`/api/fangji/projects/${project.id}/claim`, { method: 'POST', token: reader.token })
  assert.equal(claim.id, page.id, 'the seeded claim must take the requested page')
  return request(`/api/fangji/pages/${page.id}/submit`, {
    method: 'POST',
    token: reader.token,
    body: { rowJson: JSON.stringify(row), text: Object.values(row).join(' '), leaseToken: claim.leaseToken }
  })
}

const [agreeing, diverging] = pages.items
await submit(agreeing, proofreaders[0], { 释义: '站、立', 读音: 'kiā' })
await submit(agreeing, proofreaders[1], { 释义: '站、立', 读音: 'kiā' })
await submit(diverging, proofreaders[0], { 释义: '肉（左月右穴）', 读音: 'lia̍h' })
await submit(diverging, proofreaders[1], { 释义: '肉', 读音: 'lih' })

const pending = await request(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}" && status="arbitration"`)}`,
  { token: staffAuth.token })
console.log(`
seeded demo project ${project.id}
  agreed entry   : ${agreeing.id} -> proofread
  needs you      : ${pending.totalItems} page(s) awaiting arbitration on ${diverging.id}
  logins         : ${staff.email} / ${proofreaders.map((reader) => reader.email).join(', ')}
  password       : ${DEMO_PASSWORD}
  project        : ${projectName}
Open ${base} and sign in as ${staff.email} to arbitrate, or as a reader to keep proofreading.`)
if (!pending.totalItems) {
  console.log('note: no page reached arbitration; check the quorum setting for this project.')
}
