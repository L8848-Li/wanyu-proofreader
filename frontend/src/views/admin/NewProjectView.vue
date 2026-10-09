<template>
  <div class="container page" style="max-width:640px">
    <div class="flex items-center gap-3 mb-6">
      <RouterLink to="/admin" class="btn btn-secondary btn-sm">← 返回</RouterLink>
      <h2 class="font-bold" style="font-size:1.5rem">创建新项目</h2>
    </div>

    <div class="alert mb-4" role="note">
      <strong>创建后如何准备文件？</strong>
      <p class="text-sm mt-2">
        可仅上传 PDF（只提供原文预览）、仅导入 CSV（可校对但没有原文预览），
        或先上传 PDF 再预检 CSV（推荐，条目会固定关联预检时的 PDF）。
      </p>
      <RouterLink class="text-sm" to="/admin/guide/project-files">
        查看完整的 PDF、CSV 和校对页面说明
      </RouterLink>
    </div>

    <div class="card">
      <div v-if="checkingPermission" class="text-muted">正在检查创建权限…</div>
      <div v-else-if="!auth.canCreateProjects" class="alert alert-error" role="alert">
        你当前没有可用的项目创建额度。请联系平台管理员授权或调整额度。
      </div>
      <form v-else @submit.prevent="handleSubmit">
        <div v-if="auth.accessContext?.projectLimit != null" class="alert mb-4" role="status">
          当前拥有 {{ auth.accessContext.ownedProjectCount }} 个项目，还可创建 {{ auth.accessContext.remainingProjects }} 个。
        </div>
        <div class="form-group">
          <label class="form-label">项目名称 <span style="color:var(--danger)">*</span></label>
          <input v-model="form.name" type="text" class="form-control" placeholder="如：《莆田方言词典》校对项目" required />
        </div>
        <fieldset class="access-mode-grid mb-4">
          <legend class="form-label">访问方式</legend>
          <label v-for="mode in accessModes" :key="mode.value" class="access-mode-option" :class="{ 'is-selected': form.accessMode === mode.value }">
            <input v-model="form.accessMode" type="radio" :value="mode.value" />
            <span><strong>{{ mode.label }}</strong><small>{{ mode.description }}</small></span>
          </label>
        </fieldset>
        <div v-if="form.accessMode === 'password'" class="form-group">
          <label class="form-label">项目口令</label>
          <input v-model="form.password" type="password" class="form-control" minlength="8" maxlength="72" required autocomplete="new-password" placeholder="至少 8 个字符，UTF-8 编码最多 72 字节" />
        </div>
        <div class="form-group">
          <label class="form-label">项目简介</label>
          <textarea v-model="form.description" class="form-control" placeholder="简要介绍本项目的背景、目标等（可选）"></textarea>
        </div>

        <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
        <div v-if="success" class="alert alert-success" role="status">项目创建成功！即将跳转...</div>

        <div class="flex gap-3">
          <button type="submit" class="btn btn-primary" :disabled="loading">
            {{ loading ? '创建中...' : '创建项目' }}
          </button>
          <RouterLink to="/admin" class="btn btn-secondary">取消</RouterLink>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { createProject } from '@/services/projectsService'
import { getPbMessage } from '@/utils/pbErrors'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
const loading = ref(false)
const checkingPermission = ref(true)
const error = ref('')
const success = ref(false)

const form = ref({ name: '', description: '', accessMode: 'members_only', password: '' })
const accessModes = [
  { value: 'members_only', label: '指定成员', description: '默认选项，只有管理员指定的成员可以进入。' },
  { value: 'public', label: '公开加入', description: '任意已登录用户可以加入并成为校对员。' },
  { value: 'password', label: '口令加入', description: '输入正确项目口令后成为持久成员。' }
]

onMounted(async () => {
  try { await auth.loadAccessContext({ force: true }) }
  catch (e) { error.value = getPbMessage(e, '无法检查项目创建权限。') }
  finally { checkingPermission.value = false }
})

async function handleSubmit() {
  loading.value = true
  error.value = ''
  try {
    const project = await createProject({
      name: form.value.name,
      description: form.value.description,
      accessMode: form.value.accessMode,
      password: form.value.password
    })
    await auth.loadAccessContext({ force: true })
    success.value = true
    setTimeout(() => router.push(`/admin/projects/${project.id}`), 1200)
  } catch (e) {
    error.value = getPbMessage(e, '创建失败，请重试')
  } finally {
    loading.value = false
  }
}
</script>
