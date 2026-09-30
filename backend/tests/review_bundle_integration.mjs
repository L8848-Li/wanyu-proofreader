import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.PB_URL
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../reviewbundle/testdata/review-bundle-v0')

async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (form ? body : JSON.stringify(body)) : undefined,
  })
  const data = await response.json()
  assert.equal(response.status, status, JSON.stringify(data))
  return data
}

async function totals(token) {
  const counts = {}
  for (const name of ['projects', 'pages', 'import_jobs', 'users']) {
    const data = await api(`/api/collections/${name}/records?perPage=1`, { token })
    counts[name] = data.totalItems
  }
  return counts
}

async function postZip(token, fileName, status = 200) {
  const bytes = await readFile(join(fixtures, fileName))
  const form = new FormData()
  form.set('bundle', new Blob([bytes]), fileName)
  return api('/api/fangji/bundles/validate', { method: 'POST', token, body: form, status })
}

const admin = await api('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD },
})
let token = admin.token
if (admin.record.must_change_password) {
  const superAuth = await api('/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD },
  })
  await api(`/api/collections/users/records/${admin.record.id}`, {
    method: 'PATCH', token: superAuth.token, body: { must_change_password: false },
  })
  const refreshed = await api('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: process.env.APP_ADMIN_EMAIL, password: process.env.APP_ADMIN_PASSWORD },
  })
  token = refreshed.token
}
const superAuth = await api('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: process.env.PB_SUPER_EMAIL, password: process.env.PB_SUPER_PASSWORD },
})

const anonymous = await fetch(base + '/api/fangji/bundles/validate', { method: 'POST' })
assert.equal(anonymous.status, 401)

const before = await totals(superAuth.token)
const inbound = await postZip(token, 'inbound.zip')
assert.equal(inbound.ok, true)
assert.equal(inbound.schema_version, 'ReviewBundle/v0')
assert.equal(inbound.entry_count, 2)
assert.deepEqual(inbound.errors, [])
const repeated = await postZip(token, 'inbound.zip')
assert.deepEqual(repeated, inbound)
const result = await postZip(token, 'result.zip')
assert.equal(result.ok, true)
assert.equal(result.schema_version, 'ReviewResultBundle/v0')
assert.equal(result.bundle_id, 'rrb-synthetic-0001')
const missing = await postZip(token, 'missing-manifest.zip')
assert.equal(missing.ok, false)
assert.equal(missing.errors[0].code, 'manifest_missing')
assert.match(missing.errors[0].message, /缺少 manifest.json/)
assert.match(missing.errors[0].message, /未写入任何数据/)
const after = await totals(superAuth.token)
assert.deepEqual(after, before)
console.log('PASS: review bundle validation reports diagnostics and does not change records')
