import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import {
  projectWorkspaceLocation,
  projectWorkspaceSubviews,
  projectWorkspaceTarget
} from '../src/lib/projectWorkspace.js'
import {
  workflowCount,
  workflowReviewCount,
  workflowProblemCount,
  projectProblemItems,
  projectWorkflowNext,
  projectWorkflowTarget
} from '../src/lib/projectWorkflow.js'
import { normalizeAdminPageQuery } from '../src/lib/adminPageList.js'
import { createAsyncResource } from '../src/lib/asyncResource.js'
import { getPbMessage, getPbStatus } from '../src/utils/pbErrors.js'
import { sourceReviewItems } from '../src/lib/sourceReviewQueue.js'

test('legacy anchors keep each project capability reachable', () => {
  for (const [hash, section, view] of [
    ['#project-entries', 'work', 'entries'],
    ['#project-files', 'materials', 'import'],
    ['#project-ledger', 'materials', 'batches'],
    ['#project-export', 'delivery', 'exports'],
    ['#project-assist', 'work', 'checks'],
    ['#project-scheme', 'work', 'normalization']
  ])
    assert.deepEqual(projectWorkspaceLocation({ section: 'overview' }, hash), { section, view })
})

test('explicit sections ignore stale view names and ordinary filters stay in the entries workspace', () => {
  assert.deepEqual(projectWorkspaceLocation({ status: 'arbitration', page: '3' }), {
    section: 'work',
    view: 'entries'
  })
  assert.deepEqual(projectWorkspaceLocation({ section: 'materials', view: 'entries' }), {
    section: 'materials',
    view: 'import'
  })
  assert.deepEqual(projectWorkspaceLocation({ section: 'overview' }), {
    section: 'overview',
    view: 'summary'
  })
  assert.deepEqual(projectWorkspaceLocation({ section: 'unknown', view: 'queue' }), {
    section: 'work',
    view: 'queue'
  })
})

test('workspace navigation preserves exact list context and clears legacy anchors', () => {
  const context = { q: 'a̤̍ 𠮷', qualityState: 'unresolved', page: '3', view: 'entries' }
  const target = projectWorkspaceTarget('project1', 'materials', 'batches', context)
  assert.deepEqual(target, {
    path: '/admin/projects/project1',
    query: { ...context, section: 'materials', view: 'batches' },
    hash: ''
  })
  assert.deepEqual(context, { q: 'a̤̍ 𠮷', qualityState: 'unresolved', page: '3', view: 'entries' })
  assert.equal(projectWorkspaceTarget('p', 'work', undefined, target.query).query.view, undefined)
})

test('delivery navigation keeps work files, provenance, selection and package receipts distinct', () => {
  const items = projectWorkspaceSubviews('project1', 'delivery')
  assert.deepEqual(
    items.map((item) => item.key),
    ['exports', 'process', 'adoption', 'deliveries']
  )
  assert.equal(
    items.find((item) => item.key === 'adoption').to,
    '/admin/projects/project1/adoption'
  )
  assert.equal(
    items.find((item) => item.key === 'deliveries').to,
    '/admin/projects/project1/deliveries'
  )
  assert.deepEqual(projectWorkspaceSubviews('project1', 'overview'), [])
})

test('workflow guidance distinguishes an unread count from an empty project', () => {
  for (const value of [undefined, null, '', '0', -1, NaN, Infinity, 1.5]) {
    assert.equal(workflowCount(value), null)
  }
  assert.equal(workflowCount(0), 0)
  assert.equal(workflowCount(20000), 20000)
  assert.equal(projectWorkflowNext(null).action, 'entries')
  assert.equal(projectWorkflowNext({}).step, '')
  assert.equal(projectWorkflowNext({ total: 0 }).action, 'materials')
})

test('workflow guidance prioritizes arbitration and never labels reviewed data ready to deliver', () => {
  assert.equal(
    projectWorkflowNext({ total: 20, approved: 4, arbitration: 3 }).action,
    'arbitration'
  )
  assert.equal(projectWorkflowNext({ total: 20, approved: 4, arbitration: 0 }).action, 'entries')
  assert.equal(projectWorkflowNext({ total: 20, arbitration: 0 }).action, 'entries')
  const complete = projectWorkflowNext({ total: 20, approved: 20, arbitration: 0 })
  assert.equal(complete.action, 'delivery')
  assert.match(complete.title, /核对交付范围/)
  assert.match(complete.detail, /检查来源、用途/)
})

test('whole-project arbitration links clear every entry range filter and start on page one', () => {
  const query = {
    q: 'a̤̍ 𠮷',
    qualityState: 'unresolved',
    minPage: '12',
    maxPage: '14',
    importJob: 'syntheticbatch1',
    status: 'pending',
    page: '3',
    perPage: '50',
    method: 'csv'
  }
  const original = { ...query }
  const arbitration = projectWorkflowTarget('project1', 'arbitration', query)
  assert.deepEqual(arbitration.query, {
    perPage: '50',
    method: 'csv',
    section: 'work',
    view: 'entries',
    status: 'arbitration'
  })
  assert.deepEqual(
    normalizeAdminPageQuery(arbitration.query, {
      statuses: ['pending', 'arbitration'],
      qualityStates: ['unresolved'],
      pageSizes: [25, 50, 100]
    }),
    {
      q: '',
      status: 'arbitration',
      qualityState: '',
      minPage: '',
      maxPage: '',
      page: 1,
      perPage: 50
    }
  )
  assert.deepEqual(query, original)
  const entries = projectWorkflowTarget('project1', 'entries', query)
  assert.deepEqual(entries.query, { ...original, section: 'work', view: 'entries' })
})

test('other workflow links preserve list context and keep specialized destinations', () => {
  const query = { q: 'a̤̍ 𠮷', qualityState: 'unresolved', status: 'pending', page: '3' }
  const normalization = projectWorkflowTarget('project1', 'normalization', query)
  assert.deepEqual(normalization.query, {
    ...query,
    section: 'work',
    view: 'normalization',
    schemeView: 'review'
  })
  assert.equal(query.status, 'pending')
  assert.equal(query.page, '3')
  for (const action of ['materials', 'entries', 'queue', 'delivery']) {
    assert.equal(projectWorkflowTarget('project1', action, query).query.q, query.q)
  }
  assert.deepEqual(projectWorkflowTarget('project1', 'problems', query), {
    path: '/admin/projects/project1/verification',
    query: { view: 'problems', problemScope: 'todo' }
  })
  assert.deepEqual(projectWorkflowTarget('project1', 'review', query), {
    path: '/admin/projects/project1/verification',
    query: { view: 'review' }
  })
  for (const action of ['members', 'rules']) {
    assert.deepEqual(projectWorkflowTarget('project1', action, query), {
      path: '/admin/projects/project1/settings',
      query: { view: action }
    })
  }
})

const queueSource = readFileSync(
  new URL('../src/components/admin/project/ProjectWorkQueue.vue', import.meta.url),
  'utf8'
)
function queueFixture(readStats, readNormalizations, readReviews, readProblems) {
  const ref = (value) => ({ value })
  const useAsyncResource = (loader, options) => {
    const refs = { data: ref(null), pending: ref(false), error: ref('') }
    const resource = createAsyncResource(loader, {
      ...options,
      onChange: (state) => {
        for (const key of Object.keys(refs)) refs[key].value = state[key]
      }
    })
    return { ...refs, reload: resource.reload, cancel: resource.cancel }
  }
  // Run the production setup and resource lifecycle; only Vue mounting and API reads are stubbed.
  const setup = queueSource
    .match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import [\s\S]*? from [^\n]+\n/gm, '')
  return new Function(
    'ref',
    'computed',
    'onMounted',
    'defineProps',
    'defineExpose',
    'useAsyncResource',
    'getAdminProjectPageStats',
    'listNormalizations',
    'getVerificationSummary',
    'getProjectProblems',
    'getPbMessage',
    'getPbStatus',
    'projectWorkflowTarget',
    'workflowCount',
    'workflowReviewCount',
    'workflowProblemCount',
    `${setup}\nreturn { stats, normalizations, reviews, problems, items, priority, accessError, statsError, normalizationError, reviewError, problemError, loadStats, loadNormalizations, loadReviews, loadProblems, reload }`
  )(
    ref,
    (get) => ({
      get value() {
        return get()
      }
    }),
    () => {},
    () => ({ projectId: 'project1', query: {} }),
    () => {},
    useAsyncResource,
    readStats,
    readNormalizations,
    readReviews,
    readProblems,
    getPbMessage,
    getPbStatus,
    projectWorkflowTarget,
    workflowCount,
    workflowReviewCount,
    workflowProblemCount
  )
}

for (const status of [401, 403, 404]) {
  test(`queue ${status} from any reader clears all counts and rejects late peer responses`, async () => {
    const sides = ['stats', 'normalizations', 'reviews', 'problems']
    const initial = [
      { arbitration: 3 },
      { totalItems: 4 },
      { items: [{ status: 'proofread', business_complete: false }] },
      { issues: [{ status: 'new', report_count: 3 }] }
    ]
    for (const failingSide of sides) {
      let fail = false,
        finishPeer
      const peer = new Promise((resolve) => {
        finishPeer = resolve
      })
      const read = (side, initial) => () =>
        !fail ? initial : side === failingSide ? Promise.reject({ status }) : peer
      const queue = queueFixture(...sides.map((side, index) => read(side, initial[index])))
      await queue.reload()
      assert.deepEqual(
        queue.items.value.map((item) => item.count),
        [3, 1, 1, 4]
      )
      fail = true
      const readers = [
        queue.loadStats,
        queue.loadNormalizations,
        queue.loadReviews,
        queue.loadProblems
      ]
      const pendingPeers = readers
        .filter((_, index) => sides[index] !== failingSide)
        .map((load) => load())
      await readers[sides.indexOf(failingSide)]()
      assert.ok(queue.accessError.value)
      for (const side of sides) assert.equal(queue[side].value, null)
      finishPeer({ arbitration: 99, totalItems: 99, items: [], issues: [] })
      await Promise.all(pendingPeers)
      await queue.reload()
      for (const side of sides) assert.equal(queue[side].value, null)
      assert.deepEqual(
        queue.items.value.map((item) => item.count),
        [null, null, null, null]
      )
    }
    assert.match(
      queueSource,
      /<template v-if="accessError">[\s\S]*?<template v-else>[\s\S]*?class="project-todo__list"/
    )
    assert.match(queueSource, /<AppButton\s+v-if="!accessError"/)
  })
}

test('temporary queue read failures preserve prior counts and allow retry', async () => {
  let fail = false
  const queue = queueFixture(
    () => (fail ? Promise.reject({ status: 0, message: 'offline' }) : { arbitration: 3 }),
    () => (fail ? Promise.reject({ status: 503, message: 'unavailable' }) : { totalItems: 4 }),
    () =>
      fail
        ? Promise.reject({ status: 0, message: 'offline' })
        : { items: [{ status: 'proofread', business_complete: false }] },
    () =>
      fail
        ? Promise.reject({ status: 503, message: 'unavailable' })
        : { issues: [{ status: 'new', report_count: 3 }] }
  )
  await queue.reload()
  fail = true
  await queue.reload()
  assert.equal(queue.accessError.value, '')
  assert.equal(queue.stats.value.arbitration, 3)
  assert.equal(queue.normalizations.value.totalItems, 4)
  assert.equal(queue.statsError.value, 'offline')
  assert.equal(queue.normalizationError.value, 'unavailable')
  assert.equal(queue.reviewError.value, 'offline')
  assert.equal(queue.problemError.value, 'unavailable')
  assert.deepEqual(
    queue.items.value.map((item) => item.count),
    [3, 1, 1, 4]
  )
  assert.ok(queue.items.value.every((item) => item.error && !item.pending))
  assert.equal(queue.priority.value, null)
  fail = false
  await queue.reload()
  assert.equal(queue.statsError.value, '')
  assert.equal(queue.normalizationError.value, '')
  assert.equal(queue.reviewError.value, '')
  assert.equal(queue.problemError.value, '')
})

test('new queue counts are unknown until read and use the same destination scopes', () => {
  for (const missing of [null, undefined, {}, { items: null, issues: null }]) {
    assert.equal(workflowReviewCount(missing), null)
    assert.equal(workflowProblemCount(missing), null)
  }
  assert.equal(workflowReviewCount({ items: [] }), 0)
  assert.equal(workflowProblemCount({ issues: [] }), 0)
  const summary = {
    items: [
      { id: 'complete', status: 'approved', business_complete: true },
      { id: 'pending', status: 'pending', business_complete: false },
      { id: 'submitted', status: 'proofread', business_complete: false },
      { id: 'stale', status: 'approved', business_complete: true, needs_review: true },
      { id: 'hold', status: 'approved', business_complete: true, pending_review: true },
      { id: 'excluded', status: 'pending', source_empty: true },
      { id: 'excluded-stale', status: 'approved', source_empty: true, needs_review: true }
    ]
  }
  const target = projectWorkflowTarget('project', 'review', { reviewScope: 'all' })
  assert.equal(workflowReviewCount(summary), 4)
  assert.equal(
    workflowReviewCount(summary),
    sourceReviewItems(summary.items, target.query.reviewScope).length
  )
  const issues = ['new', 'in_progress', 'technical', 'resolved', 'reopened'].map((status, i) => ({
    id: String(i),
    status,
    report_count: i + 1
  }))
  issues.push({ id: 'empty', status: 'new', report_count: 0 })
  const problemTarget = projectWorkflowTarget('project', 'problems', { problemScope: 'all' })
  assert.equal(workflowProblemCount({ issues }), 4)
  assert.equal(
    workflowProblemCount({ issues }),
    projectProblemItems(issues, problemTarget.query.problemScope).length
  )
  assert.equal(
    projectProblemItems(issues).length,
    5,
    'existing direct links still include resolved history'
  )
})

test('first-read failures never display an empty queue', async () => {
  const fail = () => Promise.reject({ status: 503 })
  const queue = queueFixture(fail, fail, fail, fail)
  assert.deepEqual(
    queue.items.value.map((item) => item.count),
    [null, null, null, null]
  )
  await queue.reload()
  assert.deepEqual(
    queue.items.value.map((item) => item.count),
    [null, null, null, null]
  )
})

test('problem scope switches retain history and drop hidden bulk selections', async () => {
  const source = readFileSync(
    new URL('../src/views/admin/SourceFidelityView.vue', import.meta.url),
    'utf8'
  )
  const scopeSetup = source.match(/const problemScope = computed\([\s\S]*?\n\}\)/)[0]
  const issuesSetup = source.match(
    /const activeIssues = computed\([\s\S]*?(?=\nconst reviewItems)/
  )[0]
  const route = reactive({ query: { view: 'problems', problemScope: 'todo' } })
  const router = {
    replace: ({ query }) => {
      route.query = query
    }
  }
  const problems = ref({
    issues: [
      { id: 'open', status: 'new', report_count: 2 },
      { id: 'done', status: 'resolved', report_count: 1 }
    ],
    items: [
      { id: 'r-open', issue: { id: 'open' } },
      { id: 'r-done', issue: { id: 'done' } }
    ]
  })
  const selectedIssueId = ref('open'),
    selection = ref([]),
    linkedIssueMissing = ref(false),
    linkedIssue = ref(''),
    issueEdits = reactive({})
  const { problemScope, activeIssues, selectedIssue } = new Function(
    'computed',
    'watch',
    'route',
    'router',
    'problems',
    'selectedIssueId',
    'selection',
    'linkedIssueMissing',
    'linkedIssue',
    'issueEdits',
    'projectProblemItems',
    `${scopeSetup}\n${issuesSetup}\nreturn { problemScope, activeIssues, selectedIssue }`
  )(
    computed,
    watch,
    route,
    router,
    problems,
    selectedIssueId,
    selection,
    linkedIssueMissing,
    linkedIssue,
    issueEdits,
    projectProblemItems
  )
  assert.deepEqual(
    activeIssues.value.map((issue) => issue.id),
    ['open']
  )
  problemScope.value = 'all'
  await nextTick()
  assert.equal(route.query.problemScope, 'all')
  assert.equal(activeIssues.value.length, 2)
  selectedIssueId.value = 'done'
  selection.value = ['r-open', 'r-done']
  problemScope.value = 'todo'
  await nextTick()
  assert.equal(selectedIssue.value.id, 'open')
  assert.deepEqual(selection.value, ['r-open'])
  problems.value.issues[0].status = 'resolved'
  await nextTick()
  assert.equal(activeIssues.value.length, 0)
  assert.equal(selectedIssueId.value, '')
  assert.deepEqual(selection.value, [])
  problemScope.value = 'all'
  await nextTick()
  assert.equal(activeIssues.value.length, 2)
  linkedIssueMissing.value = true
  selectedIssueId.value = ''
  problemScope.value = 'todo'
  await nextTick()
  problemScope.value = 'all'
  await nextTick()
  assert.equal(
    selectedIssueId.value,
    '',
    'missing deep link must not silently select another issue'
  )
  linkedIssue.value = 'done'
  problemScope.value = 'todo'
  await nextTick()
  problemScope.value = 'all'
  await nextTick()
  assert.equal(selectedIssueId.value, 'done')
  assert.equal(linkedIssueMissing.value, false)
})
