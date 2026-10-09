<template>
  <main class="container page workspace-page">
    <header class="page-heading">
      <div>
        <RouterLink to="/workspace" class="back-link">← 返回工作台</RouterLink>
        <div class="page-eyebrow">平台管理</div>
        <h1>项目创建权限</h1>
        <p>默认只有平台管理员能创建项目；授权可随时调整或撤销，不影响现有项目。</p>
      </div>
    </header>
    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <section class="card">
      <div class="section-heading">
        <label class="admin-filter-field">
          <span>搜索用户</span>
          <input v-model.trim="query" class="form-control" type="search" placeholder="昵称、邮箱或用户名" />
        </label>
        <button class="btn btn-secondary" :disabled="loading" @click="load">刷新</button>
      </div>
      <div v-if="loading" class="text-muted">正在加载用户…</div>
      <div v-else class="table-wrapper">
        <table>
          <thead><tr><th>用户</th><th>当前拥有</th><th>创建权限</th><th>项目额度</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="row in filteredRows" :key="row.user">
              <td><strong>{{ row.name || row.username || '未填写昵称' }}</strong><div class="text-sm text-muted">{{ [row.username, row.email].filter(Boolean).join(' · ') }}</div></td>
              <td>{{ row.ownedProjectCount }} 个项目</td>
              <td>
                <span v-if="row.globalRole === 'platform_admin'" class="badge badge-approved">平台管理员</span>
                <label v-else class="toggle-field"><input v-model="drafts[row.user].enabled" type="checkbox" /> 已授权</label>
              </td>
              <td>
                <input
                  v-if="row.globalRole !== 'platform_admin'"
                  v-model="drafts[row.user].projectLimit"
                  class="form-control grant-limit-input"
                  inputmode="numeric"
                  placeholder="留空不限量"
                  :disabled="!drafts[row.user].enabled"
                />
                <span v-else>不限量</span>
              </td>
              <td>
                <button v-if="row.globalRole !== 'platform_admin'" class="btn btn-primary btn-sm" :disabled="saving === row.user" @click="save(row)">
                  {{ saving === row.user ? '保存中…' : '保存' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { listCreatorGrants, setCreatorGrant } from '@/services/projectsService'
import { getPbMessage } from '@/utils/pbErrors'

const rows = ref([])
const drafts = ref({})
const query = ref('')
const loading = ref(true)
const saving = ref('')
const error = ref('')
const filteredRows = computed(() => {
  const needle = query.value.toLocaleLowerCase('zh-CN')
  if (!needle) return rows.value
  return rows.value.filter((row) => `${row.name} ${row.username} ${row.email}`.toLocaleLowerCase('zh-CN').includes(needle))
})

onMounted(load)

async function load() {
  loading.value = true
  error.value = ''
  try {
    rows.value = await listCreatorGrants()
    drafts.value = Object.fromEntries(rows.value.map((row) => [row.user, {
      enabled: row.enabled,
      projectLimit: row.projectLimit == null ? '' : String(row.projectLimit)
    }]))
  } catch (e) { error.value = getPbMessage(e, '无法加载创建权限。') }
  finally { loading.value = false }
}

async function save(row) {
  const draft = drafts.value[row.user]
  const limit = draft.projectLimit.trim() === '' ? null : Number(draft.projectLimit)
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    error.value = '项目额度必须为正整数；留空表示不限量。'
    return
  }
  saving.value = row.user
  error.value = ''
  try {
    await setCreatorGrant(row.user, { enabled: draft.enabled, projectLimit: limit })
    await load()
  } catch (e) { error.value = getPbMessage(e, '创建权限保存失败。') }
  finally { saving.value = '' }
}
</script>
