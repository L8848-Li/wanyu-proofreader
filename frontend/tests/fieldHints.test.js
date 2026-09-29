import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HINT_DISPLAY_LIMIT,
  hintKindLabel,
  hintsForField,
  hintsOverflowFor,
  locateSpan,
  pageLevelHints,
  pageLevelOverflow,
  prepareFieldHints
} from '../src/lib/fieldHints.js'

// #176 §3.1 的一条真实形状（含 message_key 与 evidence），供各用例复用。
function makeHint(overrides = {}) {
  return {
    field: '莆田IPA',
    kind: 'reading_format_invalid',
    severity: 'warn',
    message: { key: 'long_digit_run', params: { runs: ['5333'], run_count: 1 } },
    highlight: false,
    evidence: {},
    ...overrides
  }
}

// ---- 空数组退化：这是当前（#179 回填后）唯一会发生的线上情况 ----

test('empty hints degrade to a frozen empty structure with zero display surface', () => {
  const prepared = prepareFieldHints([])
  // 引用相等 = 视图每次拿到的都是同一个不可变空对象，任何 v-if 判定恒假。
  assert.equal(prepared, prepareFieldHints([]))
  assert.deepEqual(prepared, { fields: {}, pageLevel: { items: [], overflow: 0 }, total: 0 })
  assert.equal(hintsForField(prepared, '莆田IPA').length, 0)
  assert.equal(hintsOverflowFor(prepared, '莆田IPA'), 0)
  assert.equal(pageLevelHints(prepared).length, 0)
  assert.equal(pageLevelOverflow(prepared), 0)
})

test('non-array garbage never throws and behaves exactly like the empty case', () => {
  for (const garbage of [null, undefined, 0, '', 'hints', {}]) {
    assert.equal(prepareFieldHints(garbage), prepareFieldHints([]))
  }
})

// ---- 分组、顺序与 D_max ----

test('hints group by field; an empty field name becomes page-level', () => {
  const prepared = prepareFieldHints([
    makeHint(),
    makeHint({ field: '仙游IPA', message: { key: 'combining_marks_present', params: { marks: ['0x303'] } } }),
    makeHint({ field: '', message: { key: 'row_width_differs', params: { cells: 5, headers: 4 } } })
  ])
  assert.deepEqual(Object.keys(prepared.fields).sort(), ['仙游IPA', '莆田IPA'])
  assert.equal(hintsForField(prepared, '莆田IPA').length, 1)
  assert.match(hintsForField(prepared, '莆田IPA')[0].text, /三位以上连续数字/)
  assert.equal(pageLevelHints(prepared).length, 1)
  assert.match(pageLevelHints(prepared)[0].text, /单元格数与表头不符/)
})

test('highlighted hints sort first but nothing is ever hidden by severity (契约 §3.1 强调信号唯一)', () => {
  const prepared = prepareFieldHints([
    makeHint({ kind: 'punctuation_mix', message: { key: 'punctuation_width_mixed_in_column', params: {} } }),
    makeHint({ highlight: true, severity: 'strong', kind: 'encoding_form_anomaly', message: { key: 'mixed_normalization_forms', params: { nfc: 2, nfd: 1, minority: 'NFD' } } }),
    makeHint({ kind: 'missing_field', message: { key: 'required_role_field_empty', params: { role: 'reading' } } })
  ])
  const items = hintsForField(prepared, '莆田IPA')
  assert.equal(items.length, 3)
  assert.equal(items[0].highlight, true)
  assert.equal(items[1].highlight, false)
  // 服务端给的相对顺序在非高亮组内保持不变（稳定排序）。
  assert.equal(items[1].kind, 'punctuation_mix')
  assert.equal(items[2].kind, 'missing_field')
})

test('D_max keeps display density bounded and folds the rest into a count', () => {
  const many = Array.from({ length: HINT_DISPLAY_LIMIT + 2 }, (_, i) =>
    makeHint({ kind: `kind_${i}`, message: { key: `unknown_key_${i}`, params: {} } }))
  const prepared = prepareFieldHints(many)
  assert.equal(hintsForField(prepared, '莆田IPA').length, HINT_DISPLAY_LIMIT)
  assert.equal(hintsOverflowFor(prepared, '莆田IPA'), 2)
  assert.equal(prepared.total, many.length)
})

// ---- kind 标签与措辞退化 ----

test('all ten contract kinds get labels and an unknown kind falls back readably (#178 扩展点)', () => {
  const kinds = [
    'char_out_of_repertoire', 'confusable_substitution', 'encoding_form_anomaly', 'missing_field',
    'reading_format_invalid', 'punctuation_mix', 'page_outlier', 'duplicate_identity',
    'cross_source_conflict', 'merged_columns'
  ]
  for (const kind of kinds) {
    const label = hintKindLabel(kind)
    assert.ok(label && label !== kind, `${kind} should have a shipped label`)
  }
  // 新 kind（例如 #178 后续扩展）不改渲染端也不会坏：原样回显，不抛错。
  assert.equal(hintKindLabel('brand_new_kind'), 'brand_new_kind')
  assert.equal(hintKindLabel(''), '机器疑点')
})

test('a malformed hint renders a fallback message instead of throwing', () => {
  const prepared = prepareFieldHints([null, makeHint({ field: '', message: undefined })])
  assert.equal(prepared.total, 2)
  assert.equal(pageLevelHints(prepared).length, 2)
  for (const item of pageLevelHints(prepared)) {
    assert.match(item.text, /未登记的疑点类型/)
  }
})

// ---- SourceSpan 定位 ----

test('char_offsets are codepoint pairs converted to utf-16 selection bounds', () => {
  assert.deepEqual(locateSpan('abcd5333ef', [[4, 8]]), { start: 4, end: 8 })
  // 补充平面汉字占 1 个码位、2 个 UTF-16 单元：𢶀abc 的 [0,2] → utf-16 [0,3]。
  assert.deepEqual(locateSpan('𢶀abc', [[0, 2]]), { start: 0, end: 3 })
  assert.deepEqual(locateSpan('甲𢶀乙', [[1, 2]]), { start: 1, end: 3 })
})

test('locateSpan returns null for missing or malformed offsets (定位降级为聚焦字段)', () => {
  assert.equal(locateSpan('abc', undefined), null)
  assert.equal(locateSpan('abc', []), null)
  assert.equal(locateSpan('abc', [[2, 1]]), null)
  assert.equal(locateSpan('abc', [[1, 99]]), null)
  assert.equal(locateSpan('abc', [['x', 2]]), null)
  assert.equal(locateSpan('', [[0, 1]]), null)
  assert.equal(locateSpan(null, [[0, 1]]), null)
  // 取第一个可用区间，坏形状跳过后继续。
  assert.deepEqual(locateSpan('abcdef', [[9, 8], [1, 3]]), { start: 1, end: 3 })
})
