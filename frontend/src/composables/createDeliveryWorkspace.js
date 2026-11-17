import { computed, nextTick, reactive, ref, watch } from 'vue'
import { batchReportNavigationQuery, readBatchReportContext } from '../lib/batchReportContext.js'
import { USAGE_PURPOSE_LABELS } from '../constants/sourceRegistry.js'
import { getPbMessage, getPbStatus } from '../utils/pbErrors.js'

// The view supplies routing, protected identity scope and disposal; Vue owns reactive state.
export function createDeliveryWorkspace({
  route,
  router,
  services,
  useProtectedPageScope,
  onBeforeUnmount,
  observeRoute = (callback) => watch(() => route.fullPath, callback, { immediate: true })
}) {
  const {
    getAdoptionBatch,
    listAdoptionBatches,
    appendDeliveryEvent,
    checkDelivery,
    createDelivery,
    downloadDelivery,
    findDeliveryImpacts,
    listDeliveries,
    getDelivery,
    listDeliveryEvents,
    checkAdoptionDelivery,
    createAdoptionDelivery
  } = services
  const projectId = computed(() => String(route.params.id))
  const queryPage = computed(() => Math.max(1, Number.parseInt(route.query.page, 10) || 1))
  const detailTab = computed(() => (route.query.tab === 'events' ? 'events' : 'summary'))
  const batchReportContext = computed(() => readBatchReportContext(route.query, projectId.value))
  const adoptionTarget = computed(() => ({
    path: `/admin/projects/${encodeURIComponent(projectId.value)}/adoption`,
    query: {
      ...batchReportNavigationQuery(batchReportContext.value),
      ...(batchReportContext.value ? { reportSection: 'adoption' } : {})
    }
  }))
  const listPage = ref(1)
  const eventsPage = ref(1)
  const listPages = ref(1)
  const eventPages = ref(1)
  const currentDelivery = ref(null)
  const unavailable = ref(false)
  const projectUnavailable = ref(false)
  const nativeBatch = ref(null)
  const adoptionChoices = ref([])
  const adoptionPage = ref(1)
  const adoptionPages = ref(1)
  const nativeDeliveryEnabled = globalThis.__FANGJI_NATIVE_DELIVERY_ENABLED__ !== false
  const legacyMode = ref(!nativeDeliveryEnabled)
  const previous = ref('')
  const changeReason = ref('')
  const requestId = ref('')
  const eventBaseline = ref('')
  function navigate(query) {
    const target = { ...query }
    delete target.returnPage
    const savedListPage =
      route.query.listPage ||
      route.query.returnPage ||
      String(view.value === 'records' ? queryPage.value : listPage.value || 1)
    if (target.view === 'records') {
      if (view.value !== 'records' || target.page === undefined) target.page = savedListPage
      target.package = undefined
      target.tab = undefined
      target.editor = undefined
      target.listPage = undefined
    } else if (target.package || target.view === 'prepare' || target.view === 'impacts') {
      target.listPage ||= savedListPage
    }
    return router.push({
      query: { ...target, ...batchReportNavigationQuery(batchReportContext.value) }
    })
  }
  function changePage(page) {
    return navigate({ ...route.query, page })
  }
  function changeEventsPage(page) {
    return navigate({ ...route.query, page: String(page) })
  }
  let adoptionGeneration = 0
  let adoptionRequest
  async function loadAdoptions(page = 1) {
    adoptionRequest?.cancel()
    const request = pageScope.capture()
    adoptionRequest = request
    const generation = ++adoptionGeneration
    try {
      const data = await listAdoptionBatches(projectId.value, { page, signal: request.signal })
      if (!request.isCurrent() || generation !== adoptionGeneration) return
      adoptionChoices.value = data.batches
      adoptionPage.value = data.page
      adoptionPages.value = data.totalPages
    } catch (error) {
      if (!handleFailure(error, request, 'project') && request.isCurrent())
        loadError.value = getPbMessage(error, '编选批次加载失败')
    } finally {
      request.finish()
    }
  }

  function chooseAdoption(id) {
    return navigate({ view: 'prepare', adoption: id })
  }
  const view = ref('records')
  const selectedPackageId = ref('')
  const loading = ref(true)
  const busy = ref(false)
  const loadError = ref('')
  const operationError = ref('')
  const preflightProblem = ref(null)
  const success = ref('')
  const items = ref([])
  const metrics = ref(null)
  const handoff = ref(null)
  const handoffInput = ref(null)
  const handoffFilename = ref('')
  const reviewer = ref('')
  const preview = ref(null)
  const confirmed = ref(false)
  const selected = ref(null)
  const eventEditor = ref(null)
  const sourceRef = ref('')
  const impacts = ref(null)
  const visibleDeliveries = computed(() => (currentDelivery.value ? [currentDelivery.value] : []))
  const dirty = computed(
    () =>
      (view.value === 'prepare' &&
        Boolean(reviewer.value || previous.value || changeReason.value || handoff.value)) ||
      Boolean(selected.value && JSON.stringify(eventForm) !== eventBaseline.value)
  )

  let disposed = false
  let loadGeneration = 0
  let operationGeneration = 0
  onBeforeUnmount(() => {
    disposed = true
    ++loadGeneration
    ++operationGeneration
  })
  function openDelivery(item) {
    return navigate({
      package: item.id,
      tab: 'summary',
      page: 1,
      listPage: String(view.value === 'records' ? queryPage.value : listPage.value || 1)
    })
  }
  function openImpact(item) {
    return openDelivery(item)
  }

  const deliveryStageLabels = {
    A: '来源与材料准备',
    B: '校对与仲裁',
    C: '拼音整理与复核',
    D: '用途编选',
    E: '交付与回执'
  }
  const deliveryStageLabel = (target) =>
    Object.hasOwn(deliveryStageLabels, target) ? deliveryStageLabels[target] : '未明确环节'
  const returnTargets = ['A', 'D']
  const eventLabels = {
    receipt: '人工导入回执',
    return: '退回上游',
    withdrawal: '停用交付包并登记升级',
    notice: '已通知消费方停用',
    resolution: '登记处置完成'
  }
  const eventForm = reactive({
    kind: 'receipt',
    status: 'success',
    affected: 0,
    reason: '',
    reviewer: '',
    responsible: '',
    target: '',
    evidence: '',
    resolves: ''
  })
  const pageScope = useProtectedPageScope((status) => {
    clearProtectedData()
    loadError.value =
      status === 401
        ? '登录状态已失效，当前页面内容已清除。请重新登录后重试。'
        : '当前账号已无权查看此项目，页面内容已清除。'
  })
  const { accessLost } = pageScope
  let readRequest
  function clearEditor() {
    selected.value = null
    eventBaseline.value = ''
    Object.assign(eventForm, {
      kind: 'receipt',
      status: 'success',
      affected: 0,
      reason: '',
      reviewer: '',
      responsible: '',
      target: '',
      evidence: '',
      resolves: ''
    })
    reviewer.value = previous.value = changeReason.value = ''
    handoff.value = null
    handoffFilename.value = ''
    if (handoffInput.value) handoffInput.value.value = ''
    invalidatePreview()
  }
  function clearProtectedData() {
    ++loadGeneration
    ++operationGeneration
    ++adoptionGeneration
    loading.value = busy.value = false
    items.value = adoptionChoices.value = []
    currentDelivery.value = nativeBatch.value = metrics.value = impacts.value = null
    sourceRef.value = ''
    listPage.value = listPages.value = eventsPage.value = eventPages.value = 1
    adoptionPage.value = adoptionPages.value = 1
    operationError.value = success.value = ''
    clearEditor()
  }
  function projectRead(promise) {
    return promise.catch((cause) => {
      throw Object.assign(new Error('项目读取失败', { cause }), { requestSource: 'project' })
    })
  }
  function handleFailure(error, request, requestSource) {
    if (pageScope.invalidate(error, request)) return true
    if (!request.isCurrent()) return true
    if (getPbStatus(error) === 404 && requestSource === 'project') {
      pageScope.cancel()
      clearProtectedData()
      projectUnavailable.value = unavailable.value = true
      loadError.value = '项目不存在或已被删除，页面资料已清除。请返回项目列表或重试。'
      return true
    }
    if (getPbStatus(error) === 404 || error?.invalidDetail) {
      pageScope.cancel()
      ++loadGeneration
      ++operationGeneration
      ++adoptionGeneration
      loading.value = busy.value = false
      items.value = items.value.filter((item) => item.id !== selectedPackageId.value)
      currentDelivery.value = nativeBatch.value = null
      unavailable.value = true
      clearEditor()
      loadError.value = '这份交付记录或编选批次已不可用，请返回列表或重新加载。'
      return true
    }
    return false
  }
  const eventLabel = (value) => eventLabels[value] || value
  const purposeLabel = (value) => USAGE_PURPOSE_LABELS[value] || value
  const sourceFixTarget = computed(() => {
    const problem = preflightProblem.value
    if (
      typeof problem?.sourceId !== 'string' ||
      !/^[a-z0-9]{15}$/.test(problem.sourceId) ||
      !Object.hasOwn(USAGE_PURPOSE_LABELS, problem.purpose)
    )
      return null
    return {
      name: 'SourceRegistry',
      query: { sourceId: problem.sourceId, purpose: problem.purpose }
    }
  })
  const adoptionFixTarget = computed(() => {
    if (
      legacyMode.value ||
      !nativeBatch.value ||
      !(
        preflightProblem.value?.reasonCode === 'ADOPTION_SCOPE_CHANGED' ||
        preview.value?.reconciliation?.counts?.pending > 0
      )
    )
      return null
    return {
      name: 'ProjectAdoption',
      params: { id: projectId.value },
      query: { batch: nativeBatch.value.id, tab: 'exceptions', from: 'delivery' }
    }
  })
  const percent = (value) => `${(value * 100).toFixed(1)}%`
  function invalidatePreview() {
    preview.value = null
    preflightProblem.value = null
    confirmed.value = false
    requestId.value = ''
  }
  async function action(fn, onError) {
    if (accessLost.value || unavailable.value) return
    const request = pageScope.capture()
    const generation = ++operationGeneration
    const isCurrent = () => request.isCurrent() && !disposed && generation === operationGeneration
    busy.value = true
    operationError.value = ''
    success.value = ''
    try {
      await fn(isCurrent, request.signal)
    } catch (e) {
      if (!handleFailure(e, request) && isCurrent()) {
        onError?.(e)
        operationError.value = getPbMessage(e, e?.message || '处理失败，请重试')
      }
    } finally {
      if (isCurrent()) busy.value = false
      request.finish()
    }
  }
  async function load() {
    readRequest?.cancel()
    const request = pageScope.capture()
    readRequest = request
    const generation = ++loadGeneration
    const isCurrent = () => request.isCurrent() && !disposed && generation === loadGeneration
    loading.value = true
    loadError.value = ''
    operationError.value = ''
    try {
      const id = projectId.value
      const data = await projectRead(
        listDeliveries(id, {
          page:
            view.value === 'records'
              ? queryPage.value
              : Math.max(
                  1,
                  Number.parseInt(route.query.listPage ?? route.query.returnPage, 10) || 1
                ),
          signal: request.signal
        })
      )
      if (!isCurrent()) return
      let detail = null,
        events = null,
        adoption = null
      if (selectedPackageId.value) {
        ;[detail, events] = await Promise.all([
          getDelivery(selectedPackageId.value, { signal: request.signal }),
          listDeliveryEvents(selectedPackageId.value, {
            page: detailTab.value === 'events' ? queryPage.value : 1,
            signal: request.signal
          })
        ])
        if (!isCurrent()) return
        if (detail.project !== id)
          throw Object.assign(new Error('交付包不属于当前项目'), { invalidDetail: true })
      }
      if (nativeDeliveryEnabled && route.query.adoption) {
        adoption = await getAdoptionBatch(route.query.adoption, { signal: request.signal })
        if (!isCurrent()) return
        if (adoption.project !== id || adoption.status !== 'confirmed')
          throw Object.assign(new Error('请选择本项目已确认的编选批次'), { invalidDetail: true })
      }
      if (!isCurrent()) return
      if (nativeDeliveryEnabled && view.value === 'prepare') await loadAdoptions()
      if (!isCurrent() || id !== projectId.value) return
      items.value = data.items
      metrics.value = data.metrics
      listPage.value = data.page
      eventsPage.value = events?.page || 1
      listPages.value = data.totalPages
      eventPages.value = events?.totalPages || 1
      currentDelivery.value = detail ? { ...detail, events: events.events } : null
      nativeBatch.value = adoption
      accessLost.value = unavailable.value = projectUnavailable.value = false
    } catch (failure) {
      const e = failure?.requestSource ? failure.cause : failure
      if (
        !handleFailure(e, request, failure?.requestSource) &&
        !disposed &&
        generation === loadGeneration
      )
        loadError.value = getPbMessage(e, '交付记录加载失败')
    } finally {
      if (request.isCurrent() && !disposed && generation === loadGeneration) loading.value = false
      request.finish()
    }
  }
  async function readHandoff(event) {
    invalidatePreview()
    handoff.value = null
    await action(async (isCurrent) => {
      const file = event.target.files?.[0]
      if (!file) return
      event.target.value = ''
      handoffFilename.value = file.name
      if (file.size > 2 * 1024 * 1024) throw new Error('交接清单超过 2 MiB，请在编选环节拆分')
      const value = JSON.parse(await file.text())
      if (!isCurrent()) return
      if (!value || !Array.isArray(value.entries) || !value.selection_ref)
        throw new Error('交接清单缺少批次编选凭据或条目范围')
      handoff.value = value
    })
  }
  const requestBody = () =>
    legacyMode.value
      ? { ...handoff.value, reviewer: reviewer.value }
      : {
          adoption_batch_id: nativeBatch.value?.id,
          expected_scope_digest: nativeBatch.value?.scope_digest,
          reviewer: reviewer.value,
          previous: previous.value,
          change_reason: changeReason.value
        }
  async function preflight() {
    if (busy.value) return
    invalidatePreview()
    await action(
      async (isCurrent, signal) => {
        const result = await (legacyMode.value ? checkDelivery : checkAdoptionDelivery)(
          projectId.value,
          requestBody(),
          { signal }
        )
        if (isCurrent()) {
          preview.value = result
          requestId.value = crypto.randomUUID()
        }
      },
      (error) => {
        preflightProblem.value = error?.response?.data || null
      }
    )
  }
  async function generate() {
    if (!confirmed.value || !preview.value?.can_generate) return
    const body = {
      ...requestBody(),
      preview_sha256: preview.value.preview_sha256,
      ...(!legacyMode.value ? { request_id: requestId.value } : {})
    }
    await action(async (isCurrent, signal) => {
      const delivery = await (legacyMode.value ? createDelivery : createAdoptionDelivery)(
        projectId.value,
        body,
        { signal }
      )
      if (!isCurrent()) return
      invalidatePreview()
      handoff.value = null
      reviewer.value = previous.value = changeReason.value = ''
      success.value = delivery.replayed
        ? '已找回上次成功生成的同一交付包，未重复生成；尚未收到消费方回执。'
        : '交付包已生成，尚未收到消费方回执。'
      await load()
      if (!isCurrent()) return
      await openDelivery(delivery)
    })
  }
  async function download(item) {
    await action((isCurrent, signal) => downloadDelivery(item.id, { signal, isCurrent }))
  }
  function selectEvent(item) {
    if (selected.value?.id === item.id) {
      focusEventEditor()
      return
    }
    selected.value = item
    Object.assign(eventForm, {
      kind: 'receipt',
      status: 'success',
      affected: item.reconciliation.payload_count,
      reason: '',
      reviewer: '',
      responsible: '',
      target: '',
      evidence: '',
      resolves: ''
    })
    eventBaseline.value = JSON.stringify(eventForm)
    focusEventEditor()
  }
  function focusEventEditor() {
    nextTick(() => {
      eventEditor.value?.focusEditor()
    })
  }
  async function saveEvent() {
    const id = selected.value.id,
      body = { ...eventForm }
    await action(async (isCurrent, signal) => {
      await appendDeliveryEvent(id, body, { signal })
      if (!isCurrent()) return
      selected.value = null
      success.value = '已追加凭据。'
      await load()
    })
  }
  async function findImpacts() {
    await action(async (isCurrent, signal) => {
      const result = await findDeliveryImpacts(projectId.value, sourceRef.value, { signal })
      if (isCurrent()) impacts.value = result.items
    })
  }
  const stopRoute = observeRoute(() => {
    const completedMessage = success.value
    pageScope.cancel()
    clearProtectedData()
    success.value = completedMessage
    projectUnavailable.value = unavailable.value = false
    selectedPackageId.value = typeof route.query.package === 'string' ? route.query.package : ''
    view.value = selectedPackageId.value
      ? 'detail'
      : ['prepare', 'impacts'].includes(route.query.view)
        ? route.query.view
        : 'records'
    load()
  })
  onBeforeUnmount(stopRoute)
  onBeforeUnmount(watch([previous, changeReason, legacyMode], invalidatePreview))
  return {
    dirty,
    accessLost,
    unavailable,
    projectId,
    view,
    projectUnavailable,
    busy,
    navigate,
    loadError,
    loading,
    load,
    operationError,
    success,
    preview,
    batchReportContext,
    adoptionTarget,
    nativeDeliveryEnabled,
    nativeBatch,
    legacyMode,
    chooseAdoption,
    adoptionChoices,
    purposeLabel,
    adoptionPage,
    adoptionPages,
    loadAdoptions,
    sourceFixTarget,
    adoptionFixTarget,
    preflightProblem,
    preflight,
    readHandoff,
    handoffInput,
    handoffFilename,
    reviewer,
    invalidatePreview,
    handoff,
    previous,
    changeReason,
    percent,
    confirmed,
    generate,
    metrics,
    items,
    listPage,
    listPages,
    changePage,
    openDelivery,
    detailTab,
    selectedPackageId,
    visibleDeliveries,
    download,
    selectEvent,
    eventPages,
    eventsPage,
    changeEventsPage,
    eventLabel,
    deliveryStageLabel,
    selected,
    eventLabels,
    returnTargets,
    eventForm,
    saveEvent,
    findImpacts,
    sourceRef,
    pageScope,
    impacts,
    openImpact,
    action,
    currentDelivery,
    requestId,
    eventBaseline,
    clearProtectedData,
    handleFailure,
    eventEditor
  }
}
