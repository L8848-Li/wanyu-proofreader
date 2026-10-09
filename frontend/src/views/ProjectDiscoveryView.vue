<template>
  <div>
    <AppNavbar>
      <template #nav-links>
        <RouterLink to="/workspace" class="nav-link">工作台</RouterLink>
        <RouterLink to="/projects" class="nav-link active">发现项目</RouterLink>
      </template>
    </AppNavbar>
    <main class="container page workspace-page">
      <header class="page-heading">
        <div>
          <div class="page-eyebrow">项目目录</div>
          <h1>找到适合参与的方言材料</h1>
          <p>公开项目可直接加入；带口令的项目验证一次后会保留成员身份。</p>
        </div>
        <button class="btn btn-secondary" :disabled="loading" @click="loadProjects">刷新</button>
      </header>
      <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
      <div v-if="loading" class="card text-muted">正在加载项目…</div>
      <div v-else-if="projects.length === 0" class="empty-state card">
        <div class="empty-state-mark" aria-hidden="true">项</div>
        <div class="empty-state-text">目前没有可发现的项目</div>
        <p>指定成员项目不会出现在这里，请联系项目管理员添加。</p>
      </div>
      <section v-else class="project-card-grid">
        <article v-for="project in projects" :key="project.id" class="project-work-card">
          <header class="project-work-card__header">
            <div><span class="work-state">{{ accessLabel(project) }}</span><h3>{{ project.name }}</h3></div>
          </header>
          <p class="project-description">{{ project.description || '该项目暂未填写简介。' }}</p>
          <div v-if="project.capabilities.isMember || project.capabilities.isPlatformAdmin" class="alert alert-success" role="status">
            已拥有{{ roleLabel(project.capabilities.projectRole) }}权限
          </div>
          <label v-else-if="project.access_mode === 'password'" class="form-group">
            <span class="form-label">项目口令</span>
            <input v-model="passwords[project.id]" type="password" class="form-control" maxlength="72" autocomplete="off" placeholder="输入项目管理员提供的口令" />
          </label>
          <footer class="project-work-card__footer">
            <span>{{ project.access_mode === 'members_only' ? '由项目管理员指定成员' : '加入后成为项目校对员' }}</span>
            <RouterLink v-if="project.capabilities.canManage" :to="`/admin/projects/${project.id}`" class="btn btn-secondary">管理项目</RouterLink>
            <RouterLink v-else-if="project.capabilities.canProofread" to="/tasks" class="btn btn-secondary">进入校对</RouterLink>
            <button v-else class="btn btn-primary" :disabled="joining === project.id" @click="join(project)">
              {{ joining === project.id ? '正在加入…' : '加入项目' }}
            </button>
          </footer>
        </article>
      </section>
    </main>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppNavbar from '@/components/AppNavbar.vue'
import { joinProject, listProjects } from '@/services/projectsService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const auth = useAuthStore()
const projects = ref([])
const passwords = ref({})
const joining = ref('')
const loading = ref(true)
const error = ref('')

onMounted(loadProjects)

async function loadProjects() {
  loading.value = true
  error.value = ''
  try { projects.value = await listProjects({ scope: 'discoverable' }) }
  catch (e) { error.value = getPbMessage(e, '项目目录加载失败。') }
  finally { loading.value = false }
}

async function join(project) {
  joining.value = project.id
  error.value = ''
  try {
    await joinProject(project.id, passwords.value[project.id] || '')
    passwords.value[project.id] = ''
    await Promise.all([loadProjects(), auth.loadAccessContext({ force: true })])
  } catch (e) {
    error.value = getPbMessage(e, '加入项目失败。')
  } finally {
    joining.value = ''
  }
}

function accessLabel(project) {
  return ({ public: '公开加入', password: '口令加入', members_only: '指定成员' })[project.access_mode] || '指定成员'
}

function roleLabel(role) {
  return ({ owner: '所有者', manager: '管理员', proofreader: '校对员' })[role] || '平台管理'
}
</script>
