<template>
  <div class="auth-container">
    <div class="auth-card">
      <div class="auth-logo">
        <h1>万语校坊</h1>
        <p>注册新账号</p>
      </div>

      <form @submit.prevent="handleRegister">
        <div class="form-group">
          <label class="form-label">姓名 / 昵称</label>
          <input v-model="name" type="text" class="form-control" placeholder="请输入姓名" required />
        </div>
        <div class="form-group">
          <label class="form-label">邮箱</label>
          <input v-model="email" type="email" class="form-control" placeholder="请输入邮箱" required />
        </div>
        <div class="form-group">
          <label class="form-label">密码</label>
          <input v-model="password" type="password" class="form-control" placeholder="至少8位" required minlength="8" />
        </div>
        <div class="form-group">
          <label class="form-label">确认密码</label>
          <input v-model="passwordConfirm" type="password" class="form-control" placeholder="再次输入密码" required />
        </div>

        <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
        <div v-if="success" class="alert alert-success" role="status">注册成功！正在跳转到登录页...</div>

        <button type="submit" class="btn btn-primary btn-block btn-lg" :disabled="loading">
          {{ loading ? '注册中...' : '注册' }}
        </button>
      </form>

      <p class="text-center mt-4 text-sm text-muted">
        已有账号？
        <RouterLink to="/login">直接登录</RouterLink>
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
const name = ref('')
const email = ref('')
const password = ref('')
const passwordConfirm = ref('')
const loading = ref(false)
const error = ref('')
const success = ref(false)

async function handleRegister() {
  error.value = ''
  if (password.value !== passwordConfirm.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  loading.value = true
  try {
    await auth.register(email.value, password.value, passwordConfirm.value, name.value)
    success.value = true
    setTimeout(() => router.push('/login'), 1500)
  } catch (e) {
    error.value = e?.response?.message || '注册失败，请检查填写的信息'
  } finally {
    loading.value = false
  }
}
</script>
