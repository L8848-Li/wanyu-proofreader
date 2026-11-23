import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach } from 'node:test'
import { effectScope, nextTick, reactive } from 'vue'
import { createDeliveryWorkspace } from '../src/composables/createDeliveryWorkspace.js'
import { receiptLabel, receiptEventNote } from '../src/lib/deliveryPresentation.js'
import { protectedPageScopeFixture } from './helpers/protectedPageScopeFixture.js'

const disposals = new Set()
afterEach(() => {
  for (const dispose of disposals) dispose()
})

function fixture(services = {}, { automaticRoute = false } = {}) {
  const route = reactive({
    params: { id: 'project-1' },
    query: {},
    fullPath: '/projects/project-1/deliveries'
  })
  const cleanup = []
  const protectedScope = protectedPageScopeFixture((callback) => cleanup.push(callback))
  let routeChanged
  const router = {
    push: async ({ query }) => {
      route.query = query
      route.fullPath = '/projects/' + route.params.id + '/deliveries?' + new URLSearchParams(query)
      if (routeChanged) routeChanged()
      await nextTick()
    }
  }
  const scope = effectScope()
  const state = scope.run(() =>
    createDeliveryWorkspace({
      route,
      router,
      useProtectedPageScope: protectedScope.useProtectedPageScope,
      onBeforeUnmount: (callback) => cleanup.push(callback),
      // Most tests control route delivery to isolate a request race. The automatic
      // route test below uses the production Vue watcher, including its initial load.
      ...(automaticRoute
        ? {}
        : {
            observeRoute: (callback) => {
              routeChanged = callback
              return () => {
                routeChanged = null
              }
            }
          }),
      services: {
        listDeliveries: async () => ({ items: [], metrics: {}, page: 1, totalPages: 1 }),
        getDelivery: async (id) => ({
          id,
          project: route.params.id,
          recipient: 'synthetic',
          reconciliation: { payload_count: 1 }
        }),
        listDeliveryEvents: async () => ({ events: [], page: 1, totalPages: 1 }),
        listAdoptionBatches: async () => ({ batches: [], page: 1, totalPages: 1 }),
        getAdoptionBatch: async (id) => ({ id, project: route.params.id, status: 'confirmed' }),
        ...services
      }
    })
  )
  const unmount = () => {
    if (!disposals.delete(unmount)) return
    cleanup.forEach((callback) => callback())
    scope.stop()
  }
  disposals.add(unmount)
  return { ...state, route, changeIdentity: protectedScope.changeIdentity, unmount }
}

async function runLoad(listDeliveries, initial = {}) {
  const state = fixture({ listDeliveries })
  state.operationError.value = '上一次出包失败'
  state.items.value = initial.items ?? []
  state.metrics.value = initial.metrics ?? null
  await state.load()
  return state
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('download feedback follows only the package that started the download', async () => {
  const state = fixture({ downloadDelivery: async () => {} })
  await state.openDelivery({ id: 'package-a' })
  await state.download({ id: 'package-a' })
  assert.match(state.success.value, /已发起浏览器下载/)

  await state.navigate({ package: 'package-a', tab: 'events', page: 1 })
  assert.match(state.success.value, /已发起浏览器下载/)
  await state.openDelivery({ id: 'package-b' })
  assert.equal(state.success.value, '', 'another package has not been downloaded')

  await state.download({ id: 'package-b' })
  state.route.params.id = 'project-2'
  await state.openDelivery({ id: 'package-b' })
  assert.equal(state.success.value, '', 'a different project must not inherit the notice')
})

test('delivery details and event pagination return to the original record page, including reload', async () => {
  const service = {
    listDeliveries: async (_id, { page }) => ({ items: [], metrics: {}, page, totalPages: 5 })
  }
  const state = fixture(service)
  await state.navigate({ view: 'records', page: 3 })
  await new Promise((resolve) => setImmediate(resolve))
  await state.openDelivery({ id: 'package-three' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(String(state.route.query.listPage), '3')
  await state.navigate({ package: 'package-three', tab: 'events', page: 2 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(String(state.route.query.listPage), '3')
  assert.equal(state.route.query.page, 2)

  const reloaded = fixture(service)
  await reloaded.navigate({ ...state.route.query })
  await new Promise((resolve) => setImmediate(resolve))
  await reloaded.navigate({ view: 'records' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(String(reloaded.route.query.page), '3')
  assert.equal(reloaded.listPage.value, 3)
  assert.equal(Object.hasOwn(reloaded.route.query, 'returnPage'), false)
})

test('reopening the same delivery event editor preserves the unsaved receipt', () => {
  const state = fixture()
  const item = { id: 'package-one', reconciliation: { payload_count: 7 } }
  state.selectEvent(item)
  state.eventForm.status = 'partial_conflict'
  state.eventForm.affected = 2
  state.eventForm.reason = '接收方报告两条冲突'
  state.selectEvent(item)
  assert.equal(state.eventForm.status, 'partial_conflict')
  assert.equal(state.eventForm.affected, 2)
  assert.equal(state.eventForm.reason, '接收方报告两条冲突')
  assert.equal(state.dirty.value, true)
})

function seedPrivateDrafts(state) {
  state.selected.value = { id: 'package-one' }
  state.eventForm.reason = 'private reason'
  state.eventForm.evidence = 'private evidence'
  state.reviewer.value = 'private reviewer'
  state.handoff.value = { entries: [{ private: true }] }
  state.handoffFilename.value = 'private.json'
  state.preview.value = { can_generate: true, preview_sha256: 'old-sha' }
  state.requestId.value = 'old-request-id'
  state.confirmed.value = true
  state.impacts.value = [{ id: 'private-impact' }]
  state.sourceRef.value = 'private-source'
}

function assertProtectedDataCleared(state, accessLost = true) {
  assert.equal(state.accessLost.value, accessLost)
  assert.equal(state.loading.value, false)
  assert.equal(state.busy.value, false)
  assert.deepEqual(state.items.value, [])
  assert.deepEqual(state.adoptionChoices.value, [])
  for (const field of [
    'currentDelivery',
    'nativeBatch',
    'metrics',
    'impacts',
    'selected',
    'preview',
    'handoff'
  ])
    assert.equal(state[field].value, null, `${field} must be cleared`)
  assert.equal(state.eventForm.reason, '')
  assert.equal(state.eventForm.evidence, '')
  assert.equal(state.reviewer.value, '')
  assert.equal(state.handoffFilename.value, '')
  assert.equal(state.requestId.value, '')
  assert.equal(state.confirmed.value, false)
  assert.equal(state.sourceRef.value, '')
}

for (const status of [401, 403]) {
  for (const origin of ['list', 'detail', 'action']) {
    test(`delivery ${origin} ${status} revokes stale detail, drafts and generation authority`, async () => {
      let denied = false
      const state = fixture({
        listDeliveries: async () => {
          if (denied && origin === 'list') throw { status }
          return {
            items: [{ id: 'package-one' }],
            metrics: { package_count: 1 },
            page: 1,
            totalPages: 1
          }
        },
        getDelivery: async (id) => {
          if (denied && origin === 'detail') throw { response: { status } }
          return { id, project: 'project-1', reconciliation: { payload_count: 1 } }
        }
      })
      state.selectedPackageId.value = 'package-one'
      state.view.value = 'detail'
      await state.load()
      seedPrivateDrafts(state)
      const pending = state.pageScope.capture()
      denied = true
      if (origin === 'action')
        await state.action(async () => {
          throw { status }
        })
      else await state.load()
      assertProtectedDataCleared(state)
      assert.equal(pending.signal.aborted, true)
      assert.match(state.loadError.value, status === 401 ? /登录状态已失效/ : /无权/)
      let attempted = false
      await state.action(async () => {
        attempted = true
      })
      assert.equal(attempted, false, 'the old page cannot generate or append another event')
    })
  }
}

for (const origin of ['list', 'picker']) {
  for (const status of [404, 500]) {
    test(`delivery project ${origin} ${status} ${status === 404 ? 'clears the whole workspace' : 'preserves loaded data and drafts'}`, async () => {
      let failed = false
      const state = fixture({
        listDeliveries: async () => {
          if (failed && origin === 'list') throw { status }
          return {
            items: [{ id: 'package-one' }, { id: 'package-two' }],
            metrics: { package_count: 2 },
            page: 1,
            totalPages: 1
          }
        },
        listAdoptionBatches: async () => {
          if (failed && origin === 'picker') throw { response: { status } }
          return { batches: [{ id: 'batch-one' }], page: 1, totalPages: 1 }
        }
      })
      state.view.value = 'prepare'
      state.selectedPackageId.value = 'package-one'
      state.route.query.adoption = 'batch-one'
      await state.load()
      seedPrivateDrafts(state)
      assert.equal(state.dirty.value, true)
      const pending = state.pageScope.capture()
      failed = true
      await state.load()
      if (status === 404) {
        assertProtectedDataCleared(state, false)
        assert.equal(state.projectUnavailable.value, true)
        assert.equal(state.unavailable.value, true)
        assert.equal(state.dirty.value, false)
        assert.equal(pending.signal.aborted, true)
        assert.match(state.loadError.value, /项目不存在或已被删除/)
      } else {
        assert.equal(state.projectUnavailable.value, false)
        assert.equal(state.accessLost.value, false)
        assert.deepEqual(
          state.items.value.map((item) => item.id),
          ['package-one', 'package-two']
        )
        assert.equal(state.metrics.value.package_count, 2)
        assert.equal(state.currentDelivery.value.id, 'package-one')
        assert.equal(state.adoptionChoices.value[0].id, 'batch-one')
        assert.equal(state.eventForm.reason, 'private reason')
        assert.equal(state.preview.value.preview_sha256, 'old-sha')
        assert.equal(state.requestId.value, 'old-request-id')
        assert.equal(state.dirty.value, true)
        assert.equal(pending.signal.aborted, false)
      }
    })
  }
}

test('delivery detail 404 revokes the selected record while preserving unrelated list rows', async () => {
  let missing = false
  const state = fixture({
    listDeliveries: async () => ({
      items: [{ id: 'package-one' }, { id: 'package-two' }],
      page: 1,
      totalPages: 1
    }),
    getDelivery: async (id) => {
      if (missing) throw { status: 404 }
      return { id, project: 'project-1', reconciliation: { payload_count: 1 } }
    }
  })
  state.selectedPackageId.value = 'package-one'
  state.view.value = 'detail'
  await state.load()
  seedPrivateDrafts(state)
  missing = true
  await state.load()
  assert.equal(state.accessLost.value, false)
  assert.equal(state.unavailable.value, true)
  assert.equal(state.projectUnavailable.value, false)
  assert.equal(state.selectedPackageId.value, 'package-one')
  assert.deepEqual(
    state.items.value.map((item) => item.id),
    ['package-two']
  )
  assert.deepEqual(state.visibleDeliveries.value, [])
  assert.equal(state.selected.value, null)
  assert.equal(state.preview.value, null)
  assert.equal(state.requestId.value, '')
  assert.match(state.loadError.value, /不可用/)
  let attempted = false
  await state.action(async () => {
    attempted = true
  })
  assert.equal(attempted, false)
  missing = false
  await state.load()
  assert.equal(state.unavailable.value, false)
  assert.equal(state.currentDelivery.value.id, 'package-one')
})

test('temporary delivery detail failure keeps current event drafts and preview rather than revoking access', async () => {
  let fail = false
  const state = fixture({
    getDelivery: async (id) => {
      if (fail) throw new Error('temporary detail outage')
      return { id, project: 'project-1', reconciliation: { payload_count: 1 } }
    }
  })
  state.selectedPackageId.value = 'package-one'
  state.view.value = 'detail'
  await state.load()
  seedPrivateDrafts(state)
  fail = true
  await state.load()
  assert.equal(state.accessLost.value, false)
  assert.equal(state.unavailable.value, false)
  assert.equal(state.currentDelivery.value.id, 'package-one')
  assert.equal(state.eventForm.reason, 'private reason')
  assert.equal(state.preview.value.preview_sha256, 'old-sha')
  assert.equal(state.requestId.value, 'old-request-id')
  assert.equal(state.loadError.value, 'temporary detail outage')
})

test('delivery session replacement aborts requests and ignores a transport that returns late success', async () => {
  const pending = deferred()
  let signal
  const state = fixture({
    listDeliveries: async (_id, options) => {
      signal = options.signal
      return pending.promise
    }
  })
  seedPrivateDrafts(state)
  const old = state.load()
  state.changeIdentity({ id: 'account-b', role: 'user' })
  assertProtectedDataCleared(state)
  assert.equal(signal.aborted, true)
  pending.resolve({ items: [{ id: 'private-a' }], metrics: { package_count: 99 } })
  await old
  assertProtectedDataCleared(state)
})

test('a stale delivery denial cannot clear a newer session successful retry', async () => {
  const pending = deferred()
  let count = 0
  const state = fixture({
    listDeliveries: async () =>
      ++count === 1
        ? pending.promise
        : {
            items: [{ id: 'current-b' }],
            page: 1,
            totalPages: 1
          }
  })
  const old = state.load()
  state.changeIdentity({ id: 'account-b', role: 'user' })
  await state.load()
  pending.reject({ status: 401 })
  await old
  assert.equal(state.accessLost.value, false)
  assert.equal(state.loadError.value, '')
  assert.equal(state.items.value[0].id, 'current-b')
})

test('adoption picker pages ignore superseded responses and revoke on current permission failure', async () => {
  const first = deferred()
  let firstSignal
  const state = fixture({
    listAdoptionBatches: async (_id, { page, signal }) => {
      if (page === 1) {
        firstSignal = signal
        return first.promise
      }
      if (page === 3) throw { status: 403 }
      return { batches: [{ id: 'page-two' }], page, totalPages: 3 }
    }
  })
  const old = state.loadAdoptions(1)
  await state.loadAdoptions(2)
  assert.equal(firstSignal.aborted, true)
  first.resolve({ batches: [{ id: 'stale-page-one' }], page: 1, totalPages: 3 })
  await old
  assert.equal(state.adoptionChoices.value[0].id, 'page-two')
  assert.equal(state.adoptionPage.value, 2)
  await state.loadAdoptions(3)
  assertProtectedDataCleared(state)
})

test('a late adoption picker success cannot repopulate a revoked delivery page', async () => {
  const pending = deferred()
  const state = fixture({ listAdoptionBatches: () => pending.promise })
  const old = state.loadAdoptions()
  state.changeIdentity(null)
  pending.resolve({ batches: [{ id: 'private-a-batch' }], page: 1, totalPages: 1 })
  await old
  assertProtectedDataCleared(state)
})

for (const waitingAt of ['list', 'adoption-detail']) {
  for (const invalidation of ['401', 'identity']) {
    test(`revoking a prepare load waiting for ${waitingAt} via ${invalidation} prevents a fresh picker request`, async () => {
      const waiting = deferred()
      const entered = deferred()
      let pickerRequests = 0
      const list = { items: [], page: 1, totalPages: 1 }
      const adoption = { id: 'batch-one', project: 'project-1', status: 'confirmed' }
      const state = fixture({
        listDeliveries: async () => {
          if (waitingAt !== 'list') return list
          entered.resolve()
          return waiting.promise
        },
        getAdoptionBatch: async () => {
          if (waitingAt !== 'adoption-detail') return adoption
          entered.resolve()
          return waiting.promise
        },
        listAdoptionBatches: async () => {
          pickerRequests++
          return { batches: [{ id: 'private-old-picker-option' }], page: 1, totalPages: 1 }
        }
      })
      state.view.value = 'prepare'
      state.route.query = { view: 'prepare', adoption: 'batch-one' }
      const old = state.load()
      await entered.promise
      if (invalidation === '401')
        await state.action(async () => {
          throw { status: 401 }
        })
      else state.changeIdentity({ id: 'account-b', role: 'user' })
      assertProtectedDataCleared(state)
      // This transport deliberately ignores AbortSignal. Its old outer load
      // must stop before a child loader can capture a new, valid scope ticket.
      waiting.resolve(waitingAt === 'list' ? list : adoption)
      await old
      assert.equal(pickerRequests, 0, 'an obsolete parent cannot start a newly owned child request')
      assertProtectedDataCleared(state)
    })
  }
}

test('已处置的冲突不再宣称为待上游处理', () => {
  assert.equal(
    receiptLabel({ receipt_state: 'partial_conflict', pending_actions: ['event-1'] }),
    '部分冲突，待上游处理'
  )
  assert.equal(
    receiptLabel({ receipt_state: 'partial_conflict', pending_actions: [] }),
    '部分冲突，已登记处置'
  )
})

test('人工回执写明记录方式，失败不叫尚未回执', () => {
  assert.equal(
    receiptLabel({
      receipt_state: 'failed_rolled_back',
      pending_actions: [],
      receipt_channel: 'manual'
    }),
    '整体失败并回滚（人工回执，对方自动回传未接入）'
  )
  assert.equal(
    receiptLabel({
      receipt_state: 'awaiting_receipt',
      pending_actions: [],
      receipt_channel: 'none'
    }),
    '对方尚未回执'
  )
  assert.notEqual(
    receiptLabel({
      receipt_state: 'failed_rolled_back',
      pending_actions: [],
      receipt_channel: 'manual'
    }),
    receiptLabel({ receipt_state: 'awaiting_receipt', pending_actions: [] })
  )
})

test('没有渠道字段的旧回执仍标成人工回执', () => {
  assert.equal(
    receiptEventNote({ payload: { affected: 2, status: 'success' } }),
    '影响 2 条 · 人工回执'
  )
  assert.equal(
    receiptEventNote({ payload: { affected: 1, status: 'failed_rolled_back', channel: 'manual' } }),
    '影响 1 条 · 人工回执'
  )
})

test('其余回执状态不受待办数量影响', () => {
  for (const [state, label] of [
    ['awaiting_receipt', '对方尚未回执'],
    ['success', '全部成功'],
    ['failed_rolled_back', '整体失败并回滚'],
    ['some_future_state', 'some_future_state']
  ]) {
    assert.equal(receiptLabel({ receipt_state: state, pending_actions: [] }), label)
    assert.equal(receiptLabel({ receipt_state: state, pending_actions: ['event-1'] }), label)
  }
})

test('当前退回和停用状态优先于历史回执字段', () => {
  const record = { receipt_state: 'awaiting_receipt', pending_actions: [] }
  for (const [workflow_state, label] of [
    ['pending_resolution', '退回待处置'],
    ['returned_resolved', '退回已处置'],
    ['withdrawn', '已停用'],
    ['awaiting_receipt', '对方尚未回执']
  ]) {
    assert.equal(receiptLabel({ ...record, workflow_state }), label)
  }
})

test('列表加载失败写入 loadError，不冒充空记录', async () => {
  const state = await runLoad(async () => {
    throw new Error('Failed to fetch')
  })
  assert.equal(state.loading.value, false)
  assert.equal(state.loadError.value, 'Failed to fetch')
  assert.deepEqual(state.items.value, [])
  assert.equal(state.operationError.value, '', '刷新要清掉上一轮操作留下的错误')
  // The empty state must stay behind the loadError branch, otherwise an unknown
  // result is announced as "no packages yet".
  assert.match(
    readFileSync(
      new URL('../src/components/admin/delivery/DeliveryRecordsPanel.vue', import.meta.url),
      'utf8'
    ),
    /v-if="loadError" state="error"[\s\S]*?v-else-if="!items\.length" class="empty-state"/
  )
})

test('刷新成功后清除旧的加载与操作错误', async () => {
  const state = await runLoad(
    async (id) => {
      assert.equal(id, 'project-1')
      return { items: [{ id: 'delivery-1' }], metrics: { package_count: 1 } }
    },
    { items: [], metrics: null }
  )
  assert.equal(state.loading.value, false)
  assert.equal(state.loadError.value, '')
  assert.equal(state.operationError.value, '')
  assert.deepEqual(state.items.value, [{ id: 'delivery-1' }])
  assert.deepEqual(state.metrics.value, { package_count: 1 })
})

test('刷新失败保留已加载的交付记录', async () => {
  const loaded = [{ id: 'delivery-1' }]
  const state = await runLoad(
    async () => {
      throw {}
    },
    { items: loaded, metrics: { package_count: 1 } }
  )
  assert.equal(state.loadError.value, '交付记录加载失败')
  assert.deepEqual(state.items.value, loaded)
})

test('late delivery list responses cannot replace a newer successful refresh', async () => {
  let resolveFirst
  const state = fixture({
    listDeliveries: (() => {
      let calls = 0
      return () =>
        ++calls === 1
          ? new Promise((resolve) => {
              resolveFirst = resolve
            })
          : Promise.resolve({ items: [{ id: 'new-package' }], metrics: { package_count: 1 } })
    })()
  })
  const first = state.load()
  await state.load()
  resolveFirst({ items: [{ id: 'old-package' }], metrics: { package_count: 99 } })
  await first
  assert.equal(state.items.value[0].id, 'new-package')
  assert.equal(state.metrics.value.package_count, 1)
  assert.equal(state.loading.value, false)
})

test('unmount prevents old delivery data and errors from publishing', async () => {
  let rejectRequest
  const state = fixture({
    listDeliveries: () =>
      new Promise((resolve, reject) => {
        rejectRequest = reject
      })
  })
  state.items.value = [{ id: 'preserved-package' }]
  const pending = state.load()
  state.unmount()
  rejectRequest(new Error('old account request failed'))
  await pending
  assert.equal(state.loadError.value, '')
  assert.equal(state.items.value[0].id, 'preserved-package')
})

test('impact selection loads the off-page ID and rejects a detail from another project', async () => {
  const requested = []
  const state = fixture({
    getDelivery: async (id) => {
      requested.push(id)
      return { id, project: 'another-project' }
    }
  })
  await state.openImpact({ id: 'off-page-package' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(requested, ['off-page-package'])
  assert.equal(state.currentDelivery.value, null)
  assert.equal(state.unavailable.value, true)
  assert.match(state.loadError.value, /不可用/)
})

test('native generation retry reuses its UUID and complete scope until input changes', async () => {
  const attempts = []
  const state = fixture({
    checkAdoptionDelivery: async () => ({ can_generate: true, preview_sha256: 'preview-hash' }),
    createAdoptionDelivery: async (_id, body) => {
      attempts.push(body)
      throw new Error('response lost')
    }
  })
  state.view.value = 'prepare'
  state.nativeBatch.value = { id: 'adoption-one', scope_digest: 'scope-hash' }
  state.reviewer.value = 'Synthetic reviewer'
  await nextTick()
  await state.preflight()
  const requestId = state.requestId.value
  assert.ok(requestId)
  state.confirmed.value = true
  await state.generate()
  await state.generate()
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0], {
    adoption_batch_id: 'adoption-one',
    expected_scope_digest: 'scope-hash',
    reviewer: 'Synthetic reviewer',
    previous: '',
    change_reason: '',
    preview_sha256: 'preview-hash',
    request_id: requestId
  })
  assert.deepEqual(attempts[1], attempts[0])
  assert.equal(state.requestId.value, requestId)
  state.changeReason.value = 'Changed input'
  await nextTick()
  assert.equal(state.preview.value, null)
  assert.equal(state.confirmed.value, false)
  assert.equal(state.requestId.value, '')
  await state.generate()
  assert.equal(attempts.length, 2, 'changed scope cannot generate without another preflight')
})

test('production route watcher clears old drafts, loads the new route and stops on disposal', async () => {
  const reads = []
  const state = fixture(
    {
      listDeliveries: async (id, { page }) => {
        reads.push([id, page])
        return { items: [{ id }], metrics: {}, page, totalPages: 3 }
      }
    },
    { automaticRoute: true }
  )
  await new Promise((resolve) => setImmediate(resolve))
  state.selected.value = { id: 'private' }
  state.eventForm.reason = 'private note'
  state.route.params.id = 'project-2'
  state.route.query = { page: '2' }
  state.route.fullPath = '/projects/project-2/deliveries?page=2'
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(reads, [
    ['project-1', 1],
    ['project-2', 2]
  ])
  assert.equal(state.selected.value, null)
  assert.equal(state.eventForm.reason, '')
  assert.equal(state.items.value[0].id, 'project-2')
  state.unmount()
  state.route.fullPath = '/projects/project-3/deliveries'
  await nextTick()
  assert.equal(reads.length, 2)
})
