<template>
  <section class="verification-panel" aria-label="来源与核验记录">
    <p v-if="loading" role="status">正在加载来源与核验约定…</p>
    <div v-if="error" class="alert alert-error" role="alert">
      {{ error }} <button class="btn btn-secondary btn-sm" @click="load">重试</button>
    </div>
    <details
      v-if="data"
      class="verification-details"
      :open="detailsOpen"
      @toggle="detailsOpen = $event.target.open"
    >
      <summary
        class="verification-summary"
        :class="{ 'verification-summary--blocked': hasBlocker }"
      >
        <span
          ><strong>来源与约定</strong
          ><span class="verification-status">{{
            hasBlocker ? '有事项需要处理' : data.context.policy ? '按当前约定核对' : '约定尚未配置'
          }}</span></span
        >
        <span class="verification-source-label"
          >{{ data.context.source?.name || '来源未配置' }} · 第 {{ data.context.pdf_page }} 页</span
        >
        <span class="verification-summary-action">约定与问题</span>
      </summary>
      <div class="verification-detail-body">
        <strong
          >来源 PDF：{{ data.context.source?.name || '尚未配置，请提交来源问题' }} · 物理第
          {{ data.context.pdf_page }} 页</strong
        >
        <p>
          {{
            data.context.policy?.instructions ||
            '逐字段对照来源 PDF；原文没有内容时保留空白，无法判断时提交问题。项目约定版本尚未记录。'
          }}
        </p>
        <p class="text-sm text-muted">
          约定：{{ data.context.policy_id || '旧版／未记录'
          }}<span v-if="data.context.policy?.tone_equivalence">
            · 指定记音字段允许声调普通数字与右上标，数字及所属音节须相同</span
          >
        </p>
        <p class="text-sm">
          机器提示只提供核对线索；未提示字段也要逐一对照。可从疑点打开来源页，导入文本中的高亮标出可定位的内容。
        </p>
        <p
          v-if="data.context.policy && !data.context.source_approved"
          class="alert alert-error"
          role="alert"
        >
          当前来源尚未纳入此版约定，请保存草稿并提交来源问题，待管理员更新约定后继续。
        </p>
        <p v-if="data.context.policy_compatible === false" class="alert alert-error" role="alert">
          记音字段配置已变化，请管理员更新核验约定后再完整提交。
        </p>
        <div
          v-for="notice in routingHelp ? data.announcements : []"
          :key="notice.id"
          class="alert"
          role="status"
        >
          {{ PROBLEM_STATES[notice.status] }}：{{ notice.feedback }} {{ notice.impact }}
          <span v-if="notice.stale">（来源或配置已变更，此处理说明需重新确认适用范围）</span>
          <span>内容仍须逐字段核对。</span>
        </div>
        <div v-if="staleDraft" class="alert alert-error" role="alert">
          草稿的来源、导入文本或约定已变化，未自动套用。旧草稿仍保留，请对照最新来源重新处理。
          <details>
            <summary>查看旧草稿</summary>
            <dl>
              <template v-for="(value, field) in staleDraft.row" :key="field"
                ><dt>{{ field }}</dt>
                <dd>{{ value || '（空白）' }}</dd></template
              >
            </dl>
          </details>
        </div>
        <details v-if="data.draft_history?.length">
          <summary>本人旧版草稿（{{ data.draft_history.length }}）</summary>
          <dl v-for="event in data.draft_history" :key="event.id">
            <template v-for="(value, field) in event.payload.row" :key="field"
              ><dt>{{ event.at }} · {{ field }}</dt>
              <dd>{{ value || '（空白）' }}</dd></template
            >
          </dl>
        </details>
        <details v-if="routingHelp">
          <summary>字段处理记录（保留／修改／暂未完成）</summary>
          <p class="text-sm">
            实际修改会随提交保存；需要补充说明或尚未完成时在此记录。这些操作不作为独立来源正误标签。
          </p>
          <label class="form-label"
            >字段
            <select v-model="selectedField" class="form-control">
              <option v-for="field in fields" :key="field">{{ field }}</option>
            </select></label
          >
          <template v-if="selectedField">
            <label class="form-label"
              ><input
                type="checkbox"
                :checked="incomplete.includes(selectedField)"
                @change="setIncomplete(selectedField, $event.target.checked)"
              />
              本字段暂未完成</label
            >
            <label class="form-label"
              >简短原因
              <select
                v-model="notes[selectedField].reason"
                class="form-control"
                @change="scheduleSave"
              >
                <option value="source_checked">已对照来源</option>
                <option value="source_blank">来源无内容，保留空白</option>
                <option value="source_content">按来源补抄／修正</option>
                <option value="legal_notation">合法声调形式，保留实际写法</option>
                <option value="reported">已提交问题，等待处理</option>
                <option value="other">其他</option>
              </select>
            </label>
            <label class="form-label"
              >补充说明（可选）<input
                v-model="notes[selectedField].note"
                class="form-control"
                maxlength="2000"
                @input="scheduleSave"
            /></label>
          </template>
        </details>
        <div class="verification-actions">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="!active || saving"
            @click="reportOpen = !reportOpen"
          >
            提交问题
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="saving || !active"
            @click="saveExplicitDraft"
          >
            保存未完成工作
          </button>
          <RouterLink to="/tasks/problems" class="btn btn-quiet btn-sm">我的问题与草稿</RouterLink>
        </div>
        <form v-if="reportOpen" class="verification-report" @submit.prevent="sendReport">
          <label class="form-label"
            >涉及字段<select
              :value="report.field"
              class="form-control"
              :disabled="saving"
              @change="switchReportTarget($event.target.value, '')"
            >
              <option value="">整条／来源页</option>
              <option v-for="field in fields" :key="field">{{ field }}</option>
            </select></label
          >
          <label class="form-label"
            >问题类型<select v-model="report.category" class="form-control" :disabled="saving">
              <option v-for="(label, key) in PROBLEM_TYPES" :key="key" :value="key">
                {{ label }}
              </option>
            </select></label
          >
          <label class="form-label"
            >相关提示（可选）<select
              :value="report.finding"
              class="form-control"
              :disabled="saving"
              @change="switchReportTarget(report.field, $event.target.value)"
            >
              <option value="">不针对某条提示</option>
              <option v-for="hint in matchingHints" :key="hint.id" :value="hint.id">
                {{ hint.field || '整条' }} · {{ hintKindLabel(hint.kind) }}
              </option>
            </select></label
          >
          <label class="form-label"
            >问题说明<textarea
              ref="reportDescription"
              v-model="report.description"
              class="form-control"
              :disabled="saving"
              required
              maxlength="4000"
              placeholder="说明看不清、无法输入或需要帮助的位置"
            ></textarea>
          </label>
          <label class="form-label"
            ><input v-model="report.blocking" type="checkbox" :disabled="saving" />
            此问题使本条无法完成；保留草稿，等待处理</label
          >
          <button class="btn btn-primary btn-sm" :disabled="saving || !active">
            {{ saving ? '正在保存…' : '保存草稿并提交问题' }}
          </button>
        </form>
        <p v-if="message" role="status">{{ message }}</p>
        <p v-if="saveError" class="alert alert-error" role="alert">{{ saveError }}</p>
        <ul v-if="data.reports.length" class="text-sm">
          <li v-for="item in data.reports" :key="item.id">
            {{ item.field || '整条' }}：{{ PROBLEM_STATES[item.issue.status] }} ·
            {{ item.issue.feedback || '等待管理员受理'
            }}<span v-if="item.blocking_unresolved"
              >（阻塞未解决或处理版本已失效，暂不能完整提交）</span
            >
          </li>
        </ul>
      </div>
    </details>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  getVerification,
  saveVerificationDraft,
  reportProblem,
  PROBLEM_STATES,
  PROBLEM_TYPES
} from '@/services/verificationService'
import { hintKindLabel } from '@/lib/fieldHints'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

const props = defineProps({
  page: Object,
  row: Object,
  leaseToken: String,
  hints: { type: Array, default: () => [] },
  active: Boolean,
  routingHelp: { type: Boolean, default: true }
})
const emit = defineEmits(['restore', 'context'])
const data = ref(null)
const loading = ref(false)
const error = ref('')
const saveError = ref('')
const message = ref('')
const saving = ref(false)
const staleDraft = ref(null)
const selectedField = ref('')
const incomplete = ref([])
const notes = reactive({})
const reportOpen = ref(false)
const detailsOpen = ref(false)
const hasBlocker = computed(() =>
  Boolean(
    error.value ||
    incomplete.value.length > 0 ||
    saveError.value ||
    staleDraft.value ||
    (data.value?.context.policy && !data.value.context.source_approved) ||
    data.value?.context.policy_compatible === false ||
    data.value?.reports?.some((item) => item.blocking_unresolved)
  )
)
watch(hasBlocker, (blocked) => {
  if (blocked) detailsOpen.value = true
})
watch(reportOpen, (open) => {
  if (open) detailsOpen.value = true
})

function emptyReport() {
  return { field: '', category: 'input_display', finding: '', description: '', blocking: false }
}

const report = reactive(emptyReport())
// Keep unsent reports on this entry apart, including manual changes of target.
const reportDrafts = new Map()
const reportKey = (field, finding) => JSON.stringify([field, finding])
const reportDescription = ref(null)
const canReport = computed(() => !!data.value && props.active && !saving.value)
const fields = computed(() => Object.keys(props.row || {}))
const matchingHints = computed(() =>
  props.hints.filter((hint) => hint.id && (!report.field || report.field === hint.field))
)
let generation = 0
let timer
let restoring = false
let inFlight = Promise.resolve()

watch(
  () => props.page?.id,
  () => {
    void load()
  },
  { immediate: true }
)
watch(
  () => props.row,
  () => {
    if (!restoring) scheduleSave()
  },
  { deep: true }
)
onBeforeUnmount(() => {
  generation++
  clearTimeout(timer)
})

async function load() {
  const pageId = props.page?.id
  const token = ++generation
  clearTimeout(timer)
  restoring = false
  data.value = null
  staleDraft.value = null
  incomplete.value = []
  for (const key of Object.keys(notes)) delete notes[key]
  error.value = ''
  saveError.value = ''
  message.value = ''
  reportOpen.value = false
  Object.assign(report, emptyReport())
  reportDrafts.clear()
  detailsOpen.value = false
  saving.value = false
  if (!pageId) return
  loading.value = true
  try {
    const result = await getVerification(pageId).catch((error) => {
      // Research events can advance the verification revision during this read.
      if (getPbStatus(error) !== 409 || token !== generation) throw error
      return getVerification(pageId)
    })
    if (token !== generation) return
    restoring = true
    for (const field of Object.keys(result.context.input))
      notes[field] = { reason: 'source_checked', note: '' }
    selectedField.value = Object.keys(result.context.input)[0] || ''
    data.value = result
    emit('context', result.context)
    await nextTick()
    if (token !== generation) return
    if (result.draft?.stale) staleDraft.value = result.draft
    else if (result.draft) {
      incomplete.value = result.draft.incomplete || []
      for (const item of result.draft.actions || [])
        if (notes[item.field]) Object.assign(notes[item.field], item)
      if (
        Object.keys(result.context.input).every(
          (field) => props.row[field] === result.context.input[field]
        )
      ) {
        emit('restore', result.draft.row)
        message.value = '已恢复服务端草稿及未完成字段；请继续对照来源。'
      } else message.value = '本机已有未提交修改，未用服务端草稿覆盖；服务端未完成字段仍保留。'
    }
    queueMicrotask(() => {
      restoring = false
    })
  } catch (e) {
    if (token === generation) error.value = getPbMessage(e, '来源与核验记录加载失败')
  } finally {
    if (token === generation) {
      loading.value = false
      restoring = false
    }
  }
}

function actions() {
  const original = data.value?.context.input || {}
  return fields.value
    .filter(
      (field) =>
        incomplete.value.includes(field) ||
        props.hints.some((hint) => hint.field === field) ||
        original[field] !== props.row[field] ||
        notes[field]?.note ||
        notes[field]?.reason !== 'source_checked'
    )
    .map((field) => ({
      field,
      action: incomplete.value.includes(field)
        ? 'incomplete'
        : original[field] === props.row[field]
          ? 'kept'
          : 'modified',
      reason: notes[field]?.reason || 'source_checked',
      note: notes[field]?.note || '',
      finding_ids: props.hints
        .filter((hint) => hint.field === field && hint.id)
        .map((hint) => hint.id)
    }))
}
function payload() {
  if (!data.value) throw new Error('请先加载有效来源与核验约定')
  return { basis: data.value.context.basis, actions: actions(), incomplete: [...incomplete.value] }
}
function draftPayload() {
  return { ...payload(), row: { ...props.row }, leaseToken: props.leaseToken }
}
function setIncomplete(field, checked) {
  incomplete.value = checked
    ? [...new Set([...incomplete.value, field])]
    : incomplete.value.filter((item) => item !== field)
  scheduleSave()
}
function scheduleSave() {
  clearTimeout(timer)
  if (!data.value || !props.active || restoring) return
  timer = setTimeout(() => {
    void persistDraft().catch(() => {})
  }, 900)
}
async function persistDraft() {
  clearTimeout(timer)
  if (!props.active || !props.leaseToken) return
  const id = props.page.id
  const token = generation
  const body = draftPayload()
  const request = inFlight
    .catch(() => {})
    .then(() => {
      if (token !== generation || id !== props.page?.id) return
      return saveVerificationDraft(id, body)
    })
  inFlight = request
  try {
    await request
    if (token === generation && props.page?.id === id) {
      saveError.value = ''
      staleDraft.value = null
      message.value = '未完成工作已保存到服务端，不计入正式校对提交。'
    }
  } catch (e) {
    if (token === generation && props.page?.id === id)
      saveError.value = getPbMessage(e, '服务端草稿保存失败；本机草稿仍保留')
    throw e
  }
}
async function prepareSubmit() {
  clearTimeout(timer)
  await inFlight.catch(() => {})
  return payload()
}
async function saveExplicitDraft() {
  saving.value = true
  try {
    await persistDraft()
  } catch {
    /* shown next to the form */
  } finally {
    saving.value = false
  }
}
function switchReportTarget(field, finding) {
  if (saving.value || (report.field === field && report.finding === finding)) return
  const category = finding ? 'hint' : report.finding ? 'input_display' : report.category
  reportDrafts.set(reportKey(report.field, report.finding), { ...report })
  Object.assign(
    report,
    reportDrafts.get(reportKey(field, finding)) || {
      ...emptyReport(),
      field,
      finding,
      category
    }
  )
}

async function openReport(hint) {
  if (!canReport.value || !props.hints.some(({ id }) => id === hint.id)) return
  const pageId = props.page?.id
  const field = fields.value.includes(hint.targetField) ? hint.targetField : ''
  switchReportTarget(field, hint.id)
  reportOpen.value = true
  detailsOpen.value = true
  await nextTick()
  if (pageId !== props.page?.id || !canReport.value) return
  reportDescription.value?.focus()
}

async function sendReport() {
  if (saving.value || !props.active || !data.value) return
  const token = generation
  const id = props.page.id
  const isCurrent = () => token === generation && id === props.page?.id
  saving.value = true
  saveError.value = ''
  message.value = ''
  try {
    if (report.blocking && report.field) setIncomplete(report.field, true)
    const result = await reportProblem(id, {
      ...report,
      basis: payload().basis,
      leaseToken: props.leaseToken,
      draft: draftPayload()
    })
    if (!isCurrent()) return
    clearTimeout(timer)
    data.value.reports.push(result)
    reportOpen.value = false
    message.value = report.blocking
      ? '问题和草稿已保存。待处理期间可释放任务，稍后从“我的问题与草稿”恢复。'
      : '问题已提交，可继续逐字段核对。'
    reportDrafts.delete(reportKey(report.field, report.finding))
    Object.assign(report, emptyReport())
  } catch (e) {
    if (isCurrent()) saveError.value = getPbMessage(e, '问题提交失败，请重试')
  } finally {
    if (isCurrent()) saving.value = false
  }
}
defineExpose({ payload, persistDraft, prepareSubmit, canReport, openReport })
</script>

<style scoped>
.verification-panel {
  padding: var(--space-3);
  margin-bottom: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-raised);
}
.verification-panel p {
  margin: var(--space-2) 0;
}
.verification-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.verification-report {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--line);
}
.verification-panel .form-label {
  display: block;
  margin-top: var(--space-2);
}
</style>
