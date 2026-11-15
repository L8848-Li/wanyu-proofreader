<template>
  <main class="container page workspace-page batch-report">
    <ProjectWorkspaceNav v-if="report" :project-id="projectId" active="materials" />
    <header class="page-heading report-heading">
      <div>
        <RouterLink :to="returnTarget" class="report-back">← 返回批次台账</RouterLink>
        <h1>质量与交付报告</h1>
        <p v-if="report">
          <template v-if="report.project_name">{{ report.project_name }} · </template>
          {{ report.batch.filename || '导入批次' }} · <code>{{ batchId }}</code>
        </p>
      </div>
      <div v-if="report" class="report-heading-actions">
        <a href="#report-exports" class="btn btn-primary">
          {{ selected?.status === 'completed' ? '查看报告文件' : '生成与下载' }}
        </a>
        <AppButton variant="secondary" :loading="loading" @click="load">刷新当前数据</AppButton>
      </div>
    </header>

    <p v-if="loading && !report" role="status">正在读取批次报告…</p>
    <div v-if="error" class="alert alert-error" role="alert">
      <p>{{ error }}</p>
      <AppButton v-if="!accessLost" variant="secondary" size="sm" @click="load">
        重新读取报告
      </AppButton>
    </div>

    <template v-if="report">
      <section class="report-overview" aria-labelledby="batch-overview-heading">
        <div class="report-timestamp text-sm">
          <h2 id="batch-overview-heading">当前批次</h2>
          <span role="status">统计于 {{ reportDate(report.generated_at) }}</span>
          <span>{{ modeLabel }} · {{ batchImportStatus(report.batch.status) }}</span>
        </div>
        <dl class="report-overview-items">
          <div>
            <dt>校对完成</dt>
            <dd class="report-overview-number">
              {{ reportMetricValue(report.metrics.proofreading?.completed) }}
            </dd>
            <dd v-if="report.batch.status === 'validated'">
              <RouterLink :to="importTarget" class="report-link">前往材料导入</RouterLink>
            </dd>
            <dd v-else-if="importComplete && needsProofreading">
              <RouterLink :to="entriesTarget" class="report-link">查看本批条目</RouterLink>
            </dd>
          </div>
          <div>
            <dt>待仲裁</dt>
            <dd class="report-overview-number">
              {{ reportMetricValue(report.metrics.proofreading?.pending_arbitration) }}
            </dd>
            <dd><RouterLink :to="queueTarget" class="report-link">查看本批待仲裁</RouterLink></dd>
          </div>
          <div>
            <dt>等待回执</dt>
            <dd class="report-overview-number">{{ awaitingReceiptCount }}</dd>
            <dd>
              <a href="#report-delivery" class="report-link">查看本批交付与回执</a>
            </dd>
          </div>
        </dl>
      </section>
      <BatchReportMetrics :metrics="report.metrics" :import-complete="importComplete" />

      <section
        v-if="importComplete"
        id="report-findings"
        class="card report-section"
        aria-labelledby="report-findings-heading"
      >
        <div class="record-heading">
          <h2 id="report-findings-heading">列与分页疑点</h2>
          <RouterLink
            :to="
              projectWorkspaceTarget(projectId, 'work', 'checks', reportContextQuery('findings'))
            "
            class="report-link"
          >
            前往质量检查重算
          </RouterLink>
        </div>
        <p v-if="batchFindingsError" class="alert alert-error" role="alert">
          {{ batchFindingsError }}
          <AppButton variant="secondary" size="sm" @click="loadBatchFindings(findingsPage)"
            >重试</AppButton
          >
        </p>
        <p v-else-if="findingsLoading && !batchFindings" role="status">正在读取本批疑点…</p>
        <template v-else-if="batchFindings">
          <p v-if="!batchFindings.items.length" class="report-empty">
            本批暂无记录。项目质量检查重算后，刷新这里查看最新结果。
          </p>
          <ul v-else class="report-records">
            <li v-for="item in batchFindings.items" :key="item.id">
              <div class="record-heading">
                <strong>{{
                  item.field
                    ? `列「${item.field}」`
                    : item.evidence?.page
                      ? `PDF 第 ${item.evidence.page} 页`
                      : 'PDF 分页'
                }}</strong>
                <RouterLink
                  v-if="item.evidence?.page"
                  :to="
                    projectWorkspaceTarget(projectId, 'work', 'entries', {
                      ...reportContextQuery('findings'),
                      importJob: batchId,
                      minPage: String(item.evidence.page),
                      maxPage: String(item.evidence.page)
                    })
                  "
                  class="report-link"
                  >查看本批该页条目</RouterLink
                >
              </div>
              <p class="text-sm">{{ renderFindingMessage(item.message) }}</p>
            </li>
          </ul>
          <AppPagination
            v-if="batchFindings.hasMore || findingsPage > 1"
            :page="findingsPage"
            :has-next="batchFindings.hasMore"
            :busy="findingsLoading"
            label="批次疑点分页"
            @change="loadBatchFindings"
          />
        </template>
      </section>

      <section class="card report-section" aria-labelledby="report-adoption">
        <div class="record-heading">
          <div>
            <h2 id="report-adoption">用途编选</h2>
            <p class="text-sm text-muted">
              下列数量取各编选记录保存时的结果，核对总数包含未采用条目，不能分摊为本导入批次的数量。
            </p>
          </div>
          <div class="report-heading-actions">
            <RouterLink
              v-if="canCreateForBatch"
              :to="
                reportActionTarget(
                  'ProjectAdoption',
                  { view: 'create', importJob: batchId },
                  'adoption'
                )
              "
              class="btn btn-secondary"
              >为本批新建编选</RouterLink
            >
            <RouterLink
              :to="reportActionTarget('ProjectAdoption', {}, 'adoption')"
              class="report-link"
              >浏览项目全部编选</RouterLink
            >
          </div>
        </div>
        <p v-if="!report.adoptions.length" class="report-empty">没有涵盖本批次的编选记录。</p>
        <ul v-else class="report-records">
          <li v-for="item in report.adoptions" :key="item.id">
            <div class="record-heading">
              <strong
                >{{ purposeLabel(item.purpose) || '用途未记录' }} ·
                {{ item.recipient || '接收方未记录' }}</strong
              >
              <span class="text-sm text-muted">{{ batchStatusLabel(item.status) }}</span>
            </div>
            <p class="text-sm">
              {{ adoptionScope(item) }} · 记录时间 {{ reportDate(item.recorded_at) }}
            </p>
            <p v-if="item.counts" class="text-sm record-numbers">
              核对 {{ reportNumber(item.counts.total) }} 条 ·
              {{ reportNumber(item.counts.selected) }} 采用 ·
              {{ reportNumber(item.counts.excluded) }} 排除 ·
              {{ reportNumber(item.counts.pending) }} 保存时待定
            </p>
            <p v-else class="text-sm text-muted">尚未保存编选数量。</p>
            <RouterLink
              :to="reportActionTarget('ProjectAdoption', { batch: item.id }, 'adoption')"
              class="report-link"
            >
              查看编选记录
            </RouterLink>
          </li>
        </ul>
      </section>

      <section class="card report-section" aria-labelledby="report-delivery">
        <h2 id="report-delivery">交付与回执</h2>
        <p class="text-sm text-muted">回执依据已登记的事件；下载交付包不代表接收。</p>
        <p v-if="!report.deliveries.length" class="report-empty">本批次暂无交付包。</p>
        <ul v-else class="report-records">
          <li v-for="item in report.deliveries" :key="item.id">
            <div class="record-heading">
              <strong
                >{{ item.recipient || '接收方未记录' }} · 第
                {{ reportNumber(item.version) }} 版</strong
              >
              <span
                class="text-sm"
                :class="
                  item.withdrawn || item.workflow_state === 'pending_resolution'
                    ? 'text-danger'
                    : 'text-muted'
                "
              >
                {{ receiptLabel(item) }}
              </span>
            </div>
            <p class="text-sm">
              {{ purposeLabel(item.purpose) || '用途未记录' }} · 生成于
              {{ reportDate(item.created) }} · 正文
              {{ reportNumber(item.reconciliation?.payload_count) }} 条
            </p>
            <p
              v-if="item.awaiting_receipt === true && Number.isFinite(item.waiting_seconds)"
              class="text-sm"
            >
              等待回执 {{ reportDuration(item.waiting_seconds) }}
            </p>
            <div class="report-heading-actions">
              <RouterLink
                v-if="item.awaiting_receipt || item.workflow_state === 'pending_resolution'"
                :to="
                  reportActionTarget(
                    'ProjectDeliveries',
                    { package: item.id, tab: 'events' },
                    'delivery'
                  )
                "
                class="btn btn-secondary"
                >{{ item.awaiting_receipt ? '登记本包回执' : '处理退回事项' }}</RouterLink
              >
              <RouterLink
                :to="reportActionTarget('ProjectDeliveries', { package: item.id }, 'delivery')"
                class="report-link"
                >查看交付详情</RouterLink
              >
            </div>
          </li>
        </ul>
      </section>

      <section
        v-if="report.unknowns.length"
        class="report-unknowns"
        aria-labelledby="report-unknowns"
      >
        <h2 id="report-unknowns">记录缺口</h2>
        <ul>
          <li v-for="note in report.unknowns" :key="note">{{ note }}</li>
        </ul>
      </section>

      <section
        id="report-exports"
        class="card report-section"
        aria-labelledby="report-exports-title"
      >
        <div class="record-heading">
          <div>
            <h2 id="report-exports-title">生成与下载</h2>
            <p class="text-sm text-muted">
              生成时重新读取批次。已生成的 JSON 报告与 CSV 明细保留当时的数据。
            </p>
          </div>
          <AppButton
            variant="primary"
            :loading="creating"
            :disabled="generationPending || selectedLoading || historyLoading"
            @click="generate"
            >生成报告文件</AppButton
          >
        </div>
        <p v-if="actionError" class="alert alert-error" role="alert">{{ actionError }}</p>
        <div v-if="selectedId || selectedError" class="report-selected" aria-label="所选报告文件">
          <h3>所选历史报告文件</h3>
          <p class="text-sm text-muted">文件保留生成时的数据；本页上方仍展示当前批次的最新记录。</p>
          <p v-if="selectedLoading" role="status">正在读取生成状态…</p>
          <div v-else-if="selectedError" role="alert">
            <p>{{ selectedError }}</p>
            <AppButton v-if="selectedId" variant="secondary" size="sm" @click="readSelected()"
              >重试读取</AppButton
            >
          </div>
          <template v-else-if="selected">
            <p role="status">
              <strong>{{ reportExportStatus(selected) }}</strong>
              <span v-if="selected.status === 'completed'">
                · 生成于 {{ reportDate(selected.generated_at) }}</span
              >
            </p>
            <p v-if="selected.status === 'failed'" class="text-danger" role="alert">
              {{ selected.error_message || '本次生成未完成，可以重新生成。' }}
            </p>
            <div v-if="selected.status === 'completed'" class="report-downloads">
              <AppButton
                v-if="selected.artifacts?.json?.id"
                :loading="downloading === 'json'"
                :disabled="Boolean(downloading)"
                variant="secondary"
                @click="download('json')"
                >下载 JSON 报告</AppButton
              >
              <AppButton
                v-if="selected.artifacts?.csv?.id"
                :loading="downloading === 'csv'"
                :disabled="Boolean(downloading)"
                variant="secondary"
                @click="download('csv')"
                >下载 CSV 明细</AppButton
              >
              <p
                v-if="!selected.artifacts?.json?.id || !selected.artifacts?.csv?.id"
                class="text-sm"
              >
                部分文件记录缺失，请重新读取后再试。
              </p>
            </div>
          </template>
        </div>
        <p v-if="historyPending && selected?.id !== historyPending.id" class="text-sm">
          本批次有一份报告正在生成。
          <RouterLink :to="historyTarget(historyPending.id)" class="report-link"
            >查看生成进度</RouterLink
          >
        </p>

        <div id="report-history" class="record-heading report-history-heading">
          <h3>历史报告</h3>
          <AppButton variant="ghost" size="sm" :loading="historyLoading" @click="loadHistory()">
            刷新历史
          </AppButton>
        </div>
        <p v-if="historyLoading && !history" role="status">正在读取历史报告…</p>
        <p v-if="historyError" class="alert alert-error" role="alert">{{ historyError }}</p>
        <p v-else-if="history && !history.items.length" class="report-empty">
          {{ historyPage > 1 ? '这一页没有报告文件，可返回上一页查看。' : '尚未生成报告文件。' }}
        </p>
        <ul v-if="history?.items.length" class="report-records report-history">
          <li v-for="item in history.items" :key="item.id">
            <div>
              <strong>{{ reportDate(item.generated_at || item.created) }}</strong>
              <p class="text-sm text-muted">{{ reportExportStatus(item) }}</p>
            </div>
            <RouterLink
              :to="historyTarget(item.id)"
              :aria-current="item.id === selectedId ? 'true' : undefined"
              :aria-label="`打开历史报告文件 ${reportDate(item.generated_at || item.created)} ${item.id}`"
              class="report-link"
              >{{ item.id === selectedId ? '已选文件' : '打开历史文件' }}</RouterLink
            >
          </li>
        </ul>
        <AppPagination
          v-if="history && (history.hasNext || historyPage > 1)"
          :page="historyPage"
          :has-next="history.hasNext"
          :busy="historyLoading"
          label="历史报告分页"
          @change="changeHistoryPage"
        />
      </section>
    </template>
  </main>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import AppButton from '@/components/AppButton.vue'
import AppPagination from '@/components/AppPagination.vue'
import BatchReportMetrics from '@/components/admin/project/BatchReportMetrics.vue'
import ProjectWorkspaceNav from '@/components/admin/project/ProjectWorkspaceNav.vue'
import { useBatchReportExports } from '@/composables/useBatchReportExports'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import { batchStatusLabel, purposeLabel } from '@/lib/adoption'
import {
  batchImportStatus,
  reportDate,
  reportDuration,
  reportExportStatus,
  reportMetricValue,
  reportNumber
} from '@/lib/batchReport'
import { receiptLabel } from '@/lib/deliveryPresentation'
import { batchReportNavigationQuery } from '@/lib/batchReportContext'
import { renderFindingMessage } from '@/lib/findingMessages'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
import { listProjectFindings } from '@/services/assistService'
import { getBatchReport } from '@/services/batchReportService'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

const route = useRoute()
const projectId = String(route.params.id)
const batchId = String(route.params.batchId)
const returnTarget = {
  ...projectWorkspaceTarget(projectId, 'materials', 'batches'),
  hash: `#import-batch-${batchId}`
}
const queueTarget = computed(() =>
  projectWorkspaceTarget(projectId, 'work', 'entries', {
    ...reportContextQuery('overview'),
    importJob: batchId,
    status: 'arbitration'
  })
)
const entriesTarget = computed(() =>
  projectWorkspaceTarget(projectId, 'work', 'entries', {
    ...reportContextQuery('overview'),
    importJob: batchId
  })
)
const importTarget = computed(() => {
  const method = report.value?.batch.mode
  return projectWorkspaceTarget(projectId, 'materials', 'import', {
    ...reportContextQuery('overview'),
    method:
      method === 'ocr' ? 'ocr' : ['bundle', 'review_bundle'].includes(method) ? 'bundle' : 'csv'
  })
})
const needsProofreading = computed(() => {
  const metric = report.value?.metrics.proofreading?.completed
  return Number.isFinite(metric?.value) && metric.value < metric.denominator
})
const report = ref(null)
const loading = ref(false)
const error = ref('')
const batchFindings = ref(null)
const batchFindingsError = ref('')
const findingsPage = ref(1)
const findingsLoading = ref(false)
const scope = useProtectedPageScope((status) => {
  report.value = null
  loading.value = false
  batchFindings.value = null
  exportsState.clear()
  error.value =
    status === 401 ? '登录状态已变化，请重新打开报告。' : '当前账号无法查看这个批次的报告。'
})
const { accessLost } = scope
const exportsState = useBatchReportExports(projectId, batchId, scope)
const {
  selectedId,
  selected,
  selectedLoading,
  selectedError,
  history,
  historyPage,
  historyLoading,
  historyError,
  historyPending,
  generationPending,
  actionError,
  creating,
  downloading,
  loadHistory,
  changeHistoryPage,
  readSelected,
  historyTarget,
  generate,
  download
} = exportsState

const awaitingReceiptCount = computed(() => {
  const items = report.value?.deliveries
  if (!items || items.some((item) => typeof item.awaiting_receipt !== 'boolean')) return '未记录'
  return `${reportNumber(items.filter((item) => item.awaiting_receipt).length)} 包`
})
const importComplete = computed(() =>
  ['completed', 'completed_with_errors'].includes(report.value?.batch.status)
)
const canCreateForBatch = computed(
  () => importComplete.value && Number(report.value?.metrics.import?.retained?.value) > 0
)

function reportContextQuery(section) {
  return batchReportNavigationQuery({
    projectId,
    batchId,
    exportId: selectedId.value,
    historyPage: historyPage.value,
    section
  })
}
function reportActionTarget(name, query, section) {
  return {
    name,
    params: { id: projectId },
    query: { ...reportContextQuery(section), ...query }
  }
}

let restoredAnchor = ''
async function restoreReportSection() {
  const anchor = route.hash
  if (!report.value || historyLoading.value || selectedLoading.value || restoredAnchor === anchor)
    return
  if (
    ![
      '#batch-overview-heading',
      '#report-findings',
      '#report-adoption',
      '#report-delivery',
      '#report-exports',
      '#report-history'
    ].includes(anchor)
  )
    return
  await nextTick()
  if (route.hash !== anchor) return
  const target = document.getElementById(anchor.slice(1))
  if (target) {
    target.scrollIntoView({ block: 'start' })
    restoredAnchor = anchor
  }
}
watch(
  () => route.hash,
  () => {
    restoredAnchor = ''
    void restoreReportSection()
  }
)
watch([report, historyLoading, selectedLoading], restoreReportSection)
const modeLabel = computed(
  () =>
    ({
      bundle: '资料包',
      review_bundle: '资料包',
      ocr: 'PDF 文字提取',
      skip_invalid: 'CSV',
      strict: 'CSV'
    })[report.value?.batch.mode] || '导入批次'
)

function adoptionScope(item) {
  if (item.scope === 'project') return '整个项目'
  return item.import_jobs?.length ? `选定的 ${item.import_jobs.length} 个导入批次` : '范围未记录'
}

async function load() {
  if (loading.value || accessLost.value) return
  loading.value = true
  error.value = ''
  const request = scope.capture()
  try {
    const value = await getBatchReport(projectId, batchId, request.signal)
    if (!request.isCurrent()) return
    if (
      value?.project_id !== projectId ||
      value?.batch?.id !== batchId ||
      value.schema !== 'WanyuBatchReport/v1'
    )
      throw new Error('收到的报告与当前批次不一致，暂无法显示。')
    report.value = value
    if (importComplete.value) void loadBatchFindings(1)
    if (!history.value && !historyLoading.value) void loadHistory()
    if (selectedId.value && !selected.value && !selectedError.value && !selectedLoading.value)
      void readSelected()
  } catch (cause) {
    if (!request.isCurrent() || scope.invalidate(cause, request)) return
    if (getPbStatus(cause) === 404) {
      scope.cancel()
      report.value = null
      loading.value = false
      batchFindings.value = null
      findingsLoading.value = false
      exportsState.clear()
      error.value = '找不到这个导入批次，请返回台账重新选择。'
    } else {
      error.value = getPbMessage(cause, '批次报告暂时无法读取。')
    }
  } finally {
    if (request.isCurrent()) loading.value = false
    request.finish()
  }
}

async function loadBatchFindings(page) {
  if (findingsLoading.value || accessLost.value) return
  findingsLoading.value = true
  batchFindingsError.value = ''
  findingsPage.value = page
  const request = scope.capture()
  try {
    const view = await listProjectFindings(projectId, {
      batch: batchId,
      page,
      per: 20,
      signal: request.signal
    })
    if (request.isCurrent()) batchFindings.value = view
  } catch (cause) {
    if (!request.isCurrent() || scope.invalidate(cause, request)) return
    batchFindingsError.value = getPbMessage(cause, '本批疑点暂时无法读取。')
  } finally {
    if (request.isCurrent()) findingsLoading.value = false
    request.finish()
  }
}

onMounted(load)
</script>

<style scoped>
.batch-report {
  padding-bottom: var(--space-6);
}
.report-heading h1 {
  margin-top: var(--space-2);
}
.report-heading p {
  overflow-wrap: anywhere;
}
.report-back,
.report-link {
  display: inline-flex;
  align-items: center;
  min-height: var(--control-height);
  color: var(--primary);
}
.report-heading-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.report-overview {
  margin-bottom: var(--space-4);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--primary-glow-soft);
}
.report-timestamp {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-3) var(--space-4);
  color: var(--ink-muted);
}
.report-timestamp h2 {
  color: var(--primary);
  font-size: var(--text-md);
}
.report-overview-items {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: var(--space-2) var(--space-4);
  margin: 0;
  border-top: 1px solid var(--line);
}
.report-overview-items > div {
  padding: var(--space-2) var(--space-3);
}
.report-overview-items > div + div {
  border-inline-start: 1px solid var(--line);
}
.report-overview-number {
  margin-top: var(--space-1);
  font-size: var(--text-lg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
#report-exports {
  scroll-margin-top: 96px;
}
.report-section,
.report-unknowns {
  margin-top: var(--space-4);
}
.report-section h2,
.report-unknowns h2 {
  font-size: var(--text-lg);
  margin-bottom: var(--space-1);
}
.report-section h3 {
  font-size: var(--text-md);
}
.record-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}
.report-records {
  list-style: none;
  padding: 0;
  margin: var(--space-2) 0 0;
}
.report-records > li {
  padding-block: var(--space-3);
  border-top: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.report-records p + p {
  margin-top: var(--space-1);
}
.record-numbers {
  font-variant-numeric: tabular-nums;
}
.report-empty {
  margin-top: var(--space-3);
  color: var(--ink-muted);
}
.report-unknowns,
.report-selected {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-panel);
  background: var(--paper);
}
.report-unknowns ul {
  padding-inline-start: var(--space-5);
}
.report-selected {
  margin-block: var(--space-3);
}
.report-downloads {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.report-history-heading {
  margin-top: var(--space-4);
}
.report-history > li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
}
@media (max-width: 768px) {
  .report-overview-items {
    padding-inline: var(--space-2);
  }
  .report-overview-items > div {
    padding-inline: var(--space-2);
  }
  .report-back,
  .report-link {
    min-height: var(--control-height-touch);
  }
}
</style>
