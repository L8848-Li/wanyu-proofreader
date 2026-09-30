import assert from 'node:assert/strict'

const base = process.env.PB_URL
const purposes = [
  'public_display',
  'internal_research',
  'model_training',
  'commercial_use',
  'redistribution',
  'raw_third_party_transfer'
]
const decisions = {
  public_display: 'allow',
  internal_research: 'deny',
  model_training: 'unknown',
  commercial_use: 'allow',
  redistribution: 'deny',
  raw_third_party_transfer: 'unknown'
}

async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined
  })
  const data = await response.json()
  assert.equal(response.status, status, JSON.stringify(data))
  return data
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD }
})
const token = admin.token

const empty = await api('/api/fangji/sources', { token })
assert.deepEqual(empty.items, [])

const generated = await api('/api/fangji/sources', {
  method: 'POST',
  token,
  status: 201,
  body: { title: '合成词典', format: 'csv', holder: '测试权利主体', scope: '测试地区', status: 'restricted' }
})
assert.match(generated.logical_id, /^src-[0-9a-f]{8}$/)
assert.equal(generated.status, 'restricted')
assert.equal(generated.undecided_purposes.length, purposes.length)

const blocked = await api(`/api/fangji/sources/${generated.id}/usages/model_training/gate`, { token })
assert.equal(blocked.decision, 'unknown')
assert.equal(blocked.blocked, true)

for (const purpose of purposes) {
  const saved = await api(`/api/fangji/sources/${generated.id}/usages/${purpose}`, {
    method: 'PUT',
    token,
    body: { decision: decisions[purpose], evidence_ref: '柜外：合成卷宗，不是授权文件正文' }
  })
  assert.equal(saved.decision, decisions[purpose])
  const gate = await api(`/api/fangji/sources/${generated.id}/usages/${purpose}/gate`, { token })
  assert.equal(gate.decision, decisions[purpose])
  assert.equal(gate.blocked, decisions[purpose] !== 'allow')
}

await api('/api/fangji/sources', {
  method: 'POST',
  token,
  status: 400,
  body: { title: '重复逻辑 ID', logical_id: generated.logical_id }
})

const reader = await api('/api/collections/users/records', {
  method: 'POST',
  body: {
    email: 'source-reader@example.com',
    name: 'reader',
    role: 'user',
    password: 'SourceTest12345!',
    passwordConfirm: 'SourceTest12345!'
  }
})
const readerAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: 'source-reader@example.com', password: 'SourceTest12345!' }
})
await api('/api/fangji/sources', { method: 'POST', token: readerAuth.token, status: 403, body: { title: '越权' } })

const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '来源关联夹具' }, status: 201 })
const linkedForm = new FormData()
linkedForm.set('file', new Blob(['词头,释义,PDF页码\n样例甲,合成释义,1\n']), 'linked.csv')
linkedForm.set('inspect_only', 'true')
linkedForm.set('source_id', generated.logical_id)
const linkedJob = await api(`/api/fangji/projects/${project.id}/imports/csv`, {
  method: 'POST', token, body: linkedForm, status: 202
})
assert.equal(linkedJob.source_link, 'linked')
assert.equal(linkedJob.source, generated.id)

const unknownForm = new FormData()
unknownForm.set('file', new Blob(['词头,释义,PDF页码\n样例乙,另一释义,1\n']), 'unknown.csv')
unknownForm.set('inspect_only', 'true')
const unknownJob = await api(`/api/fangji/projects/${project.id}/imports/csv`, {
  method: 'POST', token, body: unknownForm, status: 202
})
assert.equal(unknownJob.source_link, 'unknown')
assert.equal(unknownJob.source, '')

async function wait(job, status) {
  for (let i = 0; i < 100; i++) {
    const current = await api(`/api/collections/import_jobs/records/${job.id}`, { token })
    if (current.status === status) return current
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('import timeout')
}

await wait(unknownJob, 'validated')
await api(`/api/fangji/imports/${unknownJob.id}/commit`, { method: 'POST', token, status: 202 })
const completed = await wait(unknownJob, 'completed')
assert.equal(completed.source_link, 'unknown')
assert.equal(completed.success_count, 1)

const linkedProject = await api(`/api/fangji/projects/${project.id}`, {
  method: 'PATCH',
  token,
  body: { sourceId: generated.logical_id }
})
assert.equal(linkedProject.source, generated.id)

await api(`/api/fangji/projects/${project.id}/members/${reader.id}`, {
  method: 'PUT', token, body: { role: 'proofreader' }
})
const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
assert.equal(pages.items.length, 1)
await api('/api/fangji/sources', { token: readerAuth.token, status: 403 })
await api(`/api/fangji/sources/${generated.id}/usages/public_display/gate`, { token: readerAuth.token, status: 403 })

const stamped = await api(`/api/fangji/sources/${generated.id}/usages/public_display`, {
  method: 'PUT',
  token,
  body: { decision: 'allow', evidence_ref: 'off-repo:stamp', decided_at: 'not-a-date' }
})
assert.notEqual(stamped.decided_at, '')
assert.equal(String(stamped.decided_at).includes('not-a-date'), false)

await api(`/api/fangji/sources/${generated.id}`, {
  method: 'PATCH', token, status: 400, body: { logical_id: 'src-rewritten' }
})
const kept = await api(`/api/fangji/sources/${generated.id}`, { token })
assert.equal(kept.logical_id, generated.logical_id)

await api(`/api/fangji/sources/${generated.id}`, { method: 'DELETE', token, status: 400 })
const projectAfter = await api(`/api/fangji/projects/${project.id}`, { token })
assert.equal(projectAfter.source, generated.id)
const jobAfter = await api(`/api/collections/import_jobs/records/${linkedJob.id}`, { token })
assert.equal(jobAfter.source, generated.id)
assert.equal(jobAfter.source_link, 'linked')

console.log('PASS: source registry records six usage decisions, blocks unknown, and leaves unlinked imports marked source:unknown')
