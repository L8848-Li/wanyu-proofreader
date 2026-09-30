<template>
  <main class="container page workspace-page">
    <header class="page-heading">
      <div>
        <RouterLink to="/admin" class="back-link">← 返回项目管理</RouterLink>
        <div class="page-eyebrow">权利登记</div>
        <h1>来源登记</h1>
        <p>一份来源是一份可以单独谈权利的材料。这里只记录人填的结论，不托管授权文件，也不自动放行下游用途。</p>
      </div>
    </header>
    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <div v-if="success" class="alert alert-success" role="status">{{ success }}</div>
    <section class="card mb-6">
      <div class="section-heading">
        <div>
          <h2>来源清单</h2>
          <p>未允许用途指还没登记、结论仍是未知，或已明确禁止的用途。任何未允许的用途都会被下游读成阻断，不会当成允许。</p>
        </div>
        <button class="btn btn-secondary" :disabled="loading" @click="load">刷新</button>
      </div>
      <div v-if="loading" class="text-muted">正在加载来源…</div>
      <div v-else-if="!items.length" class="empty-state">
        <div class="empty-state-text">还没有登记来源</div>
        <p>导入时可以不填来源。那样作业仍会成功，并标成 source:unknown，不会挡住现有校对。</p>
      </div>
      <div v-else class="table-wrapper">
        <table>
          <thead>
            <tr><th>来源</th><th>权利主体</th><th>状态</th><th>未允许用途</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td>
                <strong>{{ item.title }}</strong>
                <div class="text-sm text-muted"><code>{{ item.logical_id }}</code> · {{ originLabel(item.original_vs_derived) }} · {{ item.format || '未填格式' }}</div>
              </td>
              <td>{{ item.holder || '未填' }}</td>
              <td><span class="badge" :class="sourceStatusClass(item.status)">{{ statusLabel(item.status) }}</span></td>
              <td>{{ undecidedLabel(item) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="auth.isPlatformAdmin" class="card">
      <div class="section-heading">
        <div>
          <h2>登记一条来源</h2>
          <p>逻辑 ID 可留空，系统会按标题和格式生成。证据只记仓外位置，不要把授权文件贴进来。</p>
        </div>
      </div>
      <form class="settings-form" @submit.prevent="submitSource">
        <label class="form-group"><span class="form-label">标题</span><input v-model.trim="form.title" class="form-control" required maxlength="200" /></label>
        <label class="form-group"><span class="form-label">权利主体</span><input v-model.trim="form.holder" class="form-control" maxlength="200" /></label>
        <label class="form-group"><span class="form-label">方言或地区范围</span><input v-model.trim="form.scope" class="form-control" maxlength="200" /></label>
        <label class="form-group"><span class="form-label">格式</span><input v-model.trim="form.format" class="form-control" maxlength="80" placeholder="例如 csv" /></label>
        <label class="form-group"><span class="form-label">逻辑 ID</span><input v-model.trim="form.logical_id" class="form-control" maxlength="80" placeholder="留空则自动生成" /></label>
        <label class="form-group">
          <span class="form-label">原始或派生</span>
          <select v-model="form.original_vs_derived" class="form-control">
            <option v-for="(label, value) in SOURCE_ORIGIN_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
        </label>
        <label class="form-group">
          <span class="form-label">处理状态</span>
          <select v-model="form.status" class="form-control">
            <option v-for="(label, value) in SOURCE_STATUS_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
        </label>
        <button class="btn btn-primary" :disabled="saving">{{ saving ? '正在登记…' : '登记来源' }}</button>
      </form>
    </section>
  </main>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  SOURCE_ORIGIN_LABELS,
  SOURCE_STATUS_LABELS,
  USAGE_PURPOSE_LABELS,
  sourceStatusClass
} from '@/constants/sourceRegistry'
import { createSource, listSources } from '@/services/sourcesService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const auth = useAuthStore()
const items = ref([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const success = ref('')
const form = reactive({
  title: '',
  holder: '',
  scope: '',
  format: '',
  logical_id: '',
  original_vs_derived: 'original',
  status: 'unregistered'
})

function statusLabel(status) {
  return SOURCE_STATUS_LABELS[status] || status
}

function originLabel(origin) {
  return SOURCE_ORIGIN_LABELS[origin] || origin
}

function undecidedLabel(item) {
  const names = (item.undecided_purposes || []).map((purpose) => USAGE_PURPOSE_LABELS[purpose] || purpose)
  return names.length ? names.join('、') : '没有未允许用途'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await listSources()
    items.value = result.items || []
  } catch (cause) {
    error.value = getPbMessage(cause, '来源清单加载失败')
  } finally {
    loading.value = false
  }
}

async function submitSource() {
  saving.value = true
  error.value = ''
  success.value = ''
  try {
    await createSource({ ...form, record_count: 0 })
    form.title = ''
    form.holder = ''
    form.scope = ''
    form.format = ''
    form.logical_id = ''
    form.status = 'unregistered'
    success.value = '来源已登记。用途结论仍是未知，下游会读到阻断，直到逐项写明允许或禁止。'
    await load()
  } catch (cause) {
    error.value = getPbMessage(cause, '登记来源失败')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>
