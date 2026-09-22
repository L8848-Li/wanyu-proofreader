import assert from 'node:assert/strict'

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
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await response.text()
  let payload = null
  if (raw) {
    try { payload = JSON.parse(raw) } catch { payload = raw }
  }
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${raw}`)
  return payload
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'ReviewedTasks123!'
const projectIds = []
const userIds = []
const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: platformEmail, password: platformPassword }
})
const superAuth = await request('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: { identity: superEmail, password: superPassword }
})

const concealedKeys = [
  'round',
  'pass_no',
  'required_proofreads',
  'proofread_count',
  'first_proofreader',
  'second_proofreader',
  'proofread_round'
]

function assertBlindCursor(payload, label) {
  const serialized = JSON.stringify(payload)
  for (const field of concealedKeys) {
    assert.equal(serialized.includes(`"${field}"`), false, `${label} leaked ${field}`)
  }
}

async function createUser(label) {
  const email = `${label}-${suffix}@example.com`
  const user = await request('/api/collections/users/records', {
    method: 'POST',
    token: superAuth.token,
    body: { email, password, passwordConfirm: password, name: label, role: 'user' }
  })
  userIds.push(user.id)
  const auth = await request('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: email, password }
  })
  return { id: user.id, token: auth.token }
}

async function createProject(name, users) {
  const project = await request('/api/fangji/projects', {
    method: 'POST',
    token: platformAuth.token,
    expected: 201,
    body: { name: `${name} ${suffix}` }
  })
  projectIds.push(project.id)
  for (const user of users) {
    await request(`/api/fangji/projects/${project.id}/members/${user.id}`, {
      method: 'PUT',
      token: platformAuth.token,
      body: { role: 'proofreader' }
    })
  }
  return project
}

async function createPage(projectId, pageNumber, value) {
  return request('/api/collections/pages/records', {
    method: 'POST',
    token: superAuth.token,
    body: {
      project: projectId,
      page_number: pageNumber,
      pdf_page: pageNumber,
      ocr_row_json: JSON.stringify({ 词条: value }),
      ocr_text: value,
      proofread_round: 1,
      mismatch_count: 0,
      status: 'pending'
    }
  })
}

async function claimAndSubmit(projectId, user, value, expectedPageId) {
  const claim = await request(`/api/fangji/projects/${projectId}/claim`, {
    method: 'POST',
    token: user.token
  })
  if (expectedPageId) assert.equal(claim.id, expectedPageId)
  const result = await request(`/api/fangji/pages/${claim.id}/submit`, {
    method: 'POST',
    token: user.token,
    body: {
      rowJson: JSON.stringify({ 词条: value }),
      text: value,
      leaseToken: claim.leaseToken
    }
  })
  return { claim, result }
}

const first = await createUser('reviewed-first')
const second = await createUser('reviewed-second')
const outsider = await createUser('reviewed-outsider')

try {
  const project = await createProject('Reviewed cursor', [first, second])
  const otherProject = await createProject('Reviewed other', [second])
  const page1 = await createPage(project.id, 1, '条目一')
  const page3 = await createPage(project.id, 3, '条目三')

  await request(`/api/fangji/projects/${project.id}/tasks/reviewed`, { expected: 401 })
  await request(`/api/fangji/projects/${project.id}/tasks/reviewed`, {
    token: outsider.token,
    expected: 403
  })
  await request(`/api/fangji/projects/${otherProject.id}/tasks/reviewed`, {
    token: first.token,
    expected: 403
  })

  const emptyReviewed = await request(`/api/fangji/projects/${project.id}/tasks/reviewed`, {
    token: first.token
  })
  assert.deepEqual(emptyReviewed, { items: [], position: 0, total: 0 })
  assertBlindCursor(emptyReviewed, 'empty reviewed cursor')

  const firstClaim = await request(`/api/fangji/projects/${project.id}/claim`, {
    method: 'POST',
    token: first.token
  })
  assert.equal(firstClaim.id, page1.id)
  const activeMine = await request(`/api/fangji/projects/${project.id}/tasks/mine`, {
    token: first.token
  })
  assert.deepEqual(activeMine, [{ id: page1.id, page_number: 1 }])

  const activeTask = await request(`/api/fangji/pages/${page1.id}/task`, { token: first.token })
  assert.equal(activeTask.id, page1.id)
  assert.equal(activeTask.proofreader, first.id)
  assert.equal(activeTask.readonly, undefined)
  assert.equal(activeTask.proofread_row_json, undefined)
  assert.equal(activeTask.proofread_text, undefined)
  assertBlindCursor(activeTask, 'active assigned task')

  await request(`/api/fangji/pages/${page1.id}/task`, { token: second.token, expected: 403 })
  await request(`/api/fangji/pages/${page1.id}/task?mode=review`, { token: second.token, expected: 403 })
  await request(`/api/fangji/pages/${page3.id}/task`, { token: first.token, expected: 403 })
  await request(`/api/fangji/pages/${page3.id}/task?mode=review`, { token: first.token, expected: 403 })

  const firstSubmit = await request(`/api/fangji/pages/${page1.id}/submit`, {
    method: 'POST',
    token: first.token,
    body: {
      rowJson: JSON.stringify({ 词条: '条目一甲' }),
      text: '条目一甲',
      leaseToken: firstClaim.leaseToken
    }
  })
  assert.equal(firstSubmit.status, 'proofread')

  const mineAfterSubmit = await request(`/api/fangji/projects/${project.id}/tasks/mine`, {
    token: first.token
  })
  assert.deepEqual(mineAfterSubmit, [])

  const reviewedAfterFirst = await request(
    `/api/fangji/projects/${project.id}/tasks/reviewed?pageId=${page1.id}`,
    { token: first.token }
  )
  assert.equal(reviewedAfterFirst.total, 1)
  assert.equal(reviewedAfterFirst.position, 1)
  assert.equal(reviewedAfterFirst.items.length, 1)
  assert.equal(reviewedAfterFirst.items[0].id, page1.id)
  assert.equal(reviewedAfterFirst.items[0].page_number, 1)
  assert.equal(typeof reviewedAfterFirst.items[0].submitted_at, 'string')
  assert.ok(reviewedAfterFirst.items[0].submitted_at)
  assert.match(
    reviewedAfterFirst.items[0].submitted_at,
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/,
    'submitted_at should be a datetime string'
  )
  assert.equal(Object.keys(reviewedAfterFirst.items[0]).sort().join(','), 'id,page_number,submitted_at')
  assertBlindCursor(reviewedAfterFirst, 'first reviewed cursor')

  await request(`/api/fangji/pages/${page1.id}/task`, { token: first.token, expected: 403 })

  const secondEmpty = await request(`/api/fangji/projects/${project.id}/tasks/reviewed`, {
    token: second.token
  })
  assert.deepEqual(secondEmpty.items, [])
  assert.equal(secondEmpty.total, 0)

  await request(`/api/fangji/pages/${page1.id}/task`, { token: second.token, expected: 403 })

  const secondClaim = await request(`/api/fangji/projects/${project.id}/claim`, {
    method: 'POST',
    token: second.token
  })
  assert.equal(secondClaim.id, page1.id)
  const secondMine = await request(`/api/fangji/projects/${project.id}/tasks/mine`, {
    token: second.token
  })
  assert.deepEqual(secondMine, [{ id: page1.id, page_number: 1 }])
  const firstMineUnchanged = await request(`/api/fangji/projects/${project.id}/tasks/mine`, {
    token: first.token
  })
  assert.deepEqual(firstMineUnchanged, [])

  const secondActiveTask = await request(`/api/fangji/pages/${page1.id}/task`, { token: second.token })
  assert.equal(secondActiveTask.proofreader, second.id)
  assert.equal(secondActiveTask.readonly, undefined)
  assert.equal(secondActiveTask.proofread_row_json, undefined)
  assert.equal(secondActiveTask.proofread_text, undefined)
  assert.equal(JSON.stringify(secondActiveTask).includes('条目一甲'), false, 'active task leaked another proofreader submission')

  const firstReadonly = await request(`/api/fangji/pages/${page1.id}/task?mode=review`, { token: first.token })
  assert.equal(firstReadonly.readonly, true)
  assert.equal(firstReadonly.proofreader, undefined)
  assert.equal('status' in firstReadonly, false, 'readonly task leaked page status')
  assert.equal(firstReadonly.proofread_text, '条目一甲')
  assert.equal(JSON.parse(firstReadonly.proofread_row_json).词条, '条目一甲')
  assert.equal(firstReadonly.ocr_text, '条目一')
  assertBlindCursor(firstReadonly, 'own readonly task')
  await request(`/api/fangji/pages/${page1.id}/task`, { token: first.token, expected: 403 })

  await claimAndSubmit(project.id, first, '条目三甲', page3.id)

  const page2 = await createPage(project.id, 2, '条目二')
  await claimAndSubmit(project.id, first, '条目二甲', page2.id)

  const ordered = await request(
    `/api/fangji/projects/${project.id}/tasks/reviewed?pageId=${page2.id}`,
    { token: first.token }
  )
  assert.deepEqual(ordered.items.map((item) => item.page_number), [1, 2, 3])
  assert.deepEqual(ordered.items.map((item) => item.id), [page1.id, page2.id, page3.id])
  assert.equal(ordered.position, 2)
  assert.equal(ordered.total, 3)
  const unorderedCursor = await request(`/api/fangji/projects/${project.id}/tasks/reviewed`, {
    token: first.token
  })
  assert.equal(unorderedCursor.position, 0)
  assert.equal(unorderedCursor.total, 3)
  await request(
    `/api/fangji/projects/${project.id}/tasks/reviewed?pageId=not-a-valid-id`,
    { token: first.token, expected: 400 }
  )

  const secondSubmit = await request(`/api/fangji/pages/${page1.id}/submit`, {
    method: 'POST',
    token: second.token,
    body: {
      rowJson: JSON.stringify({ 词条: '条目一乙' }),
      text: '条目一乙',
      leaseToken: secondClaim.leaseToken
    }
  })
  assert.equal(secondSubmit.status, 'arbitration')

  await request(`/api/fangji/pages/${page1.id}/task`, { token: first.token, expected: 403 })
  await request(`/api/fangji/pages/${page1.id}/task`, { token: second.token, expected: 403 })
  const firstOwn = await request(`/api/fangji/pages/${page1.id}/task?mode=review`, { token: first.token })
  const secondOwn = await request(`/api/fangji/pages/${page1.id}/task?mode=review`, { token: second.token })
  assert.equal(firstOwn.proofread_text, '条目一甲')
  assert.equal(secondOwn.proofread_text, '条目一乙')
  assert.equal('status' in firstOwn, false, 'arbitration readonly leaked page status')
  assert.equal('status' in secondOwn, false, 'arbitration readonly leaked page status')
  assert.equal(JSON.stringify(firstOwn).includes('条目一乙'), false)
  assert.equal(JSON.stringify(secondOwn).includes('条目一甲'), false)
  assertBlindCursor(firstOwn, 'first arbitration readonly')
  assertBlindCursor(secondOwn, 'second arbitration readonly')

  const secondReviewed = await request(`/api/fangji/projects/${project.id}/tasks/reviewed`, {
    token: second.token
  })
  assert.deepEqual(secondReviewed.items.map((item) => item.id), [page1.id])
  assert.equal(secondReviewed.total, 1)

  const resubmit = await request(`/api/fangji/pages/${page1.id}/submit`, {
    method: 'POST',
    token: first.token,
    expected: 400,
    body: {
      rowJson: JSON.stringify({ 词条: '重提' }),
      text: '重提',
      leaseToken: firstClaim.leaseToken
    }
  })
  // After submit, ownership is cleared, so this is rejected by the assignment
  // gate rather than the duplicate-attempt check.
  assert.match(String(resubmit?.message || ''), /该条目当前不属于你/)

  const stalePage = await createPage(project.id, 9, '旧轮')
  await request('/api/collections/proofreading_attempts/records', {
    method: 'POST',
    token: superAuth.token,
    body: {
      page: stalePage.id,
      project: project.id,
      proofreader: first.id,
      round: 2,
      pass_no: 1,
      kind: 'proofread',
      row_json: JSON.stringify({ 词条: '旧轮' }),
      text: '旧轮',
      outcome: 'waiting',
      submitted_at: new Date().toISOString().replace('T', ' ')
    }
  })
  const afterStaleRound = await request(`/api/fangji/projects/${project.id}/tasks/reviewed`, {
    token: first.token
  })
  assert.deepEqual(afterStaleRound.items.map((item) => item.id), [page1.id, page2.id, page3.id])
  assert.equal(afterStaleRound.total, 3)
  await request(`/api/fangji/pages/${stalePage.id}/task`, { token: first.token, expected: 403 })
  await request(`/api/fangji/pages/${stalePage.id}/task?mode=review`, { token: first.token, expected: 403 })

  console.log('Reviewed tasks cursor integration test passed.')
} finally {
  for (const projectId of projectIds.reverse()) {
    await request(`/api/fangji/projects/${projectId}`, {
      method: 'DELETE', token: platformAuth.token, expected: 204
    })
  }
  for (const userId of userIds.reverse()) {
    await request(`/api/collections/users/records/${userId}`, {
      method: 'DELETE', token: superAuth.token, expected: 204
    })
  }
}
