<template>
  <div class="container page">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="font-bold" style="font-size:1.5rem">个人中心</h2>
        <p class="text-sm text-muted mt-1">管理个人资料，查看校对参与情况与当前排行</p>
      </div>
      <button class="btn btn-secondary btn-sm" @click="loadStats" :disabled="loading">
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <section class="card mb-6" aria-labelledby="profile-details-title">
      <h3 id="profile-details-title" class="card-title">个人资料</h3>
      <UserAvatar :user="auth.user" style="width:4rem;height:4rem;margin-bottom:1rem" />
      <form @submit.prevent="saveProfile">
        <div class="form-group">
          <label for="profile-name" class="form-label">昵称</label>
          <input id="profile-name" v-model="profile.name" class="form-control" autocomplete="nickname" required :disabled="savingProfile" />
        </div>
        <div class="form-group">
          <label for="profile-email" class="form-label">邮箱（选填）</label>
          <input id="profile-email" v-model.trim="profile.email" class="form-control" type="email" autocomplete="email" maxlength="255" :disabled="savingProfile" />
          <p class="text-sm text-muted mt-1">修改邮箱后将标记为未验证。个人资料仅保存在万语校坊，不会修改外部账号。</p>
        </div>
        <div v-if="profileError" class="alert alert-error mb-4" role="alert">{{ profileError }}</div>
        <div v-if="profileSuccess" class="alert alert-success mb-4" role="status">{{ profileSuccess }}</div>
        <button type="submit" class="btn btn-primary" :disabled="savingProfile || !profile.name.trim()">{{ savingProfile ? '保存中...' : '保存资料' }}</button>
      </form>
    </section>

    <section class="card mb-6" aria-labelledby="onboarding-title">
      <h3 id="onboarding-title" class="card-title">新手引导</h3>
      <p class="text-sm text-muted mb-4">第一次进入校对编辑器时会看到分步说明。跳过或完成后不会再自动弹出。</p>
      <button type="button" class="btn btn-secondary" @click="replayOnboarding">重看新手引导</button>
    </section>

    <div v-if="error" class="alert alert-error mb-4" role="alert">
      <p>{{ error }}</p>
      <p v-if="stats" class="text-sm">下方保留上次成功加载的统计，可能不是最新结果。</p>
      <p v-else class="text-sm">暂时无法显示统计；这不代表你的校对记录为零。</p>
      <button class="btn btn-secondary btn-sm mt-3" :disabled="loading" @click="loadStats">重试统计</button>
    </div>
    <div v-if="loading && !stats" class="text-muted" role="status">正在加载统计…</div>

      <section class="profile-hero mb-6">
        <div>
          <div class="text-sm text-muted">账户名称</div>
          <div class="profile-name">{{ displayName }}</div>
        </div>
        <div v-if="stats" class="profile-rank">
          <span>一致率排行</span>
          <strong>{{ rankLabel(stats.accuracyRank) }}</strong>
        </div>
        <div v-if="stats" class="profile-rank">
          <span>条目排行</span>
          <strong>{{ rankLabel(stats.proofreadRank) }}</strong>
        </div>
      </section>

      <section v-if="stats" class="profile-stats" aria-label="校对统计">
        <div class="stat-card">
          <div class="stat-value">{{ stats.projectCount }}</div>
          <div class="stat-label">参加项目数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.proofreadCount }}</div>
          <div class="stat-label">已校对条目</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ accuracyLabel }}</div>
          <div class="stat-label">结果一致率</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.correctCount }}</div>
          <div class="stat-label">结果一致的校对次数</div>
        </div>
      </section>

      <section v-if="providers.length" class="card mt-6">
        <div class="card-title">统一身份绑定</div>
        <p class="profile-note mb-4">绑定后可以使用外部账号登录万语校坊。登录或绑定时会尝试补齐昵称、邮箱和头像，保留你已填写的资料。同步的邮箱仍需验证；资料服务暂时不可用不影响登录。</p>
        <div class="identity-list">
          <div v-for="provider in providers" :key="provider.id" class="identity-card">
            <div class="identity-heading">
              <strong>{{ provider.name }}</strong>
              <span class="identity-state" :class="{ bound: provider.bound }">{{ provider.bound ? '已绑定' : '未绑定' }}</span>
            </div>
            <template v-if="!provider.bound">
              <div class="identity-fields">
                <input
                  v-model.trim="credentials[provider.id].identity"
                  class="form-control"
                  type="text"
                  :placeholder="`${provider.name}账号`"
                  autocomplete="username"
                  :disabled="bindingProvider === provider.id"
                />
                <input
                  v-model="credentials[provider.id].password"
                  class="form-control"
                  type="password"
                  placeholder="密码"
                  autocomplete="current-password"
                  :disabled="bindingProvider === provider.id"
                />
                <button
                  class="btn btn-primary"
                  :disabled="bindingProvider === provider.id || !canBind(provider.id)"
                  @click="bindProvider(provider)"
                >{{ bindingProvider === provider.id ? '验证中...' : '验证并绑定' }}</button>
              </div>
              <div v-if="bindingError[provider.id]" class="alert alert-error mt-3" role="alert">{{ bindingError[provider.id] }}</div>
            </template>
          </div>
        </div>
      </section>

      <div class="card mt-6">
        <div class="card-title">排行说明</div>
        <div class="profile-note">
          一致率按已完成系统比对的校对尝试计算；仍在等待其他独立结果的提交暂不进入分母。不一致记录会永久保留并计入统计。
        </div>
      </div>
  </div>
</template>

<script setup>
import UserAvatar from '@/components/UserAvatar.vue'
import { computed, inject, onMounted, reactive, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { bindExternalIdentity, currentUserId, listExternalProviders, updateProfile } from '@/services/authService'
import { getProofreaderProfileStats } from '@/services/proofreaderStatsService'
import { formatPbError } from '@/utils/pbErrors'

const auth = useAuthStore()
const profile = reactive({ name: auth.user?.name || '', email: auth.user?.email || '' })
const savingProfile = ref(false)
const profileError = ref('')
const profileSuccess = ref('')

async function saveProfile() {
  if (savingProfile.value) return
  profileError.value = ''
  profileSuccess.value = ''
  if (!profile.name.trim() || Array.from(profile.name.trim()).length > 255) {
    profileError.value = '昵称不能为空且不能超过 255 个字符'
    return
  }
  savingProfile.value = true
  try {
    const record = await updateProfile({ name: profile.name.trim(), email: profile.email.trim() })
    profile.name = record.name || ''
    profile.email = record.email || ''
    profileSuccess.value = '个人资料已保存'
  } catch (e) {
    profileError.value = formatPbError('保存个人资料失败', e)
  } finally {
    savingProfile.value = false
  }
}

const loading = ref(false)
const error = ref('')
const providers = ref([])
const credentials = reactive({})
const bindingProvider = ref('')
const bindingError = reactive({})
const stats = ref(null)
const onboardingRef = inject('proofreaderOnboarding', ref(null))

const displayName = computed(() => auth.user?.name || auth.user?.email || auth.user?.username || '校对员')
const accuracyLabel = computed(() => stats.value?.evaluatedCount ? `${stats.value.accuracy}%` : '暂无已评估结果')

onMounted(async () => {
  await Promise.all([loadStats(), loadProviders()])
})

async function loadProviders() {
  try {
    providers.value = await listExternalProviders()
    for (const provider of providers.value) {
      credentials[provider.id] ||= { identity: '', password: '' }
      bindingError[provider.id] = ''
    }
  } catch {
    providers.value = []
  }
}

function canBind(providerId) {
  const entry = credentials[providerId]
  return Boolean(entry?.identity?.trim() && entry?.password)
}

async function bindProvider(provider) {
  if (!canBind(provider.id) || bindingProvider.value) return
  bindingProvider.value = provider.id
  bindingError[provider.id] = ''
  try {
    const entry = credentials[provider.id]
    const before = { name: auth.user?.name || '', email: auth.user?.email || '' }
    await bindExternalIdentity(provider.id, entry.identity.trim(), entry.password)
    // Refresh untouched fields without discarding an in-progress local edit.
    if (profile.name === before.name) profile.name = auth.user?.name || ''
    if (profile.email === before.email) profile.email = auth.user?.email || ''
    entry.identity = ''
    entry.password = ''
    provider.bound = true
  } catch (e) {
    bindingError[provider.id] = e?.response?.message || '绑定失败，请检查外部账号和密码'
  } finally {
    bindingProvider.value = ''
  }
}

async function loadStats() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const userId = currentUserId(auth.user)
    if (!userId) throw new Error('登录状态已失效，请重新登录')
    stats.value = await getProofreaderProfileStats(userId)
  } catch (e) {
    error.value = formatPbError('统计暂时无法加载', e)
  } finally {
    loading.value = false
  }
}

function rankLabel(rank) {
  return rank ? `第 ${rank} 名` : '暂无'
}

function replayOnboarding() {
  onboardingRef.value?.reopen()
}
</script>

<style scoped>
.profile-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 1rem;
  align-items: center;
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 1.5rem;
}

.profile-name {
  margin-top: .35rem;
  font-size: 1.7rem;
  font-weight: 700;
  color: var(--gray-900);
  overflow-wrap: anywhere;
}

.profile-rank {
  min-width: 130px;
  padding: .85rem 1rem;
  border: 1px solid var(--gray-200);
  border-radius: var(--radius);
  background: var(--gray-50);
}

.profile-rank span {
  display: block;
  font-size: .82rem;
  color: var(--gray-500);
  margin-bottom: .25rem;
}

.profile-rank strong {
  font-size: 1.15rem;
  color: var(--primary);
}

.profile-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
}

.profile-note {
  color: var(--gray-600);
  line-height: 1.7;
}

.identity-list {
  display: grid;
  gap: 1rem;
}

.identity-card {
  padding: 1rem;
  border: 1px solid var(--gray-200);
  border-radius: var(--radius);
  background: var(--gray-50);
}

.identity-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.identity-state {
  padding: .2rem .55rem;
  border-radius: var(--radius-pill);
  color: var(--gray-600);
  background: var(--gray-200);
  font-size: .78rem;
}

.identity-state.bound {
  color: var(--success-ink-deep);
  background: var(--success-tint);
}

.identity-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: .75rem;
  margin-top: 1rem;
}

@media (max-width: 900px) {
  .profile-hero,
  .profile-stats {
    grid-template-columns: 1fr;
  }

  .identity-fields {
    grid-template-columns: 1fr;
  }
}
</style>
