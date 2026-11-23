import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function view(path) {
  return readFileSync(new URL(`../src/views/${path}`, import.meta.url), 'utf8')
}

test('操作错误不参与加载态门禁', () => {
  const gate = view('admin/GateRulesView.vue')
  assert.match(gate, /(?:const loadError = ref\(''\)|error: loadError)/)
  assert.match(gate, /const operationError = ref\(''\)/)
  assert.match(gate, /v-if="loadError"/)
  assert.doesNotMatch(gate, /const error = ref\(''\)/)
  assert.doesNotMatch(gate, /v-if="error"/)

  const grants = view('admin/CreatorGrantsView.vue')
  assert.match(grants, /(?:const loadError = ref\(''\)|error: loadError)/)
  assert.match(grants, /const operationErrorUser = ref\(''\)/)

  const discovery = view('ProjectDiscoveryView.vue')
  assert.match(discovery, /(?:const loadError = ref\(''\)|error: loadError)/)
  assert.match(discovery, /joinErrorProjectId === project\.id/)

  const hall = view('proofreader/TaskHallView.vue')
  assert.match(hall, /(?:const loadError = ref\(''\)|error: loadError)/)
  assert.match(hall, /const actionError = ref\(''\)/)
  assert.match(hall, /async function loadProjects\(\{ keepActionError = false \} = \{\}\)/)
  assert.equal((hall.match(/await loadProjects\(\{ keepActionError: true \}\)/g) || []).length, 2)

  const guide = view('admin/ProjectFilesGuideView.vue')
  assert.match(guide, /<main class="container page(?: [^"]*)?"/)

  const sources = view('admin/SourcesView.vue')
  assert.match(sources, /(?:const loadError = ref\(''\)|error: loadError)/)
  assert.match(sources, /const operationError = ref\(''\)/)

  const deliveries = view('admin/DeliveriesView.vue')
  // State transitions run against createDeliveryWorkspace in deliveriesView.test.js.
  assert.match(deliveries, /v-if="loadError && /)
  assert.match(deliveries, /:load-error="loadError"/)
  assert.doesNotMatch(deliveries, /const error = ref\(''\)/)
  assert.doesNotMatch(deliveries, /v-if="error"/)
})
