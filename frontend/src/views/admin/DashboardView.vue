<template>
  <main class="container page workspace-page work-catalog admin-catalog">
    <header class="page-heading">
      <div>
        <h1>项目管理</h1>
      </div>
      <div class="page-heading-actions">
        <RouterLink
          v-if="auth.isPlatformAdmin || auth.hasManagedProjects"
          to="/admin/todos"
          class="btn btn-secondary"
          >统一待办</RouterLink
        >
        <AppButton
          variant="ghost"
          :loading="loading"
          loading-label="正在刷新"
          @click="loadDashboard()"
        >
          <AppIcon name="refresh" />刷新
        </AppButton>
        <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new" class="btn btn-primary"
          ><AppIcon name="plus" />创建项目</RouterLink
        >
      </div>
    </header>
    <ProjectHubTabs active="managed" />

    <AppStatusPanel
      v-if="error"
      state="error"
      :title="hasResult ? '更新失败，当前显示上次结果。' : '项目状态暂时无法加载。'"
      retry-label="重新加载"
      :busy="loading"
      @retry="loadDashboard()"
    >
      <span>{{ error }}</span>
    </AppStatusPanel>

    <dl
      class="catalog-summary admin-summary"
      aria-label="所有管理项目的校对概况"
      :aria-busy="loading"
    >
      <div
        :class="{
          'catalog-summary__attention': hasResult && overallSummary.arbitration > 0
        }"
      >
        <dt>待仲裁</dt>
        <dd>
          <AppButton
            v-if="hasResult && overallSummary.arbitration > 0"
            class="summary-arbitration"
            variant="ghost"
            size="sm"
            aria-label="筛选待仲裁项目"
            @click="selectArbitrationProjects"
            >{{ overallSummary.arbitration }}<span class="summary-unit">条</span
            ><AppIcon name="arrow"
          /></AppButton>
          <template v-else>{{ hasResult ? '0 条' : '—' }}</template>
        </dd>
      </div>
      <div>
        <dt>校对中</dt>
        <dd>{{ hasResult ? overallSummary.active : '—' }}<span v-if="hasResult">条</span></dd>
      </div>
      <div class="summary-completion">
        <dt>校对完成</dt>
        <dd v-if="hasResult && overallSummary.total > 0">
          {{ overallSummary.completionPct }}<span>%</span>
          <div class="progress" aria-hidden="true">
            <div class="progress-bar" :style="{ width: overallSummary.completionPct + '%' }"></div>
          </div>
        </dd>
        <dd v-else>—</dd>
        <small v-if="hasResult"
          >已完成 {{ overallSummary.approved }} 条 · 未完成
          {{ overallSummary.incomplete }} 条</small
        >
      </div>
    </dl>

    <section
      class="admin-projects-card catalog-projects"
      aria-labelledby="admin-project-list-title"
      :aria-busy="loading"
    >
      <div class="section-heading admin-project-heading">
        <h2 id="admin-project-list-title">项目进展</h2>
        <label class="admin-filter-field" for="admin-project-search">
          <span class="sr-only">搜索项目名或简介</span>
          <AppIcon name="search" />
          <input
            id="admin-project-search"
            v-model="searchQuery"
            class="form-control"
            type="search"
            autocomplete="off"
            placeholder="搜索项目名或简介"
            @input="scheduleSearch"
          />
        </label>
      </div>

      <div class="admin-list-filters admin-insights-controls">
        <div class="admin-quick-filters" role="group" aria-label="项目快捷筛选">
          <AppButton
            v-for="option in FILTER_OPTIONS"
            :key="option.value"
            type="button"
            size="sm"
            variant="ghost"
            :aria-pressed="dashboardQuery.filter === option.value"
            @click="setFilter(option.value)"
          >
            {{ option.label }}
          </AppButton>
        </div>
        <span v-if="loading && hasResult" class="admin-updating" role="status">正在更新…</span>
        <span v-else-if="hasResult" class="section-count"
          >{{ hasActiveFilters ? '找到 ' : '共 ' }}{{ pagination.totalItems }} 个项目</span
        >
      </div>

      <AppStatusPanel v-if="loading && !hasResult" state="pending" message="正在加载项目…" />

      <div v-else-if="!hasResult && error" class="empty-state">
        <AppIcon name="refresh" />
        <div class="empty-state-text">项目状态暂时不可用</div>
        <p>请检查网络连接后重试；重试不会清空当前筛选条件。</p>
        <AppButton class="mt-3" :loading="loading" @click="loadDashboard()"> 重新加载 </AppButton>
      </div>

      <AppStatusPanel v-else-if="projectInsights.length === 0" state="empty" reason="none">
        <template v-if="hasActiveFilters && overallSummary.projects > 0">
          <AppIcon name="search" />
          <div class="empty-state-text">没有符合条件的项目</div>
          <p>当前搜索或快捷筛选没有结果，可以清除条件后查看全部项目。</p>
          <AppButton class="mt-3" @click="clearFilters"> 清除搜索与筛选 </AppButton>
        </template>
        <template v-else>
          <AppIcon name="project" />
          <div class="empty-state-text">还没有项目</div>
          <p>创建项目后，先上传原文 PDF，再用 CSV 导入待校对条目。</p>
          <RouterLink
            v-if="auth.canCreateProjects"
            to="/admin/projects/new"
            class="btn btn-primary mt-3"
            >创建第一个项目</RouterLink
          >
          <RouterLink v-else to="/projects" class="btn btn-secondary mt-3"
            >发现可加入项目</RouterLink
          >
        </template>
      </AppStatusPanel>

      <AppDataTable v-else label="项目进展表" table-class="admin-project-table">
        <template #head>
          <tr>
            <th>项目</th>
            <th>待仲裁</th>
            <th>校对中</th>
            <th>完成进度</th>
            <th>操作</th>
          </tr>
        </template>
        <tr
          v-for="item in projectInsights"
          :key="item.project.id"
          :data-project-id="item.project.id"
          :class="{ 'admin-project-row--urgent': item.summary.arbitration > 0 }"
        >
          <td class="admin-project-identity">
            <div class="admin-project-name">
              <RouterLink :to="`/admin/projects/${item.project.id}`" class="project-name-link">
                {{ item.project.name }}
              </RouterLink>
              <ProjectPurposeBadge :purpose="item.project.purpose" />
            </div>
            <p class="project-created">
              <template v-if="item.project.description">{{ item.project.description }} · </template>
              创建于 {{ formatDate(item.project.created) }}
            </p>
          </td>
          <td class="admin-project-attention">
            <span class="project-mobile-label" aria-hidden="true">待仲裁</span>
            <RouterLink
              v-if="item.summary.arbitration"
              :to="`/admin/projects/${item.project.id}?section=work&view=entries&status=${PAGE_STATUS.ARBITRATION}`"
              class="attention-count"
              :aria-label="`${item.project.name}：处理 ${item.summary.arbitration} 条待仲裁`"
              >{{ item.summary.arbitration }} 条 <AppIcon name="arrow"
            /></RouterLink>
            <span v-else class="attention-clear">—</span>
          </td>
          <td class="admin-project-active">
            <span class="project-mobile-label" aria-hidden="true">校对中</span>
            <span v-if="item.summary.active">{{ item.summary.active }} 条</span>
            <span v-else class="attention-clear">—</span>
          </td>
          <td class="project-progress-cell">
            <template v-if="item.summary.total > 0">
              <div class="project-progress-label">
                <span>{{ item.summary.approved }} / {{ item.summary.total }} 条</span>
                <strong>{{ item.summary.completionPct }}%</strong>
              </div>
              <div
                class="progress"
                role="progressbar"
                :aria-label="`${item.project.name} 校对进度`"
                :aria-valuenow="item.summary.completionPct"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div
                  class="progress-bar"
                  :style="{ width: item.summary.completionPct + '%' }"
                ></div>
              </div>
            </template>
            <span v-else class="attention-clear">暂无材料</span>
          </td>
          <td class="admin-project-action-cell">
            <RouterLink
              :to="`/admin/projects/${item.project.id}/settings`"
              class="btn btn-quiet btn-sm project-settings-link"
              :aria-label="`${item.project.name}：项目设置`"
              ><AppIcon name="settings" />项目设置</RouterLink
            >
          </td>
        </tr>
      </AppDataTable>

      <AppPagination
        v-if="hasResult && projectInsights.length && pagination.totalPages > 1"
        :page="pagination.page"
        :total-pages="pagination.totalPages"
        :busy="loading"
        label="项目分页"
        @change="goToPage"
      />
    </section>
  </main>
</template>

<script setup>
import ProjectPurposeBadge from '@/components/ProjectPurposeBadge.vue'
import ProjectHubTabs from '@/components/ProjectHubTabs.vue'
import { useQueueReturnPosition } from '@/composables/useQueueReturnPosition'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import AppPagination from '@/components/AppPagination.vue'
import AppButton from '@/components/AppButton.vue'
import AppIcon from '@/components/AppIcon.vue'
import '@/styles/work-catalog.css'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { PAGE_STATUS } from '@/constants/pageStatus'
import {
  normalizeProjectInsightsQuery,
  toProjectInsightsRouteQuery
} from '@/lib/adminProjectInsights'
import { listProjectInsights } from '@/services/projectsService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

const PROJECTS_PER_PAGE = 12
const FILTER_OPTIONS = Object.freeze([
  { value: 'all', label: '全部' },
  { value: 'attention', label: '待仲裁' },
  { value: 'incomplete', label: '未完成' },
  { value: 'completed', label: '已完成' }
])

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projectInsights = ref([])
const overallSummary = ref(emptySummary())
const pagination = ref({
  page: 1,
  perPage: PROJECTS_PER_PAGE,
  totalItems: 0,
  totalPages: 0
})
const searchQuery = ref('')
const {
  pending: loading,
  error,
  hasValue: hasResult,
  reload: reloadDashboard
} = useAsyncResource(({ signal }, requested) => listProjectInsights(requested, { signal }), {
  formatError: dashboardError
})
useQueueReturnPosition(hasResult)
const dashboardQuery = computed(() =>
  normalizeProjectInsightsQuery({
    ...route.query,
    perPage: PROJECTS_PER_PAGE
  })
)
const hasActiveFilters = computed(
  () => Boolean(dashboardQuery.value.q) || dashboardQuery.value.filter !== 'all'
)
let searchTimer = null

watch(
  dashboardQuery,
  (query) => {
    clearSearchTimer()
    searchQuery.value = query.q
    loadDashboard(query)
  },
  { immediate: true }
)

onMounted(() => {
  auth.loadAccessContext().catch(() => {})
})

onBeforeUnmount(() => {
  clearSearchTimer()
})

async function loadDashboard(requestedQuery = dashboardQuery.value) {
  const requested = normalizeProjectInsightsQuery({
    ...requestedQuery,
    perPage: PROJECTS_PER_PAGE
  })
  const request = await reloadDashboard(requested)
  if (!request.ok) return
  const result = request.data
  projectInsights.value = result.items || []
  overallSummary.value = result.summary || emptySummary()
  pagination.value = {
    page: result.page ?? requested.page,
    perPage: result.perPage ?? PROJECTS_PER_PAGE,
    totalItems: result.totalItems ?? projectInsights.value.length,
    totalPages: result.totalPages ?? 0
  }
  if (pagination.value.page !== requested.page) {
    router.replace({
      query: toProjectInsightsRouteQuery({
        ...requested,
        page: pagination.value.page
      })
    })
  }
}

function scheduleSearch() {
  clearSearchTimer()
  searchTimer = setTimeout(() => {
    searchTimer = null
    replaceFilters({ q: searchQuery.value, page: 1 })
  }, 300)
}

function setFilter(filter) {
  clearSearchTimer()
  replaceFilters({ q: searchQuery.value, filter, page: 1 })
}

function selectArbitrationProjects() {
  clearSearchTimer()
  searchQuery.value = ''
  replaceFilters({ q: '', filter: 'attention', page: 1 })
}

function clearFilters() {
  clearSearchTimer()
  searchQuery.value = ''
  replaceFilters({ q: '', filter: 'all', page: 1 })
}

function replaceFilters(patch) {
  const next = normalizeProjectInsightsQuery({
    ...dashboardQuery.value,
    ...patch,
    perPage: PROJECTS_PER_PAGE
  })
  if (sameDashboardQuery(next, dashboardQuery.value)) return
  return router.replace({ query: toProjectInsightsRouteQuery(next) })
}

function goToPage(page) {
  const nextPage = Number(page)
  if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > pagination.value.totalPages) return
  clearSearchTimer()
  const next = normalizeProjectInsightsQuery({
    ...dashboardQuery.value,
    q: searchQuery.value,
    page: nextPage,
    perPage: PROJECTS_PER_PAGE
  })
  if (sameDashboardQuery(next, dashboardQuery.value)) return
  return router.push({ query: toProjectInsightsRouteQuery(next) })
}

function sameDashboardQuery(left, right) {
  return left.q === right.q && left.filter === right.filter && left.page === right.page
}

function clearSearchTimer() {
  if (searchTimer !== null) clearTimeout(searchTimer)
  searchTimer = null
}

function emptySummary() {
  return {
    projects: 0,
    total: 0,
    unstarted: 0,
    active: 0,
    collecting: 0,
    arbitration: 0,
    approved: 0,
    incomplete: 0,
    completionPct: 0
  }
}

function dashboardError(cause) {
  const status = getPbStatus(cause)
  if (status === 401) return '登录状态已失效，请重新登录。'
  if (status === 403) return '无权限读取项目状态，请检查项目与条目的访问规则。'
  return getPbMessage(cause, '加载项目状态失败，请稍后重试。')
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('zh-CN') : '—'
}
</script>

<style scoped>
.admin-catalog .admin-summary {
  grid-template-columns: minmax(96px, 0.65fr) minmax(96px, 0.65fr) minmax(230px, 2fr);
  gap: var(--space-5);
  padding-bottom: var(--space-4);
  margin-bottom: var(--space-5);
}
.admin-summary > div + div {
  border-inline-start: 1px solid var(--line);
  padding-inline-start: var(--space-5);
}
.admin-summary .summary-arbitration {
  padding-inline: 0;
  min-height: 0;
  padding-block: 0;
  color: var(--warn-hot-ink-deep);
  font-size: var(--text-xl);
  line-height: 1.3;
  font-weight: 600;
}
.admin-catalog .admin-summary .summary-arbitration :deep(.app-button__content) {
  color: inherit;
  font: inherit;
  align-items: baseline;
}
.admin-catalog .admin-summary .summary-unit {
  align-self: baseline;
  color: var(--warn-hot-ink-deep);
}
.summary-arbitration .app-icon {
  width: 16px;
  height: 16px;
  align-self: center;
  margin-inline-start: var(--space-1);
}
.summary-completion .progress {
  align-self: center;
  width: 112px;
  height: 6px;
  margin-inline-start: var(--space-3);
}
.admin-catalog .admin-project-heading {
  margin-bottom: var(--space-2);
  gap: var(--space-3);
}
.admin-project-heading .admin-filter-field {
  display: flex;
  flex: 0 1 280px;
  align-items: center;
  position: relative;
}
.admin-filter-field .app-icon {
  position: absolute;
  left: var(--space-3);
  pointer-events: none;
}
.admin-filter-field .form-control {
  padding-inline-start: var(--space-6);
}
.admin-catalog .admin-insights-controls {
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.admin-catalog :deep(.admin-project-table) {
  width: 100%;
}
.admin-catalog :deep(.admin-project-table td) {
  vertical-align: middle;
}
.admin-project-identity {
  width: 39%;
}
.admin-project-attention,
.admin-project-active {
  width: 13%;
  white-space: nowrap;
  font-size: var(--text-sm);
}
.admin-catalog .attention-count {
  align-items: center;
  gap: var(--space-1);
}
.attention-count .app-icon {
  width: 13px;
  height: 13px;
}
.admin-catalog .project-created {
  max-width: 100%;
  margin-top: var(--space-1);
  white-space: normal;
  overflow-wrap: anywhere;
}
.project-mobile-label {
  display: none;
}
.project-progress-cell {
  width: 22%;
}
.project-progress-cell .progress {
  height: 6px;
  margin: var(--space-1) 0 0;
}
.project-progress-label {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  align-items: baseline;
  color: var(--gray-500);
  white-space: nowrap;
  font-size: var(--text-xs);
}
.project-progress-label strong {
  color: var(--ink);
  font-weight: 600;
}
.admin-project-action-cell {
  white-space: nowrap;
}
.project-settings-link {
  margin-inline-start: calc(-1 * var(--space-2));
}
@media (max-width: 640px) {
  .admin-catalog .page-heading {
    margin-bottom: var(--space-3);
  }
  .admin-catalog .page-heading-actions {
    grid-row: 3;
    grid-column: 1 / -1;
    flex-wrap: wrap;
  }
  .admin-catalog .admin-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .admin-summary > div + div {
    border-inline-start: 0;
    padding-inline-start: 0;
  }
  .summary-completion {
    grid-column: 1 / -1;
  }
  .admin-catalog .admin-summary .summary-completion {
    display: block;
  }
  .admin-catalog .admin-project-heading {
    flex-wrap: wrap;
  }
  .admin-project-heading .admin-filter-field {
    flex: 1 1 170px;
  }
  .admin-catalog .admin-insights-controls {
    flex-wrap: wrap;
  }
  .admin-catalog :deep(.admin-project-table),
  .admin-catalog :deep(.admin-project-table tbody) {
    display: block;
  }
  .admin-catalog :deep(.admin-project-table thead) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .admin-catalog :deep(.admin-project-table tr) {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-areas: 'identity identity' 'attention active' 'progress progress' 'actions actions';
    gap: var(--space-2) var(--space-3);
    padding: var(--space-3);
    border-bottom: 1px solid var(--line);
  }
  .admin-catalog :deep(.admin-project-table td) {
    display: block;
    width: auto;
    min-width: 0;
    padding: 0;
    border: 0;
  }
  .admin-catalog :deep(.admin-project-table tr:hover td) {
    background: transparent;
  }
  .admin-project-identity {
    grid-area: identity;
  }
  .project-name-link {
    overflow-wrap: anywhere;
  }
  .admin-project-attention {
    grid-area: attention;
  }
  .admin-project-active {
    grid-area: active;
  }
  .project-progress-cell {
    grid-area: progress;
  }
  .admin-project-action-cell {
    grid-area: actions;
  }
  .project-mobile-label {
    display: inline;
    margin-inline-end: var(--space-1);
    color: var(--gray-500);
    font-size: var(--text-xs);
  }
  .attention-count {
    min-height: var(--control-height-sm);
  }
  .project-settings-link {
    min-height: var(--control-height-touch);
  }
}
</style>
