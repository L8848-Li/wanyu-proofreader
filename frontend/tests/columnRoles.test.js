import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { FIELD_ROLE_LABELS, FIELD_ROLES } from '../src/constants/fieldRoles.js'
import { suggestColumnRole, suggestColumnRoles } from '../src/lib/columnRoleSuggestion.js'

const require = createRequire(import.meta.url)
const roles = require('../../backend/pb_hooks/lib/column_roles.js')

test('suggestions are defaults and leave page columns unspecified', () => {
  assert.equal(suggestColumnRole('词头'), 'headword')
  assert.equal(suggestColumnRole('莆田IPA'), 'reading')
  assert.equal(suggestColumnRole('释义'), 'meaning')
  assert.equal(suggestColumnRole('地区'), 'region')
  assert.equal(suggestColumnRole('例句'), 'example')
  assert.equal(suggestColumnRole('备注'), 'note')
  assert.equal(suggestColumnRole('PDF页码'), 'unspecified')
  assert.equal(suggestColumnRole('随便一列'), 'unspecified')
  assert.equal(suggestColumnRole(''), 'unspecified')
  assert.deepEqual(suggestColumnRoles(['词头', '随便一列']), { 词头: 'headword', 随便一列: 'unspecified' })
})

test('every role has a Chinese label', () => {
  assert.deepEqual(roles.ROLES, [...FIELD_ROLES])
  for (const role of FIELD_ROLES) assert.match(FIELD_ROLE_LABELS[role], /\p{Script=Han}/u)
})

test('unset columns are unspecified and vanished columns stay visible', () => {
  const view = roles.resolveColumnRoles({}, ['词头', '释义'])
  assert.deepEqual(view.roles, { 词头: 'unspecified', 释义: 'unspecified' })
  assert.deepEqual(view.stale, [])

  const stale = roles.resolveColumnRoles({ 词头: 'headword', 旧列: 'reading', 废列: 'unspecified' }, ['词头', '新列'])
  assert.equal(stale.roles.词头, 'headword')
  assert.equal(stale.roles.新列, 'unspecified')
  assert.equal(stale.roles.旧列, 'reading')
  assert.equal(Object.hasOwn(stale.roles, '废列'), false)
  assert.deepEqual(stale.stale, ['旧列'])
  assert.equal(stale.columns.find((column) => column.name === '旧列').present, false)
})

test('rules see null until a real role is attached to a present column', () => {
  assert.equal(roles.rolesForRules({}, { 词头: '甲' }), null)
  assert.equal(roles.rolesForRules({ 词头: 'unspecified' }, { 词头: '甲' }), null)
  assert.equal(roles.rolesForRules({ 旧列: 'reading' }, { 词头: '甲' }), null)
  assert.deepEqual(roles.rolesForRules({ 词头: 'headword', 释义: 'meaning' }, { 词头: '甲', 释义: '乙' }), {
    词头: 'headword',
    释义: 'meaning'
  })
})
