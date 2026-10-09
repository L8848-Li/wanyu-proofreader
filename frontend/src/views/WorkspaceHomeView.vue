<template>
  <div>
    <AppNavbar>
      <template #nav-links>
        <RouterLink to="/workspace" class="nav-link active">工作台</RouterLink>
        <RouterLink to="/projects" class="nav-link">发现项目</RouterLink>
      </template>
    </AppNavbar>
    <main class="container page workspace-page">
      <header class="page-heading">
        <div>
          <div class="page-eyebrow">我的万语校坊工作台</div>
          <h1>{{ greeting }}，今天从哪项工作开始？</h1>
          <p>入口只按你当前拥有的能力显示；不同项目可以承担不同职责。</p>
        </div>
        <button class="btn btn-secondary" :disabled="loading" @click="refresh">
          {{ loading ? '正在刷新' : '刷新权限' }}
        </button>
      </header>

      <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
      <div v-if="loading" class="card text-muted">正在读取项目权限…</div>
      <section v-else class="capability-grid" aria-label="可用工作入口">
        <RouterLink v-if="canManage" to="/admin" class="capability-card capability-card--manage">
          <span class="capability-card__mark" aria-hidden="true">管</span>
          <div><h2>项目管理</h2><p>查看项目进度、准备文件、处理仲裁和配置成员。</p></div>
          <strong>{{ managedCount }} 个项目 →</strong>
        </RouterLink>
        <RouterLink v-if="auth.hasProofreadingProjects" to="/tasks" class="capability-card capability-card--proofread">
          <span class="capability-card__mark" aria-hidden="true">校</span>
          <div><h2>材料校对</h2><p>进入独立校对队列，只关注材料原文和当前判断。</p></div>
          <strong>{{ proofreadingCount }} 个项目 →</strong>
        </RouterLink>
        <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new" class="capability-card">
          <span class="capability-card__mark" aria-hidden="true">新</span>
          <div><h2>创建项目</h2><p>{{ creationHint }}</p></div>
          <strong>开始创建 →</strong>
        </RouterLink>
        <RouterLink v-if="auth.isPlatformAdmin" to="/admin/creator-grants" class="capability-card">
          <span class="capability-card__mark" aria-hidden="true">权</span>
          <div><h2>创建权限</h2><p>向普通用户开放项目创建权限，并设置可选额度。</p></div>
          <strong>管理白名单 →</strong>
        </RouterLink>
        <RouterLink to="/projects" class="capability-card">
          <span class="capability-card__mark" aria-hidden="true">寻</span>
          <div><h2>发现项目</h2><p>查看开放加入的项目，或用项目口令加入。</p></div>
          <strong>浏览项目 →</strong>
        </RouterLink>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppNavbar from '@/components/AppNavbar.vue'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const auth = useAuthStore()
const loading = ref(true)
const error = ref('')
const managedCount = computed(() => auth.accessContext?.managedProjectIds?.length || 0)
const proofreadingCount = computed(() => auth.accessContext?.proofreadingProjectIds?.length || 0)
const canManage = computed(() => auth.isPlatformAdmin || auth.hasManagedProjects)
const greeting = computed(() => auth.user?.name || auth.user?.username || '你好')
const creationHint = computed(() => {
  const context = auth.accessContext
  if (context?.projectLimit == null) return '你的创建权限不限量。'
  return `当前还可创建 ${context.remainingProjects} 个项目。`
})

onMounted(refresh)

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    await auth.loadAccessContext({ force: true })
  } catch (e) {
    error.value = getPbMessage(e, '暂时无法读取项目权限。')
  } finally {
    loading.value = false
  }
}
</script>
