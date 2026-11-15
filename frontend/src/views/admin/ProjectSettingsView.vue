<template>
  <main class="container page workspace-page project-workspace-page">
    <header class="page-heading">
      <div>
        <RouterLink :to="projectReturnTarget" class="back-link">← 返回项目</RouterLink>
        <div class="page-eyebrow">项目配置</div>
        <h1>{{ project?.name || '项目设置' }}</h1>
        <p>维护项目资料、核验规则和参与方式。</p>
      </div>
    </header>
    <ProjectWorkspaceNav :project-id="projectId" active="settings" />
    <BatchReportReturn :project-id="projectId" />
    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <div v-if="success" class="alert alert-success" role="status">{{ success }}</div>
    <AppStatusPanel v-if="loading" state="pending" message="正在加载项目配置…" />
    <template v-else-if="project?.capabilities?.canManage">
      <div class="project-settings-layout">
        <nav class="project-settings-nav" aria-label="项目设置分区">
          <RouterLink
            v-for="item in settingSections"
            :key="item.key"
            :to="{ query: { ...route.query, view: item.key }, hash: '' }"
            :class="{ 'is-active': settingsView === item.key }"
            :aria-current="settingsView === item.key ? 'page' : undefined"
            >{{ item.label }}</RouterLink
          >
        </nav>
        <div class="project-settings-content">
          <AppStatusPanel v-if="sectionLoading" state="pending" message="正在打开设置分区…" />
          <AppStatusPanel
            v-if="sectionError"
            state="error"
            :message="sectionError"
            retry-label="重试此分区"
            @retry="activateSettings"
          />
          <div v-show="!sectionLoading && !sectionError">
            <nav
              v-if="settingsView === 'members'"
              class="project-subnav"
              aria-label="成员与账号功能"
            >
              <RouterLink
                v-for="item in memberSections"
                :key="item.key"
                :to="{
                  query: { ...route.query, view: 'members', membersView: item.key },
                  hash: ''
                }"
                :class="{ 'is-active': memberView === item.key }"
                :aria-current="memberView === item.key ? 'page' : undefined"
                >{{ item.label }}</RouterLink
              >
            </nav>
            <AppStatusPanel
              v-if="
                settingsView === 'ownership' &&
                !project.capabilities.isOwner &&
                !project.capabilities.isPlatformAdmin
              "
              state="empty"
              reason="not_authorized"
              message="只有项目所有者或平台管理员能变更所有权。其他项目设置仍可继续使用。"
            />
            <section
              id="project-details"
              v-show="settingsView === 'general'"
              class="card project-settings-section mb-6"
              aria-labelledby="project-details-title"
            >
              <div class="section-heading">
                <div>
                  <h2 id="project-details-title">项目资料</h2>
                  <p>名称和简介会同步显示在工作台、项目详情和发现项目中。</p>
                </div>
              </div>
              <form class="settings-form" @submit.prevent="saveDetails">
                <fieldset :disabled="savingDetails" class="settings-fieldset">
                  <AppField
                    ><template #label>项目名称</template
                    ><input v-model="details.name" class="form-control" required
                  /></AppField>
                  <AppField
                    ><template #label>项目简介</template
                    ><textarea
                      v-model="details.description"
                      class="form-control"
                      placeholder="介绍校对目标、材料来源或参与须知"
                    ></textarea>
                  </AppField>
                  <p v-if="detailsError" class="alert alert-error" role="alert">
                    {{ detailsError }}
                  </p>
                  <p v-if="detailsSuccess" class="alert alert-success" role="status">
                    {{ detailsSuccess }}
                  </p>
                  <button class="btn btn-primary" :disabled="!detailsDirty">
                    {{ savingDetails ? '保存中…' : '保存项目资料' }}
                  </button>
                </fieldset>
              </form>
            </section>

            <section
              id="column-roles"
              v-show="settingsView === 'rules'"
              class="card project-settings-section mb-6"
              aria-labelledby="column-roles-title"
            >
              <div class="section-heading">
                <div>
                  <h2 id="column-roles-title">列角色</h2>
                  <p>
                    给已经导入的列起一个角色。这只是标注，不会改列名，也不会改校对页的排版。没标过的列都是未标注。
                  </p>
                </div>
              </div>
              <p v-if="rolesError" class="alert alert-error" role="alert">{{ rolesError }}</p>
              <p v-if="rolesSuccess" class="alert alert-success" role="status">
                {{ rolesSuccess }}
              </p>
              <p v-if="!columnRoles.length" class="text-muted">
                还没有导入列。导入 CSV 之后可以在这里标注。
              </p>
              <AppDataTable v-else label="列角色表">
                <template #head
                  ><tr>
                    <th>列名</th>
                    <th>角色</th>
                    <th>状态</th>
                  </tr></template
                >

                <tr v-for="column in columnRoles" :key="column.name">
                  <td>
                    <code>{{ column.name }}</code>
                  </td>
                  <td>
                    <select
                      v-model="column.role"
                      class="form-control"
                      :aria-label="`设置列 ${column.name} 的角色`"
                    >
                      <option v-for="role in FIELD_ROLES" :key="role" :value="role">
                        {{ FIELD_ROLE_LABELS[role] }}
                      </option>
                    </select>
                  </td>
                  <td class="text-sm text-muted">
                    {{
                      column.present
                        ? '当前导入里有这一列'
                        : '这一列已经不在当前导入结果里，标注仍保留，但不会生效'
                    }}
                  </td>
                </tr>
              </AppDataTable>
              <fieldset
                v-if="toneReadingColumns.length || toneReference || toneComparison"
                class="settings-fieldset tone-count-settings"
              >
                <legend class="form-label">带调音节数核对</legend>
                <p class="text-sm text-muted">
                  选择音节应一一对应的两列。规则识别空格分隔的带调音节，普通数字和上标均可。
                </p>
                <div class="tone-count-fields">
                  <AppField label="参照记音列">
                    <select
                      v-model="toneReference"
                      aria-label="参照记音列"
                      class="form-control"
                      :disabled="savingRoles"
                    >
                      <option value="">关闭核对</option>
                      <option v-for="field in toneReadingColumns" :key="field" :value="field">
                        {{ field }}
                      </option>
                    </select>
                  </AppField>
                  <AppField v-if="toneReference" label="待核对记音列">
                    <select
                      v-model="toneComparison"
                      aria-label="待核对记音列"
                      class="form-control"
                      :disabled="savingRoles"
                    >
                      <option value="">请选择</option>
                      <option
                        v-for="field in toneReadingColumns.filter((name) => name !== toneReference)"
                        :key="field"
                        :value="field"
                      >
                        {{ field }}
                      </option>
                    </select>
                  </AppField>
                </div>
              </fieldset>
              <p v-if="columnRolesNote" class="text-sm text-muted mt-3">{{ columnRolesNote }}</p>
              <div class="section-heading mt-3">
                <button
                  type="button"
                  class="btn btn-secondary"
                  :disabled="!columnRoles.length"
                  @click="applyRoleSuggestions"
                >
                  按列名填入建议
                </button>
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="
                    savingRoles || !columnRoles.length || (toneReference && !canCompareTone)
                  "
                  @click="saveRoles"
                >
                  {{ savingRoles ? '正在保存…' : '保存列角色' }}
                </button>
              </div>
              <p class="text-sm text-muted mt-3">
                建议只是按列名猜的默认值，可以不采用。保存之后，条目里的原文和校对结果不会被改写。
              </p>
            </section>

            <ProjectVerificationPolicy
              v-if="visitedSettings.has('rules')"
              v-show="settingsView === 'rules'"
              :project-id="projectId"
              @dirty-change="policyDirty = $event"
              :guard-leave="false"
            />
            <section
              v-show="settingsView === 'rules'"
              class="card project-settings-section mt-4 mb-6"
            >
              <div class="section-heading">
                <div>
                  <h2>独立校对规则</h2>
                  <p>收齐指定人数的独立结果后，一致则完成校对，有差异则进入仲裁。</p>
                </div>
              </div>
              <form class="settings-form" @submit.prevent="saveProofreadRules">
                <AppField label="每条材料所需独立校对人数"
                  ><input
                    v-model.number="settings.requiredProofreads"
                    type="number"
                    class="form-control"
                    min="2"
                    max="1000"
                    step="1"
                    required
                /></AppField>
                <button class="btn btn-primary" :disabled="savingRules">
                  {{ savingRules ? '保存中…' : '保存校对规则' }}
                </button>
              </form>
            </section>
            <section
              v-show="settingsView === 'members' && memberView === 'access'"
              id="project-access"
              class="card project-settings-section mb-6"
            >
              <div class="section-heading">
                <div>
                  <h2>新成员加入方式</h2>
                  <p>指定成员是默认且最严格的模式。</p>
                </div>
              </div>
              <form class="settings-form" @submit.prevent="saveSettings">
                <fieldset class="access-mode-grid">
                  <legend class="form-label">新成员加入方式</legend>
                  <label
                    v-for="mode in accessModes"
                    :key="mode.value"
                    class="access-mode-option"
                    :class="{ 'is-selected': settings.accessMode === mode.value }"
                  >
                    <input v-model="settings.accessMode" type="radio" :value="mode.value" />
                    <span
                      ><strong>{{ mode.label }}</strong
                      ><small>{{ mode.description }}</small></span
                    >
                  </label>
                </fieldset>
                <AppField v-if="settings.accessMode === 'password'"
                  ><template #label>{{
                    project.access_mode === 'password'
                      ? '更新项目口令（留空则保持不变）'
                      : '设置项目口令'
                  }}</template>
                  <input
                    v-model="settings.password"
                    type="password"
                    class="form-control"
                    minlength="8"
                    maxlength="72"
                    autocomplete="new-password"
                    placeholder="至少 8 个字符，UTF-8 编码最多 72 字节"
                  />
                </AppField>
                <button class="btn btn-primary" :disabled="saving">
                  {{ saving ? '保存中…' : '保存项目设置' }}
                </button>
              </form>
            </section>

            <section
              v-show="settingsView === 'members' && memberView === 'accounts'"
              id="volunteer-accounts"
              class="card project-settings-section mb-6"
            >
              <div class="section-heading">
                <div>
                  <h2>批量志愿者账号</h2>
                  <p>一次生成并加入本项目，所有账号首次登录都必须修改密码。</p>
                </div>
                <span class="section-count">单批最多 200 个</span>
              </div>
              <form class="volunteer-account-form" @submit.prevent="generateVolunteers">
                <AppField
                  ><template #label>账号数量</template
                  ><input
                    v-model.number="volunteerForm.count"
                    type="number"
                    class="form-control"
                    min="1"
                    max="200"
                    required
                /></AppField>
                <AppField
                  ><template #label>用户名规则</template
                  ><input
                    v-model.trim="volunteerForm.usernamePattern"
                    class="form-control"
                    maxlength="150"
                    required
                  /><small class="text-muted"
                    >用 <code>{n}</code> 表示补零后的编号，例如 <code>px-{n}</code>。</small
                  ></AppField
                >
                <AppField
                  ><template #label>起始编号</template
                  ><input
                    v-model.number="volunteerForm.startNumber"
                    type="number"
                    class="form-control"
                    min="0"
                    required
                /></AppField>
                <AppField
                  ><template #label>编号位数</template
                  ><input
                    v-model.number="volunteerForm.digits"
                    type="number"
                    class="form-control"
                    min="1"
                    max="12"
                    required
                  /><small class="text-muted">例如 3 位会生成 001、002。</small></AppField
                >
                <AppField class="volunteer-account-form__wide"
                  ><template #label>昵称规则</template
                  ><input
                    v-model.trim="volunteerForm.nicknamePattern"
                    class="form-control"
                    maxlength="255"
                    required
                  /><small class="text-muted"
                    >同样使用 <code>{n}</code>，例如“莆仙志愿者 {n}”。</small
                  ></AppField
                >
                <div class="volunteer-account-form__action">
                  <button class="btn btn-primary" :disabled="generatingVolunteers">
                    {{ generatingVolunteers ? '正在生成…' : '预检并生成账号' }}
                  </button>
                </div>
              </form>
              <div v-if="generatedBatch" class="credential-download-panel mt-4">
                <div>
                  <strong>已生成 {{ generatedBatch.count }} 个账号</strong>
                  <p>
                    初始密码不会写入数据库或日志。请现在下载并妥善分发；刷新或离开本页后无法再次取得本批密码。
                  </p>
                </div>
                <button class="btn btn-success" @click="downloadGeneratedCredentials">
                  再次下载凭据 CSV
                </button>
                <AppDataTable class="credential-account-preview" label="生成账号预览">
                  <template #head
                    ><tr>
                      <th>昵称</th>
                      <th>用户名</th>
                    </tr></template
                  >
                  <tr v-for="account in generatedBatch.accounts.slice(0, 10)" :key="account.id">
                    <td>{{ account.nickname }}</td>
                    <td>
                      <code>{{ account.username }}</code>
                    </td>
                  </tr>
                </AppDataTable>
                <small v-if="generatedBatch.accounts.length > 10" class="text-muted"
                  >这里只预览前 10 个账号，完整内容见 CSV。</small
                >
              </div>
            </section>

            <section
              v-show="settingsView === 'members' && memberView === 'members'"
              id="project-members"
              class="card project-settings-section mb-6"
            >
              <div class="section-heading">
                <div>
                  <h2>项目成员</h2>
                  <p>同一成员在本项目内只能是管理员或校对员之一。</p>
                </div>
                <span class="section-count">{{ members.length }} 人</span>
              </div>
              <div class="member-candidate-search mb-3">
                <input
                  v-model="candidateTerm"
                  class="form-control"
                  type="search"
                  placeholder="输入完整用户名或昵称"
                  aria-label="按完整用户名或昵称查找用户"
                  @keyup.enter.prevent="searchCandidates"
                />
                <button
                  class="btn btn-secondary"
                  type="button"
                  :disabled="candidateState.loading"
                  @click="searchCandidates"
                >
                  查找
                </button>
                <button
                  v-if="candidateState.nextCursor"
                  class="btn btn-secondary"
                  type="button"
                  :disabled="candidateState.loading"
                  @click="candidatePager.next"
                >
                  加载更多候选用户
                </button>
              </div>
              <AppStatusPanel
                v-if="candidateState.error"
                state="error"
                :message="candidateState.error"
                retry-label="重试候选加载"
                :busy="candidateState.loading"
                @retry="candidatePager.retry"
              />
              <p v-if="candidateState.loading" role="status">正在加载候选用户…</p>

              <p
                v-if="
                  candidateSearched &&
                  !candidateState.loading &&
                  !candidateState.error &&
                  !availableCandidates.length
                "
                class="field-hint"
              >
                没有精确匹配到的用户。查找需要完整用户名或完整昵称；对方也可以用项目口令自助加入，或由平台管理员分配账号。
              </p>
              <form class="member-add-form" @submit.prevent="addMember">
                <select
                  v-model="newMember.userId"
                  class="form-control"
                  aria-label="选择用户"
                  required
                >
                  <option value="">选择用户</option>
                  <option
                    v-for="candidate in availableCandidates"
                    :key="candidate.id"
                    :value="candidate.id"
                  >
                    {{ [candidate.name, candidate.username].filter(Boolean).join(' · ') }}
                  </option>
                </select>
                <select v-model="newMember.role" class="form-control" aria-label="新成员的项目角色">
                  <option value="proofreader">校对员</option>
                  <option value="manager">项目管理员</option>
                </select>
                <button class="btn btn-primary" :disabled="savingMember || candidateState.loading">
                  添加成员
                </button>
              </form>
              <AppDataTable class="mt-3" label="项目成员表">
                <template #head
                  ><tr>
                    <th>成员</th>
                    <th>项目角色</th>
                    <th>加入方式</th>
                    <th>操作</th>
                  </tr></template
                >

                <tr v-for="member in members" :key="member.id">
                  <td>
                    <strong>{{ member.name || member.username || '未填写昵称' }}</strong>
                    <div class="text-sm text-muted">
                      {{ [member.username, member.email].filter(Boolean).join(' · ') }}
                    </div>
                  </td>
                  <td>
                    <span v-if="member.role === 'owner'" class="badge badge-approved">所有者</span>
                    <select
                      v-else
                      :value="member.role"
                      class="form-control member-role-select"
                      :aria-label="`修改 ${member.name || member.username || '该成员'} 的项目角色`"
                      @change="changeRole(member, $event.target.value)"
                    >
                      <option value="proofreader">校对员</option>
                      <option value="manager">项目管理员</option>
                    </select>
                  </td>
                  <td>{{ sourceLabel(member.source) }}</td>
                  <td>
                    <button
                      v-if="member.role !== 'owner'"
                      class="btn btn-danger btn-sm"
                      @click="removeMember(member)"
                    >
                      移除
                    </button>
                  </td>
                </tr>
              </AppDataTable>
            </section>

            <section
              v-show="settingsView === 'keyboard'"
              id="project-keyboards"
              class="card project-settings-section mb-6"
            >
              <div class="section-heading">
                <div>
                  <h2>校对键盘</h2>
                  <p>校对员和仲裁员只能使用这里启用的键盘；未启用任何键盘时编辑器会隐藏入口。</p>
                </div>
                <span class="section-count">{{ enabledKeyboardIds.length }} 个已启用</span>
              </div>
              <div v-if="keyboardLibrary.length" class="keyboard-settings-list">
                <div
                  v-for="keyboard in keyboardLibrary"
                  :key="keyboard.keyboardId"
                  class="keyboard-settings-row"
                >
                  <input
                    type="checkbox"
                    :checked="enabledKeyboardIds.includes(keyboard.keyboardId)"
                    :aria-label="`启用${keyboard.name}`"
                    @change="toggleKeyboard(keyboard.keyboardId, $event.target.checked)"
                  />
                  <span
                    ><strong>{{ keyboard.name }}</strong
                    ><small
                      >{{ keyboard.description || '暂无说明' }} ·
                      {{ originLabel(keyboard.origin) }}</small
                    ></span
                  >
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
              <button
                class="btn btn-primary mt-3"
                :disabled="savingKeyboards"
                @click="saveKeyboardSettings"
              >
                {{ savingKeyboards ? '保存中…' : '保存键盘设置' }}
              </button>
            </section>

            <section
              v-if="project.capabilities.isOwner || project.capabilities.isPlatformAdmin"
              v-show="settingsView === 'ownership'"
              class="card project-settings-section danger-zone"
            >
              <div class="section-heading">
                <div>
                  <h2>所有权与删除</h2>
                  <p>转移所有权后，你会保留为项目管理员；删除项目会释放创建额度。</p>
                </div>
              </div>
              <div class="danger-zone-actions">
                <div class="member-add-form">
                  <select v-model="nextOwnerId" class="form-control" aria-label="选择新所有者">
                    <option value="">选择新所有者</option>
                    <option
                      v-for="candidate in transferCandidates"
                      :key="candidate.id"
                      :value="candidate.id"
                    >
                      {{ [candidate.name, candidate.username].filter(Boolean).join(' · ') }}
                    </option>
                  </select>
                  <button
                    class="btn btn-secondary"
                    :disabled="!nextOwnerId || transferring"
                    @click="transferOwner"
                  >
                    转移所有权
                  </button>
                </div>
                <button class="btn btn-danger" :disabled="deleting" @click="removeProject">
                  {{ deleting ? '删除中…' : '删除项目' }}
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </template>
    <WorkspaceLeaveGuard :dirty="!deleting && hasUnsavedSettings" />
  </main>
</template>

<script setup>
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import AppField from '@/components/AppField.vue'
import ProjectWorkspaceNav from '@/components/admin/project/ProjectWorkspaceNav.vue'
import BatchReportReturn from '@/components/admin/project/BatchReportReturn.vue'
import { batchReportNavigationQuery, readBatchReportContext } from '@/lib/batchReportContext'
import WorkspaceLeaveGuard from '@/components/admin/project/WorkspaceLeaveGuard.vue'
import ProjectVerificationPolicy from '@/components/admin/project/ProjectVerificationPolicy.vue'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  deleteProject,
  generateProjectVolunteers,
  getColumnRoles,
  getProject,
  listMemberCandidatePage,
  listProjectMembers,
  removeProjectMember,
  setProjectMember,
  saveColumnRoles,
  transferProjectOwnership,
  updateProject
} from '@/services/projectsService'
import { createCandidatePager } from '@/lib/candidatePager'
import { FIELD_ROLE_LABELS, FIELD_ROLES } from '@/constants/fieldRoles'
import { suggestColumnRoles } from '@/lib/columnRoleSuggestion'
import {
  configureProjectKeyboards,
  getProjectKeyboards,
  listKeyboardLibrary
} from '@/services/keyboardsService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projectId = computed(() =>
  String(Array.isArray(route.params.id) ? route.params.id[0] : route.params.id)
)
const projectReturnTarget = computed(() => ({
  path: `/admin/projects/${encodeURIComponent(projectId.value)}`,
  query: batchReportNavigationQuery(readBatchReportContext(route.query, projectId.value))
}))
const settingsView = computed(() => {
  const legacy = {
    '#project-details': 'general',
    '#column-roles': 'rules',
    '#project-access': 'members',
    '#project-members': 'members',
    '#volunteer-accounts': 'members',
    '#project-keyboards': 'keyboard'
  }
  if (legacy[route.hash]) return legacy[route.hash]
  return ['general', 'rules', 'members', 'keyboard', 'ownership'].includes(route.query?.view)
    ? route.query.view
    : 'general'
})
const memberSections = [
  { key: 'members', label: '项目成员' },
  { key: 'access', label: '加入方式' },
  { key: 'accounts', label: '批量账号' }
]
const memberView = computed(() =>
  route.hash === '#volunteer-accounts'
    ? 'accounts'
    : route.hash === '#project-access'
      ? 'access'
      : ['members', 'access', 'accounts'].includes(route.query?.membersView)
        ? route.query.membersView
        : 'members'
)
const settingSections = computed(() => [
  { key: 'general', label: '基本资料' },
  { key: 'rules', label: '列与核验规则' },
  { key: 'members', label: '成员与账号' },
  { key: 'keyboard', label: '字符输入' },
  ...(project.value?.capabilities?.isOwner || project.value?.capabilities?.isPlatformAdmin
    ? [{ key: 'ownership', label: '所有权' }]
    : [])
])
const visitedSettings = reactive(new Set())
watch(settingsView, (value) => visitedSettings.add(value), { immediate: true })
const savingRules = ref(false)
const project = ref(null)
const members = ref([])
const candidateState = reactive({ items: [], nextCursor: '', term: '', loading: false, error: '' })
const candidatePager = createCandidatePager(listMemberCandidatePage, candidateState)
const candidates = computed(() => candidateState.items)
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
const credentialsDownloaded = ref(false)
const rolesBaseline = ref('[]')
const keyboardBaseline = ref(JSON.stringify([[], '']))
const policyDirty = ref(false)
const details = reactive({ name: '', description: '' })
const savingDetails = ref(false)
const detailsError = ref('')
const detailsSuccess = ref('')
const detailsDirty = computed(
  () =>
    details.name.trim() !== project.value?.name ||
    details.description.trim() !== (project.value?.description || '')
)
const columnRoles = ref([])
const toneReference = ref('')
const toneComparison = ref('')
const toneReadingColumns = computed(() =>
  columnRoles.value
    .filter((column) => column.role === 'reading' && column.present)
    .map((column) => column.name)
)
const canCompareTone = computed(
  () =>
    toneReference.value !== toneComparison.value &&
    toneReadingColumns.value.includes(toneReference.value) &&
    toneReadingColumns.value.includes(toneComparison.value)
)
const columnSettingsSnapshot = () =>
  JSON.stringify([columnRoles.value, toneReference.value, toneComparison.value])
const columnRolesNote = ref('')
const savingRoles = ref(false)
const rolesError = ref('')
const rolesSuccess = ref('')
const settings = reactive({ accessMode: 'members_only', password: '', requiredProofreads: 2 })
const newMember = reactive({ userId: '', role: 'proofreader' })
const candidateTerm = ref('')
const candidateSearched = ref(false)
const volunteerForm = reactive({
  count: 10,
  usernamePattern: 'volunteer-{n}',
  startNumber: 1,
  digits: 3,
  nicknamePattern: '志愿者 {n}'
})
const accessModes = [
  {
    value: 'members_only',
    label: '指定成员',
    description: '只有所有者或项目管理员添加的用户可以进入。'
  },
  { value: 'public', label: '公开加入', description: '任意已登录用户可以直接成为校对员。' },
  { value: 'password', label: '口令加入', description: '验证项目口令后成为持久校对成员。' }
]
const memberIds = computed(() => new Set(members.value.map((item) => item.user)))
const availableCandidates = computed(() =>
  candidates.value.filter((item) => !memberIds.value.has(item.id))
)
const transferCandidates = computed(() =>
  candidates.value.filter((item) => item.id !== project.value?.owner)
)

const hasUnsavedSettings = computed(() =>
  Boolean(
    project.value &&
    !loading.value &&
    (detailsDirty.value ||
      policyDirty.value ||
      settings.password ||
      settings.accessMode !== project.value.access_mode ||
      Number(settings.requiredProofreads) !== Number(project.value.required_proofreads || 2) ||
      columnSettingsSnapshot() !== rolesBaseline.value ||
      JSON.stringify([enabledKeyboardIds.value, defaultKeyboardId.value]) !==
        keyboardBaseline.value ||
      (generatedBatch.value && !credentialsDownloaded.value))
  )
)

const sectionLoading = ref(false)
const sectionError = ref('')
const loadedSettings = new Set()
let sectionGeneration = 0
let loadGeneration = 0
let disposed = false
const currentProject = (id) => !disposed && id === projectId.value
onBeforeUnmount(() => {
  disposed = true
  loadGeneration++
  sectionGeneration++
})
watch(projectId, load, { immediate: true })
watch(settingsView, activateSettings)

async function load() {
  const generation = ++loadGeneration
  const id = projectId.value
  sectionGeneration++
  loadedSettings.clear()
  loading.value = true
  error.value = ''
  success.value = ''
  sectionError.value = ''
  project.value = null
  members.value = []
  columnRoles.value = []
  applyToneCountFields([])
  enabledKeyboardIds.value = []
  defaultKeyboardId.value = ''
  keyboardBaseline.value = JSON.stringify([[], ''])
  generatedBatch.value = null
  credentialsDownloaded.value = false
  policyDirty.value = false
  candidateTerm.value = ''
  candidateSearched.value = false
  newMember.userId = ''
  try {
    const nextProject = await getProject(id)
    if (generation !== loadGeneration) return
    if (!nextProject.capabilities.canManage) throw new Error('你没有管理该项目的权限。')
    project.value = nextProject
    details.name = nextProject.name
    details.description = nextProject.description || ''
    settings.accessMode = nextProject.access_mode
    settings.requiredProofreads = Number(nextProject.required_proofreads || 2)
    settings.password = ''
  } catch (e) {
    if (generation === loadGeneration)
      error.value = getPbMessage(e, e.message || '项目配置加载失败。')
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
  if (currentProject(id) && project.value) await activateSettings()
}

async function activateSettings() {
  const id = projectId.value
  const view = settingsView.value
  const generation = ++sectionGeneration
  sectionError.value = ''
  sectionLoading.value = false
  if (!project.value || loadedSettings.has(view)) return
  sectionLoading.value = true
  try {
    if (view === 'rules') {
      const roleView = await getColumnRoles(id)
      if (!currentProject(id) || generation !== sectionGeneration) return
      columnRoles.value = (roleView.columns || []).map((column) => ({ ...column }))
      applyToneCountFields(roleView.tone_count_fields)
      columnRolesNote.value = roleView.headers_truncated
        ? '列名较多，这里只展示前 1000 条里出现过的列。'
        : ''
    } else if (view === 'members') {
      const [nextMembers] = await Promise.all([listProjectMembers(id), candidatePager.search(id)])
      if (!currentProject(id) || generation !== sectionGeneration) return
      members.value = nextMembers
    } else if (view === 'keyboard') {
      const [library, config] = await Promise.all([listKeyboardLibrary(), getProjectKeyboards(id)])
      if (!currentProject(id) || generation !== sectionGeneration) return
      keyboardLibrary.value = library
      enabledKeyboardIds.value = config.items.map((item) => item.keyboardId)
      defaultKeyboardId.value = config.defaultKeyboardId || ''
      keyboardBaseline.value = JSON.stringify([enabledKeyboardIds.value, defaultKeyboardId.value])
    } else if (
      view === 'ownership' &&
      (project.value.capabilities.isOwner || project.value.capabilities.isPlatformAdmin) &&
      !loadedSettings.has('members')
    ) {
      await candidatePager.search(id)
      if (!currentProject(id) || generation !== sectionGeneration) return
    }
    loadedSettings.add(view)
  } catch (e) {
    if (currentProject(id) && generation === sectionGeneration)
      sectionError.value = getPbMessage(e, '此分区加载失败，其他项目设置仍可使用。')
  } finally {
    if (currentProject(id) && generation === sectionGeneration) sectionLoading.value = false
  }
}

async function searchCandidates() {
  if (candidateState.loading) return
  newMember.userId = ''
  await candidatePager.search(projectId.value, candidateTerm.value)
  candidateSearched.value = Boolean(candidateState.term)
}

function applyRoleSuggestions() {
  const headers = columnRoles.value.filter((column) => column.present).map((column) => column.name)
  const suggested = suggestColumnRoles(headers)
  for (const column of columnRoles.value) {
    if (column.present && column.role === 'unspecified')
      column.role = suggested[column.name] || 'unspecified'
  }
}

function applyToneCountFields(fields = []) {
  const [reference = '', comparison = ''] = fields
  toneReference.value = reference
  toneComparison.value = comparison
  rolesBaseline.value = columnSettingsSnapshot()
}

async function saveRoles() {
  if (savingRoles.value || (toneReference.value && !canCompareTone.value)) return
  savingRoles.value = true
  rolesError.value = ''
  rolesSuccess.value = ''
  const id = projectId.value
  try {
    const roles = {}
    for (const column of columnRoles.value) roles[column.name] = column.role
    const fields = canCompareTone.value ? [toneReference.value, toneComparison.value] : []
    const roleView = await saveColumnRoles(id, roles, fields)
    if (!currentProject(id)) return
    columnRoles.value = (roleView.columns || []).map((column) => ({ ...column }))
    applyToneCountFields(roleView.tone_count_fields)
    rolesSuccess.value = '列角色已保存。条目内容没有改动。'
  } catch (e) {
    if (!currentProject(id)) return
    rolesError.value = getPbMessage(e, '列角色保存失败。')
  } finally {
    if (currentProject(id)) savingRoles.value = false
  }
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
  const id = projectId.value
  try {
    const updated = await updateProject(id, { name, description })
    if (!currentProject(id)) return
    project.value = updated
    details.name = project.value.name
    details.description = project.value.description || ''
    detailsSuccess.value = '项目资料已保存。'
  } catch (e) {
    if (!currentProject(id)) return
    detailsError.value = getPbMessage(e, '项目资料保存失败，请重试。')
  } finally {
    if (currentProject(id)) savingDetails.value = false
  }
}

async function saveProofreadRules() {
  if (savingRules.value) return
  savingRules.value = true
  error.value = ''
  success.value = ''
  const id = projectId.value
  try {
    const updated = await updateProject(id, { requiredProofreads: settings.requiredProofreads })
    if (!currentProject(id)) return
    project.value = updated
    success.value = '独立校对规则已保存。'
  } catch (e) {
    if (currentProject(id)) error.value = getPbMessage(e, '校对规则保存失败。')
  } finally {
    if (currentProject(id)) savingRules.value = false
  }
}

async function saveSettings() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  success.value = ''
  const id = projectId.value
  try {
    const updated = await updateProject(id, {
      accessMode: settings.accessMode,
      password: settings.password,
      requiredProofreads: Number(project.value.required_proofreads || 2)
    })
    if (!currentProject(id)) return
    project.value = updated
    settings.password = ''
    success.value = '项目设置已保存，现有成员保持不变。'
  } catch (e) {
    if (!currentProject(id)) return
    error.value = getPbMessage(e, '项目设置保存失败。')
  } finally {
    if (currentProject(id)) saving.value = false
  }
}

async function addMember() {
  savingMember.value = true
  error.value = ''
  const id = projectId.value
  try {
    await setProjectMember(id, newMember.userId, newMember.role)
    if (!currentProject(id)) return
    newMember.userId = ''
    await reloadMembers(id)
    if (!currentProject(id)) return
    success.value = '成员已添加。'
  } catch (e) {
    if (!currentProject(id)) return
    error.value = getPbMessage(e, '成员添加失败。')
  } finally {
    if (currentProject(id)) savingMember.value = false
  }
}

async function changeRole(member, role) {
  error.value = ''
  const id = projectId.value
  try {
    await setProjectMember(id, member.user, role)
    if (!currentProject(id)) return
    await reloadMembers(id)
    if (!currentProject(id)) return
    success.value = '项目角色已更新。'
  } catch (e) {
    if (!currentProject(id)) return
    error.value = getPbMessage(e, '项目角色更新失败。')
  }
}

async function removeMember(member) {
  if (!window.confirm(`确定移除 ${member.name || member.email} 吗？`)) return
  error.value = ''
  const id = projectId.value
  try {
    await removeProjectMember(id, member.user)
    if (!currentProject(id)) return
    await reloadMembers(id)
    if (!currentProject(id)) return
    success.value = '成员已移除。'
  } catch (e) {
    if (!currentProject(id)) return
    error.value = getPbMessage(e, '成员移除失败。')
  }
}

async function reloadMembers(id = projectId.value) {
  const result = await listProjectMembers(id)
  if (!currentProject(id)) return
  members.value = result
  await auth.loadAccessContext({ force: true })
}

async function generateVolunteers() {
  generatingVolunteers.value = true
  error.value = ''
  success.value = ''
  const id = projectId.value
  try {
    const batch = await generateProjectVolunteers(id, {
      ...volunteerForm,
      loginUrl: `${window.location.origin}/login`
    })
    if (!currentProject(id)) return
    generatedBatch.value = batch
    await reloadMembers(id)
    if (!currentProject(id)) return
    success.value = `已生成并加入 ${batch.count} 个志愿者账号。凭据只保留在当前页面。`
    downloadGeneratedCredentials()
  } catch (e) {
    if (!currentProject(id)) return
    error.value = getPbMessage(e, '志愿者账号生成失败，未创建任何账号。')
  } finally {
    if (currentProject(id)) generatingVolunteers.value = false
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
  credentialsDownloaded.value = true
  anchor.remove()
  URL.revokeObjectURL(url)
}

async function transferOwner() {
  if (!window.confirm('确定转移项目所有权吗？你将保留为项目管理员。')) return
  transferring.value = true
  error.value = ''
  const id = projectId.value
  try {
    await transferProjectOwnership(id, nextOwnerId.value)
    if (!currentProject(id)) return
    await auth.loadAccessContext({ force: true })
    if (!currentProject(id)) return
    await load()
    if (!currentProject(id)) return
    success.value = '项目所有权已转移。'
  } catch (e) {
    if (!currentProject(id)) return
    error.value = getPbMessage(e, '所有权转移失败。')
  } finally {
    if (currentProject(id)) transferring.value = false
  }
}

async function removeProject() {
  if (!window.confirm(`确定永久删除项目“${project.value.name}”及其全部材料吗？`)) return
  deleting.value = true
  error.value = ''
  const id = projectId.value
  try {
    await deleteProject(id)
    if (!currentProject(id)) return
    await auth.loadAccessContext({ force: true })
    if (!currentProject(id)) return
    await router.push('/admin')
  } catch (e) {
    if (!currentProject(id)) return
    error.value = getPbMessage(e, '项目删除失败。')
  } finally {
    if (currentProject(id)) deleting.value = false
  }
}

function toggleKeyboard(keyboardId, enabled) {
  const next = enabledKeyboardIds.value.filter((id) => id !== keyboardId)
  if (enabled) next.push(keyboardId)
  enabledKeyboardIds.value = next
  if (!next.includes(defaultKeyboardId.value)) defaultKeyboardId.value = next[0] || ''
}

async function saveKeyboardSettings() {
  if (
    enabledKeyboardIds.value.length &&
    !enabledKeyboardIds.value.includes(defaultKeyboardId.value)
  ) {
    error.value = '请从已启用键盘中选择默认键盘。'
    return
  }
  savingKeyboards.value = true
  error.value = ''
  success.value = ''
  const id = projectId.value
  try {
    const config = await configureProjectKeyboards(
      id,
      enabledKeyboardIds.value,
      defaultKeyboardId.value
    )
    if (!currentProject(id)) return
    enabledKeyboardIds.value = config.items.map((item) => item.keyboardId)
    defaultKeyboardId.value = config.defaultKeyboardId || ''
    keyboardBaseline.value = JSON.stringify([enabledKeyboardIds.value, defaultKeyboardId.value])
    success.value = enabledKeyboardIds.value.length
      ? '项目键盘设置已保存。'
      : '已关闭本项目的键盘入口。'
  } catch (e) {
    if (!currentProject(id)) return
    error.value = getPbMessage(e, '键盘设置保存失败。')
  } finally {
    if (currentProject(id)) savingKeyboards.value = false
  }
}

function sourceLabel(source) {
  return (
    { assigned: '管理员指定', public: '公开加入', password: '口令加入' }[source] || '管理员指定'
  )
}

function originLabel(origin) {
  return origin === 'preset' ? '仓库预置' : '自定义上传'
}
</script>

<style scoped>
.settings-fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.tone-count-settings {
  margin-top: var(--space-4);
}
.tone-count-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  gap: var(--space-3);
  margin-top: var(--space-2);
}
</style>

<style scoped>
.member-candidate-search {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.member-candidate-search input {
  flex: 1;
  min-width: 12rem;
}
</style>
