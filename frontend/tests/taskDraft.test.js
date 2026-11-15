import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearTaskDraft,
  loadTaskDraft,
  loadTaskDraftHistory,
  saveTaskDraft,
  setTaskFlash,
  takeTaskFlash,
  taskDraftKey
} from '../src/lib/taskDraft.js'
import { insertTextAtSelection } from '../src/composables/useStructuredRow.js'

function memoryStorage() {
  const data = new Map()
  return {
    get length() {
      return data.size
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key)
  }
}

test('inserts special characters at the caret and replaces selections', () => {
  assert.deepEqual(insertTextAtSelection('abcd', 'ŋ', 2, 2), {
    value: 'abŋcd',
    cursor: 3
  })
  assert.deepEqual(insertTextAtSelection('abcd', 'ŋ', 1, 3), {
    value: 'aŋd',
    cursor: 2
  })
})

test('persists, validates and clears a compatible task draft', () => {
  const storage = memoryStorage()
  const input = {
    userId: 'user-1',
    pageId: 'page-1',
    sourceSignature: '{"词条":"天光"}',
    row: { 词条: '天光', 释义: '清晨' },
    savedAt: '2026-07-23T08:00:00.000Z'
  }
  saveTaskDraft(storage, input)
  assert.deepEqual(loadTaskDraft(storage, input), {
    version: 1,
    ...input
  })
  assert.equal(loadTaskDraft(storage, { ...input, sourceSignature: 'changed' }), null)
  assert.ok(
    storage.getItem(taskDraftKey('user-1', 'page-1')),
    'a mismatched source must not silently delete the old draft'
  )

  saveTaskDraft(storage, input)
  clearTaskDraft(storage, input)
  assert.equal(loadTaskDraft(storage, input), null)
})

test('guarded draft clearing preserves a newer or unreadable entry', () => {
  const storage = memoryStorage()
  const key = taskDraftKey('u', 'p')
  const submitted = { userId: 'u', pageId: 'p', savedAt: '2026-11-14T11:00:00.000Z' }
  const newer = JSON.stringify({ ...submitted, savedAt: '2026-11-14T11:01:00.000Z' })
  storage.setItem(key, newer)
  clearTaskDraft(storage, submitted)
  assert.equal(storage.getItem(key), newer)

  storage.setItem(key, '{')
  clearTaskDraft(storage, submitted)
  assert.equal(storage.getItem(key), '{')
})

test('moves task feedback through session storage exactly once', () => {
  const storage = memoryStorage()
  setTaskFlash(storage, '上一条已提交')
  assert.equal(takeTaskFlash(storage), '上一条已提交')
  assert.equal(takeTaskFlash(storage), '')
})

test('keeps old context drafts and refuses to overwrite them when archival storage fails', () => {
  const storage = memoryStorage()
  const old = {
    userId: 'u',
    pageId: 'p',
    sourceSignature: 'old',
    contextBasis: 'policy-old',
    row: { 记音: 'ka⁵³³' }
  }
  saveTaskDraft(storage, old)
  saveTaskDraft(storage, {
    ...old,
    sourceSignature: 'new',
    contextBasis: 'policy-new',
    row: { 记音: 'ka533' }
  })
  assert.equal(loadTaskDraftHistory(storage, old)[0].row.记音, 'ka⁵³³')
  const set = storage.setItem
  storage.setItem = (key, value) => {
    if (key.includes(':history:')) throw new Error('quota')
    set(key, value)
  }
  assert.throws(
    () => saveTaskDraft(storage, { ...old, sourceSignature: 'third', row: { 记音: 'ga453' } }),
    /quota/
  )
  assert.equal(loadTaskDraft(storage, { ...old, sourceSignature: 'new' }).row.记音, 'ka533')
})
