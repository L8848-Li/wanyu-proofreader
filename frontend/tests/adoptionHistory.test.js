import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as adoption from '../src/lib/adoption.js'
import * as batchReportContext from '../src/lib/batchReportContext.js'
import { nextTick } from 'vue'
import { protectedPageScopeFixture } from './helpers/protectedPageScopeFixture.js'
import { getPbMessage, getPbStatus } from '../src/utils/pbErrors.js'

// Execute the view's actual setup and async handlers. Vue's small reactive
// primitives are enough here; service promises stay under test control.
const view = readFileSync(new URL('../src/views/admin/AdoptionView.vue', import.meta.url), 'utf8')
const script = view
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*? from ['"][^'"]+['"]\r?$/gm, '')

function fixture(services = {}, onNavigate = () => {}) {
  const route = { params: { id: 'project-a' }, query: {} }
  let routeChanged
  let watchCount = 0
  const unmount = []
  const protectedScope = protectedPageScopeFixture((callback) => unmount.push(callback))
  const bindings = {
    ...adoption,
    ...batchReportContext,
    nextTick,
    useProtectedPageScope: protectedScope.useProtectedPageScope,
    getPbMessage,
    getPbStatus,
    ref: (value) => ({ value }),
    reactive: (value) => value,
    computed: (getter) => ({
      get value() {
        return getter()
      }
    }),
    useRoute: () => route,
    useRouter: () => ({
      push: async ({ query }) => {
        onNavigate(query)
        route.query = query
        await routeChanged()
      }
    }),
    watch: (_source, callback) => {
      if (++watchCount === 2) routeChanged = callback
    },
    onBeforeUnmount: (callback) => {
      unmount.push(callback)
    },
    listAdoptionBatches: async (id, { page }) => ({
      batches: [{ id: `${id}-${page}`, counts: {}, reasons: [] }],
      page,
      totalPages: 5,
      totalItems: 101,
      purposes: [],
      reasons: []
    }),
    listAdoptionExceptions: async (id) => ({
      exceptions: [],
      pending: [],
      pendingTotal: 0,
      batch: id
    }),
    listAdoptionEvents: async (id) => ({ events: [], stale: false, batch: id }),
    getAdoptionSummary: async (id) => ({ project: id }),
    getAdoptionBatch: async (id) => ({ id, project: route.params.id, counts: {}, reasons: [] }),
    ...services
  }
  const state = new Function(
    ...Object.keys(bindings),
    `${script}\nreturn {
    resetProject, load, selectBatch, batches, currentId, exceptions, batchEvents, summary,
    historyPage, requestedHistoryPage, historyTotalPages, historyTotalItems,
    loaded, loading, loadError, decisionDrafts, createForm, screen, createStep, detailTab, draftFor, create, preview, operationError,
    exceptionQuery, activeExceptionId, visibleExceptions, navigate, changePage, verifyReportScope, reportScopeReady,
    current, currentRecord, accessLost, projectUnavailable, pageScope, busy, message, confirmOpen, removeOpen, dirty, act,
    clearProtectedData, handleFailure, exportManifest
  }`
  )(...Object.values(bindings))
  return {
    ...state,
    reset: () => state.resetProject(),
    route,
    changeIdentity: protectedScope.changeIdentity,
    unmount: () => unmount.forEach((callback) => callback())
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('adoption detail reload preserves the list page independently of exception pagination', async () => {
  const state = fixture()
  await state.load(4)
  await state.selectBatch('batch-four')
  assert.equal(state.route.query.listPage, '4')
  await state.navigate({ batch: 'batch-four', tab: 'exceptions', page: 2 })
  assert.equal(state.route.query.listPage, '4')
  const reloaded = fixture()
  reloaded.route.query = { ...state.route.query }
  await reloaded.reset()
  assert.equal(reloaded.historyPage.value, 4)
  assert.equal(reloaded.route.query.page, 2)
  await reloaded.navigate({ page: reloaded.historyPage.value })
  assert.equal(reloaded.historyPage.value, 4)
  assert.equal(reloaded.screen.value, 'list')
  assert.equal(Object.hasOwn(reloaded.route.query, 'returnPage'), false)
})

test('report-sourced creation uses only the verified import batch', async () => {
  const project = 'project00000001'
  const batch = 'import000000001'
  let submitted
  const state = fixture({
    getBatchReport: async () => ({
      schema: 'WanyuBatchReport/v1',
      project_id: project,
      batch: { id: batch, status: 'completed', filename: 'fixture.csv' },
      metrics: { import: { retained: { value: 3 } } }
    }),
    createAdoptionBatch: async (_id, body) => {
      submitted = body
      return { id: 'created', project, counts: {}, reasons: [] }
    },
    previewAdoptionBatch: async () => ({})
  })
  state.route.params.id = project
  state.route.query = {
    view: 'create',
    importJob: batch,
    reportProject: project,
    reportBatch: batch
  }
  state.screen.value = 'create'
  state.createForm.recipient = '接收团队'
  await state.verifyReportScope()
  assert.equal(state.reportScopeReady.value, true)
  await state.create()
  assert.deepEqual(submitted.rule.importJobs, [batch])
  assert.equal(state.route.query.reportBatch, batch)
})

test('a saved adoption batch navigates without an unsaved-create warning while a failed create stays dirty', async () => {
  let state
  let navigations = 0
  state = fixture(
    {
      createAdoptionBatch: async () => ({
        id: 'created',
        project: 'project-a',
        counts: {},
        reasons: []
      }),
      previewAdoptionBatch: async () => ({})
    },
    () => {
      navigations += 1
      assert.equal(state.dirty.value, false)
    }
  )
  state.screen.value = 'create'
  state.createForm.recipient = '接收团队'
  assert.equal(state.dirty.value, true)
  await state.create()
  assert.equal(navigations, 1)
  assert.equal(state.currentId.value, 'created')
  assert.equal(state.screen.value, 'detail')

  const failed = fixture({
    createAdoptionBatch: async () => {
      throw new Error('暂时不可用')
    }
  })
  failed.screen.value = 'create'
  failed.createForm.recipient = '接收团队'
  await failed.create()
  assert.equal(failed.screen.value, 'create')
  assert.equal(failed.dirty.value, true)
  assert.equal(failed.createForm.recipient, '接收团队')
})

function assertProtectedDataCleared(state, accessLost = true) {
  assert.equal(state.accessLost.value, accessLost)
  assert.equal(state.loaded.value, false)
  assert.equal(state.loading.value, false)
  assert.equal(state.busy.value, false)
  assert.deepEqual(state.batches.value, [])
  assert.equal(state.current.value, null)
  assert.equal(state.currentRecord.value, null)
  assert.equal(state.summary.value, null)
  assert.deepEqual(state.decisionDrafts, {})
  assert.deepEqual(state.exceptions.value, { exceptions: [], pending: [], pendingTotal: 0 })
  assert.deepEqual(state.batchEvents.value, { events: [], stale: false })
  assert.equal(state.createForm.recipient, '')
  assert.equal(state.createForm.note, '')
  assert.equal(state.confirmOpen.value, false)
  assert.equal(state.removeOpen.value, false)
  assert.equal(state.message.value, '')
}

for (const status of [401, 403]) {
  for (const origin of ['list', 'detail', 'action']) {
    test(`${origin} ${status} clears adoption authority and sensitive drafts`, async () => {
      let denied = false
      const state = fixture({
        listAdoptionBatches: async () => {
          if (denied && origin === 'list') throw { status }
          return { batches: [{ id: 'batch-one' }], page: 1, totalPages: 1, totalItems: 1 }
        },
        getAdoptionBatch: async (id) => {
          if (denied && origin === 'detail') throw { response: { status } }
          return { id, project: 'project-a', counts: {}, reasons: [] }
        }
      })
      await state.reset()
      await state.selectBatch('batch-one')
      state.createForm.recipient = 'private recipient'
      state.createForm.note = 'private note'
      state.draftFor('entry-one').note = 'private exception'
      state.confirmOpen.value = state.removeOpen.value = true
      state.message.value = 'old success'
      const pending = state.pageScope.capture()
      denied = true
      if (origin === 'action')
        await state.act(async () => {
          throw { status }
        }, '')
      else await state.load()
      assertProtectedDataCleared(state)
      assert.equal(pending.signal.aborted, true)
      assert.match(state.loadError.value, status === 401 ? /登录状态已失效/ : /无权/)
      let attempted = false
      await state.act(async () => {
        attempted = true
      }, 'must not publish')
      assert.equal(attempted, false, 'revoked pages cannot start another mutation')
    })
  }
}

for (const origin of ['list', 'summary']) {
  for (const status of [404, 500]) {
    test(`adoption project ${origin} ${status} ${status === 404 ? 'clears the whole workspace' : 'preserves loaded data and drafts'}`, async () => {
      let failed = false
      const state = fixture({
        listAdoptionBatches: async () => {
          if (failed && origin === 'list') throw { status }
          return {
            batches: [{ id: 'batch-one' }, { id: 'batch-two' }],
            page: 1,
            totalPages: 1,
            totalItems: 2
          }
        },
        getAdoptionSummary: async () => {
          if (failed && origin === 'summary') throw { response: { status } }
          return { project: 'project-a', private: true }
        }
      })
      await state.reset()
      await state.selectBatch('batch-one')
      state.createForm.recipient = 'private recipient'
      state.draftFor('entry-one').note = 'private decision'
      state.confirmOpen.value = true
      assert.equal(state.dirty.value, true)
      const pending = state.pageScope.capture()
      failed = true
      await state.load()
      if (status === 404) {
        assertProtectedDataCleared(state, false)
        assert.equal(state.projectUnavailable.value, true)
        assert.equal(state.dirty.value, false)
        assert.equal(pending.signal.aborted, true)
        assert.match(state.loadError.value, /项目不存在或已被删除/)
      } else {
        assert.equal(state.projectUnavailable.value, false)
        assert.equal(state.accessLost.value, false)
        assert.equal(state.loaded.value, true)
        assert.deepEqual(
          state.batches.value.map((batch) => batch.id),
          ['batch-one', 'batch-two']
        )
        assert.equal(state.current.value.id, 'batch-one')
        assert.equal(state.summary.value.private, true)
        assert.equal(state.createForm.recipient, 'private recipient')
        assert.equal(state.draftFor('entry-one').note, 'private decision')
        assert.equal(state.dirty.value, true)
        assert.equal(pending.signal.aborted, false)
      }
    })
  }
}

test('adoption detail 404 clears the exact authority and never falls back to a list summary', async () => {
  let missing = false
  const state = fixture({
    listAdoptionBatches: async () => ({
      batches: [{ id: 'batch-one', recipient: 'stale list summary', counts: {} }],
      page: 1,
      totalPages: 1,
      totalItems: 1
    }),
    getAdoptionBatch: async (id) => {
      if (missing) throw { status: 404 }
      return { id, project: 'project-a', recipient: 'authoritative detail', counts: {} }
    }
  })
  await state.reset()
  await state.selectBatch('batch-one')
  state.draftFor('entry-one').note = 'removed object draft'
  state.confirmOpen.value = true
  missing = true
  await state.load()
  assert.equal(state.currentId.value, 'batch-one', 'the failed deep-link target stays explicit')
  assert.equal(state.current.value, null)
  assert.equal(state.confirmOpen.value, false)
  assert.deepEqual(state.decisionDrafts, {})
  assert.match(state.loadError.value, /不可用/)
  assert.equal(state.accessLost.value, false, 'one missing object does not revoke the account')
  assert.equal(state.projectUnavailable.value, false)
  state.batches.value.push({ id: 'batch-one', recipient: 'cached summary', counts: {} })
  assert.equal(state.current.value, null, 'even a cached list item cannot substitute for detail')
})

test('temporary adoption detail failure preserves same-object drafts and supports retry', async () => {
  let unavailable = false
  const state = fixture({
    getAdoptionBatch: async (id) => {
      if (unavailable) throw new Error('temporary network failure')
      return { id, project: 'project-a', recipient: 'same object', counts: {} }
    }
  })
  await state.reset()
  await state.selectBatch('batch-one')
  state.draftFor('entry-one').note = 'unsent evidence'
  unavailable = true
  await state.load()
  assert.equal(state.accessLost.value, false)
  assert.equal(state.current.value.recipient, 'same object')
  assert.equal(state.draftFor('entry-one').note, 'unsent evidence')
  assert.equal(state.loadError.value, 'temporary network failure')
  unavailable = false
  await state.load()
  assert.equal(state.loadError.value, '')
  assert.equal(state.draftFor('entry-one').note, 'unsent evidence')
})

test('identity replacement aborts adoption reads and late success cannot resurrect cleared data', async () => {
  const pending = deferred()
  let signal
  const state = fixture({
    listAdoptionBatches: async (_id, options) => {
      signal = options.signal
      return pending.promise
    }
  })
  const old = state.reset()
  state.createForm.recipient = 'account A recipient'
  state.changeIdentity({ id: 'account-b', role: 'user' })
  assertProtectedDataCleared(state)
  assert.equal(signal.aborted, true)
  pending.resolve({ batches: [{ id: 'private-a' }], page: 1, totalPages: 1, totalItems: 1 })
  await old
  assertProtectedDataCleared(state)
})

test('A to B to A and a fresh adoption reload reject the first session late denial', async () => {
  const pending = deferred()
  let calls = 0
  const state = fixture({
    listAdoptionBatches: async () =>
      ++calls === 1
        ? pending.promise
        : {
            batches: [{ id: 'fresh-a' }],
            page: 1,
            totalPages: 1,
            totalItems: 1
          }
  })
  const old = state.reset()
  state.changeIdentity({ id: 'account-b', role: 'user' })
  state.changeIdentity({ id: 'account-a', role: 'user' })
  await state.load()
  pending.reject({ status: 403 })
  await old
  assert.equal(state.accessLost.value, false)
  assert.equal(state.loadError.value, '')
  assert.equal(state.batches.value[0].id, 'fresh-a')
})

test('a created adoption batch arriving after access loss cannot restore the form or preview', async () => {
  const pending = deferred()
  let previews = 0
  const state = fixture({
    createAdoptionBatch: () => pending.promise,
    previewAdoptionBatch: async () => {
      previews++
    }
  })
  await state.reset()
  state.createForm.recipient = 'account A recipient'
  const old = state.create()
  state.changeIdentity(null)
  pending.resolve({ id: 'late-created', project: 'project-a', counts: {}, status: 'draft' })
  await old
  assertProtectedDataCleared(state)
  assert.equal(previews, 0)
})

for (const outcome of ['404', 'success']) {
  test(`switching adoption A to B ignores A export late ${outcome}`, async () => {
    const pending = deferred()
    let signal
    let downloads = 0
    const state = fixture({
      exportAdoptionManifest: async (id, _include, options) => {
        assert.equal(id, 'batch-a')
        signal = options.signal
        return pending.promise
      },
      downloadText: () => {
        downloads++
      }
    })
    await state.reset()
    await state.selectBatch('batch-a')
    const old = state.exportManifest('select')
    await state.selectBatch('batch-b')
    state.draftFor('entry-b').note = 'B evidence stays here'
    state.confirmOpen.value = true
    state.message.value = 'B current message'
    assert.equal(signal.aborted, true)
    assert.equal(state.busy.value, false)
    if (outcome === '404') pending.reject({ status: 404 })
    else pending.resolve({ entries: [{ private: 'batch-a' }] })
    await old
    assert.equal(state.currentId.value, 'batch-b')
    assert.equal(state.current.value.id, 'batch-b')
    assert.equal(state.draftFor('entry-b').note, 'B evidence stays here')
    assert.equal(state.confirmOpen.value, true)
    assert.equal(state.message.value, 'B current message')
    assert.equal(state.loadError.value, '')
    assert.equal(state.operationError.value, '')
    assert.equal(downloads, 0, 'an obsolete export cannot publish a file')
  })
}

test('leaving adoption creation cancels a late result before navigation or preview', async () => {
  const pending = deferred()
  let signal
  let previews = 0
  const state = fixture({
    createAdoptionBatch: async (_id, _body, options) => {
      signal = options.signal
      return pending.promise
    },
    previewAdoptionBatch: async () => {
      previews++
    }
  })
  await state.reset()
  await state.navigate({ view: 'create' })
  state.createForm.recipient = 'recipient from the old create screen'
  const old = state.create()
  await state.navigate({ page: 1 })
  assert.equal(signal.aborted, true)
  pending.resolve({ id: 'late-created', project: 'project-a', counts: {}, status: 'draft' })
  await old
  assert.equal(state.screen.value, 'list')
  assert.equal(state.currentId.value, '')
  assert.equal(state.current.value, null)
  assert.deepEqual(state.route.query, { page: 1 })
  assert.equal(previews, 0)
  assert.equal(state.message.value, '')
  assert.equal(state.busy.value, false)
})

test('page failure preserves successful page/details and retry targets the failed page', async () => {
  let fail = true
  const requested = []
  const state = fixture({
    listAdoptionBatches: async (id, { page, perPage }) => {
      requested.push([id, page, perPage])
      if (page === 2 && fail) throw new Error('翻页暂时失败')
      return {
        batches: [{ id: `batch-${page}`, counts: {}, reasons: [] }],
        page,
        totalPages: 5,
        totalItems: 101
      }
    }
  })
  await state.reset()
  await state.selectBatch('batch-1')
  await state.load(2)
  assert.equal(state.historyPage.value, 1)
  assert.equal(state.currentId.value, 'batch-1')
  assert.equal(state.batchEvents.value.batch, 'batch-1')
  assert.equal(state.requestedHistoryPage.value, 2)
  assert.equal(state.loadError.value, '翻页暂时失败')
  assert.equal(state.loading.value, false)
  fail = false
  await state.load()
  assert.deepEqual(requested, [
    ['project-a', 1, 25],
    ['project-a', 1, 25],
    ['project-a', 2, 25],
    ['project-a', 2, 25]
  ])
  assert.equal(state.historyPage.value, 2)
  assert.equal(state.currentId.value, 'batch-1')
  assert.equal(state.screen.value, 'detail')
  assert.equal(state.loadError.value, '')
})

test('last/empty page metadata is applied from the server rather than guessed locally', async () => {
  const state = fixture({
    listAdoptionBatches: async () => ({ batches: [], page: 1, totalPages: 1, totalItems: 0 })
  })
  await state.reset()
  assert.equal(state.loaded.value, true)
  assert.equal(state.currentId.value, '')
  assert.equal(state.historyPage.value, 1)
  assert.equal(state.historyTotalPages.value, 1)
  assert.equal(state.historyTotalItems.value, 0)
  assert.deepEqual(state.batchEvents.value, { events: [], stale: false })
  assert.match(
    readFileSync(
      new URL('../src/components/admin/adoption/AdoptionHistoryPanel.vue', import.meta.url),
      'utf8'
    ),
    /<AppPagination[^>]*:page="historyPage"[^>]*:total-pages="historyTotalPages"[^>]*label="编选历史分页"/
  )
  const pagination = readFileSync(
    new URL('../src/components/AppPagination.vue', import.meta.url),
    'utf8'
  )
  assert.match(pagination, /page <= 1/)
  assert.match(pagination, /page >= totalPages/)
})

test('changing projects resets to page one and ignores the old list response', async () => {
  const pending = deferred()
  const requested = []
  const state = fixture({
    listAdoptionBatches: async (id, { page }) => {
      requested.push([id, page])
      if (id === 'project-a' && page === 4) return pending.promise
      return {
        batches: [{ id: `${id}-${page}`, counts: {}, reasons: [] }],
        page,
        totalPages: 5,
        totalItems: 101
      }
    }
  })
  await state.reset()
  state.createForm.recipient = '旧项目接收方'
  const old = state.load(4)
  state.route.params.id = 'project-b'
  state.route.query = {}
  await state.reset()
  pending.resolve({ batches: [{ id: 'late-a' }], page: 4, totalPages: 5, totalItems: 101 })
  await old
  assert.deepEqual(requested, [
    ['project-a', 1],
    ['project-a', 4],
    ['project-b', 1]
  ])
  assert.equal(state.historyPage.value, 1)
  assert.equal(state.currentId.value, '')
  assert.equal(state.summary.value.project, 'project-b')
  assert.equal(state.createForm.recipient, '')
})

test('late old-project summary/details never overwrite the new project', async () => {
  const summary = deferred()
  const state = fixture({
    getAdoptionSummary: (id) =>
      id === 'project-a' ? summary.promise : Promise.resolve({ project: id })
  })
  const old = state.reset()
  await tick()
  state.route.params.id = 'project-b'
  state.route.query = {}
  await state.reset()
  await state.selectBatch('project-b-1')
  summary.resolve({ project: 'project-a' })
  await old
  assert.equal(state.summary.value.project, 'project-b')
  assert.equal(state.currentId.value, 'project-b-1')
  assert.equal(state.batchEvents.value.batch, 'project-b-1')
  assert.equal(state.loading.value, false)
})

test('a late selected-batch response and errors are isolated across project switches', async () => {
  const events = deferred()
  const state = fixture({
    listAdoptionEvents: (id) =>
      id === 'old-selection' ? events.promise : Promise.resolve({ events: [], batch: id })
  })
  await state.reset()
  const old = state.selectBatch('old-selection')
  await tick()
  state.route.params.id = 'project-b'
  state.route.query = {}
  await state.reset()
  await state.selectBatch('project-b-1')
  events.reject(new Error('old failure'))
  await old
  assert.equal(state.currentId.value, 'project-b-1')
  assert.equal(state.batchEvents.value.batch, 'project-b-1')
  assert.equal(state.loadError.value, '')
  assert.equal(state.loading.value, false)
})

test('landing on a project shows the batch list without fetching or exposing an arbitrary batch', async () => {
  const requested = []
  const state = fixture({
    listAdoptionExceptions: async (id) => {
      requested.push(id)
      return { exceptions: [], pending: [], pendingTotal: 0 }
    },
    listAdoptionEvents: async (id) => {
      requested.push(id)
      return { events: [], stale: false }
    }
  })
  await state.reset()
  assert.equal(state.screen.value, 'list')
  assert.equal(state.currentId.value, '')
  assert.deepEqual(requested, [])
  await state.selectBatch('project-a-1')
  assert.equal(state.screen.value, 'detail')
  assert.deepEqual(requested, ['project-a-1', 'project-a-1'])
})

test('accepted query navigation discards drafts rather than applying them to another batch', async () => {
  const state = fixture()
  await state.reset()
  await state.selectBatch('batch-one')
  state.draftFor('same-entry').note = 'first batch evidence'
  await state.selectBatch('batch-two')
  assert.equal(state.draftFor('same-entry').note, '')
  state.draftFor('same-entry').note = 'second batch evidence'
  await state.selectBatch('batch-one')
  assert.equal(state.draftFor('same-entry').note, '')
})

test('preview failure retains the newly created batch and retries without creating a duplicate', async () => {
  let created = 0,
    failPreview = true
  const batch = { id: 'created-batch', status: 'draft', counts: {}, reasons: [] }
  const state = fixture({
    createAdoptionBatch: async () => {
      created++
      return batch
    },
    previewAdoptionBatch: async () => {
      if (failPreview) throw new Error('preview unavailable')
      batch.status = 'previewed'
    },
    listAdoptionBatches: async () => ({
      batches: created ? [batch] : [],
      page: 1,
      totalPages: 1,
      totalItems: created
    })
  })
  await state.reset()
  state.createForm.recipient = 'synthetic recipient'
  await state.create()
  assert.equal(created, 1)
  assert.equal(state.screen.value, 'detail')
  assert.equal(state.currentId.value, 'created-batch')
  assert.equal(state.operationError.value, 'preview unavailable')
  failPreview = false
  await state.preview()
  assert.equal(created, 1)
  assert.equal(state.currentId.value, 'created-batch')
  assert.equal(state.operationError.value, '')
})

test('creating a batch keeps note edits made during the request and does not submit twice', async () => {
  const pending = deferred()
  let created = 0
  const state = fixture({
    createAdoptionBatch: async (_id, body) => {
      created++
      assert.equal(body.note, 'submitted note')
      return pending.promise
    },
    previewAdoptionBatch: async () => {}
  })
  await state.reset()
  state.createForm.note = 'submitted note'
  const request = state.create()
  state.createForm.note = 'new note typed while waiting'
  await state.create()
  pending.resolve({ id: 'created-batch', status: 'draft', counts: {} })
  await request
  assert.equal(created, 1)
  assert.equal(state.createForm.note, 'new note typed while waiting')
})

test('an exact decided exception deep link remains visible outside the current exceptions page', async () => {
  const requested = []
  const state = fixture({
    getAdoptionExceptionByPage: async (batch, page) => {
      requested.push([batch, page])
      return {
        entry: { page: 'off-page', pending: false },
        exception: { page: 'off-page', decision: 'exclude', note: 'retained authority' }
      }
    }
  })
  state.route.query = {
    batch: 'historical-batch',
    tab: 'exceptions',
    exception: 'off-page',
    page: '1'
  }
  await state.reset()
  assert.equal(state.currentId.value, 'historical-batch')
  assert.equal(state.exceptions.value.exceptions[0].note, 'retained authority')
  assert.deepEqual(requested, [['historical-batch', 'off-page']])
  assert.equal(state.exceptionQuery.value, 'off-page')
  assert.match(view, /:open="Boolean\(exceptionQuery\)"/)
})

test('canonical exception wins over a legacy entry and selects an off-page pending item', async () => {
  const requested = []
  const state = fixture({
    listAdoptionExceptions: async () => ({
      pending: [{ page: 'on-page', pageNumber: 1 }],
      exceptions: [],
      pendingTotal: 26
    }),
    getAdoptionExceptionByPage: async (_batch, page) => {
      requested.push(page)
      return { entry: { page, pending: true, pageNumber: 26 } }
    }
  })
  state.route.query = {
    batch: 'batch',
    tab: 'exceptions',
    page: '1',
    exception: 'canonical-target',
    entry: 'legacy-target'
  }
  await state.reset()
  assert.deepEqual(requested, ['canonical-target'])
  assert.equal(state.activeExceptionId.value, 'canonical-target')
  assert.equal(state.visibleExceptions.value[0].page, 'canonical-target')
  assert.equal(state.exceptions.value.pending.length, 2)
})

test('legacy entry links still load and navigation emits only canonical exception', async () => {
  const requested = []
  const state = fixture({
    getAdoptionExceptionByPage: async (_batch, page) => {
      requested.push(page)
      return { entry: { page, pending: true, pageNumber: 26 } }
    }
  })
  state.route.query = { batch: 'batch', tab: 'exceptions', page: '1', entry: 'legacy-target' }
  await state.reset()
  assert.equal(state.activeExceptionId.value, 'legacy-target')
  await state.changePage(2)
  assert.equal(state.route.query.page, 2)
  assert.equal(state.route.query.exception, 'legacy-target')
  assert.equal(Object.hasOwn(state.route.query, 'entry'), false)
  assert.equal(state.activeExceptionId.value, 'legacy-target')
  await state.navigate({ ...state.route.query, entry: 'stale-alias', exception: 'selected-target' })
  assert.equal(state.route.query.exception, 'selected-target')
  assert.equal(Object.hasOwn(state.route.query, 'entry'), false)
  assert.equal(state.activeExceptionId.value, 'selected-target')
  await state.navigate({ ...state.route.query, decidedPage: 3 })
  assert.equal(state.route.query.decidedPage, 3)
  assert.equal(state.route.query.exception, 'selected-target')
  assert.deepEqual(requested, [
    'legacy-target',
    'legacy-target',
    'selected-target',
    'selected-target'
  ])
})

test('creation and legacy detail navigation preserve the original list page', async () => {
  const state = fixture({
    createAdoptionBatch: async () => ({
      id: 'created',
      project: 'project-a',
      counts: {},
      status: 'draft'
    }),
    previewAdoptionBatch: async () => ({})
  })
  state.route.query = { listPage: '4' }
  await state.reset()
  await state.navigate({ view: 'create' })
  state.createForm.recipient = 'synthetic recipient'
  await state.create()
  assert.equal(state.currentId.value, 'created')
  assert.equal(state.historyPage.value, 4)
  await state.navigate({ listPage: state.historyPage.value })
  assert.equal(state.route.query.listPage, '4')
  state.route.query = { batch: 'created', returnPage: '4' }
  await state.reset()
  await state.navigate({ batch: 'created', tab: 'history', page: 1 })
  assert.equal(state.route.query.listPage, '4')
  assert.equal(state.historyPage.value, 4)
})
