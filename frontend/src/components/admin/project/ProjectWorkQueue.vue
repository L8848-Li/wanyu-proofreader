<template>
  <section class="project-todo" aria-label="选择待办队列">
    <header class="project-todo__heading">
      <div>
        <h2>待办队列</h2>
        <p>从需要你处理的事项进入，完成后可返回这里继续。</p>
      </div>
      <AppButton
        v-if="!accessError"
        variant="ghost"
        size="sm"
        :loading="busy"
        loading-label="正在刷新…"
        @click="reload"
      >
        <AppIcon name="refresh" />刷新数量
      </AppButton>
    </header>
    <template v-if="accessError">
      <AppStatusPanel state="error" title="当前项目暂不可访问" :message="accessError" />
      <RouterLink to="/admin" class="project-todo__action"
        >返回项目列表<AppIcon name="arrow"
      /></RouterLink>
    </template>
    <template v-else>
      <div v-if="priority" class="project-todo__next">
        <AppIcon name="task" />
        <p>{{ priority.message }}</p>
        <RouterLink :to="link(priority.action)" class="btn btn-primary btn-sm"
          >{{ priority.label }}<AppIcon name="arrow"
        /></RouterLink>
      </div>
      <ul class="project-todo__list" aria-label="项目待办事项">
        <li v-for="item in items" :key="item.key">
          <span class="project-todo__icon"><AppIcon :name="item.icon" /></span>
          <div class="project-todo__body">
            <h3>{{ item.title }}</h3>
            <p>{{ item.detail }}</p>
          </div>
          <div
            class="project-todo__state"
            :class="{ 'project-todo__state--active': item.count > 0 }"
          >
            <strong v-if="item.count !== null"
              >{{ item.count }}<span> {{ item.unit || '条' }}</span></strong
            >
            <span v-else>{{ item.pending ? '读取中…' : item.error ? '读取失败' : '未读取' }}</span>
            <small v-if="item.count !== null && item.pending">正在更新…</small>
            <small v-else-if="item.error && item.count !== null">上次读取</small>
            <small v-else-if="item.count === 0">{{ item.emptyLabel }}</small>
            <small v-else-if="item.count === null">打开队列查看</small>
            <small v-else>{{ item.countLabel }}</small>
          </div>
          <RouterLink :to="link(item.key)" class="project-todo__action"
            >{{ item.label }}<AppIcon name="arrow"
          /></RouterLink>
          <AppStatusPanel
            v-if="item.error"
            class="project-todo__row-error"
            state="error"
            :title="`${item.title}数量暂不可用`"
            :message="item.error"
            retry-label="重试读取"
            @retry="retryItem(item)"
          />
        </li>
      </ul>
      <p class="project-todo__note">
        数量均为全项目统计。来源复核包含待完成条目；成员问题按未处理事项计数，同一事项的多份报告合并计为一项。
      </p>
    </template>
  </section>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppButton from '@/components/AppButton.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { getAdminProjectPageStats } from '@/services/pagesService'
import { listNormalizations } from '@/services/schemeConversionService'
import { getVerificationSummary, getProjectProblems } from '@/services/verificationService'
import {
  projectWorkflowTarget,
  workflowCount,
  workflowReviewCount,
  workflowProblemCount
} from '@/lib/projectWorkflow'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'
const props = defineProps({
  projectId: { type: String, required: true },
  query: { type: Object, default: () => ({}) }
})
const accessError = ref('')
const {
  data: stats,
  pending: statsPending,
  error: statsError,
  reload: readStats,
  cancel: cancelStats
} = useAsyncResource(({ signal }) => getAdminProjectPageStats(props.projectId, { signal }), {
  formatError: (error) => getPbMessage(error, '请稍后重试；也可以直接打开仲裁队列。')
})
const {
  data: normalizations,
  pending: normalizationPending,
  error: normalizationError,
  reload: readNormalizations,
  cancel: cancelNormalizations
} = useAsyncResource(
  () =>
    listNormalizations(props.projectId, { status: 'AMBIGUOUS,UNSUPPORTED', page: 1, perPage: 1 }),
  { formatError: (error) => getPbMessage(error, '请稍后重试；也可以直接打开归一复核。') }
)
const {
  data: reviews,
  pending: reviewPending,
  error: reviewError,
  reload: readReviews,
  cancel: cancelReviews
} = useAsyncResource(() => getVerificationSummary(props.projectId), {
  formatError: (error) => getPbMessage(error, '请稍后重试；也可以直接打开来源复核。')
})
const {
  data: problems,
  pending: problemPending,
  error: problemError,
  reload: readProblems,
  cancel: cancelProblems
} = useAsyncResource(() => getProjectProblems(props.projectId), {
  formatError: (error) => getPbMessage(error, '请稍后重试；也可以直接打开成员问题。')
})
function invalidateAccess(error) {
  const status = getPbStatus(error)
  if (![401, 403, 404].includes(status)) return
  // Stop every read before clearing values; late successful peers cannot restore them.
  cancelStats()
  cancelNormalizations()
  cancelReviews()
  cancelProblems()
  stats.value = null
  normalizations.value = null
  reviews.value = null
  problems.value = null
  accessError.value =
    status === 401
      ? '登录状态已失效，请重新登录后打开项目。'
      : status === 403
        ? '当前账号已无权查看此项目，请联系项目管理员。'
        : '项目或待办入口已不可用，请返回项目列表确认。'
}
async function loadResource(read) {
  if (accessError.value) return
  const result = await read()
  if (result.error) invalidateAccess(result.error)
  return result
}
const loadStats = () => loadResource(readStats)
const loadNormalizations = () => loadResource(readNormalizations)
const loadReviews = () => loadResource(readReviews)
const loadProblems = () => loadResource(readProblems)
const busy = computed(
  () =>
    statsPending.value || normalizationPending.value || reviewPending.value || problemPending.value
)
const arbitrationCount = computed(() => workflowCount(stats.value?.arbitration))
const normalizationCount = computed(() => workflowCount(normalizations.value?.totalItems))
const reviewCount = computed(() => workflowReviewCount(reviews.value))
const problemCount = computed(() => workflowProblemCount(problems.value))
const priority = computed(() => {
  if (arbitrationCount.value > 0 && !statsError.value)
    return {
      action: 'arbitration',
      label: '处理仲裁',
      message: `先处理 ${arbitrationCount.value} 条独立结果差异。`
    }
  if (problemCount.value > 0 && !problemError.value)
    return {
      action: 'problems',
      label: '处理成员问题',
      message: `${problemCount.value} 项成员问题尚未处理完成。`
    }
  if (normalizationCount.value > 0 && !normalizationError.value)
    return {
      action: 'normalization',
      label: '打开归一复核',
      message: `${normalizationCount.value} 条写法需要人工复核。`
    }
  return null
})
const items = computed(() => [
  {
    key: 'arbitration',
    icon: 'task',
    title: '待仲裁',
    detail: '逐字段核对独立结果的差异，决定最终内容。',
    count: arbitrationCount.value,
    countLabel: '等待仲裁',
    emptyLabel: '暂无待仲裁',
    pending: statsPending.value,
    error: statsError.value,
    retry: loadStats,
    label: '处理仲裁'
  },
  {
    key: 'review',
    icon: 'source',
    title: '来源复核',
    detail: '处理已有提交的来源核验或仲裁；等待校对的条目在队列中单列。',
    count: reviewCount.value,
    countLabel: '可核验或仲裁',
    emptyLabel: '当前范围无待办',
    pending: reviewPending.value,
    error: reviewError.value,
    retry: loadReviews,
    label: '打开复核队列'
  },
  {
    key: 'problems',
    icon: 'help',
    title: '成员报告的问题',
    detail: '查看来源、工具与内容问题，处理后向成员反馈。',
    count: problemCount.value,
    unit: '项',
    countLabel: '尚未处理完成',
    emptyLabel: '暂无未处理事项',
    pending: problemPending.value,
    error: problemError.value,
    retry: loadProblems,
    label: '处理问题'
  },
  {
    key: 'normalization',
    icon: 'keyboard',
    title: '拼音归一复核',
    detail: '查看已生成的归一结果，复核需人工确认或暂不支持的写法。',
    count: normalizationCount.value,
    countLabel: '等待复核',
    emptyLabel: '暂无待复核',
    pending: normalizationPending.value,
    error: normalizationError.value,
    retry: loadNormalizations,
    label: '打开归一复核'
  }
])
const link = (action) => projectWorkflowTarget(props.projectId, action, props.query)
function retryItem(item) {
  document.activeElement
    ?.closest('li')
    ?.querySelector('.project-todo__action')
    ?.focus({ preventScroll: true })
  void item.retry()
}
const reload = () =>
  Promise.allSettled([loadStats(), loadNormalizations(), loadReviews(), loadProblems()])
onMounted(reload)
defineExpose({ reload })
</script>
<style scoped>
.project-todo {
  display: grid;
  gap: var(--space-4);
}
.project-todo__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}
.project-todo__heading h2 {
  font-size: var(--text-xl);
}
.project-todo p {
  color: var(--ink-muted);
  font-size: var(--text-sm);
  line-height: 1.7;
}
.project-todo__heading p {
  margin-top: var(--space-1);
}
.project-todo__heading > .app-button {
  flex-shrink: 0;
}
.project-todo__next {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--primary-glow-soft);
  border: 1px solid var(--primary-line);
  border-radius: var(--radius-panel);
}
.project-todo__next > .app-icon {
  color: var(--primary);
  flex-shrink: 0;
}
.project-todo__next p {
  flex: 1;
  color: var(--ink);
}
.project-todo__next .btn {
  flex-shrink: 0;
}
.project-todo__list {
  list-style: none;
  border-top: 1px solid var(--line);
}
.project-todo__list li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 7em 10em;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-5) 0;
  border-bottom: 1px solid var(--line);
}
.project-todo__icon {
  color: var(--ink-muted);
  align-self: start;
  padding-top: var(--space-1);
}
.project-todo__body h3 {
  font-size: var(--text-md);
}
.project-todo__body p {
  margin-top: var(--space-1);
  max-width: 48ch;
}
.project-todo__state {
  display: grid;
  gap: var(--space-1);
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.project-todo__state strong {
  color: var(--ink);
  font-size: var(--text-lg);
  font-variant-numeric: tabular-nums;
}
.project-todo__state strong span {
  font-size: var(--text-sm);
  font-weight: 400;
}
.project-todo__state small {
  font-size: var(--text-xs);
}
.project-todo__state--active strong {
  color: var(--primary);
}
.project-todo__action {
  display: inline-flex;
  align-items: center;
  justify-self: end;
  gap: var(--space-2);
  min-height: var(--control-height);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.project-todo__action .app-icon {
  width: 16px;
  height: 16px;
}
.project-todo__row-error {
  grid-column: 2 / -1;
  margin: 0;
}
.project-todo__note {
  max-width: 78ch;
}
@media (max-width: 768px) {
  .project-todo__list li {
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-4) 0;
  }
  .project-todo__action {
    grid-column: 2 / -1;
    justify-self: start;
    min-height: var(--control-height-touch);
  }
  .project-todo__state {
    text-align: right;
  }
}
@media (max-width: 640px) {
  .project-todo__heading {
    align-items: flex-start;
  }
  .project-todo__next {
    flex-wrap: wrap;
  }
  .project-todo__next .btn {
    width: 100%;
    min-height: var(--control-height-touch);
  }
}
</style>
