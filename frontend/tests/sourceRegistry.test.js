import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  SOURCE_ORIGIN_LABELS,
  SOURCE_STATUS_LABELS,
  USAGE_DECISION_LABELS,
  USAGE_PURPOSE_LABELS
} from '../src/constants/sourceRegistry.js'

const require = createRequire(import.meta.url)
const registry = require('../../backend/pb_hooks/lib/source_registry.js')

test('unknown and missing usage decisions block downstream', () => {
  assert.equal(registry.usageBlocked('allow'), false)
  assert.equal(registry.usageBlocked('deny'), true)
  assert.equal(registry.usageBlocked('unknown'), true)
  assert.equal(registry.usageBlocked(undefined), true)
  assert.deepEqual(registry.undecidedPurposes([]), registry.PURPOSES)
  assert.deepEqual(
    registry.undecidedPurposes(registry.PURPOSES.map((purpose) => ({ purpose, decision: 'allow' }))),
    []
  )
  const denied = registry.undecidedPurposes([{ purpose: 'internal_research', decision: 'deny' }])
  assert.equal(denied.includes('internal_research'), true)
})

test('every registry code has a Chinese label', () => {
  for (const status of registry.STATUSES) assert.match(SOURCE_STATUS_LABELS[status], /\p{Script=Han}/u)
  for (const origin of registry.ORIGINS) assert.match(SOURCE_ORIGIN_LABELS[origin], /\p{Script=Han}/u)
  for (const purpose of registry.PURPOSES) assert.match(USAGE_PURPOSE_LABELS[purpose], /\p{Script=Han}/u)
  for (const decision of registry.DECISIONS) assert.match(USAGE_DECISION_LABELS[decision], /\p{Script=Han}/u)
})

test('logical ids are stable and reject free text', () => {
  assert.equal(registry.suggestLogicalId('合成词典', 'csv'), registry.suggestLogicalId('合成词典', 'csv'))
  assert.notEqual(registry.suggestLogicalId('合成词典', 'csv'), registry.suggestLogicalId('合成词典', 'pdf'))
  assert.equal(registry.isLogicalId(registry.suggestLogicalId('甲', 'csv')), true)
  assert.equal(registry.isLogicalId(''), false)
  assert.equal(registry.isLogicalId('含空格 id'), false)
  assert.equal(registry.isLogicalId('../secret'), false)
})
