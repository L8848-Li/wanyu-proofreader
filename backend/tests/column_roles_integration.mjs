import assert from 'node:assert/strict'

const base = process.env.PB_URL

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
const project = await api('/api/fangji/projects', { method: 'POST', token, body: { name: '列角色夹具' }, status: 201 })
const form = new FormData()
form.set('file', new Blob(['词头,释义,PDF页码\n样例,合成释义,1\n']), 'roles.csv')
form.set('inspect_only', 'true')
const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, { method: 'POST', token, body: form, status: 202 })

async function waitJob(jobId, status) {
  for (let i = 0; i < 100; i++) {
    const current = await api(`/api/collections/import_jobs/records/${jobId}`, { token })
    if (current.status === status) return current
    assert.notEqual(current.status, 'failed', JSON.stringify(current))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('import timeout')
}

async function importCsv(projectId, name, csv) {
  const upload = new FormData()
  upload.set('file', new Blob([csv]), name)
  upload.set('inspect_only', 'true')
  const created = await api(`/api/fangji/projects/${projectId}/imports/csv`, {
    method: 'POST', token, body: upload, status: 202
  })
  await waitJob(created.id, 'validated')
  await api(`/api/fangji/imports/${created.id}/commit`, { method: 'POST', token, status: 202 })
  await waitJob(created.id, 'completed')
}

await waitJob(job.id, 'validated')
await api(`/api/fangji/imports/${job.id}/commit`, { method: 'POST', token, status: 202 })
await waitJob(job.id, 'completed')

const before = await api(`/api/fangji/projects/${project.id}/column-roles`, { token })
assert.equal(before.roles.词头, 'unspecified')
assert.equal(before.roles.释义, 'unspecified')
assert.equal(before.roles.PDF页码, undefined)

const pages = await api(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}`, { token })
const page = pages.items[0]
const ocrBefore = page.ocr_row_json
const proofBefore = page.proofread_row_json
const headersBefore = page.row_headers_json

const saved = await api(`/api/fangji/projects/${project.id}/column-roles`, {
  method: 'PUT',
  token,
  body: { roles: { 词头: 'headword', 释义: 'meaning', 旧列: 'reading' } }
})
assert.equal(saved.roles.词头, 'headword')
assert.equal(saved.roles.释义, 'meaning')
assert.equal(saved.roles.旧列, 'reading')
assert.equal(saved.columns.find((column) => column.name === '旧列').present, false)
assert.equal(saved.columns.find((column) => column.name === '词头').present, true)

const after = await api(`/api/collections/pages/records/${page.id}`, { token })
assert.equal(after.ocr_row_json, ocrBefore)
assert.equal(after.proofread_row_json, proofBefore)
assert.equal(after.row_headers_json, headersBefore)

await api(`/api/fangji/projects/${project.id}/column-roles`, {
  method: 'PUT',
  token,
  status: 400,
  body: { roles: { 词头: 'not-a-role' } }
})

const outsider = await api('/api/collections/users/records', {
  method: 'POST',
  body: {
    email: 'column-outsider@example.com',
    name: 'outsider',
    role: 'user',
    password: 'ColumnTest12345!',
    passwordConfirm: 'ColumnTest12345!'
  }
})
const outsiderAuth = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: 'column-outsider@example.com', password: 'ColumnTest12345!' }
})
await api(`/api/fangji/projects/${project.id}/column-roles`, {
  method: 'PUT', token: outsiderAuth.token, status: 403, body: { roles: { 词头: 'headword' } }
})
await api(`/api/fangji/projects/${project.id}/members/${outsider.id}`, { method: 'PUT', token, body: { role: 'proofreader' } })
await api(`/api/fangji/projects/${project.id}/column-roles`, { token: outsiderAuth.token, status: 403 })
await api(`/api/fangji/projects/${project.id}/column-roles`, {
  method: 'PUT', token: outsiderAuth.token, status: 403, body: { roles: { 词头: 'unspecified' } }
})

const split = await api('/api/fangji/projects', {
  method: 'POST', token, body: { name: '列角色分列夹具' }, status: 201
})
await importCsv(split.id, 'meaning.csv', '词头,释义,PDF页码\n甲,意思,1\n')
await importCsv(split.id, 'example.csv', '词头,例句,PDF页码\n乙,,2\n')
const splitPages = await api(
  `/api/collections/pages/records?perPage=10&sort=page_number&filter=${encodeURIComponent(`project="${split.id}"`)}`,
  { token }
)
assert.equal(splitPages.items.length, 2)
const pageWithExample = splitPages.items.find((item) => item.ocr_row_json.includes('例句'))
const pageWithMeaning = splitPages.items.find((item) => item.ocr_row_json.includes('"释义"'))
const listed = await api(`/api/fangji/projects/${split.id}/column-roles`, { token })
assert.equal(listed.columns.some((column) => column.name === '例句' && column.present), true)
assert.equal(listed.columns.some((column) => column.name === '释义' && column.present), true)

const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD }
})
async function openFindings(projectId) {
  const data = await api(
    `/api/collections/review_findings/records?perPage=100&filter=${encodeURIComponent(`project="${projectId}"`)}`,
    { token: superAuth.token }
  )
  return data.items.filter((item) => !item.superseded_at && item.message_key === 'required_role_field_empty')
}

await api(`/api/fangji/projects/${split.id}/column-roles`, {
  method: 'PUT', token, body: { roles: { 例句: 'meaning' } }
})
await api(`/api/fangji/projects/${split.id}/findings/recompute`, { method: 'POST', token })
let missing = await openFindings(split.id)
assert.equal(missing.filter((item) => item.page === pageWithExample.id && item.field_name === '例句').length, 1)
assert.equal(missing.filter((item) => item.page === pageWithMeaning.id).length, 0)
await api(`/api/fangji/pages/${pageWithExample.id}/findings/recompute`, { method: 'POST', token })
await api(`/api/fangji/projects/${split.id}/findings/recompute`, { method: 'POST', token })
missing = await openFindings(split.id)
assert.equal(missing.filter((item) => item.page === pageWithExample.id && item.field_name === '例句').length, 1)

await api(`/api/fangji/projects/${split.id}/column-roles`, {
  method: 'PUT', token, body: { roles: { 释义: 'meaning' } }
})
await api(`/api/fangji/projects/${split.id}/findings/recompute`, { method: 'POST', token })
missing = await openFindings(split.id)
assert.equal(missing.filter((item) => item.page === pageWithExample.id).length, 0)
const exampleAfter = await api(`/api/collections/pages/records/${pageWithExample.id}`, { token: superAuth.token })
assert.notEqual(exampleAfter.difficulty_tier, 'B')

console.log('PASS: column roles are metadata and do not change imported or proofread row bytes')
