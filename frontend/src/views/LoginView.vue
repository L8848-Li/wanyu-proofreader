<template>
  <div class="auth-container">
    <div class="auth-card">
      <div class="auth-logo">
        <h1>万语校坊</h1>
        <p>线上方言校对工坊</p>
      </div>

      <div v-if="providers.length" class="auth-methods" aria-label="登录方式">
        <button
          type="button"
          class="auth-method"
          :class="{ active: !selectedProviderId }"
          :disabled="loading"
          @click="selectProvider('')"
        >万语校坊账号</button>
        <button
          v-for="provider in providers"
          :key="provider.id"
          type="button"
          class="auth-method"
          :class="{ active: selectedProviderId === provider.id }"
          :disabled="loading"
          @click="selectProvider(provider.id)"
        >{{ provider.name }}</button>
      </div>

      <form @submit.prevent="handleLogin">
        <div class="form-group">
          <label class="form-label">{{ selectedProvider ? `${selectedProvider.name}账号` : '用户名或邮箱' }}</label>
          <input
            v-model.trim="email"
            type="text"
            class="form-control"
            :placeholder="selectedProvider ? `请输入${selectedProvider.name}账号` : '请输入用户名或邮箱'"
            autocomplete="username"
            :disabled="loading"
            required
          />
        </div>

        <div class="form-group">
          <label class="form-label">密码</label>
          <input
            v-model="password"
            type="password"
            class="form-control"
            placeholder="请输入密码"
            autocomplete="current-password"
            :disabled="loading"
            required
          />
        </div>

        <div v-if="success" class="alert alert-success" role="status">{{ success }}</div>
        <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>

        <button
          type="submit"
          class="btn btn-primary btn-block btn-lg"
          :disabled="loading || !canSubmit"
        >
          {{ loading ? '登录中...' : selectedProvider ? `通过 ${selectedProvider.name} 登录` : '登录' }}
        </button>
      </form>

      <p class="text-center mt-4 text-sm text-muted">
        还没有账号？
        <RouterLink to="/register">立即注册</RouterLink>
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listExternalProviders } from '@/services/authService'
import { useAuthStore } from '@/stores/auth'

const emit = defineEmits(['close'])

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')
const success = computed(() => route.query.passwordChanged === '1' ? '密码已更新，请使用新密码登录。' : '')
const providers = ref([])
const selectedProviderId = ref('')

const canSubmit = computed(() => email.value.trim() && password.value)
const selectedProvider = computed(() => providers.value.find((provider) => provider.id === selectedProviderId.value) || null)

async function redirectAfterLogin() {
  const target = typeof route.query.redirect === 'string' && route.query.redirect
    ? route.query.redirect
    : '/workspace'

  emit('close')

  if (router.currentRoute.value.fullPath !== target) {
    await router.push(target)
  }
}

onMounted(async () => {
  if (auth.isLoggedIn) {
    await redirectAfterLogin()
    return
  }
  try {
    providers.value = await listExternalProviders()
  } catch {
    // Local sign-in remains available when provider discovery is unavailable.
    providers.value = []
  }
})

function selectProvider(providerId) {
  selectedProviderId.value = providerId
  password.value = ''
  error.value = ''
}

async function handleLogin() {
  if (loading.value) return

  loading.value = true
  error.value = ''

  try {
    if (selectedProvider.value) {
      await auth.loginExternal(selectedProvider.value.id, email.value.trim(), password.value)
    } else {
      await auth.login(email.value.trim(), password.value)
    }
    password.value = ''
    await redirectAfterLogin()
  } catch (e) {
    error.value = e?.response?.message || (selectedProvider.value
      ? '外部账号登录失败，请检查账号和密码'
      : '登录失败，请检查用户名、邮箱或密码')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.auth-methods {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: .5rem;
  margin-bottom: 1.25rem;
  padding: .3rem;
  border-radius: var(--radius);
  background: var(--gray-100);
}

.auth-method {
  border: 0;
  border-radius: var(--radius-inset);
  padding: .65rem .75rem;
  color: var(--gray-600);
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.auth-method.active {
  color: var(--primary);
  background: var(--surface);
  box-shadow: 0 1px 4px var(--slate-shadow-soft);
  font-weight: 600;
}
</style>
