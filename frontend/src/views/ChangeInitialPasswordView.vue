<template>
  <div class="auth-container">
    <div class="auth-card">
      <div class="auth-logo">
        <div class="page-eyebrow">账号安全</div>
        <h1>首次登录，请修改密码</h1>
        <p>初始密码只用于本次登录。设置自己的密码后才能领取或提交校对任务。</p>
      </div>

      <form @submit.prevent="submit">
        <label class="form-group">
          <span class="form-label">当前初始密码</span>
          <input v-model="form.currentPassword" type="password" class="form-control" autocomplete="current-password" required />
        </label>
        <label class="form-group">
          <span class="form-label">新密码</span>
          <input v-model="form.newPassword" type="password" class="form-control" autocomplete="new-password" minlength="10" maxlength="200" required />
          <small class="text-muted">至少 10 个字符，请勿继续使用初始密码。</small>
        </label>
        <label class="form-group">
          <span class="form-label">确认新密码</span>
          <input v-model="form.newPasswordConfirm" type="password" class="form-control" autocomplete="new-password" minlength="10" maxlength="200" required />
        </label>
        <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
        <button class="btn btn-primary btn-block btn-lg" :disabled="saving || !canSubmit">
          {{ saving ? '正在更新…' : '更新密码并重新登录' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { changeInitialPassword } from '@/services/authService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const router = useRouter()
const auth = useAuthStore()
const saving = ref(false)
const error = ref('')
const form = reactive({ currentPassword: '', newPassword: '', newPasswordConfirm: '' })
const canSubmit = computed(() => (
  form.currentPassword &&
  form.newPassword.length >= 10 &&
  form.newPassword === form.newPasswordConfirm
))

async function submit() {
  if (!canSubmit.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await changeInitialPassword(form)
    auth.logout()
    await router.replace({ path: '/login', query: { passwordChanged: '1' } })
  } catch (e) {
    error.value = getPbMessage(e, '密码更新失败，请检查当前密码后重试。')
  } finally {
    saving.value = false
  }
}
</script>
