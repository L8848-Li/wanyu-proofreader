<template>
  <main class="container page workbench-home">
    <header class="page-heading workbench-heading">
      <div>
        <h1>工作台</h1>
        <p class="workbench-introduction">你的校勘工作与项目进展</p>
      </div>
      <div class="page-heading-actions">
        <RouterLink v-if="accessReady && canManage" to="/admin/todos" class="btn btn-secondary">
          全部项目待办
        </RouterLink>
        <AppButton
          variant="ghost"
          :loading="loading"
          :disabled="loading"
          @click="refresh"
          aria-label="刷新工作台"
        >
          <AppIcon name="refresh" /><span class="workbench-refresh-label">刷新</span>
        </AppButton>
      </div>
    </header>
    <AppStatusPanel
      v-if="accessError"
      state="error"
      :message="accessError"
      retry-label="重新加载"
      @retry="refresh"
    />
    <AppStatusPanel v-if="actionError" state="error" :message="actionError" />
    <AppStatusPanel v-if="loading && !accessReady" state="pending" message="正在准备你的工作台…" />
    <template v-if="accessReady">
      <AppStatusPanel
        v-if="queueError"
        state="error"
        :message="queueError"
        retry-label="重试任务"
        @retry="reloadQueues"
      />
      <AppStatusPanel
        v-if="managedError && canManage"
        state="error"
        :message="managedError"
        retry-label="重试项目待办"
        @retry="reloadManaged"
      />
      <section
        class="workbench-start"
        :class="{ 'workbench-start--quiet': !primaryWork }"
        aria-label="当前工作"
      >
        <template v-if="primaryWork">
          <div class="workbench-start__copy">
            <p class="workbench-context">{{ primaryWork.context }}</p>
            <h2 id="workbench-start-title">{{ primaryWork.projectName }}</h2>
            <p class="workbench-start__detail">{{ primaryWork.detail }}</p>
            <RouterLink
              v-if="primaryWork.kind === 'claim'"
              :to="{
                path: '/tasks',
                query: { view: 'available', project: primaryWork.projectId, guide: 'keyboard' }
              }"
              >查看项目键盘说明</RouterLink
            >
            <AppStatusPanel
              v-if="primaryWork.kind === 'resume' && resumeNameError"
              state="error"
              :message="resumeNameError"
              retry-label="重试项目"
              @retry="readResumeProject"
            />
          </div>
          <AppButton
            v-if="primaryWork.kind === 'claim'"
            variant="primary"
            :loading="Boolean(opening)"
            loading-label="正在打开…"
            :disabled="Boolean(opening)"
            @click="startProject(primaryWork.queue)"
          >
            开始校对<AppIcon name="arrow" />
          </AppButton>
          <RouterLink
            v-else-if="!resumeNameError || primaryWork.kind !== 'resume'"
            :to="primaryWork.to"
            class="btn btn-primary workbench-primary-link"
          >
            {{ primaryWork.label }}<AppIcon name="arrow" />
          </RouterLink>
        </template>
        <template v-else-if="workPending">
          <AppStatusPanel state="pending" message="正在读取当前工作…" />
        </template>
        <template v-else-if="queueError || (canManage && managedError)">
          <div class="workbench-start__copy">
            <h2 id="workbench-start-title">工作信息暂未更新</h2>
            <p class="workbench-start__detail">可以重试读取，或从下方已加载的项目继续。</p>
          </div>
        </template>
        <template v-else>
          <div class="workbench-start__copy">
            <h2 id="workbench-start-title">从项目开始下一项工作</h2>
            <p class="workbench-start__detail">
              {{
                recentProjects.length
                  ? '选择一个项目，查看任务与当前进展。'
                  : '加入或创建项目后，当前工作会出现在这里。'
              }}
            </p>
          </div>
          <RouterLink
            :to="
              !recentProjects.length && auth.canCreateProjects
                ? '/admin/projects/new'
                : canManage
                  ? '/admin'
                  : '/projects'
            "
            class="btn btn-primary workbench-primary-link"
          >
            {{
              !recentProjects.length && auth.canCreateProjects
                ? '创建项目'
                : canManage
                  ? '查看项目'
                  : '浏览可加入项目'
            }}<AppIcon name="arrow" />
          </RouterLink>
        </template>
      </section>
      <section
        v-if="remainingAttention.length"
        class="workbench-section workbench-attention"
        aria-labelledby="attention-title"
      >
        <div class="section-heading">
          <h2 id="attention-title">需要你的判断</h2>
        </div>
        <ul class="workbench-list">
          <li v-for="item in remainingAttention" :key="item.project.id">
            <RouterLink
              :to="`/admin/projects/${item.project.id}?section=work&status=arbitration`"
              class="workbench-row"
            >
              <div class="workbench-row__body">
                <h3>{{ item.project.name }}</h3>
                <ProjectPurposeBadge :purpose="item.project.purpose" />
                <p>仲裁差异字段</p>
              </div>
              <span class="workbench-attention-count"
                ><strong>{{ item.summary.arbitration }}</strong
                ><span>条待仲裁</span></span
              >
              <AppIcon name="arrow" />
            </RouterLink>
          </li>
        </ul>
      </section>
      <section
        v-if="recentProjects.length || workPending"
        class="workbench-section workbench-project-section"
        aria-labelledby="recent-projects-title"
      >
        <div class="section-heading">
          <h2 id="recent-projects-title">{{ canManage ? '项目进展' : '参与的项目' }}</h2>
          <div class="workbench-inline-actions">
            <RouterLink to="/projects?view=mine">全部项目</RouterLink>
            <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new"
              ><AppIcon name="plus" />创建项目</RouterLink
            >
          </div>
        </div>
        <AppStatusPanel
          v-if="workPending && !recentProjects.length"
          state="pending"
          message="正在读取项目…"
        />
        <ul v-else-if="recentProjects.length" class="workbench-projects">
          <li v-for="project in recentProjects" :key="project.id">
            <RouterLink
              :to="
                project.managed ? `/admin/projects/${project.id}` : `/tasks?project=${project.id}`
              "
              class="workbench-project"
            >
              <span class="workbench-project__name"
                ><AppIcon name="project" /><span
                  ><strong>{{ project.name }}</strong
                  ><ProjectPurposeBadge :purpose="project.purpose" /><small>{{
                    project.managed ? '管理项目' : '参与校对'
                  }}</small></span
                ></span
              >
              <span v-if="project.summary" class="workbench-project__progress"
                ><span>校对完成</span
                ><strong
                  >{{ project.summary.approved ?? '—' }}
                  <span>/ {{ project.summary.total ?? '—' }}</span></strong
                ></span
              >
              <span v-else-if="project.queue" class="workbench-project__progress"
                ><span>可领取</span
                ><strong>{{ project.queue.claimable ?? '—' }} <span>条</span></strong></span
              >
              <AppIcon name="arrow" />
            </RouterLink>
          </li>
        </ul>
        <p v-else-if="!queueError && !managedError" class="workbench-empty">
          还没有已参与的项目。<RouterLink to="/projects">浏览可加入项目 →</RouterLink>
        </p>
      </section>
      <div class="workbench-shortcuts">
        <RouterLink v-if="auth.hasProofreadingProjects || !canManage" to="/tasks/problems"
          >问题与草稿<AppIcon name="arrow"
        /></RouterLink>
        <RouterLink v-if="auth.hasProofreadingProjects || !canManage" to="/tasks"
          >我的任务<AppIcon name="arrow"
        /></RouterLink>
      </div>
    </template>
  </main>
</template>
<script setup>
import ProjectPurposeBadge from '@/components/ProjectPurposeBadge.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { measureBusiness } from '@/lib/businessMetrics'
import { RouterLink, useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import AppButton from '@/components/AppButton.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { useAuthStore } from '@/stores/auth'
import { getProject, listProjectInsights } from '@/services/projectsService'
import { claimNextProjectPage, listProjectQueueSummaries } from '@/services/pagesService'
import { currentUserId } from '@/services/authService'
import { loadRecentWork, resumeWork } from '@/lib/workbenchNavigation'
import { browserLocalStorage } from '@/lib/onboarding'
import { saveTaskLease, saveGlyphQueue } from '@/lib/taskLease'
import { getPbMessage } from '@/utils/pbErrors'
const auth = useAuthStore()
const router = useRouter()
const opening = ref('')
const actionError = ref('')
const accessReady = ref(false)
const managedRequired = ref(false)
const recent = loadRecentWork(browserLocalStorage(), auth.user?.id)
let active = true
onBeforeUnmount(() => {
  active = false
})
const {
  pending: accessPending,
  error: accessError,
  reload: reloadAccess
} = useAsyncResource(({ signal }) => auth.loadAccessContext({ force: true, signal }), {
  formatError: (cause) => getPbMessage(cause, '暂时无法读取项目权限。')
})
const {
  data: queueData,
  pending: queuePending,
  error: queueError,
  reload: reloadQueues
} = useAsyncResource(({ signal }) => listProjectQueueSummaries(1, 6, { signal }), {
  formatError: (cause) => getPbMessage(cause, '暂时无法读取校对任务。')
})
const {
  data: managedData,
  pending: managedPending,
  error: managedError,
  reload: reloadManaged
} = useAsyncResource(({ signal }) => listProjectInsights({ perPage: 6 }, { signal }), {
  formatError: (cause) => getPbMessage(cause, '暂时无法读取项目待办。')
})
const loading = computed(() => accessPending.value || queuePending.value || managedPending.value)
const workspaceStartedAt = performance.now()
let workspaceTimingReported = false
let workspaceDisposed = false
// Access and queue reads are always required; management data is required only
// when the successful access response selected that reader for this page.
const workspaceReady = computed(
  () =>
    accessReady.value &&
    !loading.value &&
    !accessError.value &&
    !queueError.value &&
    queueData.value !== null &&
    (!managedRequired.value || (!managedError.value && managedData.value !== null))
)
onBeforeUnmount(() => {
  workspaceDisposed = true
})
watch(workspaceReady, async (ready) => {
  if (!ready || workspaceTimingReported) return
  await nextTick()
  requestAnimationFrame(() => {
    if (!workspaceReady.value || workspaceTimingReported || workspaceDisposed || document.hidden)
      return
    workspaceTimingReported = true
    measureBusiness('workspace_ready', performance.now() - workspaceStartedAt)
  })
})

const canManage = computed(() => auth.isPlatformAdmin || auth.hasManagedProjects)
const queues = computed(() => queueData.value?.items || [])
const attention = computed(() =>
  (managedData.value?.items || []).filter((item) => item.summary.arbitration > 0)
)
const resume = computed(() =>
  resumeWork(recent, queues.value, auth.accessContext, auth.isPlatformAdmin)
)
const available = computed(() => queues.value.find((queue) => queue.nextPage))
const recentProjects = computed(() => {
  const items = new Map(
    queues.value.map((queue) => [queue.project.id, { ...queue.project, queue }])
  )
  for (const item of managedData.value?.items || [])
    items.set(item.project.id, {
      ...items.get(item.project.id),
      ...item.project,
      managed: true,
      summary: item.summary
    })
  const order = recent.map((item) => item.projectId)
  return [...items.values()]
    .sort(
      (a, b) =>
        (order.indexOf(a.id) < 0 ? 100 : order.indexOf(a.id)) -
        (order.indexOf(b.id) < 0 ? 100 : order.indexOf(b.id))
    )
    .slice(0, 6)
})
const knownResumeProjectName = computed(
  () =>
    resume.value?.project.name ||
    recentProjects.value.find((project) => project.id === resume.value?.project.id)?.name ||
    ''
)
const resumeProjectToRead = computed(() =>
  resume.value && !knownResumeProjectName.value ? resume.value.project.id : ''
)
const {
  data: resumeProjectData,
  error: resumeProjectError,
  reload: reloadResumeProject,
  cancel: cancelResumeProject
} = useAsyncResource(
  async ({ signal }, id) => {
    const project = await getProject(id, { signal })
    if (!project.capabilities?.canManage)
      throw new Error('已无法管理上次的项目，请从当前项目清单继续。')
    return { id, project }
  },
  {
    formatError: (cause) => getPbMessage(cause, '上次项目暂时无法读取，请重新核对访问权限后重试。')
  }
)
function readResumeProject() {
  if (resumeProjectToRead.value) return reloadResumeProject(resumeProjectToRead.value)
}
watch(
  resumeProjectToRead,
  (id) => {
    if (id) void reloadResumeProject(id)
    else cancelResumeProject()
  },
  { immediate: true }
)
const resumeNameError = computed(() => (resumeProjectToRead.value ? resumeProjectError.value : ''))
const resumeProjectName = computed(
  () =>
    knownResumeProjectName.value ||
    (resumeProjectData.value?.id === resume.value?.project.id
      ? resumeProjectData.value.project.name
      : '') ||
    (resumeNameError.value ? '上次项目暂不可用' : '正在读取项目…')
)
const resumeContext = computed(() => {
  const work = resume.value
  if (!work) return ''
  if (work.path.startsWith('/tasks/')) return work.detail
  if (work.path.includes('/arbitration/')) return '差异仲裁'
  if (work.path.includes('/verification')) return '来源复核'
  if (work.path.includes('/adoption')) return '用途编选'
  if (work.path.includes('/deliveries')) return '交付与回执'
  if (work.path.includes('/settings')) return '项目设置'
  return '项目工作区'
})
const primaryWork = computed(() => {
  if (resume.value)
    return {
      kind: 'resume',
      projectId: resume.value.project.id,
      projectName: resumeProjectName.value,
      context: resume.value.path.startsWith('/tasks/') ? '当前校对' : '上次工作',
      detail: resumeContext.value,
      to: resume.value.path,
      label: resume.value.label
    }
  const pending = canManage.value ? attention.value[0] : null
  if (pending)
    return {
      kind: 'arbitration',
      projectId: pending.project.id,
      projectName: pending.project.name,
      context: '需要你的判断',
      detail: `${pending.summary.arbitration} 条待仲裁 · 逐字段核对差异，确定最终结果`,
      to: `/admin/projects/${pending.project.id}?section=work&status=arbitration`,
      label: '处理仲裁'
    }
  if (available.value)
    return {
      kind: 'claim',
      projectId: available.value.project.id,
      projectName: available.value.project.name,
      context: '可领取任务',
      detail: `第 ${available.value.nextPage.page_number || '—'} 条 · ${available.value.claimable} 条可领取`,
      queue: available.value
    }
  return null
})
const remainingAttention = computed(() =>
  attention.value.filter(
    (item) =>
      primaryWork.value?.kind !== 'arbitration' || item.project.id !== primaryWork.value.projectId
  )
)
const workPending = computed(() => queuePending.value || (canManage.value && managedPending.value))
onMounted(refresh)
async function refresh() {
  const access = await reloadAccess()
  if (!access.ok) return
  managedRequired.value = Boolean(auth.isPlatformAdmin || access.data?.managedProjectIds?.length)
  accessReady.value = true
  const reads = [reloadQueues()]
  // A concurrent shell refresh may own the store's publication generation.
  // This successful response still tells this page which readers it needs.
  if (managedRequired.value) reads.push(reloadManaged())
  await Promise.allSettled(reads)
}
async function startProject(queue) {
  if (!queue?.nextPage || opening.value) return
  const userId = currentUserId(auth.user),
    requestToken = auth.token
  opening.value = queue.project.id
  actionError.value = ''
  try {
    const page = await claimNextProjectPage(queue.project.id, userId)
    if (!active || currentUserId(auth.user) !== userId || auth.token !== requestToken) return
    if (!page?.id) {
      actionError.value = '这条任务已被领取，请刷新任务后重试。'
      await reloadQueues()
      return
    }
    saveTaskLease(window.sessionStorage, {
      userId,
      pageId: page.id,
      token: page.leaseToken,
      expiresAt: page.leaseExpiresAt
    })
    saveGlyphQueue(window.sessionStorage, { userId, projectId: queue.project.id, glyph: false })
    await router.push(`/tasks/${page.id}/edit`)
  } catch (cause) {
    if (!active || currentUserId(auth.user) !== userId || auth.token !== requestToken) return
    actionError.value = getPbMessage(cause, '暂时无法领取任务，输入和现有草稿不会受影响。')
  } finally {
    if (active) opening.value = ''
  }
}
</script>
