<template>
  <main class="container page adoption-workspace">
    <WorkspaceLeaveGuard
      :dirty="dirty"
      :preserve-query="false"
      :bypass="accessLost || unavailable"
    />
    <ProjectWorkspaceNav :project-id="projectId" active="delivery" />
    <BatchReportReturn v-if="!accessLost && !projectUnavailable" :project-id="projectId" />
    <header class="page-heading adoption-heading">
      <div>
        <div class="page-eyebrow">项目交付</div>
        <h1>
          {{
            screen === 'create'
              ? '新建编选批次'
              : screen === 'detail'
                ? '核对本批交付范围'
                : '用途编选'
          }}
        </h1>
        <p>按用途与接收方整理交付范围，处理例外后明确确认。</p>
      </div>
      <div class="adoption-actions">
        <AppButton
          v-if="screen !== 'list'"
          type="button"
          :disabled="busy"
          @click="navigate({ listPage: historyPage })"
        >
          返回批次列表
        </AppButton>
        <AppButton
          v-else-if="!accessLost && !projectUnavailable"
          type="button"
          variant="primary"
          :disabled="loading || busy"
          @click="openCreate"
        >
          新建编选批次
        </AppButton>
      </div>
    </header>
    <AppDisclosure class="adoption-explanation mb-4" label="编选与校对、用途许可的关系">
      <p>
        这里的「编选」是整批交付取舍，不是仲裁台里选哪一份校对结果的「采用」；校对成果与状态保持原样。用途尚未允许的来源继续由服务端阻断。
      </p>
    </AppDisclosure>
    <AppStatusPanel v-if="loading && !loaded" state="pending" message="正在加载编选批次…" />
    <AppStatusPanel
      v-if="loadError && !loaded"
      state="error"
      :message="loadError"
      retry-label="重试"
      :busy="loading"
      @retry="load()"
    />
    <RouterLink v-if="projectUnavailable" to="/admin" class="btn btn-secondary mb-4">
      返回项目列表
    </RouterLink>
    <div v-if="visibleCreateConflict" class="alert alert-warning" role="alert">
      <p>本项目已有同用途的未确认编选。它可能包含其他批次，请打开后核对范围。</p>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="busy"
        @click="selectBatch(visibleCreateConflict.id)"
      >
        查看已有未确认编选
      </button>
    </div>
    <div v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</div>
    <p v-if="message" class="alert alert-success" role="status">{{ message }}</p>
    <AppStatusPanel
      v-if="loadError && loaded && screen !== 'list'"
      state="error"
      :message="loadError"
      retry-label="重试批次详情"
      :busy="loading"
      @retry="load()"
    />

    <template v-if="loaded">
      <AdoptionCreatePanel
        v-if="screen === 'create'"
        v-model:purpose="createForm.purpose"
        v-model:recipient="createForm.recipient"
        v-model:statuses="createForm.statuses"
        v-model:quality-selection="createForm.qualityStates"
        v-model:require-pinyin="createForm.requirePinyin"
        v-model:import-jobs-text="createForm.importJobsText"
        v-model:note="createForm.note"
        v-model:scope-preset="scopePreset"
        v-model:step="createStep"
        :purposes="purposes"
        :page-statuses="pageStatuses"
        :quality-states="qualityStates"
        :busy="busy"
        :loading="loading"
        :report-scope-requested="reportScopeRequested"
        :report-scope-pending="reportScopePending"
        :report-scope-error="reportScopeError"
        :requested-report-batch="requestedReportBatch"
        :verified-report-batch="verifiedReportBatch"
        :custom-report-scope="customReportScope"
        :report-scope-ready="reportScopeReady"
        :has-selected-report-scope="hasSelectedReportScope"
        :project-id="projectId"
        @verify-scope="verifyReportScope"
        @custom-scope="openCustomReportScope"
        @next="nextCreateStep"
        @create="create"
        @scope-change="applyScopePreset"
        @access-error="pageScope.invalidate($event)"
      />

      <nav v-if="screen === 'detail' && current" class="adoption-tabs" aria-label="编选批次步骤">
        <button
          type="button"
          :class="detailTab === 'overview' ? 'is-active' : ''"
          :aria-current="detailTab === 'overview' ? 'page' : undefined"
          @click="changeTab('overview')"
        >
          范围与确认
        </button>
        <button
          type="button"
          :class="detailTab === 'exceptions' ? 'is-active' : ''"
          :aria-current="detailTab === 'exceptions' ? 'page' : undefined"
          @click="changeTab('exceptions')"
        >
          处理例外 <span v-if="exceptions.pendingTotal">{{ exceptions.pendingTotal }}</span>
        </button>
        <button
          type="button"
          :class="detailTab === 'history' ? 'is-active' : ''"
          :aria-current="detailTab === 'history' ? 'page' : undefined"
          @click="changeTab('history')"
        >
          判断与历史
        </button>
      </nav>
      <AdoptionBatchDetails
        v-if="screen === 'detail' && current"
        :current="current"
        :detail-tab="detailTab"
        :next-step-hint="nextStepHint"
        :counts="counts"
        :consistent="consistent"
        :batch-events="batchEvents"
        :native-delivery-enabled="nativeDeliveryEnabled"
        :project-id="projectId"
        :report-query="reportQuery"
        :busy="busy"
        :loading="loading"
        @export="exportManifest"
        @tab="changeTab"
        @confirm="openConfirmation"
        @preview="preview"
        @reevaluate="reevaluate"
        @remove="openRemoval"
        @page="changePage"
      />

      <section
        v-if="screen === 'detail' && current && detailTab === 'exceptions'"
        class="card mb-4"
      >
        <h2>处理例外</h2>
        <div v-if="canReplaceBatch" class="alert alert-warning mb-3" role="status">
          <p>
            这份批次已经确认。新草稿会沿用接收方、用途、筛选条件和已记录的例外，按当前数据重新预览。
            新批次确认后，从「准备交付包」重新检查。
          </p>
          <AppButton class="mt-2" :disabled="busy || loading" @click="startReplacement"
            >沿用范围创建并预览</AppButton
          >
          <p v-if="replacementConflict" class="mt-2">
            这个用途已有未完成的编选批次。
            <RouterLink :to="{ query: { batch: replacementConflict.id, tab: 'overview' } }"
              >打开现有批次并核对范围</RouterLink
            >
          </p>
        </div>
        <AppPagination
          :page="exceptions.page || 1"
          :total-pages="exceptions.totalPages || 1"
          :busy="loading || busy"
          label="待处理例外分页"
          @change="changePage"
        />
        <p v-if="exceptions.pendingTotal">
          {{ exceptions.pendingTotal }} 条待处理。当前页 {{ exceptions.pending.length }} 条。
          <template v-if="current.status !== 'confirmed'">
            请填写结论和依据。保存后重新预览并确认范围。
          </template>
        </p>
        <div v-else class="adoption-exceptions-done">
          <p class="empty-state-text">没有待处理的例外。</p>
          <p class="text-muted">返回范围与确认，核对本批数量后继续。</p>
          <AppButton variant="primary" :disabled="busy || loading" @click="changeTab('overview')">
            返回核对数量
          </AppButton>
        </div>
        <AppField v-if="exceptions.pending.length"
          ><template #label>选择待处理条目</template
          ><select
            :value="activeExceptionId"
            class="form-control"
            @change="navigate({ ...route.query, exception: $event.target.value })"
          >
            <option v-for="item in exceptions.pending" :key="item.page" :value="item.page">
              第 {{ item.pageNumber }} 条 · {{ reasonLabel(item.reason) }}
            </option>
          </select></AppField
        >
        <AdoptionExceptionEditor
          v-for="item in visibleExceptions"
          :key="item.page"
          :item="item"
          :readonly="current.status === 'confirmed'"
          :reason-codes="reasonCodes"
          :busy="busy"
          :loading="loading"
          v-model:decision="draftFor(item.page).decision"
          v-model:reason="draftFor(item.page).reason"
          v-model:note="draftFor(item.page).note"
          @save="decide"
        />

        <details v-if="exceptions.exceptions.length" class="mt-3" :open="Boolean(exceptionQuery)">
          <summary>
            已处理的例外（{{ exceptions.decidedTotal || exceptions.exceptions.length }}）
          </summary>
          <AppPagination
            :page="exceptions.decidedPage || 1"
            :total-pages="exceptions.decidedPages || 1"
            :busy="loading || busy"
            label="已处理例外分页"
            @change="navigate({ ...route.query, decidedPage: $event })"
          />
          <ul class="adoption-reasons">
            <li v-for="item in exceptions.exceptions" :key="item.page">
              {{ DECISION_LABELS[item.decision] || item.decision }}
              <span v-if="item.reason"> · {{ reasonLabel(item.reason) }}</span>
              · {{ item.note }} · {{ item.decidedAt }}
            </li>
          </ul>
        </details>
      </section>

      <AdoptionHistoryPanel
        v-if="screen === 'list'"
        :loading="loading"
        :busy="busy"
        :load-error="loadError"
        :batches="batches"
        :current-id="currentId"
        :history-page="historyPage"
        :history-total-pages="historyTotalPages"
        :history-total-items="historyTotalItems"
        @retry="load()"
        @select="selectBatch"
        @page="changePage"
      />
      <AdoptionSummaryPanel
        v-if="screen === 'list' && summary?.batches?.total"
        :summary="summary"
      />
    </template>
    <ConfirmDialog
      :open="confirmOpen && Boolean(current)"
      title-id="adoption-confirm-title"
      :busy="busy"
      :close-on-backdrop="!busy"
      :close-on-esc="!busy"
      @close="confirmOpen = false"
    >
      <h2 id="adoption-confirm-title">确认本批采用范围</h2>
      <p v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</p>
      <p>交给 {{ current?.recipient }} · {{ purposeLabel(current?.purpose) }}。</p>
      <p>
        进入 {{ counts.selected }} 条，已定不进入 {{ counts.excluded }} 条，待处理
        {{ counts.pending }} 条。确认后保留这一次的规则、数量与凭据。
      </p>
      <p v-if="counts.pending" class="alert alert-warning" role="alert">
        仍有待处理条目；清单会明确标为未完整处理，且不会放宽来源用途许可。
      </p>
      <template #actions
        ><button
          type="button"
          class="btn btn-secondary"
          :disabled="busy"
          @click="confirmOpen = false"
        >
          继续核对</button
        ><button
          type="button"
          class="btn btn-primary"
          :disabled="busy || !consistent"
          @click="confirm"
        >
          {{ busy ? '正在确认…' : '确认并保留本批范围' }}
        </button></template
      >
    </ConfirmDialog>
    <ConfirmDialog
      :open="removeOpen && Boolean(current)"
      title-id="adoption-remove-title"
      :busy="busy"
      :close-on-backdrop="!busy"
      :close-on-esc="!busy"
      @close="removeOpen = false"
    >
      <h2 id="adoption-remove-title">删除这份编选草稿？</h2>
      <p v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</p>
      <p>
        将删除交给 {{ current?.recipient }} 的本批草稿及其例外记录；项目条目和校对结果保持原样。
      </p>
      <template #actions
        ><button
          type="button"
          class="btn btn-secondary"
          :disabled="busy"
          @click="removeOpen = false"
        >
          保留草稿</button
        ><button type="button" class="btn btn-danger" :disabled="busy" @click="remove">
          {{ busy ? '正在删除…' : '删除本批草稿' }}
        </button></template
      >
    </ConfirmDialog>
  </main>
</template>

<script setup>
import AdoptionHistoryPanel from '@/components/admin/adoption/AdoptionHistoryPanel.vue'
import AdoptionSummaryPanel from '@/components/admin/adoption/AdoptionSummaryPanel.vue'
import AdoptionBatchDetails from '@/components/admin/adoption/AdoptionBatchDetails.vue'
import AdoptionCreatePanel from '@/components/admin/adoption/AdoptionCreatePanel.vue'
import AdoptionExceptionEditor from '@/components/admin/adoption/AdoptionExceptionEditor.vue'
const nativeDeliveryEnabled = globalThis.__FANGJI_NATIVE_DELIVERY_ENABLED__ !== false
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ProjectWorkspaceNav from '@/components/admin/project/ProjectWorkspaceNav.vue'
import BatchReportReturn from '@/components/admin/project/BatchReportReturn.vue'
import { batchReportNavigationQuery, readBatchReportContext } from '@/lib/batchReportContext'
import { getBatchReport } from '@/services/batchReportService'
import WorkspaceLeaveGuard from '@/components/admin/project/WorkspaceLeaveGuard.vue'
import AppButton from '@/components/AppButton.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import AppPagination from '@/components/AppPagination.vue'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import AppField from '@/components/AppField.vue'
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  DECISION_LABELS,
  DEFAULT_STATUSES,
  PAGE_STATUS_LABELS,
  QUALITY_STATE_LABELS,
  countsConsistent,
  includeLabel,
  manifestFilename,
  normalizeCounts,
  purposeLabel,
  reasonLabel,
  ruleFromForm
} from '@/lib/adoption'
import {
  confirmAdoptionBatch,
  continueAdoptionBatch,
  createAdoptionBatch,
  deleteAdoptionBatch,
  exportAdoptionManifest,
  decideAdoptionException,
  getAdoptionSummary,
  getAdoptionBatch,
  getAdoptionExceptionByPage,
  listAdoptionBatches,
  listAdoptionEvents,
  listAdoptionExceptions,
  previewAdoptionBatch,
  reevaluateAdoptionBatch
} from '@/services/adoptionService'
import { downloadText } from '@/lib/downloadText'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => String(route.params.id))
const reportContext = computed(() => readBatchReportContext(route.query, projectId.value))
const reportQuery = computed(() => batchReportNavigationQuery(reportContext.value))

function positivePage(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 1
  if (!/^[1-9]\d*$/.test(String(value))) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) ? page : 1
}
const queryPage = computed(() => positivePage(route.query.page))
const routeListPage = computed(() =>
  positivePage(
    route.query.listPage ??
      route.query.returnPage ??
      (!route.query.batch && route.query.view !== 'create' ? route.query.page : undefined)
  )
)
function exceptionFromQuery(query) {
  // Canonical links win when both keys exist; entry remains a read-only alias.
  return typeof query.exception === 'string'
    ? query.exception
    : typeof query.entry === 'string'
      ? query.entry
      : ''
}
const exceptionQuery = computed(() => exceptionFromQuery(route.query))
function navigate(query) {
  const canonical = { ...query }
  delete canonical.returnPage
  for (const key of [
    'reportProject',
    'reportBatch',
    'reportExport',
    'reportHistoryPage',
    'reportSection'
  ])
    delete canonical[key]
  const listPage = positivePage(
    canonical.listPage ??
      route.query.listPage ??
      route.query.returnPage ??
      (screen.value === 'list' ? historyPage.value : routeListPage.value)
  )
  if (listPage > 1) canonical.listPage = String(listPage)
  else delete canonical.listPage
  const selected = exceptionFromQuery(query)
  delete canonical.entry
  if (selected) canonical.exception = selected
  else delete canonical.exception
  return router.push({ query: { ...canonical, ...reportQuery.value } })
}
function changeTab(tab) {
  return navigate({
    batch: currentId.value,
    tab,
    page: 1,
    from: route.query.from === 'delivery' ? 'delivery' : undefined
  })
}
function changePage(page) {
  return screen.value === 'list' ? navigate({ listPage: page }) : navigate({ ...route.query, page })
}
const screen = ref('list')
const createStep = ref(1)
const scopePreset = ref('ready')
const detailTab = ref('overview')
const activeExceptionId = ref('')
const confirmOpen = ref(false)
const removeOpen = ref(false)
function openConfirmation() {
  operationError.value = ''
  confirmOpen.value = true
}
function openRemoval() {
  operationError.value = ''
  removeOpen.value = true
}
const pageStatuses = Object.keys(PAGE_STATUS_LABELS)
const qualityStates = Object.keys(QUALITY_STATE_LABELS)

const loading = ref(false)
const loadError = ref('')
const loaded = ref(false)
const unavailable = ref(false)
const projectUnavailable = ref(false)
const busy = ref(false)
const operationError = ref('')
const createConflict = ref(null)
const message = ref('')

const batches = ref([])
const historyPage = ref(1)
const requestedHistoryPage = ref(1)
const historyTotalPages = ref(1)
const historyTotalItems = ref(0)
const purposes = ref([])
const reasonCodes = ref([])
const currentId = ref('')
const currentRecord = ref(null)
const exceptions = ref({ exceptions: [], pending: [], pendingTotal: 0 })
const batchEvents = ref({ events: [], stale: false })
const summary = ref(null)
const decisionDrafts = reactive({})

const createForm = reactive({
  purpose: 'public_display',
  recipient: '',
  note: '',
  statuses: [...DEFAULT_STATUSES],
  qualityStates: [],
  requirePinyin: false,
  importJobsText: ''
})

const visibleCreateConflict = computed(() =>
  screen.value === 'create' && createConflict.value?.purpose === createForm.purpose
    ? createConflict.value
    : null
)

const reportScopeRequested = computed(
  () => route.query.view === 'create' && route.query.importJob !== undefined
)
const requestedReportBatch = computed(() => {
  const batchId = reportContext.value?.batchId
  return reportScopeRequested.value && batchId && route.query.importJob === batchId ? batchId : ''
})
const reportScopePending = ref(false)
const reportScopeError = ref('')
const verifiedReportBatch = ref(null)
const customReportScope = ref(false)
const savedCreateTransition = ref(false)
let reportScopeRequest
let reportScopeKey = ''
const reportScopeReady = computed(
  () => !reportScopeRequested.value || verifiedReportBatch.value?.id === requestedReportBatch.value
)
const hasSelectedReportScope = computed(
  () =>
    !reportScopeRequested.value ||
    !customReportScope.value ||
    createForm.importJobsText.split(/[,，\s]+/).some(Boolean)
)

function openCustomReportScope() {
  if (!verifiedReportBatch.value) return
  createForm.importJobsText = verifiedReportBatch.value.id
  customReportScope.value = true
}

function syncReportScope() {
  const key = reportScopeRequested.value ? `${projectId.value}:${requestedReportBatch.value}` : ''
  if (key === reportScopeKey) return
  reportScopeKey = key
  createForm.importJobsText = ''
  customReportScope.value = false
  if (key) createStep.value = 1
  void verifyReportScope()
}

async function verifyReportScope() {
  reportScopeRequest?.cancel()
  verifiedReportBatch.value = null
  reportScopePending.value = false
  reportScopeError.value = ''
  if (!reportScopeRequested.value || accessLost.value) return
  const batchId = requestedReportBatch.value
  if (!batchId) {
    reportScopeError.value = '未能确认本链接指向的导入批次。请返回批次报告重新打开编选。'
    return
  }
  const request = pageScope.capture()
  reportScopeRequest = request
  const id = projectId.value
  reportScopePending.value = true
  try {
    const report = await getBatchReport(id, batchId, request.signal)
    if (!request.isCurrent() || requestedReportBatch.value !== batchId || projectId.value !== id)
      return
    if (
      report?.schema !== 'WanyuBatchReport/v1' ||
      report.project_id !== id ||
      report.batch?.id !== batchId
    )
      throw new Error('读取到的批次与本报告不一致。')
    if (!['completed', 'completed_with_errors'].includes(report.batch.status)) {
      reportScopeError.value = '本批次尚未完成导入。请完成导入后再核对。'
      return
    }
    const entries = report.metrics?.import?.retained?.value
    if (!Number.isSafeInteger(entries) || entries < 0) {
      reportScopeError.value = '暂时无法核对本批次的入册数量。'
      return
    }
    if (entries === 0) {
      reportScopeError.value = '本批次暂无已入册条目，无法从这里创建编选。'
      return
    }
    const filename = typeof report.batch.filename === 'string' ? report.batch.filename.trim() : ''
    verifiedReportBatch.value = {
      id: batchId,
      filename: filename || '未记录文件名的导入批次',
      entries
    }
  } catch (cause) {
    if (!request.isCurrent() || pageScope.invalidate(cause, request)) return
    reportScopeError.value =
      getPbStatus(cause) === 404
        ? '本批次已不可用，请返回批次台账重新选择。'
        : '暂时无法核对本批次。请重试或返回批次报告。'
  } finally {
    if (request.isCurrent()) reportScopePending.value = false
    request.finish()
  }
}

const visibleExceptions = computed(() => {
  const active =
    exceptions.value.pending.find((item) => item.page === activeExceptionId.value) ||
    exceptions.value.pending[0]
  return active ? [active] : []
})

function openCreate() {
  navigate({ view: 'create' })
  createStep.value = 1
}
function nextCreateStep() {
  if (reportScopeReady.value) createStep.value = 2
}
function applyScopePreset() {
  if (scopePreset.value === 'ready') createForm.statuses = [...DEFAULT_STATUSES]
}

const current = computed(() =>
  currentRecord.value?.id === currentId.value ? currentRecord.value : null
)
const canReplaceBatch = computed(
  () =>
    current.value?.status === 'confirmed' &&
    (route.query.from === 'delivery' || exceptions.value.pendingTotal > 0)
)
const replacementConflict = computed(() =>
  createConflict.value?.purpose === current.value?.purpose ? createConflict.value : null
)
const dirty = computed(
  () =>
    (screen.value === 'create' &&
      !savedCreateTransition.value &&
      Boolean(
        createForm.recipient ||
        createForm.note ||
        createForm.importJobsText ||
        customReportScope.value
      )) ||
    Object.values(decisionDrafts).some(
      (draft) => draft.note || draft.reason || draft.decision !== 'select'
    )
)
const counts = computed(() => normalizeCounts(current.value?.counts))
const consistent = computed(() => countsConsistent(current.value?.counts))
const nextStepHint = computed(() => {
  if (!consistent.value) return '数量对账尚未通过，请重新预览并核对数量。'
  if (current.value?.status === 'confirmed') {
    if (batchEvents.value.stale)
      return '先核对来源用途变更，再准备交付；当前显示的仍是确认时的范围。'
    return nativeDeliveryEnabled
      ? '准备交付包，继续核查本批范围与接收方要求。'
      : '导出本批清单，交由交付环节检查。'
  }
  if (current.value?.status === 'previewed')
    return counts.value.pending > 0
      ? '先处理待定条目，再核对数量并确认范围。'
      : '核对下方数量，再确认本批采用范围。'
  return '预览当前条目数量，再处理待定项并确认范围。'
})
const EMPTY_EXCEPTIONS = { exceptions: [], pending: [], pendingTotal: 0 }
const EMPTY_EVENTS = { events: [], stale: false }
let projectGeneration = 0
let loadGeneration = 0
let readRequest
let activeOperationRequest
const pageScope = useProtectedPageScope((status) => {
  clearProtectedData()
  loadError.value =
    status === 401
      ? '登录状态已失效，当前页面内容已清除。请重新登录后重试。'
      : '当前账号已无权查看此项目，页面内容已清除。'
})
const { accessLost } = pageScope
function clearDetails() {
  currentRecord.value = null
  exceptions.value = { ...EMPTY_EXCEPTIONS }
  batchEvents.value = { ...EMPTY_EVENTS }
  activeExceptionId.value = ''
  confirmOpen.value = removeOpen.value = false
  for (const key of Object.keys(decisionDrafts)) delete decisionDrafts[key]
}
function clearProtectedData() {
  ++projectGeneration
  ++loadGeneration
  loaded.value = loading.value = busy.value = false
  batches.value = []
  purposes.value = reasonCodes.value = []
  summary.value = null
  operationError.value = message.value = ''
  createConflict.value = null
  historyPage.value = requestedHistoryPage.value = historyTotalPages.value = 1
  historyTotalItems.value = 0
  clearDetails()
  Object.assign(createForm, {
    purpose: 'public_display',
    recipient: '',
    note: '',
    statuses: [...DEFAULT_STATUSES],
    qualityStates: [],
    requirePinyin: false,
    importJobsText: ''
  })
  createStep.value = 1
  scopePreset.value = 'ready'
  reportScopeKey = ''
  reportScopePending.value = false
  reportScopeError.value = ''
  verifiedReportBatch.value = null
  customReportScope.value = false
}
// Preserve the endpoint's authority: a missing project revokes the entire
// workspace; a missing batch/exception revokes only the selected detail.
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
  if ((getPbStatus(error) === 404 || error?.invalidDetail) && currentId.value) {
    pageScope.cancel()
    ++projectGeneration
    ++loadGeneration
    loading.value = busy.value = false
    batches.value = batches.value.filter((item) => item.id !== currentId.value)
    clearDetails()
    unavailable.value = true
    loadError.value = '这份编选批次或所选例外已不可用，请返回批次列表或重试。'
    return true
  }
  return false
}

watch(projectId, resetProject, { immediate: true })
watch(
  () => route.query,
  async () => {
    for (const key of Object.keys(decisionDrafts)) delete decisionDrafts[key]
    unavailable.value = false
    createConflict.value = null
    const previousId = currentId.value
    const previousScreen = screen.value
    syncQuery()
    syncReportScope()
    if (previousId !== currentId.value || (!currentId.value && previousScreen !== screen.value)) {
      activeOperationRequest?.cancel()
      busy.value = false
    }
    await load(routeListPage.value)
  }
)
function syncQuery() {
  currentId.value = typeof route.query.batch === 'string' ? route.query.batch : ''
  screen.value = currentId.value ? 'detail' : route.query.view === 'create' ? 'create' : 'list'
  detailTab.value = ['overview', 'exceptions', 'history'].includes(route.query.tab)
    ? route.query.tab
    : 'overview'
  activeExceptionId.value = exceptionQuery.value
}
onBeforeUnmount(() => {
  ++projectGeneration
})

function resetProject() {
  pageScope.cancel()
  clearProtectedData()
  projectUnavailable.value = unavailable.value = false
  syncQuery()
  syncReportScope()
  return load(routeListPage.value)
}

async function load(page = requestedHistoryPage.value) {
  requestedHistoryPage.value = page
  readRequest?.cancel()
  const request = pageScope.capture()
  readRequest = request
  const generation = ++loadGeneration
  const isCurrent = () => request.isCurrent() && generation === loadGeneration
  const id = projectId.value
  const nextId = currentId.value
  loading.value = true
  loadError.value = ''
  try {
    const data = await projectRead(
      listAdoptionBatches(id, { page, perPage: 25, signal: request.signal })
    )
    const [details, nextSummary] = await Promise.all([
      loadBatchDetails(nextId, request.signal),
      projectRead(getAdoptionSummary(id, { signal: request.signal }))
    ])
    if (!isCurrent()) return
    // Only the exact detail endpoint is authoritative. Network errors retain
    // the last successful same-object content; 401/403 and 404 revoke it.
    batches.value = data.batches || []
    currentId.value = nextId
    historyPage.value = requestedHistoryPage.value = data.page
    historyTotalPages.value = data.totalPages
    historyTotalItems.value = data.totalItems
    purposes.value = data.purposes || []
    reasonCodes.value = data.reasons || []
    summary.value = nextSummary
    applyBatchDetails(details)
    loaded.value = true
    accessLost.value = unavailable.value = projectUnavailable.value = false
  } catch (failure) {
    const error = failure?.requestSource ? failure.cause : failure
    if (handleFailure(error, request, failure?.requestSource) || !isCurrent()) return
    loadError.value = getPbMessage(error, '加载编选批次失败')
  } finally {
    if (isCurrent()) loading.value = false
    request.finish()
  }
}

async function loadBatchDetails(batchId, signal) {
  if (!batchId)
    return { record: null, exceptions: { ...EMPTY_EXCEPTIONS }, events: { ...EMPTY_EVENTS } }
  const [record, exceptionsData, eventsData, exact] = await Promise.all([
    getAdoptionBatch(batchId, { signal }),
    listAdoptionExceptions(batchId, {
      signal,
      page: detailTab.value === 'exceptions' ? queryPage.value : 1,
      decidedPage: Number(route.query.decidedPage) || 1
    }),
    listAdoptionEvents(batchId, {
      signal,
      page: detailTab.value === 'history' ? queryPage.value : 1
    }),
    exceptionQuery.value
      ? getAdoptionExceptionByPage(batchId, exceptionQuery.value, { signal })
      : null
  ])
  if (record.project !== projectId.value)
    throw Object.assign(new Error('编选批次不属于当前项目'), { invalidDetail: true })
  if (
    exact?.entry?.pending &&
    !exceptionsData.pending.some((item) => item.page === exact.entry.page)
  )
    exceptionsData.pending.push(exact.entry)
  if (
    exact?.exception &&
    !exceptionsData.exceptions.some((item) => item.page === exact.exception.page)
  ) {
    exceptionsData.exceptions.push(exact.exception)
  }
  return { record, exceptions: exceptionsData, events: eventsData }
}

function applyBatchDetails(details) {
  if (Object.hasOwn(details, 'record')) currentRecord.value = details.record
  exceptions.value = details.exceptions || { ...EMPTY_EXCEPTIONS }
  batchEvents.value = details.events || { ...EMPTY_EVENTS }
  for (const item of exceptions.value.pending) draftFor(item.page)
  if (!exceptions.value.pending.some((item) => item.page === activeExceptionId.value))
    activeExceptionId.value = exceptions.value.pending[0]?.page || ''
}

function draftFor(pageId) {
  const key = `${currentId.value}:${pageId}`
  if (!decisionDrafts[key]) {
    decisionDrafts[key] = { decision: 'select', reason: '', note: '' }
  }
  return decisionDrafts[key]
}

async function act(fn, success, onError) {
  if (accessLost.value) return
  activeOperationRequest?.cancel()
  const request = pageScope.capture()
  activeOperationRequest = request
  const id = projectId.value
  const generation = projectGeneration
  const isCurrent = () => request.isCurrent() && generation === projectGeneration
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    await fn(id, isCurrent, request.signal)
    if (!isCurrent()) return
    if (success) message.value = success
    await load()
  } catch (e) {
    if (handleFailure(e, request) || !isCurrent() || onError?.(e)) return
    operationError.value = getPbMessage(e, '操作失败，请重试')
  } finally {
    if (isCurrent()) busy.value = false
    request.finish()
  }
}

function handleCreateConflict(error, purpose) {
  const batch = error?.response?.batch
  if (
    getPbStatus(error) !== 409 ||
    batch?.project !== projectId.value ||
    batch.purpose !== purpose ||
    !['draft', 'previewed'].includes(batch.status) ||
    typeof batch.id !== 'string' ||
    !/^[a-z0-9]{15}$/.test(batch.id)
  )
    return false
  createConflict.value = { id: batch.id, purpose }
  return true
}

async function startReplacement() {
  if (!canReplaceBatch.value || busy.value || loading.value) return
  const { id: previousId, purpose } = current.value
  createConflict.value = null
  await act(
    async (_id, isCurrent, signal) => {
      const draft = await continueAdoptionBatch(previousId, { signal })
      if (!isCurrent()) return
      let tab = 'exceptions'
      try {
        await previewAdoptionBatch(draft.id, { signal })
        if (!isCurrent()) return
        message.value = '已沿用原范围创建草稿并预览，请处理例外。'
      } catch (error) {
        if (!isCurrent() || [401, 403, 404].includes(getPbStatus(error))) throw error
        tab = 'overview'
        message.value = '草稿已创建，预览暂未完成。请在新批次重新预览数量。'
      }
      await navigate({ batch: draft.id, tab, page: 1 })
    },
    '',
    (error) => handleCreateConflict(error, purpose)
  )
}

async function create() {
  if (busy.value || !reportScopeReady.value) return
  createConflict.value = null
  const submittedPurpose = createForm.purpose
  const submittedNote = createForm.note
  const built = ruleFromForm({
    ...createForm,
    importJobsText:
      reportScopeRequested.value && !customReportScope.value
        ? verifiedReportBatch.value.id
        : createForm.importJobsText
  })
  if (built.error) {
    operationError.value = built.error
    return
  }
  if (reportScopeRequested.value && !built.rule.importJobs.length) {
    operationError.value = '请至少选择一个导入批次。'
    return
  }
  await act(
    async (id, isCurrent, signal) => {
      const batch = await createAdoptionBatch(
        id,
        {
          purpose: submittedPurpose,
          recipient: createForm.recipient.trim(),
          note: createForm.note.trim(),
          rule: built.rule
        },
        { signal }
      )
      if (!isCurrent()) return
      // Retain a successfully created draft before previewing: a failed preview
      // must retry this batch instead of silently creating another one.
      batches.value = [batch, ...batches.value.filter((item) => item.id !== batch.id)]
      currentId.value = batch.id
      currentRecord.value = batch
      if (createForm.note === submittedNote) createForm.note = ''
      savedCreateTransition.value = true
      try {
        await nextTick()
        if (!isCurrent()) return
        await navigate({ batch: batch.id, tab: 'overview', page: 1 })
      } finally {
        savedCreateTransition.value = false
      }
      if (!isCurrent()) return
      screen.value = 'detail'
      detailTab.value = 'overview'
      applyBatchDetails({ exceptions: { ...EMPTY_EXCEPTIONS }, events: { ...EMPTY_EVENTS } })
      await previewAdoptionBatch(batch.id, { signal })
      if (!isCurrent()) return
      // 接收方保留：同一批交付常常要按不同用途连续开几条；说明是一次性的。
      if (createForm.note === submittedNote) createForm.note = ''
      screen.value = 'detail'
      detailTab.value = 'overview'
    },
    '批次已创建并完成预览；核对数量后再确认。',
    (error) => handleCreateConflict(error, submittedPurpose)
  )
}

async function preview() {
  await act(
    (_id, _current, signal) => previewAdoptionBatch(current.value.id, { signal }),
    '已按当前数据重新计算。'
  )
}

async function confirm() {
  if (!current.value || !consistent.value || current.value.status !== 'previewed') return
  await act(
    (_id, _current, signal) => confirmAdoptionBatch(current.value.id, { signal }),
    '已确认本批采用范围；导出与下游都以这份清单为准。'
  )
  if (!operationError.value) confirmOpen.value = false
}

// 重评只追加一条事件，不改写确认时的数字：D5.3 的红线是「追加，不改历史」。
// 界面上必须把这件事说出来，否则「重新评估」会被读成「把这一批改了」。
async function reevaluate() {
  await act(async (_id, isCurrent, signal) => {
    const result = await reevaluateAdoptionBatch(current.value.id, { signal })
    if (!isCurrent()) return
    message.value = result.drift
      ? `已追加重评记录：${result.stored.selected}/${result.stored.total} → ${result.current.selected}/${result.current.total}，差异在「${result.drift}」。已确认的数字没有改。`
      : `已追加重评记录：与确认时一致（${result.current.selected}/${result.current.total}）。`
  }, '')
}

async function remove() {
  const batchId = current.value.id
  await act(async (_id, isCurrent, signal) => {
    await deleteAdoptionBatch(batchId, { signal })
    if (isCurrent()) {
      currentId.value = ''
      await navigate({ listPage: historyPage.value })
    }
  }, '草稿已删除。')
  if (!operationError.value) removeOpen.value = false
}

async function exportManifest(include) {
  if (accessLost.value || !current.value) return
  activeOperationRequest?.cancel()
  const request = pageScope.capture()
  activeOperationRequest = request
  const generation = projectGeneration
  const batch = current.value
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    const manifest = await exportAdoptionManifest(batch.id, include, { signal: request.signal })
    if (!request.isCurrent() || generation !== projectGeneration) return
    downloadText(JSON.stringify(manifest, null, 2), manifestFilename(batch), 'application/json')
    message.value =
      include === 'select'
        ? includeLabel('select')
        : `${includeLabel('all')}；未采用与待处理的数量写在清单里。`
  } catch (e) {
    if (handleFailure(e, request) || !request.isCurrent() || generation !== projectGeneration)
      return
    operationError.value = getPbMessage(e, '导出失败')
  } finally {
    if (request.isCurrent() && generation === projectGeneration) busy.value = false
    request.finish()
  }
}

async function decide(pageId) {
  if (current.value?.status === 'confirmed') return
  const batchId = currentId.value
  const draftKey = `${batchId}:${pageId}`
  const draft = draftFor(pageId)
  const note = draft.note.trim()
  if (!note) {
    operationError.value = '处理例外必须写明依据。'
    return
  }
  if (draft.decision === 'exclude' && !draft.reason) {
    operationError.value = '判为不进入本批时必须选一个理由。'
    return
  }
  await act(async (_id, isCurrent, signal) => {
    await decideAdoptionException(
      batchId,
      {
        page: pageId,
        decision: draft.decision,
        reason: draft.decision === 'exclude' ? draft.reason : '',
        note
      },
      { signal }
    )
    if (isCurrent()) delete decisionDrafts[draftKey]
  }, '例外已记录；批次退回草稿，请重新预览再确认。')
}

function selectBatch(id) {
  return navigate({ batch: id, tab: 'overview', page: 1 })
}
</script>

<style src="../../styles/adoption-workspace.css"></style>
