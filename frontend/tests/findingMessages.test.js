import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  codepointLabel,
  findingMessageKeys,
  renderFindingMessage,
  renderHints,
  FALLBACK_PREFIX
} from '../src/lib/findingMessages.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const detectors = path.join(here, '..', '..', 'scripts', 'corpus_probe', 'detectors.py')

// 措辞表与检测器必须一起改：检测器新增一个 message_key 而前端没配措辞时，
// 校对员会看到 FALLBACK 文案，而这条测试会先一步失败。
function detectorMessageKeys() {
  const source = readFileSync(detectors, 'utf8')
  const pattern = /finding\(\s*[A-Z_]+,\s*[A-Z]+,\s*[^,]+,\s*"([a-z_]+)"/g
  const keys = new Set()
  for (const match of source.matchAll(pattern)) keys.add(match[1])
  assert.ok(keys.size >= 9, `expected the shipped detectors' message keys, got ${[...keys]}`)
  return keys
}

test('every detector message key has a wording entry', () => {
  const registered = new Set(findingMessageKeys())
  for (const key of detectorMessageKeys()) {
    assert.ok(registered.has(key), `findingMessages.js is missing wording for ${key}`)
  }
})

test('each wording renders and stays free of cell text', () => {
  const cases = [
    ['long_digit_run', { runs: ['5333'], run_count: 1 }],
    ['tone_token_count_differs', { pinyin_count: 2, ipa_count: 3 }],
    ['missing_glyph_placeholder', { marks: ['@20000'], mark_count: 1 }],
    ['column_collapse', { reasons: ['unbalanced_bracket'] }],
    ['meaning_is_phonetic_fragment', {}],
    ['phonetic_run_inside_meaning', {}],
    ['mixed_normalization_forms', { minority: 'nfd', nfc: 2276, nfd: 1986 }],
    ['combining_marks_present', { marks: ['0x303'] }],
    ['non_ipa_range_codepoints', { codepoints: ['0x3b6'] }],
    ['cjk_extension_present', { codepoints: ['0x20bb8'] }],
    ['row_width_differs', { cells: 7, headers: 6 }]
  ]
  for (const [key, params] of cases) {
    const text = renderFindingMessage({ key, params })
    assert.ok(text.length > 8, `${key} rendered ${text}`)
    assert.ok(!/[{}[\]]/.test(text), `${key} leaked raw params: ${text}`)
  }
})

test('codepoints are labelled, never rendered as glyphs', () => {
  assert.equal(codepointLabel('0x303'), 'U+0303')
  assert.equal(codepointLabel('U+20BB8'), 'U+20BB8')
  assert.equal(codepointLabel(0x20bb8), 'U+20BB8')
  assert.equal(codepointLabel('𠮷'), '未知码位')
  assert.equal(codepointLabel(-1), '未知码位')
  assert.equal(codepointLabel(null), '未知码位')
  // 组合符措辞即便被塞进真的字符也只能显示码位。
  const text = renderFindingMessage({ key: 'combining_marks_present', params: { marks: ['𠮷', '0x303'] } })
  assert.ok(text.includes('U+0303'), text)
  assert.ok(text.includes('未知码位'), text)
  assert.ok(!text.includes('𠮷'), `wording echoed a glyph instead of a codepoint: ${text}`)
})

test('a missing key falls back without throwing', () => {
  assert.ok(renderFindingMessage({ key: 'brand_new_rule', params: {} }).startsWith(FALLBACK_PREFIX))
  assert.ok(renderFindingMessage({}).startsWith(FALLBACK_PREFIX))
  assert.ok(renderFindingMessage(null).startsWith(FALLBACK_PREFIX))
  // params 缺失或形状错误都不能让措辞函数抛错。
  assert.equal(typeof renderFindingMessage({ key: 'row_width_differs' }), 'string')
  assert.ok(renderFindingMessage({ key: 'long_digit_run', params: { runs: 'not-a-list' } }).length > 8)
})

test('counters fall back to what is derivable, not to zero text', () => {
  assert.ok(renderFindingMessage({ key: 'long_digit_run', params: { runs: ['123', '456'] } }).includes('2'))
  assert.ok(renderFindingMessage({ key: 'row_width_differs', params: { cells: 'abc', headers: 6 } }).includes('0 对 6'))
})

test('renderHints is empty for no data and drops nothing otherwise', () => {
  assert.deepEqual(renderHints([]), [])
  assert.deepEqual(renderHints(undefined), [])
  assert.deepEqual(renderHints(null), [])
  const hints = renderHints([
    { field: '拼音', kind: 'reading_format_invalid', severity: 'strong', highlight: true, message: { key: 'long_digit_run', params: { runs: ['5333'], run_count: 1 } } },
    { field: '释义', kind: 'merged_columns', severity: 'warn', highlight: false, message: { key: 'phonetic_run_inside_meaning', params: {} } }
  ])
  assert.equal(hints.length, 2)
  assert.deepEqual(hints[0], {
    field: '拼音',
    kind: 'reading_format_invalid',
    severity: 'strong',
    highlight: true,
    text: hints[0].text
  })
  assert.equal(hints[1].highlight, false)
  assert.equal(hints[1].field, '释义')
})
