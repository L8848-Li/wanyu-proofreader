<template>
  <main class="container page workspace-page todo-workspace">
    <header class="page-heading todo-heading">
      <div>
        <h1>统一待办</h1>
        <p>找到需要你处理的事项，继续核验、整理与交付。</p>
      </div>
      <AppButton variant="ghost" :disabled="accessLost" :loading="loading" @click="load">
        <AppIcon name="refresh" />刷新待办
      </AppButton>
    </header>

    <section v-if="!accessLost" class="todo-filter-bar" aria-label="待办筛选">
      <AppField label="项目">
        <AppSelect
          aria-label="筛选项目"
          :model-value="filters.project"
          :options="projectOptions"
          :disabled="!projects.length"
          @update:model-value="changeFilter({ project: $event })"
        />
      </AppField>
      <AppField label="阶段">
        <AppSelect
          aria-label="筛选阶段"
          :model-value="filters.stage"
          :options="stageOptions"
          @update:model-value="changeFilter({ stage: $event })"
        />
      </AppField>
      <AppButton
        v-if="invalidFilter || filters.project || filters.stage"
        variant="ghost"
        @click="clearFilters"
      >
        清除筛选
      </AppButton>
    </section>

    <AppStatusPanel
      v-if="error"
      state="error"
      :message="error"
      :retry-label="accessLost || invalidFilter ? '' : '重新读取'"
      :busy="loading"
      @retry="load"
    />
    <AppStatusPanel v-if="loading && !result" state="pending" message="正在读取统一待办…" />

    <section
      v-if="result"
      ref="resultsPanel"
      class="card todo-results"
      aria-labelledby="todo-results-heading"
      :aria-busy="loading"
    >
      <div class="todo-list-heading">
        <div>
          <h2 id="todo-results-heading" tabindex="-1">
            {{ filters.stage ? TODO_STAGES[filters.stage].label : '待处理环节' }}
          </h2>
          <p class="text-sm text-muted">
            {{ currentProjectLabel }} · {{ result.totalItems }} 个项目环节
          </p>
        </div>
        <span v-if="loading" class="text-sm text-muted" role="status">正在更新…</span>
        <time v-else-if="generatedAt" class="text-sm text-muted" :datetime="result.generated_at">
          更新于 {{ generatedAt }}
        </time>
      </div>
      <AppStatusPanel v-if="!result.items.length" state="empty" reason="none">
        <p>{{ emptyMessage }}</p>
      </AppStatusPanel>
      <ul v-else class="todo-list">
        <li v-for="row in presentedRows" :key="row.item.id" class="todo-row">
          <div class="todo-row__body">
            <div class="todo-row__context">
              <strong>{{ row.item.project.name }}</strong>
              <span>{{ row.stage.label }}</span>
            </div>
            <p v-if="row.item.note" class="text-sm text-muted">{{ row.item.note }}</p>
            <p v-if="row.item.role" class="todo-role text-sm">{{ row.item.role }}处理</p>
          </div>
          <div class="todo-row__measure">
            <strong>{{ row.count }}</strong>
            <span v-if="row.wait" class="text-sm text-muted">最早等待 {{ row.wait }}</span>
            <span
              v-else-if="row.item.state === 'ready' && row.item.waiting_note"
              class="text-sm text-muted"
              >{{ row.item.waiting_note }}</span
            >
            <span v-else-if="row.item.state === 'ready'" class="text-sm text-muted"
              >等待起点未记录</span
            >
          </div>
          <RouterLink
            v-if="row.target"
            :to="row.target"
            class="btn btn-secondary todo-row__action"
            :data-todo-row="row.item.id"
            :aria-label="`${row.item.project.name} · ${row.stage.label} · ${row.action}`"
          >
            {{ row.action }} <AppIcon name="arrow" />
          </RouterLink>
        </li>
      </ul>
      <AppPagination
        v-if="result.totalPages > 1"
        :page="result.page"
        :total-pages="result.totalPages"
        :busy="loading"
        label="统一待办分页"
        @change="changePage"
      />
    </section>
  </main>
</template>

<script setup>
import { computed, ref, useTemplateRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/AppButton.vue'
import AppField from '@/components/AppField.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppPagination from '@/components/AppPagination.vue'
import AppSelect from '@/components/AppSelect.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import { useQueueReturnPosition } from '@/composables/useQueueReturnPosition'
import { browserSessionStorage, retargetTodoPosition } from '@/lib/queueReturn'
import { useAuthStore } from '@/stores/auth'
import {
  TODO_STAGES,
  todoActionTarget,
  todoFilterError,
  todoFilters,
  todoListQuery,
  todoWait
} from '@/lib/unifiedTodos'
import { listUnifiedTodos } from '@/services/unifiedTodosService'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const filters = computed(() => todoFilters(route.query))
const invalidFilter = computed(() => todoFilterError(route.query))
const result = ref(null)
const resultsPanel = useTemplateRef('resultsPanel')
const projects = ref([])
const loading = ref(false)
const error = ref('')
const scope = useProtectedPageScope((status) => {
  result.value = null
  projects.value = []
  loading.value = false
  error.value =
    status === 401 ? '登录状态已变化，请重新打开待办。' : '当前账号没有管理项目待办的权限。'
})
const { accessLost } = scope
let activeRequest

useQueueReturnPosition(
  () => Boolean(result.value) && !loading.value,
  (id) => {
    const panel = resultsPanel.value
    const action = [...(panel?.querySelectorAll('[data-todo-row]') || [])].find(
      (link) => link.dataset.todoRow === id
    )
    const target = action ?? panel?.querySelector('#todo-results-heading')
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  }
)

const projectOptions = computed(() => [
  { value: '', label: '全部项目' },
  ...projects.value.map((item) => ({ value: item.id, label: item.name }))
])
const stageOptions = computed(() => [
  { value: '', label: '全部阶段' },
  ...Object.entries(TODO_STAGES).map(([value, stage]) => {
    const summary = result.value?.summary?.by_stage?.[value]
    const count = Number.isFinite(summary?.count)
      ? ` · ${summary.count} ${stage.unit}`
      : summary
        ? ' · 数量未读取'
        : ''
    return { value, label: stage.label + count }
  })
])
const currentProjectLabel = computed(() =>
  filters.value.project
    ? projects.value.find((item) => item.id === filters.value.project)?.name || '所选项目'
    : '全部管理项目'
)
const generatedAt = computed(() => {
  const value = result.value?.generated_at
  if (!value) return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : ''
})
const emptyMessage = computed(() => {
  if (!projects.value.length) return '当前没有可管理的项目。'
  return filters.value.project || filters.value.stage
    ? '所选范围内暂无待办。'
    : '目前没有需要处理的待办。'
})
const presentedRows = computed(() =>
  (result.value?.items || []).map((item) => {
    const stage = TODO_STAGES[item.stage] || { label: '其他待办', unit: '项', action: '打开处理页' }
    return {
      item,
      stage,
      count:
        item.state === 'ready' && Number.isFinite(item.count)
          ? `${item.count} ${stage.unit}`
          : '数量暂未读取',
      wait: todoWait(item.waiting_seconds),
      action: item.target_label || stage.action,
      target: todoActionTarget(item, router.resolve, filters.value)
    }
  })
)

function changeFilter(patch) {
  return router.push({ query: todoListQuery({ ...filters.value, ...patch, page: 1 }) })
}
function clearFilters() {
  return router.push({ query: {} })
}
function changePage(page) {
  return router.push({ query: todoListQuery({ ...filters.value, page }) })
}
async function load() {
  if (accessLost.value) return
  activeRequest?.cancel()
  if (invalidFilter.value) {
    error.value = invalidFilter.value
    loading.value = false
    return
  }
  const request = scope.capture()
  activeRequest = request
  const requested = filters.value
  loading.value = true
  error.value = ''
  try {
    const data = await listUnifiedTodos(requested, request.signal)
    if (!request.isCurrent()) return
    if (Number.isInteger(data.page) && data.page !== requested.page) {
      const target = { query: todoListQuery({ ...requested, page: data.page }) }
      // Finishing the last item may remove the page that launched the work.
      retargetTodoPosition(
        browserSessionStorage(),
        auth.user?.id,
        route.fullPath,
        router.resolve(target).fullPath
      )
      await router.replace(target)
      return
    }
    projects.value = data.projects
    result.value = data
  } catch (cause) {
    if (!request.isCurrent()) return
    const status = getPbStatus(cause)
    if (requested.project && (status === 403 || status === 404)) {
      result.value = null
      projects.value = []
      error.value = '所选项目已不可用，请清除项目筛选后重试。'
    } else if (!scope.invalidate(cause, request)) {
      const fallback = getPbMessage(cause, '统一待办暂时无法读取。')
      error.value = result.value ? `${fallback} 当前仍显示上次结果。` : fallback
    }
  } finally {
    if (request.isCurrent()) loading.value = false
    request.finish()
  }
}

watch(
  () => [filters.value.project, filters.value.stage, filters.value.page, invalidFilter.value],
  () => {
    result.value = null
    void load()
  },
  { immediate: true }
)
</script>

<style scoped>
.todo-filter-bar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 18rem)) auto;
  justify-content: start;
  align-items: end;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--primary-glow-soft);
}
.todo-filter-bar > .form-group {
  min-width: 0;
  margin-bottom: 0;
}
.todo-results {
  margin-bottom: var(--space-6);
}
.todo-list-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  margin-bottom: var(--space-3);
}
.todo-list-heading h2 {
  font-size: var(--text-lg);
  margin-bottom: var(--space-1);
}
.todo-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.todo-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(8rem, 0.35fr) 11rem;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  padding-block: var(--space-3);
  border-top: 1px solid var(--line);
}
.todo-row__context {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  overflow-wrap: anywhere;
}
.todo-row__context > span {
  color: var(--primary);
  font-size: var(--text-sm);
  font-weight: 600;
}
.todo-row__body p,
.todo-row__measure > span {
  margin-top: var(--space-1);
  overflow-wrap: anywhere;
}
.todo-role {
  color: var(--ink-muted);
}
.todo-row__measure {
  display: grid;
  justify-items: start;
  font-variant-numeric: tabular-nums;
}
.todo-row__action {
  justify-self: end;
}
@media (max-width: 768px) {
  .todo-workspace .todo-heading {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
  }
  .todo-filter-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding-inline: var(--space-3);
  }
  .todo-filter-bar > .btn {
    justify-self: start;
  }
  .todo-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .todo-row__body {
    grid-column: 1 / -1;
  }
  .todo-row__action {
    min-height: var(--control-height-touch);
  }
}
@media (max-width: 360px) {
  .todo-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .todo-row__action {
    justify-self: start;
  }
}
</style>
