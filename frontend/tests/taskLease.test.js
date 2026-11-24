import test from 'node:test'
import assert from 'node:assert/strict'

import { clearTaskLease, isTransientLeaseRenewalError, leaseExpiresSoon, loadTaskLease, saveTaskLease, taskLeaseKey } from '../src/lib/taskLease.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}

test('stores task lease tokens only in the provided session storage', () => {
  const storage = memoryStorage()
  const input = { userId: 'user-a', pageId: 'page-a', token: 'x'.repeat(64), expiresAt: '2026-09-04T10:00:00Z' }
  saveTaskLease(storage, input)
  assert.deepEqual(loadTaskLease(storage, input), { token: input.token, expiresAt: input.expiresAt })
  assert.match(taskLeaseKey(input.userId, input.pageId), /user-a:page-a$/)
  clearTaskLease(storage, input)
  assert.equal(loadTaskLease(storage, input), null)
})

test('detects leases that need renewal without trusting malformed dates', () => {
  const now = new Date('2026-09-04T09:50:00Z').getTime()
  assert.equal(leaseExpiresSoon('2026-09-04T09:54:00Z', now), false)
  assert.equal(leaseExpiresSoon('2026-09-04T09:52:00Z', now), true)
  assert.equal(leaseExpiresSoon('invalid', now), true)
})

test('lease renewal treats network and server failures as transient, authoritative rejections as lost', () => {
  const transient = [{ status: 0 }, { status: 500 }, { status: 503 }, { status: 408 }, { status: 429 }, new TypeError('Failed to fetch'), { response: { status: 502 } }]
  for (const error of transient) {
    assert.equal(isTransientLeaseRenewalError(error), true, JSON.stringify(error))
  }
  const authoritative = [{ status: 400 }, { status: 401 }, { status: 403 }, { status: 404 }, { status: 409 }]
  for (const error of authoritative) {
    assert.equal(isTransientLeaseRenewalError(error), false, JSON.stringify(error))
  }
})
