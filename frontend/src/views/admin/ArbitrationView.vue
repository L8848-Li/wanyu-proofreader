<template>
  <h1 class="sr-only">{{ verificationMode ? '来源核验' : '条目仲裁' }}</h1>
  <DocumentReviewWorkspace
    class="arbitration-studio"
    inline-source-toggle
    :page="casePage"
    :keyboard-available="keyboardAvailable"
    :suspended="(mobile && overview) || reviewingSubmission"
    :loading="loading"
    :watermark-user-id="currentUserId"
    :return-to="
      todoReturn
        ? router.resolve(todoReturn).fullPath
        : verificationMode
          ? sourceReviewListTarget(projectId, sourceReviewScope)
          : arbitrationReturnTarget
    "
    :return-label="todoReturn ? '返回统一待办' : '返回列表'"
    content-labelled-by="arbitration-panel-title"
    empty-pdf-description="请保存进度并处理来源问题，待来源 PDF 可用后继续核验。"
  >
    <template #panel-header="{ compact, sourceCollapsed, toggleSource }">
      <header class="editor-panel-header editor-panel-header--task">
        <div class="editor-context">
          <span
            >{{ verificationMode ? '管理员来源核验' : '管理员仲裁台' }} · 第
            {{ casePage?.proofread_round || '—' }} 轮</span
          >
          <strong id="arbitration-panel-title">第 {{ casePage?.page_number || '—' }} 条</strong>
        </div>
        <div class="editor-toolbar">
          <AppButton
            v-if="compact"
            size="sm"
            :aria-expanded="!sourceCollapsed"
            aria-controls="review-source"
            @click="toggleSource"
            >{{ sourceCollapsed ? '查看原文' : '收起原文' }}</AppButton
          >
          <span v-if="submitted" class="task-position">本条已保存</span>
          <span v-else-if="casePage && (verificationMode || loading)" class="task-position"
            >{{ resolvedCount }} / {{ differingHeaders.length }} 项差异</span
          >
          <AppButton
            v-if="!submitted && !mobile"
            variant="primary"
            size="sm"
            :loading="submitting"
            :disabled="
              submitting || loading || submitted || unresolvedHeaders.length > 0 || !caseData
            "
            :aria-keyshortcuts="!verificationMode ? 'Control+Enter Meta+Enter' : undefined"
            @click="openSubmitReview"
          >
            {{ submitting ? '保存中…' : verificationMode ? '检查并完成核验' : '检查并完成仲裁' }}
          </AppButton>
        </div>
      </header>
      <nav v-if="!verificationMode" class="arbitration-queue" aria-label="待仲裁队列">
        <span class="task-position" role="status"
          >{{ validImportJob(importJob) ? '本批次 · ' : '' }}{{ queuePositionLabel }}</span
        >
        <AppButton
          size="sm"
          class="arbitration-queue-step"
          aria-label="上一条"
          :disabled="
            queueState !== 'ready' || !queueData?.previous || submitting || loading || submitted
          "
          @click="navigateQueue(queueData.previous)"
        >
          <AppIcon name="back" /><span class="arbitration-queue-label">上一条</span>
        </AppButton>
        <AppButton
          size="sm"
          class="arbitration-queue-step"
          aria-label="下一条"
          :disabled="
            queueState !== 'ready' ||
            !queueData?.next ||
            submitting ||
            loading ||
            submitted ||
            unresolvedHeaders.length > 0
          "
          @click="navigateQueue(queueData.next, true)"
        >
          <span class="arbitration-queue-label">下一条</span><AppIcon name="arrow" />
        </AppButton>
        <button
          v-if="queueState === 'error'"
          class="btn btn-secondary btn-sm"
          :disabled="submitting"
          @click="submitted ? continueAfterSubmit() : loadQueue()"
        >
          重试加载队列
        </button>
      </nav>
      <div
        v-if="caseData && !loading && !submitted && !verificationMode"
        class="arbitration-progress-note"
      >
        <p role="status" aria-atomic="true">
          <strong>差异已确认 {{ resolvedCount }} / {{ differingHeaders.length }}</strong>
          <span v-if="unresolvedHeaders.length"> · 剩余 {{ unresolvedHeaders.length }} 处</span>
        </p>
        <AppButton
          v-if="!mobile && differingHeaders.length"
          type="button"
          size="sm"
          :disabled="!unresolvedHeaders.length || submitting"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          @click="goToUnresolved()"
          >下一处待确认字段</AppButton
        >
      </div>
      <p v-if="!verificationMode && queueError" class="alert alert-error" role="alert">
        {{ queueError }}
      </p>
      <p v-if="queueMessage" class="alert alert-success" role="status">{{ queueMessage }}</p>
      <p v-if="continuingSourceReview" role="status">本条核验已保存，正在载入下一条…</p>
      <div
        v-if="verificationMode && submitted && sourceQueueError"
        class="alert alert-error"
        role="alert"
      >
        <p>{{ sourceQueueError }}</p>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="continuingSourceReview"
          @click="continueSourceReview"
        >
          重试继续来源复核
        </button>
        <RouterLink
          :to="todoReturn || sourceReviewListTarget(projectId, sourceReviewScope)"
          class="btn btn-quiet btn-sm"
          >{{ todoReturn ? '返回统一待办' : '返回来源复核列表' }}</RouterLink
        >
      </div>
    </template>

    <template #default="{ inputMode }">
      <div v-if="loading" class="panel-loading" aria-live="polite">正在加载校对结果与原文…</div>
      <div v-else-if="error" class="alert alert-error" role="alert">{{ error }}</div>

      <template v-else-if="caseData && !submitted">
        <AppDisclosure
          v-if="verificationData"
          v-model="sourceEvidenceOpen"
          class="arbitration-source-context verification-details"
        >
          <template #summary
            ><span class="arbitration-evidence-summary">
              <strong>来源与核验依据</strong
              ><span class="verification-status">{{
                verificationData.completion?.needs_review
                  ? '旧判断需要复核'
                  : '采用与来源正误分别记录'
              }}</span>
            </span></template
          >
          <strong
            >来源 PDF：{{ verificationData.context.source?.name || '未记录' }} · 物理第
            {{ verificationData.context.pdf_page }} 页</strong
          >
          <p>
            {{
              verificationData.context.policy?.instructions ||
              '逐字段对照固定来源 PDF；约定版本尚未记录。'
            }}
          </p>
          <p>
            约定版本：{{
              verificationData.context.policy_id || '旧版／未记录'
            }}。采用最终值不代表其他合法提交错误；未核实字段不自动记为正确。
          </p>
          <p v-if="verificationData.completion?.needs_review" role="alert">
            来源或约定已变化，旧判断需要复核。
          </p>
          <p
            v-if="verificationData.context.policy_compatible === false"
            class="alert alert-error"
            role="alert"
          >
            记音字段配置已变化，请先更新核验约定。
          </p>
          <p
            v-if="
              verificationData.context.policy && verificationData.context.source_approved === false
            "
            class="alert alert-error"
            role="alert"
          >
            当前来源尚未纳入此版约定，请先复核来源。
          </p>
        </AppDisclosure>
        <p v-if="progressMessage" class="alert alert-success" role="status">
          {{ progressMessage }}
        </p>
        <RareCharacterNotice
          :texts="[
            ...Object.values(originalRow),
            ...Object.values(finalRow),
            ...attemptRows.flatMap((item) => Object.values(item.row))
          ]"
        />

        <section class="arbitration-workspace">
          <header class="arbitration-toolbar">
            <div>
              <h2>字段处理</h2>
            </div>
            <div class="arbitration-toolbar__view" role="group" aria-label="字段显示范围">
              <button
                type="button"
                :class="{ active: !showAllFields }"
                :aria-pressed="!showAllFields"
                @click="showAllFields = false"
              >
                仅看差异 {{ differingHeaders.length }}
              </button>
              <button
                type="button"
                :class="{ active: showAllFields }"
                :aria-pressed="showAllFields"
                @click="showAllFields = true"
              >
                全部字段 {{ headers.length }}
              </button>
            </div>
          </header>

          <p v-if="differingHeaders.length" class="arbitration-diff-note">
            下划线标出字符差异。各份文本与第一份校对结果对齐。
          </p>
          <AppDisclosure class="bulk-actions-menu" label="批量处理">
            <div
              v-if="differingHeaders.length"
              class="bulk-source-actions"
              aria-label="批量采用来源"
            >
              <span>批量处理差异项</span>
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                @click="applySourceToDifferences('original')"
              >
                全部采用导入值
              </button>
              <button
                v-for="item in attemptRows"
                :key="`bulk-${item.key}`"
                type="button"
                class="btn btn-secondary btn-sm"
                @click="applySourceToDifferences(item.key)"
              >
                全部采用{{ item.label }}
              </button>
            </div>
          </AppDisclosure>
          <div v-if="visibleHeaders.length" class="arbitration-fields">
            <article
              v-for="{ header, sources, changes, limited } in comparisonFields"
              :key="header"
              class="arbitration-field"
              tabindex="-1"
              :aria-label="header"
              v-show="!mobile || overview || currentField === header"
              :class="{
                'arbitration-field--resolved': isResolved(header),
                'arbitration-field--matching': !differs(header)
              }"
            >
              <header class="arbitration-field__header">
                <button
                  v-if="mobile && overview"
                  class="btn btn-secondary"
                  @click="selectField(visibleHeaders.indexOf(header))"
                >
                  修改此字段
                </button>
                <h3>{{ header }}</h3>
                <span v-if="!differs(header)" class="resolution-state resolution-state--matching"
                  >结果一致</span
                >
                <span
                  v-else-if="isResolved(header)"
                  class="resolution-state resolution-state--resolved"
                  >已确认 · {{ resolutionLabel(header) }}</span
                >
                <span v-else class="resolution-state resolution-state--pending">待确认</span>
                <AppButton
                  v-if="
                    !mobile &&
                    !verificationMode &&
                    isResolved(header) &&
                    differs(header) &&
                    unresolvedHeaders.length
                  "
                  type="button"
                  size="sm"
                  variant="ghost"
                  :disabled="submitting"
                  @click="goToUnresolved(header)"
                  >下一处待确认</AppButton
                >
              </header>

              <div class="arbitration-source-grid">
                <section
                  v-for="source in sources"
                  :key="source.key"
                  class="comparison-option"
                  :class="{ selected: sourceIs(header, source.key) }"
                >
                  <span>{{ source.label }}</span>
                  <AppFieldValue
                    as="p"
                    :value="source.value"
                    :segments="source.segments?.length ? source.segments : null"
                    :class="{ 'arbitration-diff-empty': source.segments?.length === 0 }"
                    :lang="fieldValueLanguage(header)"
                    :font-notice="false"
                  />
                  <AppButton
                    size="sm"
                    :disabled="submitting"
                    :aria-pressed="sourceIs(header, source.key)"
                    @click="pickValue(header, source.key)"
                    >{{ source.key === 'original' ? '采用导入值' : '采用此结果' }}</AppButton
                  >
                </section>
              </div>
              <p v-if="limited" class="arbitration-diff-note">部分内容只能按段或按原文对照。</p>
              <AppDisclosure
                v-if="changes.length"
                class="arbitration-diff-details"
                :label="`查看「${header}」的差异码位`"
                lazy
              >
                <ul>
                  <li v-for="source in changes" :key="source.key">
                    <span>{{ source.label }}</span>
                    <code>{{ diffCodePoints(source.segments) || '（空白）' }}</code>
                  </li>
                </ul>
              </AppDisclosure>
              <div class="final-value" :class="{ selected: sourceIs(header, 'custom') }">
                <div class="arbitration-final-heading">
                  <h4>最终采用值</h4>
                  <span class="arbitration-adoption-status" :key="resolutionSource[header]">{{
                    isResolved(header) ? resolutionLabel(header) : '待确认采用'
                  }}</span>
                </div>
                <textarea
                  :inputmode="inputMode"
                  :readonly="submitting || (mobile && overview)"
                  :ref="(element) => setTextareaRef(header, element)"
                  v-model="finalRow[header]"
                  :lang="fieldValueLanguage(header) || undefined"
                  class="form-control"
                  :aria-label="`${header}的最终仲裁结果`"
                  @focus="rememberSelection(header, $event)"
                  @blur="rememberSelection(header, $event)"
                  @select="rememberSelection(header, $event)"
                  @keyup="rememberSelection(header, $event)"
                  @click="rememberSelection(header, $event)"
                  @input="onFinalInput(header)"
                ></textarea>
              </div>
              <section
                v-if="verificationData"
                class="arbitration-judgments"
                :aria-label="`${header} 来源判断`"
              >
                <header>
                  <h4>来源判断</h4>
                  <p>与采用值分别记录；未核实保持未记录。</p>
                </header>
                <div class="arbitration-judgment-grid">
                  <SourceJudgmentInput
                    v-for="item in attemptRows"
                    :key="`${header}-judgment-${item.key}`"
                    :disabled="submitting"
                    :label="item.label"
                    :model-value="judgmentFor(item.attempt.id, header)"
                    @update:model-value="setJudgment(item.attempt.id, header, $event)"
                  />
                  <SourceJudgmentInput
                    class="arbitration-final-judgment"
                    :disabled="submitting"
                    label="最终采用值"
                    :model-value="judgmentFor('final', header)"
                    @update:model-value="setJudgment('final', header, $event)"
                  />
                </div>
              </section>
            </article>
          </div>

          <div v-else class="empty-state">
            <div class="empty-state-mark" aria-hidden="true">同</div>
            <div class="empty-state-text">所有校对结果一致</div>
            <p>可切换到“全部字段”并结合原文复核。</p>
          </div>
        </section>

        <section v-show="!mobile || overview" class="arbitration-submit-card">
          <div class="flex gap-2">
            <button class="btn btn-secondary" :disabled="submitting" @click="saveProgress(false)">
              保存判断与进度
            </button>
            <button class="btn btn-secondary" :disabled="submitting" @click="saveProgress(true)">
              暂缓本条完成
            </button>
          </div>
          <div class="form-group">
            <label class="form-label" for="arbitration-note"
              >仲裁说明 <span class="text-muted">（可选）</span></label
            >
            <textarea
              id="arbitration-note"
              v-model="note"
              class="form-control"
              maxlength="4000"
              placeholder="记录选择依据、疑难点或需要后续统一的校对规范"
            ></textarea>
          </div>
          <div v-if="submitError" class="alert alert-error" role="alert">{{ submitError }}</div>
          <div class="arbitration-submit-actions">
            <p>
              <strong v-if="unresolvedHeaders.length"
                >还有 {{ unresolvedHeaders.length }} 个差异字段未确认</strong
              >
              <strong v-else>差异采用已确认</strong>
              <span>提交后将完成条目，并永久保留全部校对结果与本次仲裁记录。</span>
            </p>
          </div>
          <AppDisclosure
            v-if="verificationData?.history?.length"
            class="arbitration-history"
            :label="`处理与判断历史（${verificationData.history.length}）`"
          >
            <ul>
              <li v-for="event in verificationData.history" :key="event.id">
                {{ event.at }} · {{ event.field || '本条' }} · {{ historyLabel(event) }} ·
                {{ historyReason(event)
                }}<span v-if="event.payload.value !== undefined">
                  · 当时值：{{ displayValue(event.payload.value) }}</span
                >
              </li>
            </ul>
          </AppDisclosure>
        </section>
      </template>
    </template>
    <template #navigation
      ><FieldNavigation
        v-if="caseData && !submitted"
        :headers="visibleHeaders"
        :index="fieldIndex"
        :overview="overview"
        :workflow-label="verificationMode ? '来源核验' : '仲裁'"
        @select="selectField"
        @next="nextField"
        @overview="overview = true"
      >
        <template #submit
          ><AppButton
            variant="primary"
            :loading="submitting"
            :disabled="loading || submitted || unresolvedHeaders.length > 0 || !caseData"
            @click="openSubmitReview"
            >{{ verificationMode ? '检查并核验' : '检查并仲裁' }}</AppButton
          ></template
        >
      </FieldNavigation></template
    >
    <template #keyboard
      ><ProjectKeyboard
        v-if="casePage && !submitted"
        :project-id="casePage.project"
        @availability="keyboardAvailable = $event"
        @insert="insertText"
    /></template>
  </DocumentReviewWorkspace>

  <AppModal
    :open="reviewingSubmission"
    title-id="arbitration-review-title"
    mark="裁"
    @close="closeSubmitReview"
  >
    <div class="page-eyebrow">最终确认</div>
    <h2 id="arbitration-review-title">
      完成第 {{ casePage?.page_number }} 条{{ verificationMode ? '来源核验' : '仲裁' }}？
    </h2>
    <p>
      已确认 {{ differingHeaders.length }} 个差异字段，其中
      {{ sourceCount('custom') }} 个经过手工编辑。
    </p>
    <label class="form-label"
      ><input v-model="reviewSourceChecked" type="checkbox" /> 我已逐字段对照本条当前来源
      PDF（依据变更时必须重新确认）</label
    >
    <p class="text-sm text-muted">提交后条目进入“校对完成”，该操作不能在当前界面撤回。</p>
    <template #actions>
      <button type="button" class="btn btn-secondary" @click="closeSubmitReview">继续检查</button>
      <button
        autofocus
        type="button"
        class="btn btn-success"
        :disabled="submitting"
        @click="submitFinal"
      >
        {{ submitting ? '正在保存…' : verificationMode ? '确认完成核验' : '确认完成仲裁' }}
      </button>
    </template>
  </AppModal>
</template>

<script setup>
import AppFieldValue from '@/components/AppFieldValue.vue'
import { fieldValueLanguage } from '@/lib/fieldValue'
import { compareArbitrationValues, diffCodePoints } from '@/lib/arbitrationDiff'
import AppModal from '@/components/AppModal.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import AppIcon from '@/components/AppIcon.vue'
import '@/styles/arbitration-workspace.css'
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import SourceJudgmentInput from '@/components/editor/SourceJudgmentInput.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  RouterLink,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter
} from 'vue-router'
import DocumentReviewWorkspace from '@/components/editor/DocumentReviewWorkspace.vue'
import FieldNavigation from '@/components/editor/FieldNavigation.vue'
import AppButton from '@/components/AppButton.vue'
import { useFieldNavigation } from '@/composables/useFieldNavigation'
import ProjectKeyboard from '@/components/editor/ProjectKeyboard.vue'
import { composeRowText, safeParseRowJson } from '@/composables/useStructuredRow'
import { getDifferingHeadersForRows, getUnresolvedHeaders } from '@/lib/workspaceInsights'
import { currentUserId as getCurrentUserId } from '@/services/authService'
import {
  getArbitrationCase,
  getArbitrationQueue,
  submitArbitration
} from '@/services/arbitrationService'
import { useArbitrationQueue } from '@/composables/useArbitrationQueue'
import {
  getVerification,
  getVerificationSummary,
  saveSourceJudgments
} from '@/services/verificationService'
import {
  nextSourceReviewItem,
  sourceReviewListTarget,
  sourceReviewTarget
} from '@/lib/sourceReviewQueue'
import { getPbMessage } from '@/utils/pbErrors'
import { todoReturnTarget } from '@/lib/unifiedTodos'
import { importJobScope, validImportJob } from '@/lib/adminPageList'
import { batchReportNavigationQuery, readBatchReportContext } from '@/lib/batchReportContext'

const route = useRoute()
const router = useRouter()
const todoReturn = computed(() => todoReturnTarget(route))
const projectId = computed(() => String(route.params.projectId || ''))
const pageId = computed(() => String(route.params.pageId || ''))
const importJob = computed(() => importJobScope(route.query.importJob))
const batchReportContext = computed(() => readBatchReportContext(route.query, projectId.value))
const arbitrationReturnTarget = computed(() => {
  if (importJob.value && !validImportJob(importJob.value))
    return `/admin/projects/${projectId.value}?section=materials&view=batches#project-ledger`
  const base = `/admin/projects/${projectId.value}?section=work&status=arbitration`
  const origin = new URLSearchParams(
    batchReportNavigationQuery(batchReportContext.value)
  ).toString()
  return (
    (importJob.value ? `${base}&importJob=${importJob.value}` : base) + (origin ? `&${origin}` : '')
  )
})
const {
  state: queueState,
  error: queueError,
  data: queueData,
  refresh: refreshQueue,
  positionLabel: queuePositionLabel
} = useArbitrationQueue((project, anchor) => getArbitrationQueue(project, anchor, importJob.value))
const queueMessage = ref('')
const sourceQueueError = ref('')
const continuingSourceReview = ref(false)
const sourceReviewScope = computed(() => (route.query.reviewScope === 'all' ? 'all' : 'todo'))
const loadQueue = () => refreshQueue(projectId.value, pageId.value)
let caseVersion = 0
const verificationMode = computed(
  () => caseData.value?.mode === 'verification' || route.query.mode === 'verification'
)
const verificationData = ref(null)
const sourceEvidenceOpen = ref(false)
watch(verificationData, (data) => {
  if (
    data &&
    (data.completion?.needs_review ||
      data.context.policy_compatible === false ||
      !data.context.source_approved)
  )
    sourceEvidenceOpen.value = true
})
const judgmentDrafts = reactive({})
const progressMessage = ref('')
const reviewSourceChecked = ref(false)

const loading = ref(true)
const error = ref('')
const submitting = ref(false)
const submitError = ref('')
const submitted = ref(false)
const reviewingSubmission = ref(false)
const showAllFields = ref(false)
const caseData = ref(null)
const attemptRows = ref([])
const originalRow = reactive({})
const finalRow = reactive({})
const resolutionSource = reactive({})
const resolvedHeaders = reactive(new Set())
const touchedHeaders = reactive(new Set())
const note = ref('')
const lastSavedNote = ref('')
const activeSelection = ref({ field: '', start: null, end: null })
const textareaRefs = new Map()

const currentUserId = computed(() => getCurrentUserId() || '')
const casePage = computed(() => caseData.value?.page || null)
const headers = computed(() => [
  ...new Set([
    ...Object.keys(originalRow),
    ...attemptRows.value.flatMap((item) => Object.keys(item.row))
  ])
])
const differingHeaders = computed(() =>
  getDifferingHeadersForRows(
    headers.value,
    attemptRows.value.map((item) => item.row),
    verificationData.value?.context.policy
  )
)
const visibleHeaders = computed(() =>
  showAllFields.value ? headers.value : differingHeaders.value
)
const comparisonFields = computed(() => {
  const candidates = [
    { key: 'original', label: '导入文本', row: originalRow },
    ...attemptRows.value
  ]
  const differences = new Set(differingHeaders.value)
  return visibleHeaders.value.map((header) => {
    const values = candidates.map(({ row }) => row[header])
    const diff = differences.has(header) ? compareArbitrationValues(values[1], values) : null
    const sources = candidates.map(({ key, label }, index) => ({
      key,
      label,
      value: values[index],
      segments: diff?.segments.get(String(values[index] ?? ''))
    }))
    return {
      header,
      sources,
      changes: sources.filter(({ segments }) => segments),
      limited: diff?.limited
    }
  })
})
const unresolvedHeaders = computed(() =>
  getUnresolvedHeaders(differingHeaders.value, resolvedHeaders)
)
const resolvedCount = computed(() => differingHeaders.value.length - unresolvedHeaders.value.length)
const hasUnsubmittedWork = computed(
  () =>
    !submitted.value &&
    (touchedHeaders.size > 0 ||
      note.value !== lastSavedNote.value ||
      Object.values(judgmentDrafts).some((item) => item.dirty))
)

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('keydown', handleArbitrationShortcut)
})

onBeforeUnmount(() => {
  caseVersion += 1
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('keydown', handleArbitrationShortcut)
})

function confirmLeave() {
  if (!hasUnsubmittedWork.value || submitting.value) return true
  return window.confirm('仲裁选择尚未提交，确定离开吗？')
}
onBeforeRouteLeave(confirmLeave)
onBeforeRouteUpdate(confirmLeave)

watch(
  () => [projectId.value, pageId.value, route.query.mode, importJob.value],
  () => {
    loadCase()
    if (
      route.query.mode !== 'verification' &&
      (!importJob.value || validImportJob(importJob.value))
    )
      loadQueue()
  },
  { immediate: true }
)

function arbitrationTarget(project, page) {
  const path = `/admin/projects/${project}/arbitration/${page}`
  const context = readBatchReportContext(route.query, project)
  return importJob.value || context
    ? {
        path,
        query: {
          ...batchReportNavigationQuery(context),
          ...(importJob.value ? { importJob: importJob.value } : {})
        }
      }
    : path
}

async function navigateQueue(item, forward = false) {
  if (!item || submitting.value || loading.value) return
  if (forward && unresolvedHeaders.value.length) {
    submitError.value = '请先逐字段确认差异，再进入下一条。'
    return
  }
  await router.push(arbitrationTarget(projectId.value, item.id))
}

async function continueAfterSubmit() {
  const version = caseVersion
  const requestedPageId = pageId.value
  const requestedProjectId = projectId.value
  const requestedImportJob = importJob.value
  const result = await refreshQueue(requestedProjectId, requestedPageId)
  if (
    version !== caseVersion ||
    requestedPageId !== pageId.value ||
    requestedProjectId !== projectId.value ||
    requestedImportJob !== importJob.value
  )
    return
  if (!result) {
    queueMessage.value = '本条仲裁已保存；加载后续队列失败，请重试继续。'
    return
  }
  if (!result.totalItems) {
    queueMessage.value = '本条仲裁已保存，当前待仲裁队列已处理完。'
    return
  }
  const next = result.next || result.items[0]
  await router.push(arbitrationTarget(requestedProjectId, next.id))
}

async function continueSourceReview() {
  if (continuingSourceReview.value) return
  const version = caseVersion
  const requestedPageId = pageId.value
  const requestedProjectId = projectId.value
  const requestedPath = route.fullPath
  const requestedUserId = getCurrentUserId()
  const scope = sourceReviewScope.value
  const isCurrent = () =>
    version === caseVersion &&
    requestedPageId === pageId.value &&
    requestedProjectId === projectId.value &&
    requestedPath === route.fullPath &&
    requestedUserId === getCurrentUserId()
  continuingSourceReview.value = true
  sourceQueueError.value = ''
  try {
    const result = await getVerificationSummary(requestedProjectId)
    if (!isCurrent()) return
    const next = nextSourceReviewItem(result.items, requestedPageId, scope)
    await router.push(
      next
        ? sourceReviewTarget(requestedProjectId, next, scope)
        : sourceReviewListTarget(requestedProjectId, scope)
    )
  } catch (error) {
    if (isCurrent())
      sourceQueueError.value = getPbMessage(
        error,
        '本条核验已保存，加载后续来源复核失败，请重试继续。'
      )
  } finally {
    if (isCurrent()) continuingSourceReview.value = false
  }
}

async function loadCase() {
  const version = ++caseVersion
  const requestedPageId = pageId.value
  const requestedProjectId = projectId.value
  const requestedImportJob = importJob.value
  loading.value = true
  error.value = ''
  caseData.value = null
  verificationData.value = null
  sourceEvidenceOpen.value = false
  attemptRows.value = []
  for (const values of [originalRow, finalRow, resolutionSource, judgmentDrafts])
    for (const key of Object.keys(values)) delete values[key]
  resolvedHeaders.clear()
  touchedHeaders.clear()
  textareaRefs.clear()
  note.value = ''
  lastSavedNote.value = ''
  progressMessage.value = ''
  submitError.value = ''
  submitted.value = false
  reviewingSubmission.value = false
  reviewSourceChecked.value = false
  queueMessage.value = ''
  sourceQueueError.value = ''
  continuingSourceReview.value = false
  submitting.value = false
  try {
    if (requestedImportJob && !validImportJob(requestedImportJob))
      throw new Error('批次链接无效，请返回批次台账重新选择。')
    const results = await Promise.allSettled([
      getArbitrationCase(
        requestedPageId,
        route.query.mode === 'verification' ? 'verification' : ''
      ),
      getVerification(requestedPageId)
    ])
    if (version !== caseVersion) return
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const [result, verification] = results.map((result) => result.value)
    verificationData.value = verification
    if (result?.page?.project && requestedProjectId && result.page.project !== requestedProjectId) {
      throw new Error('仲裁条目与当前项目不匹配，请返回项目详情页后重新进入。')
    }
    if (requestedImportJob && result.page?.import_job !== requestedImportJob) {
      throw new Error('仲裁条目不属于当前批次，请返回列表后重新选择。')
    }
    caseData.value = result
    Object.assign(
      originalRow,
      safeParseRowJson(result.page?.ocr_row_json) || { 内容: result.page?.ocr_text || '' }
    )
    attemptRows.value = (result.attempts || [])
      .filter((attempt) => attempt.kind !== 'arbitration')
      .sort((left, right) => Number(left.pass_no) - Number(right.pass_no))
      .map((attempt, index) => ({
        attempt,
        key: `attempt:${attempt.id || index}`,
        label: attempt.proofreader_name || `校对结果 ${index + 1}`,
        row: safeParseRowJson(attempt.row_json) || {}
      }))

    for (const header of headers.value) {
      finalRow[header] =
        (result.mode === 'verification'
          ? safeParseRowJson(result.page.proofread_row_json)?.[header]
          : undefined) ??
        attemptRows.value[0]?.row?.[header] ??
        originalRow[header] ??
        ''
      if (!differingHeaders.value.includes(header)) resolutionSource[header] = 'matching'
      if (result.mode === 'verification') {
        resolutionSource[header] = 'existing_final'
        resolvedHeaders.add(header)
      }
    }
    const progress = verification.progress
    if (
      progress &&
      progress.context.basis === verification.context.basis &&
      progress.payload.stage === result.mode
    ) {
      Object.assign(finalRow, progress.payload.row)
      Object.assign(resolutionSource, progress.payload.selections || {})
      for (const header of differingHeaders.value)
        if (resolutionSource[header]) resolvedHeaders.add(header)
      note.value = progress.payload.note || ''
      lastSavedNote.value = note.value
    }
    showAllFields.value = result.mode === 'verification' || differingHeaders.value.length === 0
    for (const field of headers.value)
      for (const target of ['final', ...attemptRows.value.map((item) => item.attempt.id)])
        judgmentFor(target, field)
  } catch (e) {
    if (version === caseVersion) error.value = getPbMessage(e, '加载仲裁材料失败')
  } finally {
    if (version === caseVersion) loading.value = false
  }
}

function differs(header) {
  return differingHeaders.value.includes(header)
}

function displayValue(value) {
  return String(value ?? '') || '（空白）'
}
function historyLabel(event) {
  const states = {
    correct: '判为正确',
    incorrect: '判为错误',
    pending: '待核实',
    withdrawn: '已撤回判断'
  }
  const kinds = {
    submission: '校对提交',
    field_action: '字段处理',
    judgment: '来源判断',
    review_progress: '保存核验进度',
    review_completed: '完成核验',
    machine_analysis: '机器提示分析',
    source_input_changed: '来源或导入值变更',
    final_adoption: '最终采用',
    report_created: '提交问题',
    report_moved: '报告关联变更',
    draft_superseded: '保留旧版草稿',
    verified_final_updated: '更新最终采用值',
    empty_source: '空记录处理',
    research_event: '研究过程',
    research_submission: '研究提交'
  }
  return states[event.payload.state] || kinds[event.kind] || '历史记录'
}
function historyReason(event) {
  const reason = event.payload.reason || event.payload.note || ''
  return (
    {
      source_checked: '已对照来源',
      source_blank: '来源无内容，保留空白',
      source_content: '按来源补抄／修正',
      legal_notation: '保留合法声调形式',
      reported: '已提交问题'
    }[reason] || reason
  )
}

function isResolved(header) {
  return !differs(header) || resolvedHeaders.has(header)
}

function sourceIs(header, source) {
  return resolutionSource[header] === source
}

function sourceLabel(source) {
  if (source === 'original') return '采用导入值'
  if (source === 'custom') return '手工编辑'
  if (source === 'existing_final') return '当前已保存的最终值'
  const item = attemptRows.value.find((candidate) => candidate.key === source)
  return item ? `采用${item.label}` : '已确认'
}

function resolutionLabel(header) {
  return sourceLabel(resolutionSource[header])
}

function sourceValue(header, source) {
  if (source === 'original') return originalRow[header]
  return attemptRows.value.find((item) => item.key === source)?.row?.[header]
}

function pickValue(header, source) {
  if (submitting.value) return
  finalRow[header] = String(sourceValue(header, source) ?? '')
  resolutionSource[header] = source
  touchedHeaders.add(header)
  if (differs(header)) resolvedHeaders.add(header)
  submitError.value = ''
  resetFinalJudgment(header)
}

function judgmentFor(target, field) {
  const key = `${target}\u0000${field}`
  if (!judgmentDrafts[key]) {
    const previous = verificationData.value?.judgments?.find(
      (event) => event.ref === target && event.field === field
    )
    judgmentDrafts[key] = {
      state: previous && !previous.stale ? previous.payload.state : '',
      reason: previous && !previous.stale ? previous.payload.reason : '',
      location:
        previous?.payload.location ||
        `PDF 物理第 ${verificationData.value?.context.pdf_page || '—'} 页，${field}`,
      replaces: previous?.id || '',
      stale: previous?.stale || false,
      value: previous?.payload.value,
      dirty: false
    }
  }
  return judgmentDrafts[key]
}
function setJudgment(target, field, value) {
  judgmentDrafts[`${target}\u0000${field}`] = value
}
function resetFinalJudgment(field) {
  const item = judgmentFor('final', field)
  if (item.state && item.value !== finalRow[field]) {
    item.state = ''
    item.reason = ''
    item.stale = true
    item.dirty = false
  }
}
function judgmentPayload() {
  return Object.entries(judgmentDrafts)
    .filter(([, item]) => item.dirty && item.state)
    .map(([key, item]) => {
      const [attempt, field] = key.split('\u0000')
      return {
        attempt,
        field,
        state: item.state,
        reason: item.reason,
        location: item.location,
        replaces: item.replaces
      }
    })
}
async function saveProgress(defer) {
  if (submitting.value || !verificationData.value) return
  const version = caseVersion
  const requestedPageId = pageId.value
  const requestedProjectId = projectId.value
  const isCurrent = () =>
    version === caseVersion &&
    requestedPageId === pageId.value &&
    requestedProjectId === projectId.value
  const submittedNote = note.value
  submitting.value = true
  submitError.value = ''
  progressMessage.value = ''
  try {
    const result = await saveSourceJudgments(requestedPageId, {
      basis: verificationData.value.context.basis,
      row: { ...finalRow },
      judgments: judgmentPayload(),
      note: submittedNote,
      selections: { ...resolutionSource },
      defer
    })
    if (!isCurrent()) return
    for (const event of result.judgments) {
      judgmentDrafts[`${event.ref}\u0000${event.field}`] = {
        state: event.payload.state,
        reason: event.payload.reason,
        location: event.payload.location,
        value: event.payload.value,
        replaces: event.id,
        dirty: false,
        stale: false
      }
    }
    const verification = await getVerification(requestedPageId)
    if (!isCurrent()) return
    verificationData.value = verification
    touchedHeaders.clear()
    lastSavedNote.value = submittedNote
    progressMessage.value = defer
      ? '进度已保存，本条暂缓完成；不会混入业务已完成结果。'
      : '已保存实际判断及进度；未核实字段仍保持未记录。'
  } catch (e) {
    if (isCurrent()) submitError.value = getPbMessage(e, '保存判断失败')
  } finally {
    if (isCurrent()) submitting.value = false
  }
}

function onFinalInput(header) {
  resolutionSource[header] = 'custom'
  touchedHeaders.add(header)
  if (differs(header)) resolvedHeaders.add(header)
  submitError.value = ''
  resetFinalJudgment(header)
}

function applySourceToDifferences(source) {
  for (const header of differingHeaders.value) pickValue(header, source)
}

function sourceCount(source) {
  return differingHeaders.value.filter((header) => resolutionSource[header] === source).length
}

function setTextareaRef(header, element) {
  if (element) textareaRefs.set(header, element)
  else textareaRefs.delete(header)
}

const keyboardAvailable = ref(false)
const {
  index: fieldIndex,
  overview,
  mobile,
  current: currentField,
  select: selectField,
  next: nextField
} = useFieldNavigation(visibleHeaders, () => casePage.value?.id)
const fieldSelections = new Map()
watch(
  () => casePage.value?.id,
  () => {
    fieldSelections.clear()
    keyboardAvailable.value = false
  }
)
watch([currentField, mobile], ([field]) => {
  if (field) activeSelection.value = fieldSelections.get(field) || { field, start: null, end: null }
})

function rememberSelection(header, event) {
  const target = event?.target
  const selection = {
    field: header,
    start: Number.isInteger(target?.selectionStart) ? target.selectionStart : null,
    end: Number.isInteger(target?.selectionEnd) ? target.selectionEnd : null
  }
  fieldSelections.set(header, selection)
  if (mobile.value && header !== currentField.value) return
  activeSelection.value = selection
  if (!mobile.value) {
    const index = visibleHeaders.value.indexOf(header)
    if (index >= 0) selectField(index)
  }
}

async function insertText(text) {
  if (submitting.value) return
  if (mobile.value && overview.value) return
  const header = mobile.value
    ? currentField.value
    : activeSelection.value.field || visibleHeaders.value[0] || headers.value[0]
  if (!header) return
  const current = String(finalRow[header] ?? '')
  const selection =
    activeSelection.value.field === header
      ? activeSelection.value
      : fieldSelections.get(header) || {}
  const start = Number.isInteger(selection.start) ? selection.start : current.length
  const end = Number.isInteger(selection.end) ? selection.end : start
  finalRow[header] = `${current.slice(0, start)}${text}${current.slice(end)}`
  onFinalInput(header)
  const cursor = start + text.length
  await nextTick()
  const target = textareaRefs.get(header)
  target?.focus({ preventScroll: true })
  if (mobile.value) target?.scrollIntoView({ block: 'nearest' })
  target?.setSelectionRange(cursor, cursor)
  activeSelection.value = { field: header, start: cursor, end: cursor }
  fieldSelections.set(header, { ...activeSelection.value })
}

async function goToUnresolved(from = currentField.value) {
  if (submitting.value || !unresolvedHeaders.value.length) return
  const start = visibleHeaders.value.indexOf(from)
  const index = visibleHeaders.value.findIndex(
    (field, position) => position > start && unresolvedHeaders.value.includes(field)
  )
  const targetIndex = index >= 0 ? index : visibleHeaders.value.indexOf(unresolvedHeaders.value[0])
  const field = visibleHeaders.value[targetIndex]
  if (targetIndex < 0) return
  const version = caseVersion
  selectField(targetIndex)
  await nextTick()
  if (version !== caseVersion) return
  const article = textareaRefs.get(field)?.closest('.arbitration-field')
  article?.focus({ preventScroll: true })
  article?.scrollIntoView({ block: 'start', inline: 'nearest' })
}

function handleArbitrationShortcut(event) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    event.key !== 'Enter' ||
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    event.shiftKey ||
    mobile.value ||
    verificationMode.value ||
    loading.value ||
    submitting.value ||
    submitted.value ||
    !caseData.value
  )
    return
  event.preventDefault()
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
  if (unresolvedHeaders.value.length) void goToUnresolved()
  else openSubmitReview()
}

function openSubmitReview() {
  if (loading.value || submitted.value || !caseData.value) return
  if (mobile.value && !overview.value) {
    overview.value = true
    return
  }
  if (unresolvedHeaders.value.length || submitting.value) {
    submitError.value = unresolvedHeaders.value.length
      ? `请先确认以下差异字段：${unresolvedHeaders.value.join('、')}`
      : ''
    return
  }
  submitError.value = ''
  reviewingSubmission.value = true
}

function closeSubmitReview() {
  if (submitting.value) return
  reviewingSubmission.value = false
}

function handleBeforeUnload(event) {
  if (!hasUnsubmittedWork.value || submitting.value) return
  event.preventDefault()
  event.returnValue = ''
}

async function submitFinal() {
  if (
    submitting.value ||
    unresolvedHeaders.value.length ||
    submitted.value ||
    loading.value ||
    !caseData.value
  )
    return
  const version = caseVersion
  const requestedPageId = pageId.value
  const requestedProjectId = projectId.value
  const isCurrent = () =>
    version === caseVersion &&
    requestedPageId === pageId.value &&
    requestedProjectId === projectId.value
  submitting.value = true
  submitError.value = ''
  try {
    const body = {
      rowJson: JSON.stringify(finalRow),
      text: composeRowText(headers.value, finalRow),
      row: { ...finalRow },
      note: note.value,
      basis: verificationData.value.context.basis,
      sourceChecked: reviewSourceChecked.value,
      judgments: judgmentPayload(),
      selections: { ...resolutionSource }
    }
    if (verificationMode.value)
      await saveSourceJudgments(requestedPageId, {
        ...body,
        complete: true,
        adoptFinal: casePage.value.status === 'approved'
      })
    else await submitArbitration(requestedPageId, body)
    if (!isCurrent()) return
    submitted.value = true
    reviewingSubmission.value = false
    if (verificationMode.value) await continueSourceReview()
    else await continueAfterSubmit()
  } catch (e) {
    if (!isCurrent()) return
    reviewingSubmission.value = false
    submitError.value = getPbMessage(e, '仲裁提交失败')
  } finally {
    if (isCurrent()) submitting.value = false
  }
}
</script>
