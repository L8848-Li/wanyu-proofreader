import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 与 proofreadSourceLabel.test.js 同一范式：对视图源码做门禁断言。
// 「空 hints 像素级一致」在 node:test 里能证明的是——疑点相关的所有 DOM 都必须
// 处在 v-if 长度门后面，无疑点数据时这些节点根本不进入渲染树；样式侧则要求
// 新增规则只挂新类名，不改既有节点的选择器。

const editorSource = readFileSync(
  new URL('../src/views/proofreader/ProofreadEditorView.vue', import.meta.url),
  'utf8'
)
const styleSource = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')

test('every machine-hint block is gated behind a length check (no placeholder when empty)', () => {
  const gatedPatterns = [
    /v-if="pageHintList\.length" class="field-hint-list/,
    /v-if="findingsTruncated" class="field-hint-truncated/,
    /v-if="fieldHintList\(header\)\.length" class="field-hint-list/,
    /v-if="fieldHintOverflow\(header\)" class="field-hint-overflow/,
    /v-if="pageHintOverflow" class="field-hint-overflow/
  ]
  for (const pattern of gatedPatterns) assert.match(editorSource, pattern)
  // 反例门禁：模板里出现不带 v-if 的 field-hint 容器就等于给空数据留了占位。
  assert.doesNotMatch(editorSource, /<(ul|p|li|div)(?![^>]*v-if)[^>]*class="[^"]*field-hint/)
})

test('the untouched source line keeps its original single-text branch as the default', () => {
  // 无定位点击时 sourceSegments(header) 恒为 null → 渲染的是与今天逐字相同的那个 <p>。
  assert.match(editorSource, /<p v-if="!sourceSegments\(header\)">\{\{ originalRow\[header\] \|\| '（空白）' \}\}<\/p>/)
})

test('findings load is a non-blocking enhancement and resets per task', () => {
  assert.match(editorSource, /void loadFindings\(page\.value\.id\)/)
  assert.match(editorSource, /fieldHints\.value = prepareFieldHints\(\[\]\)/)
  assert.match(editorSource, /findingsTruncated\.value = false/)
  assert.match(editorSource, /locatedSpan\.value = null/)
  // 命不中已渲染列的疑点必须并入整条级（评审 #225：不允许静默消失）。
  assert.match(editorSource, /prepareFieldHints\(result\.hints, rowHeaders\.value\)/)
})

test('blind proofreading holds: the view never reads round, producer or a confidence number', () => {
  // 契约 §3.1/§9：这些字段根本不下发；渲染端也不得出现对应标识符。
  // 必须带词边界——视图里的 canNavigatePrev 之类命名含 "gate" 子串，不是消费 gate。
  for (const forbidden of [/\bround\b/, /\bproducer\b/, /\bconfidence\b/, /\bgate\b/]) {
    assert.doesNotMatch(editorSource, forbidden)
  }
})

test('hint styles only attach to new class names (zero selectors over existing nodes)', () => {
  const hintRules = styleSource.match(/\.field-hint-[a-z-]+[^{]*\{|\.source-value__hit[^{]*\{/g) || []
  assert.ok(hintRules.length >= 6, `expected the hint style block, got ${hintRules.length} rules`)
  for (const selector of hintRules) {
    assert.match(selector, /^\.field-hint-(list|chip|reason|overflow|truncated)|^\.source-value__hit/)
  }
  // 强调态必须同时有非颜色载体（「疑」字标记），满足可及性基线。
  assert.match(editorSource, /<b aria-hidden="true">疑<\/b>/)
})
