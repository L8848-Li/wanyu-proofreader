<template>
  <main class="container page workspace-page">
    <header class="page-heading">
      <div>
        <RouterLink :to="`/admin/projects/${projectId}`" class="back-link">← 返回项目</RouterLink>
        <div class="page-eyebrow">项目配置</div>
        <h1>{{ project?.name || '项目设置' }}</h1>
        <p>编辑项目名称与简介，管理加入方式、成员、校对人数和键盘。</p>
      </div>
    </header>
    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <div v-if="success" class="alert alert-success">{{ success }}</div>
    <div v-if="loading" class="card text-muted">正在加载项目配置…</div>
    <template v-else-if="project?.capabilities?.canManage">
      <section id="project-details" class="card project-settings-section mb-6" aria-labelledby="project-details-title">
        <div class="section-heading"><div><h2 id="project-details-title">项目资料</h2><p>名称和简介会同步显示在工作台、项目详情和发现项目中。</p></div></div>
        <form class="settings-form" @submit.prevent="saveDetails">
          <fieldset :disabled="savingDetails" style="border:0;padding:0;margin:0;min-width:0">
            <label class="form-group"><span class="form-label">项目名称</span><input v-model="details.name" class="form-control" required /></label>
            <label class="form-group"><span class="form-label">项目简介</span><textarea v-model="details.description" class="form-control" placeholder="介绍校对目标、材料来源或参与须知"></textarea></label>
            <p v-if="detailsError" class="alert alert-error" role="alert">{{ detailsError }}</p>
            <p v-if="detailsSuccess" class="alert alert-success" role="status">{{ detailsSuccess }}</p>
            <button class="btn btn-primary" :disabled="!detailsDirty">{{ savingDetails ? '保存中…' : '保存项目资料' }}</button>
          </fieldset>
        </form>
      </section>

      <section id="project-access" class="card project-settings-section mb-6">
        <div class="section-heading"><div><h2>加入方式与校对规则</h2><p>指定成员是默认且最严格的模式。</p></div></div>
        <form class="settings-form" @submit.prevent="saveSettings">
          <fieldset class="access-mode-grid">
            <legend class="form-label">新成员加入方式</legend>
            <label v-for="mode in accessModes" :key="mode.value" class="access-mode-option" :class="{ 'is-selected': settings.accessMode === mode.value }">
              <input v-model="settings.accessMode" type="radio" :value="mode.value" />
              <span><strong>{{ mode.label }}</strong><small>{{ mode.description }}</small></span>
            </label>
          </fieldset>
          <label v-if="settings.accessMode === 'password'" class="form-group">
            <span class="form-label">{{ project.access_mode === 'password' ? '更新项目口令（留空则保持不变）' : '设置项目口令' }}</span>
            <input v-model="settings.password" type="password" class="form-control" minlength="8" maxlength="72" autocomplete="new-password" placeholder="至少 8 个字符，UTF-8 编码最多 72 字节" />
          </label>
          <label class="form-group">
            <span class="form-label">每条材料所需独立校对人数</span>
            <input v-model.number="settings.requiredProofreads" type="number" class="form-control" min="2" max="1000" step="1" required />
            <small class="text-muted">至少 2 人。收齐后全部结果完全一致才会自动完成，存在任意差异则进入仲裁。</small>
          </label>
          <button class="btn btn-primary" :disabled="saving">{{ saving ? '保存中…' : '保存项目设置' }}</button>
        </form>
      </section>

      <section class="card project-settings-section mb-6">
        <div class="section-heading">
          <div><h2>批量志愿者账号</h2><p>一次生成并加入本项目，所有账号首次登录都必须修改密码。</p></div>
          <span class="section-count">单批最多 200 个</span>
        </div>
        <form class="volunteer-account-form" @submit.prevent="generateVolunteers">
          <label class="form-group"><span class="form-label">账号数量</span><input v-model.number="volunteerForm.count" type="number" class="form-control" min="1" max="200" required /></label>
          <label class="form-group"><span class="form-label">用户名规则</span><input v-model.trim="volunteerForm.usernamePattern" class="form-control" maxlength="150" required /><small class="text-muted">用 <code>{n}</code> 表示补零后的编号，例如 <code>px-{n}</code>。</small></label>
          <label class="form-group"><span class="form-label">起始编号</span><input v-model.number="volunteerForm.startNumber" type="number" class="form-control" min="0" required /></label>
          <label class="form-group"><span class="form-label">编号位数</span><input v-model.number="volunteerForm.digits" type="number" class="form-control" min="1" max="12" required /><small class="text-muted">例如 3 位会生成 001、002。</small></label>
          <label class="form-group volunteer-account-form__wide"><span class="form-label">昵称规则</span><input v-model.trim="volunteerForm.nicknamePattern" class="form-control" maxlength="255" required /><small class="text-muted">同样使用 <code>{n}</code>，例如“莆仙志愿者 {n}”。</small></label>
          <div class="volunteer-account-form__action">
            <button class="btn btn-primary" :disabled="generatingVolunteers">{{ generatingVolunteers ? '正在生成…' : '预检并生成账号' }}</button>
          </div>
        </form>
        <div v-if="generatedBatch" class="credential-download-panel mt-4">
          <div>
            <strong>已生成 {{ generatedBatch.count }} 个账号</strong>
            <p>初始密码不会写入数据库或日志。请现在下载并妥善分发；刷新或离开本页后无法再次取得本批密码。</p>
          </div>
          <button class="btn btn-success" @click="downloadGeneratedCredentials">再次下载凭据 CSV</button>
          <div class="table-wrapper credential-account-preview">
            <table>
              <thead><tr><th>昵称</th><th>用户名</th></tr></thead>
              <tbody><tr v-for="account in generatedBatch.accounts.slice(0, 10)" :key="account.id"><td>{{ account.nickname }}</td><td><code>{{ account.username }}</code></td></tr></tbody>
            </table>
          </div>
          <small v-if="generatedBatch.accounts.length > 10" class="text-muted">这里只预览前 10 个账号，完整内容见 CSV。</small>
        </div>
      </section>

      <section class="card project-settings-section mb-6">
        <div class="section-heading">
          <div><h2>项目成员</h2><p>同一成员在本项目内只能是管理员或校对员之一。</p></div>
          <span class="section-count">{{ members.length }} 人</span>
        </div>
        <form class="member-add-form" @submit.prevent="addMember">
          <select v-model="newMember.userId" class="form-control" required>
            <option value="">选择用户</option>
            <option v-for="candidate in availableCandidates" :key="candidate.id" :value="candidate.id">
              {{ [candidate.name, candidate.username].filter(Boolean).join(' · ') }}
            </option>
          </select>
          <select v-model="newMember.role" class="form-control">
            <option value="proofreader">校对员</option>
            <option value="manager">项目管理员</option>
          </select>
          <button class="btn btn-primary" :disabled="savingMember">添加成员</button>
        </form>
        <div class="table-wrapper mt-3">
          <table>
            <thead><tr><th>成员</th><th>项目角色</th><th>加入方式</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="member in members" :key="member.id">
                <td><strong>{{ member.name || member.username || '未填写昵称' }}</strong><div class="text-sm text-muted">{{ [member.username, member.email].filter(Boolean).join(' · ') }}</div></td>
                <td>
                  <span v-if="member.role === 'owner'" class="badge badge-approved">所有者</span>
                  <select v-else :value="member.role" class="form-control member-role-select" @change="changeRole(member, $event.target.value)">
                    <option value="proofreader">校对员</option>
                    <option value="manager">项目管理员</option>
                  </select>
                </td>
                <td>{{ sourceLabel(member.source) }}</td>
                <td><button v-if="member.role !== 'owner'" class="btn btn-danger btn-sm" @click="removeMember(member)">移除</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card project-settings-section mb-6">
        <div class="section-heading">
          <div><h2>校对键盘</h2><p>校对员和仲裁员只能使用这里启用的键盘；未启用任何键盘时编辑器会隐藏入口。</p></div>
          <span class="section-count">{{ enabledKeyboardIds.length }} 个已启用</span>
        </div>
        <div v-if="keyboardLibrary.length" class="keyboard-settings-list">
          <div v-for="keyboard in keyboardLibrary" :key="keyboard.keyboardId" class="keyboard-settings-row">
            <input
              type="checkbox"
              :checked="enabledKeyboardIds.includes(keyboard.keyboardId)"
              :aria-label="`启用${keyboard.name}`"
              @change="toggleKeyboard(keyboard.keyboardId, $event.target.checked)"
            />
            <span><strong>{{ keyboard.name }}</strong><small>{{ keyboard.description || '暂无说明' }} · {{ originLabel(keyboard.origin) }}</small></span>
            <input
              v-if="enabledKeyboardIds.includes(keyboard.keyboardId)"
              v-model="defaultKeyboardId"
              type="radio"
              name="default-keyboard"
              :value="keyboard.keyboardId"
              aria-label="设为默认键盘"
            />
            <em v-if="defaultKeyboardId === keyboard.keyboardId">默认</em>
          </div>
        </div>
        <div v-else class="text-muted">全局键盘库目前没有可用定义。</div>
        <button class="btn btn-primary mt-3" :disabled="savingKeyboards" @click="saveKeyboardSettings">
          {{ savingKeyboards ? '保存中…' : '保存键盘设置' }}
        </button>
      </section>

      <section v-if="project.capabilities.isOwner || project.capabilities.isPlatformAdmin" class="card project-settings-section danger-zone">
        <div class="section-heading"><div><h2>所有权与删除</h2><p>转移所有权后，你会保留为项目管理员；删除项目会释放创建额度。</p></div></div>
        <div class="danger-zone-actions">
          <div class="member-add-form">
            <select v-model="nextOwnerId" class="form-control">
              <option value="">选择新所有者</option>
              <option v-for="candidate in transferCandidates" :key="candidate.id" :value="candidate.id">{{ [candidate.name, candidate.username].filter(Boolean).join(' · ') }}</option>
            </select>
            <button class="btn btn-secondary" :disabled="!nextOwnerId || transferring" @click="transferOwner">转移所有权</button>
          </div>
          <button class="btn btn-danger" :disabled="deleting" @click="removeProject">{{ deleting ? '删除中…' : '删除项目' }}</button>
        </div>
      </section>
    </template>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  deleteProject,
  generateProjectVolunteers,
  getProject,
  listMemberCandidates,
  listProjectMembers,
  removeProjectMember,
  setProjectMember,
  transferProjectOwnership,
  updateProject
} from '@/services/projectsService'
import { configureProjectKeyboards, getProjectKeyboards, listKeyboardLibrary } from '@/services/keyboardsService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projectId = Array.isArray(route.params.id) ? route.params.id[0] : route.params.id
const project = ref(null)
const members = ref([])
const candidates = ref([])
const loading = ref(true)
const saving = ref(false)
const savingMember = ref(false)
const transferring = ref(false)
const deleting = ref(false)
const savingKeyboards = ref(false)
const generatingVolunteers = ref(false)
const error = ref('')
const success = ref('')
const nextOwnerId = ref('')
const keyboardLibrary = ref([])
const enabledKeyboardIds = ref([])
const defaultKeyboardId = ref('')
const generatedBatch = ref(null)
const details = reactive({ name: '', description: '' })
const savingDetails = ref(false)
const detailsError = ref('')
const detailsSuccess = ref('')
const detailsDirty = computed(() => details.name.trim() !== project.value?.name || details.description.trim() !== (project.value?.description || ''))
const settings = reactive({ accessMode: 'members_only', password: '', requiredProofreads: 2 })
const newMember = reactive({ userId: '', role: 'proofreader' })
const volunteerForm = reactive({ count: 10, usernamePattern: 'volunteer-{n}', startNumber: 1, digits: 3, nicknamePattern: '志愿者 {n}' })
const accessModes = [
  { value: 'members_only', label: '指定成员', description: '只有所有者或项目管理员添加的用户可以进入。' },
  { value: 'public', label: '公开加入', description: '任意已登录用户可以直接成为校对员。' },
  { value: 'password', label: '口令加入', description: '验证项目口令后成为持久校对成员。' }
]
const memberIds = computed(() => new Set(members.value.map((item) => item.user)))
const availableCandidates = computed(() => candidates.value.filter((item) => !memberIds.value.has(item.id)))
const transferCandidates = computed(() => candidates.value.filter((item) => item.id !== project.value?.owner))

onMounted(load)

async function load() {
  loading.value = true
  error.value = ''
  try {
    project.value = await getProject(projectId)
    if (!project.value.capabilities.canManage) throw new Error('你没有管理该项目的权限。')
    details.name = project.value.name
    details.description = project.value.description || ''
    settings.accessMode = project.value.access_mode
    settings.requiredProofreads = Number(project.value.required_proofreads || 2)
    const [nextMembers, nextCandidates, nextKeyboardLibrary, keyboardConfig] = await Promise.all([
      listProjectMembers(projectId),
      listMemberCandidates(projectId),
      listKeyboardLibrary(),
      getProjectKeyboards(projectId)
    ])
    members.value = nextMembers
    candidates.value = nextCandidates
    keyboardLibrary.value = nextKeyboardLibrary
    enabledKeyboardIds.value = keyboardConfig.items.map((item) => item.keyboardId)
    defaultKeyboardId.value = keyboardConfig.defaultKeyboardId || ''
  } catch (e) { error.value = getPbMessage(e, e.message || '项目配置加载失败。') }
  finally { loading.value = false }
}

async function saveDetails() {
  if (savingDetails.value || !detailsDirty.value) return
  detailsError.value = ''
  detailsSuccess.value = ''
  const name = details.name.trim()
  const description = details.description.trim()
  if (!name || Array.from(name).length > 500 || Array.from(description).length > 2000) {
    detailsError.value = '项目名称需为 1–500 个字符，简介不能超过 2000 个字符。'
    return
  }
  savingDetails.value = true
  try {
    project.value = await updateProject(projectId, { name, description })
    details.name = project.value.name
    details.description = project.value.description || ''
    detailsSuccess.value = '项目资料已保存。'
  } catch (e) {
    detailsError.value = getPbMessage(e, '项目资料保存失败，请重试。')
  } finally {
    savingDetails.value = false
  }
}

async function saveSettings() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  success.value = ''
  try {
    project.value = await updateProject(projectId, {
      accessMode: settings.accessMode,
      password: settings.password,
      requiredProofreads: settings.requiredProofreads
    })
    settings.password = ''
    success.value = '项目设置已保存，现有成员保持不变。'
  } catch (e) { error.value = getPbMessage(e, '项目设置保存失败。') }
  finally { saving.value = false }
}

async function addMember() {
  savingMember.value = true
  error.value = ''
  try {
    await setProjectMember(projectId, newMember.userId, newMember.role)
    newMember.userId = ''
    await reloadMembers()
    success.value = '成员已添加。'
  } catch (e) { error.value = getPbMessage(e, '成员添加失败。') }
  finally { savingMember.value = false }
}

async function changeRole(member, role) {
  error.value = ''
  try {
    await setProjectMember(projectId, member.user, role)
    await reloadMembers()
    success.value = '项目角色已更新。'
  } catch (e) { error.value = getPbMessage(e, '项目角色更新失败。') }
}

async function removeMember(member) {
  if (!window.confirm(`确定移除 ${member.name || member.email} 吗？`)) return
  error.value = ''
  try {
    await removeProjectMember(projectId, member.user)
    await reloadMembers()
    success.value = '成员已移除。'
  } catch (e) { error.value = getPbMessage(e, '成员移除失败。') }
}

async function reloadMembers() {
  members.value = await listProjectMembers(projectId)
  await auth.loadAccessContext({ force: true })
}

async function generateVolunteers() {
  generatingVolunteers.value = true
  error.value = ''
  success.value = ''
  try {
    const batch = await generateProjectVolunteers(projectId, {
      ...volunteerForm,
      loginUrl: `${window.location.origin}/login`
    })
    generatedBatch.value = batch
    await reloadMembers()
    success.value = `已生成并加入 ${batch.count} 个志愿者账号。凭据只保留在当前页面。`
    downloadGeneratedCredentials()
  } catch (e) {
    error.value = getPbMessage(e, '志愿者账号生成失败，未创建任何账号。')
  } finally {
    generatingVolunteers.value = false
  }
}

function downloadGeneratedCredentials() {
  const batch = generatedBatch.value
  if (!batch?.csv) return
  const url = URL.createObjectURL(new Blob([batch.csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = batch.fileName || '志愿者账号.csv'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

async function transferOwner() {
  if (!window.confirm('确定转移项目所有权吗？你将保留为项目管理员。')) return
  transferring.value = true
  error.value = ''
  try {
    await transferProjectOwnership(projectId, nextOwnerId.value)
    await auth.loadAccessContext({ force: true })
    await load()
    success.value = '项目所有权已转移。'
  } catch (e) { error.value = getPbMessage(e, '所有权转移失败。') }
  finally { transferring.value = false }
}

async function removeProject() {
  if (!window.confirm(`确定永久删除项目“${project.value.name}”及其全部材料吗？`)) return
  deleting.value = true
  error.value = ''
  try {
    await deleteProject(projectId)
    await auth.loadAccessContext({ force: true })
    await router.push('/admin')
  } catch (e) { error.value = getPbMessage(e, '项目删除失败。') }
  finally { deleting.value = false }
}

function toggleKeyboard(keyboardId, enabled) {
  const next = enabledKeyboardIds.value.filter((id) => id !== keyboardId)
  if (enabled) next.push(keyboardId)
  enabledKeyboardIds.value = next
  if (!next.includes(defaultKeyboardId.value)) defaultKeyboardId.value = next[0] || ''
}

async function saveKeyboardSettings() {
  if (enabledKeyboardIds.value.length && !enabledKeyboardIds.value.includes(defaultKeyboardId.value)) {
    error.value = '请从已启用键盘中选择默认键盘。'
    return
  }
  savingKeyboards.value = true
  error.value = ''
  success.value = ''
  try {
    const config = await configureProjectKeyboards(projectId, enabledKeyboardIds.value, defaultKeyboardId.value)
    enabledKeyboardIds.value = config.items.map((item) => item.keyboardId)
    defaultKeyboardId.value = config.defaultKeyboardId || ''
    success.value = enabledKeyboardIds.value.length ? '项目键盘设置已保存。' : '已关闭本项目的键盘入口。'
  } catch (e) { error.value = getPbMessage(e, '键盘设置保存失败。') }
  finally { savingKeyboards.value = false }
}

function sourceLabel(source) {
  return ({ assigned: '管理员指定', public: '公开加入', password: '口令加入' })[source] || '管理员指定'
}

function originLabel(origin) {
  return origin === 'preset' ? '仓库预置' : '自定义上传'
}
</script>
