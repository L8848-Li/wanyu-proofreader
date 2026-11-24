import { createAuthService } from '../src/services/createAuthService.js'
import { jobObserverScope } from './helpers/jobObserverScope.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, reactive, ref, watch as vueWatch } from 'vue'
import { createAccountViewScope } from '../src/lib/accountViewScope.js'
import { createPdfPreviewCache } from '../src/lib/pdfPreviewCache.js'
import { createPageImageCache } from '../src/lib/pageImageCache.js'
import * as sourceRegion from '../src/lib/sourceRegion.js'
import * as accountSecurity from '../src/lib/accountSecurity.js'
import * as localAccountData from '../src/lib/localAccountData.js'
import { adminRouteKey } from '../src/lib/adminRouteKey.js'
import * as taskDraft from '../src/lib/taskDraft.js'
import * as normalizationDraft from '../src/lib/normalizationDraft.js'

const regression = (name, run) => test(name, { timeout: 5000 }, run)

const stripImports = (source) => source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\n/gm, '')
function evaluate(path, names, overrides = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const script = source.includes('<script setup>')
    ? source.split('<script setup>')[1].split('</script>')[0]
    : source
  const cleanup = []
  const scope = {
    ...jobObserverScope(cleanup),
    ref,
    reactive,
    computed,
    watch: () => {},
    onMounted: () => {},
    onBeforeUnmount: (callback) => cleanup.push(callback),
    getPbMessage: (error) => error.message,
    ...normalizationDraft,
    ...sourceRegion,
    ...overrides
  }
  const environment = new Proxy(scope, {
    has: () => true,
    get: (target, name) =>
      name === Symbol.unscopables ? undefined : name in target ? target[name] : globalThis[name]
  })
  const body = stripImports(script).replace(/^export /gm, '')
  const value = new Function(
    'environment',
    `with (environment) { ${body}\nreturn { ${names.join(',')} } }`
  )(environment)
  return { ...value, dispose: () => cleanup.forEach((callback) => callback()) }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function memoryStorage() {
  const data = new Map()
  return {
    get length() {
      return data.size
    },
    key: (index) => [...data.keys()][index],
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  }
}

regression(
  'project workspaces remount on identity changes and keep query-only pagination mounted',
  () => {
    const a = { name: 'SourceFidelity', params: { id: 'a' }, query: { page: '1' } }
    assert.notEqual(adminRouteKey(a), adminRouteKey({ ...a, params: { id: 'b' } }))
    assert.equal(adminRouteKey(a), adminRouteKey({ ...a, query: { page: '2' } }))
    assert.notEqual(
      adminRouteKey({ name: 'Arbitration', params: { projectId: 'p', pageId: 'a' } }),
      adminRouteKey({ name: 'Arbitration', params: { projectId: 'p', pageId: 'b' } })
    )
    const layout = readFileSync(
      new URL('../src/views/admin/AdminLayout.vue', import.meta.url),
      'utf8'
    )
    assert.match(layout, /<RouterView :key="adminRouteKey\(route\)"/)
  }
)

regression(
  'auth getters react to logout and cross-tab identity changes invalidate capability cache and pending requests',
  async () => {
    let listener
    const pending = deferred()
    let calls = 0
    const pb = {
      authStore: {
        model: { id: 'a' },
        token: 'a-token',
        isValid: true,
        onChange: (fn) => {
          listener = fn
        }
      }
    }
    const { useAuthStore } = evaluate('stores/auth.js', ['useAuthStore'], {
      pb,
      defineStore: (_name, setup) => setup,
      getAccessContext: () => {
        calls++
        return calls === 1 ? pending.promise : Promise.resolve({ managedProjectIds: ['b-project'] })
      },
      platformAdmin: () => false,
      projectRoles: () => ({})
    })
    const store = useAuthStore()
    assert.equal(store.isLoggedIn.value, true)
    const oldRequest = store.loadAccessContext()
    pb.authStore.model = { id: 'b' }
    pb.authStore.token = 'b-token'
    listener('b-token', { id: 'b' })
    const newRequest = store.loadAccessContext()
    assert.equal(calls, 2)
    await newRequest
    pending.resolve({ managedProjectIds: ['a-project'] })
    await oldRequest
    assert.deepEqual(store.accessContext.value, { managedProjectIds: ['b-project'] })
    pb.authStore.isValid = false
    pb.authStore.token = ''
    pb.authStore.model = null
    listener('', null)
    assert.equal(store.isLoggedIn.value, false)
    assert.equal(store.accessContext.value, null)
  }
)

function settingsFixture(updateProject) {
  const route = reactive({ params: { id: 'a' } })
  const calls = { memberLoads: [], navigations: [] }
  const api = evaluate(
    'views/admin/ProjectSettingsView.vue',
    [
      'saveDetails',
      'saveSettings',
      'addMember',
      'project',
      'details',
      'detailsDirty',
      'newMember',
      'success',
      'error'
    ],
    {
      useRoute: () => route,
      useRouter: () => ({ push: (path) => calls.navigations.push(path) }),
      useAuthStore: () => ({ loadAccessContext: async () => {} }),
      createCandidatePager: () => ({ search: async () => {} }),
      updateProject,
      setProjectMember: updateProject,
      listProjectMembers: async (id) => {
        calls.memberLoads.push(id)
        return []
      }
    }
  )
  api.project.value = { id: 'a', name: 'Old', description: '' }
  api.details.name = 'Edited'
  return { api, route, calls }
}

regression(
  'settings late saves cannot overwrite a different project or reload its member list',
  async () => {
    const waiting = deferred()
    const { api, route } = settingsFixture(() => waiting.promise)
    const operation = api.saveDetails()
    route.params.id = 'b'
    api.project.value = { id: 'b', name: 'B' }
    api.details.name = 'B local'
    waiting.resolve({ id: 'a', name: 'Edited' })
    await operation
    assert.equal(api.project.value.id, 'b')
    assert.equal(api.details.name, 'B local')
    const memberWaiting = deferred()
    const second = settingsFixture(() => memberWaiting.promise)
    const adding = second.api.addMember()
    second.api.dispose()
    second.route.params.id = 'b'
    memberWaiting.resolve({})
    await adding
    assert.deepEqual(second.calls.memberLoads, [])
  }
)

function verificationFixture(overrides = {}) {
  const props = reactive({
    page: { id: 'a' },
    row: { 词: '新' },
    leaseToken: 'lease-a',
    active: true,
    hints: []
  })
  const calls = { drafts: [], reports: [] }
  const api = evaluate(
    'components/editor/TaskVerificationPanel.vue',
    ['load', 'persistDraft', 'sendReport', 'data', 'saveError', 'message', 'saving', 'report'],
    {
      defineProps: () => props,
      defineEmits: () => () => {},
      defineExpose: () => {},
      nextTick: async () => {},
      getPbStatus: (error) => Number(error.status),
      getVerification: async (id) => ({ context: { basis: id, input: { 词: '新' } }, reports: [] }),
      saveVerificationDraft: async (...args) => {
        calls.drafts.push(args)
      },
      reportProblem: async (...args) => {
        calls.reports.push(args)
        return { id: 'report' }
      },
      ...overrides
    }
  )
  return { api, props, calls }
}

regression(
  'verification read backs off through consecutive conflicts and remains bounded',
  async () => {
    let reads = 0
    const delays = []
    const f = verificationFixture({
      getVerification: async () => {
        if (++reads <= 2) throw Object.assign(new Error('changed'), { status: 409 })
        return { context: { basis: 'a', input: { 词: '新' } }, reports: [] }
      },
      setTimeout: (callback, delay) => {
        delays.push(delay)
        callback()
      }
    })
    await f.api.load()
    assert.equal(reads, 3)
    assert.deepEqual(delays, [100, 200])
    assert.equal(f.api.data.value.context.basis, 'a')
    for (const status of [409, 403, 500]) {
      let attempts = 0
      const g = verificationFixture({
        getVerification: async () => {
          attempts++
          throw Object.assign(new Error('unavailable'), { status })
        },
        setTimeout: (callback) => callback()
      })
      await g.api.load()
      assert.equal(attempts, status === 409 ? 4 : 1)
      assert.equal(g.api.data.value, null)
    }
  }
)

regression('verification read stops retrying when its task unmounts during backoff', async () => {
  let reads = 0
  let resume
  const f = verificationFixture({
    getVerification: async () => {
      reads++
      throw Object.assign(new Error('changed'), { status: 409 })
    },
    setTimeout: (callback) => {
      resume = callback
    }
  })
  const loading = f.api.load()
  await Promise.resolve()
  f.api.dispose()
  resume()
  await loading
  assert.equal(reads, 1)
  assert.equal(f.api.data.value, null)
})

regression(
  'verification report from a previous task cannot attach to the new task and old draft failure cannot replace its error',
  async () => {
    const waiting = deferred()
    const f = verificationFixture({ reportProblem: () => waiting.promise })
    await f.api.load()
    f.api.report.description = 'Original report'
    const sending = f.api.sendReport()
    f.props.page = { id: 'b' }
    await f.api.load()
    waiting.resolve({ id: 'old-report' })
    await sending
    assert.deepEqual(f.api.data.value.reports, [])
    assert.equal(f.api.message.value, '')
    const failing = deferred()
    const started = deferred()
    const g = verificationFixture({
      saveVerificationDraft: () => {
        started.resolve()
        return failing.promise
      }
    })
    await g.api.load()
    const draft = g.api.persistDraft()
    await started.promise
    g.props.page = { id: 'b' }
    await g.api.load()
    g.api.saveError.value = 'new task error'
    failing.reject(new Error('old failure'))
    await assert.rejects(draft, /old failure/)
    assert.equal(g.api.saveError.value, 'new task error')
  }
)

regression(
  'unmount invalidates a verification request and prevents queued old drafts being sent',
  async () => {
    const waiting = deferred()
    const f = verificationFixture({ getVerification: () => waiting.promise })
    const loading = f.api.load()
    f.api.dispose()
    waiting.resolve({ context: { input: { 词: '旧' } }, reports: [] })
    await loading
    assert.equal(f.api.data.value, null)
    const g = verificationFixture()
    await g.api.load()
    const queued = g.api.persistDraft()
    g.api.dispose()
    await queued
    assert.deepEqual(g.calls.drafts, [])
  }
)

regression(
  'stale local draft survives unchanged navigation and repeated context reads preserve newly typed values',
  () => {
    const storage = memoryStorage()
    const oldWindow = globalThis.window
    globalThis.window = { localStorage: storage, clearTimeout, setTimeout }
    try {
      const state = {
        draftReady: ref(true),
        draftStatus: ref(''),
        ownReview: ref(false),
        page: ref({ id: 'p' }),
        currentUserId: ref('u'),
        initialRowJson: ref('{"词":"当前"}'),
        hasUnsavedChanges: ref(false),
        verificationContext: ref(null),
        restoredLocalDraft: ref(null),
        staleLocalDrafts: ref([]),
        originalRow: ref({ 词: '当前' })
      }
      let row = { 词: '当前' }
      state.stringifyEditedRow = () => JSON.stringify(row)
      state.replaceEditedRow = (value) => {
        row = { ...value }
      }
      const { useProofreadDrafts } = evaluate(
        'composables/proofread/useProofreadDrafts.js',
        ['useProofreadDrafts'],
        taskDraft
      )
      const old = {
        userId: 'u',
        pageId: 'p',
        sourceSignature: 'old-source',
        contextBasis: 'old-context',
        row: { 词: '珍贵旧草稿' }
      }
      taskDraft.saveTaskDraft(storage, old)
      const api = useProofreadDrafts(state)
      api.restoreDraft()
      api.flushDraft()
      assert.equal(taskDraft.loadTaskDraftHistory(storage, old)[0].row.词, '珍贵旧草稿')
      state.restoredLocalDraft.value = {
        ...old,
        sourceSignature: state.initialRowJson.value,
        savedAt: new Date().toISOString()
      }
      row = { 词: '刚恢复' }
      api.receiveVerificationContext({ basis: 'new-context' })
      assert.deepEqual(row, { 词: '当前' })
      row = { 词: '用户重新输入' }
      api.receiveVerificationContext({ basis: 'new-context' })
      assert.deepEqual(row, { 词: '用户重新输入' })
    } finally {
      globalThis.window = oldWindow
    }
  }
)

function sessionFixture(send) {
  const listeners = new Set()
  const store = {
    token: 'a-token',
    model: { id: 'a' },
    isValid: true,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    save(token, record) {
      this.token = token
      this.model = record
      this.isValid = Boolean(token)
      for (const listener of listeners) listener(token, record)
    },
    clear() {
      this.save('', null)
    }
  }
  const api = createAuthService({
    authStore: store,
    send,
    collection: () => ({
      requestEmailChange: send,
      requestVerification: send,
      // SDK publication is deliberately hostile: using these auth helpers would
      // publish a late token before the session guard can reject the response.
      authWithPassword: async () => {
        const result = await send()
        store.save(result.token, result.record)
        return result
      },
      authRefresh: async () => {
        const result = await send()
        store.save(result.token, result.record)
        return result
      }
    })
  })
  return { api, store, listeners }
}

regression(
  'late external binding and login responses cannot resurrect a cleared or replaced session',
  async () => {
    for (const method of [
      'bindExternalIdentity',
      'loginWithExternalProvider',
      'loginWithPassword'
    ]) {
      const waiting = deferred()
      const { api, store, listeners } = sessionFixture(() => waiting.promise)
      const pending =
        method === 'loginWithPassword'
          ? api[method]('identity', 'password')
          : api[method]('provider', 'identity', 'password')
      store.clear()
      if (method !== 'loginWithPassword') store.save('b-token', { id: 'b' })
      waiting.resolve({ token: 'late-a-token', record: { id: 'a' } })
      await assert.rejects(pending, { name: 'AbortError' })
      assert.equal(store.token, method === 'loginWithPassword' ? '' : 'b-token')
      assert.equal(listeners.size, 0)
    }
  }
)

regression(
  'late refresh rejection cannot log out a newer account and current refresh still updates credentials',
  async () => {
    const waiting = deferred()
    const { api, store } = sessionFixture(() => waiting.promise)
    const refresh = api.refreshStoredAuth()
    store.save('b-token', { id: 'b' })
    waiting.reject({ status: 403 })
    assert.equal(await refresh, null)
    assert.equal(store.token, 'b-token')
    const current = sessionFixture(async () => ({ token: 'fresh-token', record: { id: 'a' } }))
    await current.api.refreshStoredAuth()
    assert.equal(current.store.token, 'fresh-token')
    const rejected = sessionFixture(async () => {
      throw { status: 401 }
    })
    await rejected.api.refreshStoredAuth()
    assert.equal(rejected.store.token, '')
  }
)

regression(
  'timed out startup refresh cannot republish credentials even if transport resolves late',
  async () => {
    const waiting = deferred()
    const { api, store, listeners } = sessionFixture(() => waiting.promise)
    const controller = new AbortController()
    const refresh = api.refreshStoredAuth({ signal: controller.signal, throwOnError: true })
    controller.abort(new DOMException('synthetic timeout', 'TimeoutError'))
    waiting.resolve({ token: 'late-token', record: { id: 'a' } })
    await assert.rejects(refresh, { name: 'TimeoutError' })
    assert.equal(store.token, 'a-token')
    assert.equal(listeners.size, 0)
  }
)

regression(
  'startup reports temporary refresh failure while keeping the existing account',
  async () => {
    const { api, store } = sessionFixture(async () => {
      throw { status: 503 }
    })
    await assert.rejects(api.refreshStoredAuth({ throwOnError: true }), { status: 503 })
    assert.equal(store.token, 'a-token')
  }
)

regression(
  'profile update does not roll a newer token for the same account backwards',
  async () => {
    const waiting = deferred()
    const { api, store } = sessionFixture(() => waiting.promise)
    const update = api.updateProfile({ name: 'updated', email: '' })
    store.save('newer-token', { id: 'a', name: 'newer' })
    waiting.resolve({ token: 'older-token', record: { id: 'a', name: 'updated' } })
    await assert.rejects(update, { name: 'AbortError' })
    assert.equal(store.token, 'newer-token')
    assert.equal(store.model.name, 'newer')
  }
)

regression(
  'confirmed same-component task navigation flushes the debounce draft before the task changes',
  () => {
    const source = readFileSync(
      new URL('../src/composables/proofread/useProofreadEditor.js', import.meta.url),
      'utf8'
    )
    const body = source.slice(
      source.indexOf('  function confirmDiscardChanges()'),
      source.indexOf('  function handleBeforeUnload')
    )
    let flushes = 0
    const guard = new Function(
      'saving',
      'releasing',
      'reclaiming',
      'returning',
      'ownReview',
      'hasUnsavedChanges',
      'flushDraft',
      `${body}; return confirmDiscardChanges`
    )(ref(false), ref(false), ref(false), ref(false), ref(false), ref(true), () => {
      flushes++
    })
    const original = globalThis.window
    globalThis.window = { confirm: () => true }
    try {
      assert.equal(guard(), true)
      assert.equal(flushes, 1)
    } finally {
      globalThis.window = original
    }
  }
)

regression(
  'a lease response after disposing its case cannot restart the renewal interval',
  async () => {
    const waiting = deferred(),
      started = deferred()
    let version = 1,
      timers = 0
    const original = globalThis.window
    globalThis.window = {
      sessionStorage: {},
      setInterval: () => {
        timers++
        return 1
      },
      clearInterval: () => {}
    }
    try {
      const { useProofreadLease } = evaluate(
        'composables/proofread/useProofreadLease.js',
        ['useProofreadLease'],
        {
          loadTaskLease: () => ({ token: 'token', expiresAt: 'future' }),
          saveTaskLease: () => {},
          unref: (value) =>
            value && typeof value === 'object' && 'value' in value ? value.value : value,
          renewTaskLease: () => {
            started.resolve()
            return waiting.promise
          }
        }
      )
      const context = Object.fromEntries(
        [
          'page',
          'currentUserId',
          'leaseToken',
          'leaseExpiresAt',
          'leaseLost',
          'saveError',
          'reviewingSubmission',
          'renewingLease',
          'reclaiming',
          'releasing',
          'leaseNavigationAllowed',
          'verificationPanel'
        ].map((key) => [key, ref(null)])
      )
      Object.assign(context, {
        page: ref({ id: 'a' }),
        returnTarget: ref('/tasks?view=active&project=project-a'),
        taskEditTarget: (pageId) => ({ path: `/tasks/${pageId}/edit`, query: {} }),
        captureCase: () => version,
        isCurrentCase: (scope) => scope === version
      })
      const api = useProofreadLease(context)
      const operation = api.restoreOrAcquireLease()
      await started.promise
      version++
      waiting.resolve({ leaseExpiresAt: 'future' })
      await operation
      assert.equal(timers, 0)
    } finally {
      globalThis.window = original
    }
  }
)

regression(
  'normalization filtering drops out-of-order responses and refresh preserves manual text for the same item',
  async () => {
    const old = deferred(),
      next = deferred()
    let calls = 0
    const api = evaluate(
      'components/admin/project/ProjectSchemePanel.vue',
      ['loadReviews', 'reviewRows', 'reviewDraft', 'reviewStatusFilter'],
      {
        defineProps: () => ({ projectId: 'p' }),
        defineExpose: () => {},
        listNormalizations: () =>
          ++calls === 1
            ? old.promise
            : calls === 2
              ? next.promise
              : Promise.resolve({
                  items: [{ id: 'latest', expected_basis: 'same-basis' }],
                  page: 1
                })
      }
    )
    const first = api.loadReviews()
    api.reviewStatusFilter.value = 'UNSUPPORTED'
    const second = api.loadReviews()
    next.resolve({ items: [{ id: 'latest', expected_basis: 'same-basis' }], page: 1 })
    await second
    old.resolve({ items: [{ id: 'old-filter' }], page: 1 })
    await first
    assert.equal(api.reviewRows.value[0].id, 'latest')
    Object.assign(api.reviewDraft.value.latest, { canonical: 'ɡa̤⁵³³', basis: '人工填写依据' })
    await api.loadReviews()
    assert.equal(api.reviewDraft.value.latest.canonical, 'ɡa̤⁵³³')
    assert.equal(api.reviewDraft.value.latest.basis, '人工填写依据')
  }
)

regression('PDF fallback arms expiration to recheck the authorization window', async () => {
  const originalFetch = globalThis.fetch,
    originalTimer = globalThis.setTimeout
  const timers = []
  const descriptor = {
    key: 'pdf',
    start: 1,
    end: 2,
    total: 8,
    expiresAt: new Date(Date.now() + 60000).toISOString()
  }
  globalThis.setTimeout = (callback, milliseconds) => {
    timers.push({ callback, milliseconds })
    return 1
  }
  globalThis.fetch = async (url) =>
    url.endsWith('/descriptor')
      ? Response.json(descriptor)
      : new Response('synthetic-pdf', {
          headers: {
            'X-PDF-Preview-Key': descriptor.key,
            'X-PDF-Expires-At': descriptor.expiresAt,
            'X-PDF-Start-Page': '1',
            'X-PDF-End-Page': '2',
            'X-PDF-Total-Pages': '8'
          }
        })
  try {
    const { useProjectPdf } = evaluate('composables/useProjectPdf.js', ['useProjectPdf'], {
      pb: {
        authStore: { record: { id: 'u' }, token: 'token', onChange: () => () => {} },
        buildURL: (value) => `https://example.test${value}`
      },
      createPdfPreviewCache: () => ({
        clear: () => {},
        get: () => null,
        put: () => ({ url: 'blob:pdf', expires: Date.parse(descriptor.expiresAt) })
      }),
      createPageImageCache: () => ({
        clear: () => {},
        load: async () => {
          throw new Error('no page image')
        }
      })
    })
    const api = useProjectPdf(ref({ id: 'page', pdf_page: 1 }))
    await api.resolveProjectPdf()
    assert.equal(api.pdfUrl.value, 'blob:pdf')
    assert.equal(timers.length, 1)
    assert.ok(timers[0].milliseconds > 0 && timers[0].milliseconds <= 60000)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalTimer
  }
})

regression(
  'same-page PDF tasks reauthorize regions without sharing their reading position',
  async () => {
    const descriptor = {
      key: 'shared-pdf',
      start: 5,
      end: 6,
      total: 10,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }
    const region = (entryId) =>
      entryId === 'legacy'
        ? null
        : {
            entryId,
            physicalPage: 5,
            assetKey: descriptor.key,
            rect: { x: 0.1, y: entryId === 'first' ? 0.2 : 0.4, width: 0.7, height: 0.1 }
          }
    let assetReads = 0
    const fixture = evaluate('composables/useProjectPdf.js', ['useProjectPdf'], {
      pb: {
        authStore: { record: { id: 'u' }, token: 'token', onChange: () => () => {} },
        buildURL: (path) => `https://example.test${path}`
      },
      fetch: async (url) => {
        const entryId = new URL(url).pathname.split('/')[4]
        if (url.endsWith('/descriptor'))
          return Response.json({ ...descriptor, sourceRegion: region(entryId) })
        assetReads++
        return new Response('synthetic-pdf', {
          headers: {
            'X-PDF-Preview-Key': descriptor.key,
            'X-PDF-Expires-At': descriptor.expiresAt,
            'X-PDF-Start-Page': '5',
            'X-PDF-End-Page': '6',
            'X-PDF-Total-Pages': '10',
            'X-PDF-Source-Region': JSON.stringify(region(entryId))
          }
        })
      },
      createPageImageCache: () => ({
        clear() {},
        load: async () => {
          throw new Error('no image')
        }
      }),
      createPdfPreviewCache: () =>
        createPdfPreviewCache({
          urls: { createObjectURL: () => 'blob:shared-pdf', revokeObjectURL: () => {} }
        })
    })
    const page = ref({ id: 'first', pdf_page: 5 })
    try {
      const api = fixture.useProjectPdf(page)
      await api.resolveProjectPdf()
      assert.equal(api.assetRegion.value.rect.y, 0.2)
      api.switchPdfPage(1)
      await api.resolveProjectPdf(true)
      assert.equal(api.currentPdfPage.value, 6, 'same task renewal preserves the page being read')
      page.value = { ...page.value, id: 'second' }
      await api.resolveProjectPdf()
      assert.equal(api.currentPdfPage.value, 5, 'new trusted region returns to the entry page')
      assert.equal(api.assetRegion.value.rect.y, 0.4)
      api.switchPdfPage(1)
      page.value = { ...page.value, id: 'legacy' }
      await api.resolveProjectPdf()
      assert.equal(api.currentPdfPage.value, 6, 'legacy tasks keep the current page')
      assert.equal(api.assetRegion.value, null)
      assert.equal(assetReads, 1, 'authorized identical PDF bytes remain shared')
      const snapshot = JSON.stringify(page.value)
      const retry = api.retryProjectPdf()
      assert.equal(api.pdfLoading.value, true)
      assert.equal(
        api.pdfUrl.value,
        null,
        'discard the failed viewer while fresh authorization is pending'
      )
      assert.equal(api.retryProjectPdf(), undefined, 'do not overlap manual retries')
      await retry
      assert.equal(
        assetReads,
        2,
        'manual retry must fetch fresh bytes even for the same authorized asset'
      )
      assert.equal(
        api.currentPdfPage.value,
        6,
        'manual retry keeps the current physical page for the same source'
      )
      assert.equal(
        JSON.stringify(page.value),
        snapshot,
        'reloading source does not modify the entry'
      )
    } finally {
      fixture.dispose()
    }
  }
)

regression('image access denial forces a fresh PDF permission check', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  let denied = false
  let pdfReads = 0
  const revoked = []
  const fetcher = async (url) => {
    if (url.includes('/images/')) return new Response(null, { status: denied ? 403 : 404 })
    if (url.endsWith('/descriptor')) {
      return Response.json({ key: 'pdf', start: 1, end: 1, total: 1, expiresAt })
    }
    pdfReads++
    if (denied) return Response.json({ message: '原文权限已撤回' }, { status: 403 })
    return new Response('synthetic-pdf', {
      headers: {
        'X-PDF-Preview-Key': 'pdf',
        'X-PDF-Expires-At': expiresAt,
        'X-PDF-Start-Page': '1',
        'X-PDF-End-Page': '1',
        'X-PDF-Total-Pages': '1'
      }
    })
  }
  const fixture = evaluate('composables/useProjectPdf.js', ['useProjectPdf'], {
    pb: {
      authStore: { record: { id: 'u' }, token: 'token', onChange: () => () => {} },
      buildURL: (value) => `https://example.test${value}`
    },
    fetch: fetcher,
    setTimeout: () => 1,
    clearTimeout: () => {},
    createPdfPreviewCache: () =>
      createPdfPreviewCache({
        urls: {
          createObjectURL: () => 'blob:protected',
          revokeObjectURL: (url) => revoked.push(url)
        }
      }),
    createPageImageCache: () => createPageImageCache({ fetcher })
  })
  try {
    const api = fixture.useProjectPdf(ref({ id: 'page', pdf_page: 1 }))
    await api.resolveProjectPdf()
    assert.equal(api.pdfUrl.value, 'blob:protected')
    denied = true
    await api.resolveProjectPdf()
    assert.equal(pdfReads, 2)
    assert.equal(api.pdfUrl.value, null)
    assert.equal(api.pdfError.value, '原文权限已撤回')
    assert.deepEqual(revoked, ['blob:protected'])
    denied = false
    await api.retryProjectPdf()
    assert.equal(pdfReads, 3)
    assert.equal(api.pdfUrl.value, 'blob:protected')
    assert.equal(api.pdfError.value, '')
  } finally {
    fixture.dispose()
  }
})

regression(
  'arbitration progress only marks the submitted note as saved when the note changes during the request',
  async () => {
    const source = readFileSync(
      new URL('../src/views/admin/ArbitrationView.vue', import.meta.url),
      'utf8'
    )
    const body = source.slice(
      source.indexOf('async function saveProgress('),
      source.indexOf('function onFinalInput(')
    )
    const waiting = deferred()
    const context = {
      caseVersion: 1,
      pageId: ref('p'),
      projectId: ref('project'),
      submitting: ref(false),
      submitError: ref(''),
      progressMessage: ref(''),
      verificationData: ref({ context: { basis: 'basis' } }),
      finalRow: {},
      judgmentPayload: () => [],
      note: ref('submitted note'),
      resolutionSource: {},
      saveSourceJudgments: () => waiting.promise,
      judgmentDrafts: {},
      getVerification: async () => ({ context: { basis: 'basis' } }),
      touchedHeaders: new Set(),
      lastSavedNote: ref('old'),
      getPbMessage: (error) => error.message
    }
    const save = new Function('scope', `with(scope){ ${body}; return saveProgress }`)(context)
    const operation = save(false)
    context.note.value = 'new unsaved note'
    waiting.resolve({ judgments: [] })
    await operation
    assert.equal(context.lastSavedNote.value, 'submitted note')
    assert.notEqual(context.lastSavedNote.value, context.note.value)
  }
)

regression(
  'logout-all ends only its own local session, including uncertain network results',
  async () => {
    const waiting = deferred()
    const { api, store } = sessionFixture(() => waiting.promise)
    const pending = api.logoutAllDevices()
    store.save('b-token', { id: 'b' })
    waiting.resolve(null)
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(store.token, 'b-token')
    const uncertain = sessionFixture(async () => {
      throw new Error('network interrupted')
    })
    await assert.rejects(uncertain.api.logoutAllDevices(), /network interrupted/)
    assert.equal(uncertain.store.token, '')
  }
)
regression('password update cannot clear a newer tab session', async () => {
  const waiting = deferred()
  const { api, store } = sessionFixture(() => waiting.promise)
  const pending = api.changeAccountPassword('old', 'new', 'new')
  store.save('b-token', { id: 'b' })
  waiting.resolve({ id: 'a' })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(store.token, 'b-token')
})

regression('account view generation rejects return-to-same-identity and disposed responses', () => {
  let identity = 'a'
  const scope = createAccountViewScope(() => identity)
  const old = scope.capture()
  identity = 'b'
  scope.invalidate()
  assert.equal(old.signal.aborted, true)
  identity = 'a'
  scope.invalidate()
  assert.equal(scope.isCurrent(old), false)
  const current = scope.capture()
  assert.equal(scope.isCurrent(current), true)
  scope.dispose()
  assert.equal(current.signal.aborted, true)
  assert.equal(scope.isCurrent(current), false)
})

function accountComponent(path, names, overrides) {
  const stops = []
  const api = evaluate(path, names, {
    createAccountViewScope,
    ...accountSecurity,
    ...localAccountData,
    watch: (...args) => {
      const stop = vueWatch(...args)
      stops.push(stop)
      return stop
    },
    ...overrides
  })
  const dispose = api.dispose
  api.dispose = () => {
    dispose()
    stops.forEach((stop) => stop())
  }
  return api
}
const settleAccountView = () => new Promise((resolve) => setImmediate(resolve))

regression(
  'account security clears previous identity drafts and ignores late events and capabilities',
  async () => {
    const storage = memoryStorage()
    for (const id of ['a', 'b'])
      storage.setItem(
        `fangji:task-draft:v1:${id}:page-${id}`,
        JSON.stringify({ pageId: `page-${id}` })
      )
    const auth = reactive({ user: { id: 'a' }, token: 'a-token', isLoggedIn: true })
    const reads = [],
      capabilities = []
    const api = accountComponent(
      'views/AccountSecurityView.vue',
      [
        'drafts',
        'events',
        'eventsLoading',
        'emailEnabled',
        'loadEvents',
        'prepareDraftRemoval',
        'confirmDraftRemoval',
        'removalSnapshot'
      ],
      {
        useAuthStore: () => auth,
        useRouter: () => ({}),
        window: { localStorage: storage },
        listSecurityEvents: (_query, options) => {
          const waiting = deferred()
          reads.push({ ...waiting, ...options })
          return waiting.promise
        },
        accountCapabilities: (options) => {
          const waiting = deferred()
          capabilities.push({ ...waiting, ...options })
          return waiting.promise
        }
      }
    )
    try {
      assert.equal(api.drafts.value[0].pageId, 'page-a')
      api.prepareDraftRemoval()
      auth.user = { id: 'b' }
      auth.token = 'b-token'
      assert.equal(api.drafts.value[0].pageId, 'page-b')
      assert.deepEqual(api.events.value, [])
      assert.equal(api.confirmDraftRemoval.value, false)
      assert.deepEqual(api.removalSnapshot.value, [])
      assert.equal(reads[0].signal.aborted, true)
      reads.at(-1).resolve({ items: [{ id: 'b-event' }] })
      capabilities.at(-1).resolve({ emailActionsEnabled: false })
      await settleAccountView()
      for (const read of reads.slice(0, -1)) read.resolve({ items: [{ id: 'a-event' }] })
      for (const capability of capabilities.slice(0, -1))
        capability.resolve({ emailActionsEnabled: true })
      await settleAccountView()
      assert.equal(api.events.value[0].id, 'b-event')
      assert.equal(api.emailEnabled.value, false)
      const older = api.loadEvents(),
        newer = api.loadEvents()
      reads.at(-1).resolve({ items: [{ id: 'newest-event' }] })
      reads.at(-2).resolve({ items: [{ id: 'older-event' }] })
      await Promise.all([older, newer])
      assert.equal(api.events.value[0].id, 'newest-event')
      auth.isLoggedIn = false
      assert.deepEqual(api.drafts.value, [])
      assert.deepEqual(api.events.value, [])
      const disposedRead = api.loadEvents()
      api.dispose()
      reads.at(-1).resolve({ items: [{ id: 'disposed-event' }] })
      await disposedRead
      assert.deepEqual(api.events.value, [])
    } finally {
      api.dispose()
    }
  }
)

regression(
  'account email mutation rejects a replaced session before reporting success',
  async () => {
    for (const method of ['requestEmailChange', 'requestEmailVerification']) {
      const waiting = deferred()
      const { api, store, listeners } = sessionFixture(() => waiting.promise)
      const pending = api[method]('synthetic@example.test')
      store.save('b-token', { id: 'b' })
      waiting.resolve()
      await assert.rejects(pending, { name: 'AbortError' })
      assert.equal(store.token, 'b-token')
      assert.equal(listeners.size, 0)
    }
  }
)

function accountActionFixture(initialAction = 'recover') {
  const route = reactive({ params: { action: initialAction }, hash: '' })
  const location = {
    hash: initialAction === 'recover' ? '' : '#token=synthetic-initial',
    pathname: `/account/${initialAction}`,
    search: ''
  }
  const history = {
    replaceState: () => {
      location.hash = ''
    }
  }
  const capabilities = [],
    submissions = []
  let refreshes = 0
  const api = accountComponent(
    'views/AccountActionView.vue',
    [
      'token',
      'loading',
      'emailEnabled',
      'error',
      'message',
      'done',
      'busy',
      'password',
      'confirmation',
      'submit'
    ],
    {
      useRoute: () => route,
      window: { location, history },
      accountCapabilities: (options) => {
        const waiting = deferred()
        capabilities.push({ ...waiting, ...options })
        return waiting.promise
      },
      requestPasswordReset: () => Promise.resolve(),
      confirmAccountAction: (...args) => {
        const waiting = deferred()
        submissions.push({ ...waiting, args })
        return waiting.promise
      },
      refreshStoredAuth: async () => {
        refreshes++
      }
    }
  )
  const navigate = (action, token = '') => {
    location.hash = token ? `#token=${token}` : ''
    route.params.action = action
  }
  return { api, capabilities, submissions, navigate, refreshes: () => refreshes }
}
regression('late recovery capability cannot overwrite the next token action route', async () => {
  const { api, capabilities, navigate } = accountActionFixture()
  try {
    navigate('reset-password', 'synthetic-new')
    assert.equal(api.token.value, 'synthetic-new')
    assert.equal(api.loading.value, false)
    assert.equal(capabilities[0].signal.aborted, true)
    capabilities[0].resolve({ emailActionsEnabled: false })
    await settleAccountView()
    assert.equal(api.error.value, '')
    assert.equal(api.emailEnabled.value, false)
  } finally {
    api.dispose()
  }
})
regression(
  'account confirmation captures action and token and never publishes into a later route',
  async () => {
    const { api, submissions, navigate, refreshes } = accountActionFixture('reset-password')
    try {
      api.password.value = api.confirmation.value = 'SyntheticPassword123!'
      const pending = api.submit()
      assert.equal(submissions[0].args[0], 'reset-password')
      assert.equal(submissions[0].args[1], 'synthetic-initial')
      navigate('verify-email', 'synthetic-other')
      submissions[0].resolve()
      await pending
      assert.equal(api.done.value, false)
      assert.equal(api.message.value, '')
      assert.equal(api.token.value, 'synthetic-other')
      assert.equal(refreshes(), 0)
      const disposed = api.submit()
      api.dispose()
      submissions[1].reject(new Error('late failure'))
      await disposed
      assert.equal(api.error.value, '')
    } finally {
      api.dispose()
    }
  }
)

regression(
  'logout-all cannot clear a session replaced and restored with the same token',
  async () => {
    const waiting = deferred()
    const { api, store, listeners } = sessionFixture(() => waiting.promise)
    const originalToken = store.token
    const pending = api.logoutAllDevices()
    store.save('b-token', { id: 'b' })
    store.save(originalToken, { id: 'a' })
    waiting.resolve()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(store.token, originalToken)
    assert.equal(listeners.size, 0)
  }
)

regression(
  'registration redirect timer is cancelled when leaving the view and still fires when staying',
  async () => {
    const mount = () => {
      const timers = new Map()
      const pushes = []
      const unmounts = []
      let nextId = 1
      const api = evaluate(
        'views/RegisterView.vue',
        ['handleRegister', 'success', 'name', 'password', 'passwordConfirm'],
        {
          onUnmounted: (callback) => unmounts.push(callback),
          useRouter: () => ({
            push: (location) => {
              pushes.push(location)
              return Promise.resolve()
            }
          }),
          useRoute: () => ({ query: {} }),
          useAuthStore: () => ({ register: async () => {} }),
          checkNicknameAvailable: async () => ({ available: true }),
          authPageLocation: (path) => ({ path }),
          setTimeout: (callback) => {
            const id = nextId++
            timers.set(id, callback)
            return id
          },
          clearTimeout: (id) => {
            timers.delete(id)
          }
        }
      )
      api.name.value = 'synthetic-volunteer'
      api.password.value = api.passwordConfirm.value = 'SyntheticPassword123!'
      return { api, timers, pushes, unmounts }
    }
    const leaving = mount()
    await leaving.api.handleRegister()
    assert.equal(leaving.api.success.value, true)
    assert.equal(leaving.timers.size, 1)
    leaving.unmounts.forEach((callback) => callback())
    assert.equal(leaving.timers.size, 0, '卸载时必须清掉跳转定时器')
    leaving.timers.forEach((callback) => callback())
    assert.equal(leaving.pushes.length, 0, '离开注册页后不得再被拉回登录页')
    const staying = mount()
    await staying.api.handleRegister()
    staying.timers.forEach((callback) => callback())
    assert.deepEqual(staying.pushes, [{ path: '/login' }])
  }
)
