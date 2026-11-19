<template>
  <DocumentReviewWorkspace
    ref="workspace"
    inline-source-toggle
    :page="page"
    :keyboard-available="keyboardAvailable"
    :suspended="(mobile && overview) || reviewingSubmission"
    :loading="loadingPage"
    :pdf-enabled="
      ownReview || submittedHere || (!leaseLost && (!!leaseToken || saving || loadingPage))
    "
    :watermark-user-id="currentUserId"
    :return-to="returnTarget"
    return-label="返回大厅"
    content-labelled-by="task-panel-title"
    empty-pdf-description="请保存草稿并提交来源问题，待来源 PDF 可用后继续核对。"
  >
    <template #panel-header="{ sourceCollapsed, toggleSource, compact }">
      <ProofreadTaskHeader
        v-bind="taskHeaderProps"
        :overview="overview"
        :lease-status="leaseStatus"
        :source-toggle-visible="compact"
        :source-collapsed="sourceCollapsed"
        @source-toggle="toggleSource"
        @previous="gotoPrevTask"
        @next="gotoNextTask"
        @retry-position="loadNeighbors"
        @release="releaseCurrentTask"
        @return="openReturnModal"
        @submit="openSubmitReview"
      />
    </template>
    <template #default="{ inputMode }">
      <div v-if="loadingPage" class="panel-loading" aria-live="polite">正在准备校对字段…</div>
      <div v-else-if="!page" class="empty-state">
        <AppStatusPanel
          v-if="saveError"
          state="error"
          :message="saveError"
          retry-label="重试加载任务"
          @retry="loadPage"
        />
        <div v-else class="empty-state-text">页面不存在</div>
        <RouterLink :to="returnTarget" class="btn btn-secondary mt-3">返回任务列表</RouterLink>
      </div>
      <template v-else>
        <ProofreadTaskFeedback
          :saved="saved"
          :submitted-here="submittedHere"
          :no-next-task="noNextTask"
          :own-submissions-target="ownSubmissionsTarget"
          :available-tasks-target="availableTasksTarget"
          :practice-guide="practiceGuide"
          :claim-next-failure="claimNextFailure"
          :claim-next-failure-notice="claimNextFailureNotice"
          :retrying-claim="retryingClaim"
          :lease-lost="leaseLost"
          :save-error="saveError"
          :reclaiming="reclaiming"
          :stale-local-drafts="staleLocalDrafts"
          @retry-claim="retryClaimNext"
          @reclaim="reclaimTask"
        />
        <RareCharacterNotice
          :texts="[...Object.values(originalRow), ...Object.values(editedRow)]"
        />
        <p v-if="ownReview" class="alert" role="note">{{ OWN_REVIEW_NOTICE }}</p>
        <TaskVerificationPanel
          v-if="!ownReview"
          ref="verificationPanel"
          :page="page"
          :row="editedRow"
          :lease-token="leaseToken"
          :hints="rawFindings"
          :routing-help="researchSession?.presentation?.display?.routing_help !== false"
          :active="!!leaseToken && !leaseLost && !submittedHere && !saving"
          @restore="replaceEditedRow"
          @context="receiveVerificationContext"
        />
        <ResearchTelemetry
          v-if="!ownReview"
          ref="researchTelemetry"
          :session="researchSession"
          :submitted="submittedHere"
          :density-collapsed-ids="densityCollapsedIds"
        />
        <ProofreadPageHints
          :key="page.id"
          ref="findingsPanel"
          v-model:expanded="findingsExpanded"
          :hints="fieldHints"
          :reviews="findingReviews"
          :state="findingsState"
          :compact="compactFindings"
          :sequential="!researchSession"
          :can-report="verificationPanel?.canReport"
          :findings-truncated="findingsTruncated"
          :gated-notice-text="gatedNoticeText"
          @locate="locateFinding"
          @report="verificationPanel?.openReport($event)"
          @next="nextFinding"
          @retry="loadFindings(page.id)"
        />
        <div
          v-if="selectedFinding && !selectedFinding.targetField"
          ref="entryFinding"
          tabindex="-1"
        >
          <ProofreadFindingDetail
            v-bind="selectedFindingProps"
            @review="reviewSelectedFinding"
            @next="nextFinding"
            @report="verificationPanel?.openReport(selectedFinding)"
            @close="closeFinding"
          />
        </div>
        <div ref="fields" class="proofread-fields">
          <ProofreadFieldCard
            v-for="(header, index) in rowHeaders"
            v-show="!mobile || overview || currentField === header"
            :key="header"
            v-model="editedRow[header]"
            :header="header"
            :index="index"
            :original-value="String(originalRow[header] ?? '')"
            :segments="sourceSegments(header)"
            :language="fieldValueLanguage(header)"
            :active="activeField === header"
            :changed="isFieldChanged(header)"
            :mobile="mobile"
            :overview="overview"
            :own-review="ownReview"
            :restore-disabled="
              !isFieldChanged(header) || saving || submittedHere || leaseLost || !leaseToken
            "
            :read-only="readOnly || (mobile && overview)"
            :input-mode="inputMode"
            @select="selectField(index)"
            @restore="restoreField(header)"
            @textarea="setTextareaRef(header, $event)"
            @activate="activateField(header, $event)"
            @remember="rememberSelection(header, $event)"
            @change="onTextChange"
          >
            <template #finding>
              <ProofreadFindingDetail
                v-if="selectedFinding?.targetField === header"
                v-bind="selectedFindingProps"
                @review="reviewSelectedFinding"
                @next="nextFinding"
                @report="verificationPanel?.openReport(selectedFinding)"
                @close="closeFinding"
              />
            </template>
          </ProofreadFieldCard>
        </div>
        <details v-if="!ownReview" class="editor-correction-help">
          <summary>校对与提交说明</summary>
          <p class="correction-paths text-sm text-muted" role="note">
            逐字段对照来源，特殊字符从字符键盘插入。选中已有调值（如 53），可点「调值转上标」改为
            ⁵³。提交前可恢复导入值；提交后不能撤回，系统会尝试打开下一条。
          </p>
        </details>
      </template>
    </template>
    <template #navigation
      ><FieldNavigation
        v-if="rowHeaders.length"
        :headers="rowHeaders"
        :index="fieldIndex"
        :overview="overview"
        :read-only="ownReview"
        :workflow-label="ownReview ? '结果回看' : '校对'"
        @select="selectField"
        @next="advanceField"
        @overview="overview = true"
        ><template v-if="!ownReview" #submit
          ><AppButton
            variant="primary"
            :loading="saving || (submittedHere && taskHeaderProps.retryingClaim)"
            :disabled="submittedHere || loadingPage || leaseLost || !leaseToken"
            @click="openSubmitReview"
            >{{ taskHeaderProps.submitLabel }}</AppButton
          ></template
        ></FieldNavigation
      ></template
    >
    <template #keyboard
      ><ProjectKeyboard
        v-if="page && !ownReview"
        :project-id="page.project"
        @availability="keyboardAvailable = $event"
        @insert="insertText"
    /></template>
  </DocumentReviewWorkspace>
  <ProofreadSubmitDialog
    ref="submitConfirmButton"
    v-model:source-checked="sourceChecked"
    :reviewing-submission="reviewingSubmission"
    :page-number="page?.page_number"
    :changed-fields="changedFields"
    :irreversible-submit-notice="irreversibleSubmitNotice"
    :saving="saving"
    :lease-lost="leaseLost"
    :lease-token="leaseToken"
    :save-error="saveError"
    @close="closeSubmitReview"
    @submit="submitProofread"
  />
  <ProofreadResearchDialog
    :research-open="researchOpen"
    :research-copy="researchCopy"
    :research-error="researchError"
    :research-saving="researchSaving"
    @choose="chooseResearchNotice"
  />
  <ProofreadReturnDialog
    ref="returnConfirmButton"
    :save-error="saveError"
    v-model:return-reason="returnReason"
    v-model:return-basis="returnBasis"
    v-model:queue-mode="queueMode"
    :return-modal-open="returnModalOpen"
    :own-review="ownReview"
    :page-number="page?.page_number"
    :return-queue="returnQueue"
    :returning="returning"
    @close="closeReturnModal"
    @queue-mode="persistQueueMode"
    @batch="batchReturn"
    @confirm="confirmReturn"
  />
</template>
<script setup>
import { RouterLink } from 'vue-router'
import AppButton from '@/components/AppButton.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import DocumentReviewWorkspace from '@/components/editor/DocumentReviewWorkspace.vue'
import FieldNavigation from '@/components/editor/FieldNavigation.vue'
import ProjectKeyboard from '@/components/editor/ProjectKeyboard.vue'
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import TaskVerificationPanel from '@/components/editor/TaskVerificationPanel.vue'
import ResearchTelemetry from '@/components/editor/ResearchTelemetry.vue'
import ProofreadPageHints from '@/components/editor/ProofreadPageHints.vue'
import ProofreadFindingDetail from '@/components/editor/ProofreadFindingDetail.vue'
import ProofreadTaskHeader from '@/components/editor/ProofreadTaskHeader.vue'
import ProofreadTaskFeedback from '@/components/editor/ProofreadTaskFeedback.vue'
import ProofreadFieldCard from '@/components/editor/ProofreadFieldCard.vue'
import ProofreadSubmitDialog from '@/components/editor/ProofreadSubmitDialog.vue'
import ProofreadResearchDialog from '@/components/editor/ProofreadResearchDialog.vue'
import ProofreadReturnDialog from '@/components/editor/ProofreadReturnDialog.vue'
import { HINT_DISPLAY_LIMIT } from '@/lib/fieldHints'
import { fieldValueLanguage } from '@/lib/fieldValue'
import { useProofreadEditor } from '@/composables/proofread/useProofreadEditor'
const {
  page,
  loadPage,
  taskHeaderProps,
  readOnly,
  keyboardAvailable,
  mobile,
  overview,
  reviewingSubmission,
  loadingPage,
  ownReview,
  leaseLost,
  leaseToken,
  saving,
  currentUserId,
  submittedHere,
  noNextTask,
  ownSubmissionsTarget,
  availableTasksTarget,
  practiceGuide,
  returnTarget,
  activeField,
  gotoPrevTask,
  gotoNextTask,
  loadNeighbors,
  releaseCurrentTask,
  openReturnModal,
  openSubmitReview,
  saved,
  claimNextFailure,
  claimNextFailureNotice,
  retryingClaim,
  saveError,
  reclaiming,
  leaseStatus,
  staleLocalDrafts,
  rowHeaders,
  changedFields,
  retryClaimNext,
  reclaimTask,
  originalRow,
  editedRow,
  OWN_REVIEW_NOTICE,
  verificationPanel,
  rawFindings,
  researchSession,
  replaceEditedRow,
  receiveVerificationContext,
  researchTelemetry,
  fieldHints,
  findingReviews,
  canReviewFindings,
  updateFindingReview,
  findingsState,
  loadFindings,
  findingsTruncated,
  gatedNoticeText,
  currentField,
  sourceSegments,
  isFieldChanged,
  selectField,
  restoreField,
  locateHint,
  clearHintLocation,
  setTextareaRef,
  activateField,
  rememberSelection,
  onTextChange,
  fieldIndex,
  nextField,
  insertText,
  submitConfirmButton,
  sourceChecked,
  irreversibleSubmitNotice,
  closeSubmitReview,
  submitProofread,
  researchOpen,
  researchCopy,
  researchError,
  researchSaving,
  chooseResearchNotice,
  returnReason,
  returnBasis,
  queueMode,
  returnModalOpen,
  returnQueue,
  returning,
  closeReturnModal,
  persistQueueMode,
  batchReturn,
  confirmReturn,
  returnConfirmButton
} = useProofreadEditor()

const workspace = ref(null)
const fields = useTemplateRef('fields')
const findingsPanel = ref(null)
const entryFinding = ref(null)
const findingsExpanded = ref(false)
const selectedFindingKey = ref(null)
const compactFindings = computed(() => !mobile.value && !researchSession.value)
const selectedFinding = computed(() => {
  if (researchSession.value) return null
  return fieldHints.value.find((hint) => hint.key === selectedFindingKey.value) || null
})
const pendingFindings = computed(() =>
  fieldHints.value.filter((hint) => !Object.hasOwn(findingReviews.value, hint.id))
)
const selectedFindingProps = computed(() => ({
  hint: selectedFinding.value,
  review: Object.hasOwn(findingReviews.value, selectedFinding.value.id)
    ? findingReviews.value[selectedFinding.value.id]
    : undefined,
  changed: isFieldChanged(selectedFinding.value.targetField),
  canReview: canReviewFindings.value,
  canReport: verificationPanel.value?.canReport,
  hasNext: pendingFindings.value.some((hint) => hint.key !== selectedFinding.value.key)
}))
const densityCollapsedIds = computed(() =>
  findingsExpanded.value
    ? []
    : fieldHints.value
        .slice(HINT_DISPLAY_LIMIT)
        .map(({ id }) => id)
        .filter(Boolean)
)

watch(
  () => page.value?.id,
  () => {
    findingsExpanded.value = false
    selectedFindingKey.value = null
  }
)
watch(findingsExpanded, (expanded) => {
  if (expanded) researchTelemetry.value?.expandFindings()
})

async function advanceField() {
  const pageId = page.value?.id
  nextField()
  if (overview.value) return
  await nextTick()
  if (page.value?.id !== pageId) return
  // Focus the field region without summoning the system keyboard on touch screens.
  fields.value?.querySelector('.proofread-field--active')?.focus({ preventScroll: true })
}

async function locateFinding(hint) {
  const pageId = page.value?.id
  selectedFindingKey.value = hint.key
  if (compactFindings.value) findingsExpanded.value = false
  await workspace.value?.revealEntrySource(hint.targetField)
  if (pageId !== page.value?.id || selectedFindingKey.value !== hint.key) return
  await locateHint(hint)
  if (selectedFinding.value === hint && !hint.targetField) {
    entryFinding.value?.focus({ preventScroll: true })
    entryFinding.value?.scrollIntoView({ block: 'nearest' })
  }
}

watch(selectedFinding, (selected, previous) => {
  if (previous && (!selected || (selected.key === previous.key && selected !== previous))) {
    clearHintLocation()
    workspace.value?.clearFindingSource()
  }
})

function nextFinding() {
  const index = fieldHints.value.indexOf(selectedFinding.value)
  const isPending = (hint) => !Object.hasOwn(findingReviews.value, hint.id)
  const next = fieldHints.value.slice(index + 1).find(isPending) || pendingFindings.value[0]
  if (next) void locateFinding(next)
}

function reviewSelectedFinding(reviewed) {
  if (selectedFinding.value) updateFindingReview(selectedFinding.value, reviewed)
}

function closeFinding() {
  selectedFindingKey.value = null
  clearHintLocation()
  workspace.value?.clearFindingSource()
  findingsPanel.value?.focus()
}
</script>
