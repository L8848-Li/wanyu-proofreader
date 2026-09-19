import test from 'node:test'
import assert from 'node:assert/strict'

import {
  composeRowText,
  orderedRowHeaders,
  safeParseRowJson
} from '../src/composables/useStructuredRow.js'

test('corrupt or non-object row JSON degrades to no row rather than throwing', () => {
  for (const raw of ['', null, undefined, 'not json', '{oops', '[]', '[1,2]', '"text"', '7', 'null']) {
    assert.equal(safeParseRowJson(raw), null, `${JSON.stringify(raw)} must not be treated as a row`)
  }
  assert.deepEqual(safeParseRowJson('{"词条":"徛"}'), { 词条: '徛' })
  assert.deepEqual(safeParseRowJson('{}'), {}, 'an empty row is still a row')
})

test('saved CSV header order wins over JavaScript integer-like key reordering', () => {
  const row = JSON.parse('{"10":"十","词条":"徛","释义":"站","2":"二"}')
  const page = { row_headers_json: JSON.stringify(['词条', '10', '释义', '2']) }
  assert.deepEqual(orderedRowHeaders(page, row), ['词条', '10', '释义', '2'])
})

test('headers that vanished from the row are dropped and new keys are appended', () => {
  const page = { row_headers_json: JSON.stringify(['词条', '已删除', '释义']) }
  assert.deepEqual(orderedRowHeaders(page, { 词条: 'a', 补充: 'b', 释义: 'c' }), ['词条', '释义', '补充'])
})

test('unreadable or malformed saved order falls back to the row keys', () => {
  for (const page of [{}, { row_headers_json: '' }, { row_headers_json: 'broken' },
                      { row_headers_json: '{"not":"an array"}' }, { row_headers_json: '[1,2,""]' },
                      { row_headers_json: null }]) {
    assert.deepEqual(orderedRowHeaders(page, { 词条: 'a', 释义: 'b' }), ['词条', '释义'],
      `unreadable saved order in ${JSON.stringify(page)} must fall back to key order`)
  }
})

test('composed text joins non-empty values with single spaces', () => {
  const headers = ['词条', '读音', '释义', '备注']
  assert.equal(composeRowText(headers, { 词条: '徛', 读音: ' kiā ', 释义: '', 备注: undefined }), '徛 kiā')
  assert.equal(composeRowText([], {}), '')
  assert.equal(composeRowText(headers, null), '', 'a missing row must not print undefined')
})
