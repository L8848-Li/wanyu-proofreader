import { measureBusiness } from '../../lib/businessMetrics.js'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useFieldNavigation } from '@/composables/useFieldNavigation'
import { useStructuredRow } from '@/composables/useStructuredRow'
import { useTaskNeighbors } from '@/composables/useTaskNeighbors'
import { mergeOwnTasks } from '@/lib/ownTaskList'
import { shouldIgnoreEditorShortcut } from '@/lib/onboarding'
import { getChangedFields } from '@/lib/workspaceInsights'
import { prepareFieldHints, gatedNotice } from '@/lib/fieldHints'
import { takeTaskFlash } from '@/lib/taskDraft'
import {
  practiceGuideTarget,
  practiceNavigationQuery,
  readPracticeContext
} from '@/lib/practiceContext'
import { proofreadSubmitLabel, proofreadTaskFeedback } from '@/lib/taskFeedback'
import { loadGlyphQueue, saveGlyphQueue } from '@/lib/taskLease'
import { currentUserId as getCurrentUserId } from '@/services/authService'
import {
  getProofreaderTask,
  listProofreaderNeighborTasks,
  listReviewedProofreads
} from '@/services/pagesService'
import {
  CLAIM_NEXT_FAILURE_NOTICE,
  IRREVERSIBLE_SUBMIT_NOTICE,
  OWN_REVIEW_NOTICE
} from '@/lib/proofreadNotices'
import { RESEARCH_NOTICE_COPY } from '@/lib/researchNoticeCopy'
import {
  chooseResearchNotice as saveResearchNotice,
  getResearchNotice
} from '@/services/researchNoticeService'
import { formatClaimConflict, getPbMessage, getPbStatus } from '@/utils/pbErrors'

import { useProofreadDrafts } from './useProofreadDrafts.js'
import { useDraftExitRegistration } from '../useDraftLogout.js'
import { useProofreadLease } from './useProofreadLease.js'
import { useProofreadReturn } from './useProofreadReturn.js'
import { useProofreadFields } from './useProofreadFields.js'
import { useProofreadSubmission } from './useProofreadSubmission.js'

export function useProofreadEditor() {
  let caseVersion = 0
  const captureCase = () => ({ version: caseVersion, id: page.value?.id })
  const isCurrentCase = (snapshot) =>
    snapshot.version === caseVersion && snapshot.id === page.value?.id
  const route = useRoute()
  const router = useRouter()
  const workReturnTarget = inject('workReturnTarget', '/tasks')
  const onboardingRef = inject('proofreaderOnboarding', ref(null))
  const researchNotice = ref(null)
  const researchLoaded = ref(false)
  const researchSaving = ref(false)
  const researchError = ref('')
  const researchDecided = computed(() => Boolean(researchNotice.value?.decided))
  const researchOpen = computed(
    () => !loadingPage.value && !ownReview.value && researchLoaded.value && !researchDecided.value
  )
  const researchCopy = computed(() => ({
    title: researchNotice.value?.title || RESEARCH_NOTICE_COPY.title,
    body: researchNotice.value?.body || RESEARCH_NOTICE_COPY.body,
    participateLabel:
      researchNotice.value?.participate_label || RESEARCH_NOTICE_COPY.participateLabel,
    optOutLabel: researchNotice.value?.opt_out_label || RESEARCH_NOTICE_COPY.optOutLabel
  }))

  const page = ref(null)
  const verificationPanel = ref(null)
  const verificationContext = ref(null)
  const sourceChecked = ref(false)
  const rawFindings = ref([])
  const staleLocalDrafts = ref([])
  const restoredLocalDraft = ref(null)
  const researchSession = ref(null)
  const researchTelemetry = ref(null)
  const loadingPage = ref(true)
  const saving = ref(false)
  const releasing = ref(false)
  const reclaiming = ref(false)
  const saved = ref('')
  const previousSubmission = ref('')
  const saveError = ref('')
  const initialRowJson = ref('')
  const draftStatus = ref('')
  const draftReady = ref(false)
  const reviewingSubmission = ref(false)
  const submitConfirmButton = ref(null)
  const activeSelection = ref({ field: '', start: null, end: null })
  const leaseToken = ref('')
  const leaseExpiresAt = ref('')
  const leaseLost = ref(false)
  const returnModalOpen = ref(false)
  const returnReason = ref('')
  const returnBasis = ref('')
  const returning = ref(false)
  // 队列与开关按 userId 隔离，打开退回弹窗时再读（那时 currentUserId 已可用）。
  const queueMode = ref(false)
  const returnQueue = ref([])
  const renewingLease = ref(false)
  const leaseNavigationAllowed = ref(false)
  const submittedHere = ref(false)
  const ownReview = ref(false)
  const claimNextFailure = ref(false)
  const retryingClaim = ref(false)
  const connectionOnline = ref(globalThis.navigator?.onLine !== false)
  const updateConnectionStatus = () => {
    connectionOnline.value = globalThis.navigator?.onLine !== false
  }
  const irreversibleSubmitNotice = IRREVERSIBLE_SUBMIT_NOTICE
  const claimNextFailureNotice = CLAIM_NEXT_FAILURE_NOTICE
  const textareaRefs = new Map()
  const fieldHints = ref(prepareFieldHints([]))
  const findingReviews = ref({})
  const findingsDirty = ref(false)
  watch(
    submittedHere,
    (submitted) => {
      if (submitted) {
        findingReviews.value = {}
        findingsDirty.value = false
      }
    },
    { flush: 'sync' }
  )
  const findingsTruncated = ref(false)
  const findingsSuppressed = ref(0)
  const gatedNoticeText = computed(() => gatedNotice(findingsSuppressed.value))
  const locatedSpan = ref(null)

  const currentUserId = computed(() => getCurrentUserId() || '')
  const editorUserId = currentUserId.value
  const readOnly = computed(
    () =>
      ownReview.value || saving.value || submittedHere.value || leaseLost.value || !leaseToken.value
  )
  const projectName = computed(() => page.value?.expand?.project?.name || '当前项目')
  const noNextTask = ref(false)
  const currentPracticeContext = computed(() => {
    const context = readPracticeContext(route.query, page.value?.project)
    return context?.role === 'proofreader' && page.value?.expand?.project?.purpose === 'practice'
      ? { ...context, step: ownReview.value ? 'reviewed' : 'proofread' }
      : null
  })
  const practiceGuide = computed(() =>
    currentPracticeContext.value ? practiceGuideTarget(currentPracticeContext.value) : null
  )
  function taskHallTarget(view, step) {
    const query = { view, ...(page.value?.project ? { project: page.value.project } : {}) }
    if (currentPracticeContext.value)
      Object.assign(query, practiceNavigationQuery({ ...currentPracticeContext.value, step }))
    return { path: '/tasks', query }
  }
  const ownSubmissionsTarget = computed(() => taskHallTarget('reviewed', 'reviewed'))
  const availableTasksTarget = computed(() => taskHallTarget('available', 'claim'))
  function taskEditTarget(pageId) {
    const context = currentPracticeContext.value
    return {
      path: `/tasks/${encodeURIComponent(pageId)}/edit`,
      query: context
        ? practiceNavigationQuery({ ...context, step: ownReview.value ? 'reviewed' : 'proofread' })
        : {}
    }
  }
  const changedFields = computed(() =>
    getChangedFields(rowHeaders.value, originalRow.value, editedRow.value)
  )
  const canSwitchPrev = computed(
    () =>
      canNavigatePrev.value &&
      !saving.value &&
      !loadingPage.value &&
      !reviewingSubmission.value &&
      !submittedHere.value
  )
  const canSwitchNext = computed(
    () =>
      canNavigateNext.value &&
      !saving.value &&
      !loadingPage.value &&
      !reviewingSubmission.value &&
      !submittedHere.value
  )
  const navigationLabel = computed(() => {
    if (submittedHere.value) return '已提交'
    if (loadingPage.value || neighborsState.value === 'loading') return '位置加载中…'
    if (neighborsState.value === 'error') return '位置不可用'
    if (!page.value) return '任务不可用'
    if (taskCount.value === 0) return ownReview.value ? '暂无已提交条目' : '暂无任务'
    if (taskPosition.value === 0) return '位置未知'
    return `${taskPosition.value} / ${taskCount.value}`
  })
  const navigationHint = computed(() => {
    if (ownReview.value) {
      if (loadingPage.value || neighborsState.value === 'loading') return ''
      if (neighborsState.value === 'error') return neighborsError.value
      if (taskCount.value === 0) return '当前没有可回看的已提交条目。'
      if (taskPosition.value === 0) return '这条已提交结果不在当前列表里。'
      if (taskCount.value === 1) return '当前只有这一条已提交结果。'
      if (!canNavigatePrev.value) return '已是最早一条。'
      if (!canNavigateNext.value) return '已是最后一条。'
      return ''
    }
    if (submittedHere.value) return '本条已提交，不再计入进行中的任务。'
    if (loadingPage.value || neighborsState.value === 'loading') return ''
    if (saving.value) return '正在提交，暂不能切换任务。'
    if (reviewingSubmission.value) return '请先完成或关闭提交确认。'
    if (neighborsState.value === 'error') return neighborsError.value
    if (!page.value) return ''
    if (taskCount.value === 0) return '当前没有可切换的进行中任务。'
    if (taskPosition.value === 0) return '当前条目不在进行中任务列表。'
    if (taskCount.value === 1) return '当前只有这一条进行中的任务。'
    if (!canNavigatePrev.value) return '已是第一条进行中的任务。'
    if (!canNavigateNext.value) return '已是最后一条进行中的任务。'
    return ''
  })
  const leaseStatus = computed(() => {
    if (leaseLost.value) return '租约已失效 · 请保留本页输入'
    if (!leaseExpiresAt.value) return ''
    const date = new Date(leaseExpiresAt.value)
    if (Number.isNaN(date.getTime())) return '任务租约已启用'
    return `任务保留至 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  })
  const taskFeedback = computed(() =>
    proofreadTaskFeedback({
      loading: loadingPage.value,
      hasPage: Boolean(page.value),
      ownReview: ownReview.value,
      saving: saving.value,
      leaseLost: leaseLost.value,
      saveError: saveError.value,
      submittedHere: submittedHere.value,
      claimNextFailure: claimNextFailure.value,
      retryingClaim: retryingClaim.value,
      draftStatus: draftStatus.value,
      saved: saved.value,
      previousSubmission: previousSubmission.value,
      online: connectionOnline.value
    })
  )
  const taskHeaderProps = computed(() => ({
    projectName: projectName.value,
    ownReview: ownReview.value,
    mobile: mobile.value,
    navigationLabel: navigationLabel.value,
    navigationHint: navigationHint.value,
    neighborsState: neighborsState.value,
    submittedHere: submittedHere.value,
    retryingClaim: retryingClaim.value,
    submitLabel: proofreadSubmitLabel({
      submittedHere: submittedHere.value,
      saving: saving.value,
      retryingClaim: retryingClaim.value
    }),
    canSwitchPrev: canSwitchPrev.value,
    canSwitchNext: canSwitchNext.value,
    leaseLost: leaseLost.value,
    saving: saving.value,
    releasing: releasing.value,
    leaseToken: leaseToken.value,
    loadingPage: loadingPage.value,
    activeField: activeField.value,
    pageNumber: page.value?.page_number,
    hasPage: Boolean(page.value),
    feedback: taskFeedback.value
  }))
  const hasUnsavedChanges = computed(() => {
    return Boolean(
      page.value &&
      !loadingPage.value &&
      initialRowJson.value &&
      stringifyEditedRow() !== initialRowJson.value
    )
  })

  const {
    rowHeaders,
    originalRow,
    editedRow,
    activeField,
    editedText,
    hydrateForProofread,
    hydrateForReview,
    replaceEditedRow,
    markChanged,
    insertText: insertIntoActiveField,
    stringifyEditedRow
  } = useStructuredRow()
  watch(
    () => (Object.keys(findingReviews.value).length ? { ...editedRow.value } : null),
    (values, previous) => {
      if (!values || !previous) return
      const changed = new Set(rowHeaders.value.filter((field) => values[field] !== previous[field]))
      if (!changed.size) return
      const entries = Object.entries(findingReviews.value)
      const remaining = entries.filter(([, review]) => review.field && !changed.has(review.field))
      if (remaining.length !== entries.length) {
        findingReviews.value = Object.fromEntries(remaining)
        findingsDirty.value = true
        scheduleDraftSave()
      }
    },
    { flush: 'sync' }
  )

  const canReviewFindings = computed(
    () => !readOnly.value && Boolean(verificationContext.value?.basis)
  )
  function updateFindingReview(hint, reviewed) {
    if (!canReviewFindings.value || !hint.id || !fieldHints.value.includes(hint)) return
    const field = hint.targetField
    const next = { ...findingReviews.value }
    if (reviewed) {
      const result = !field ? 'reviewed' : isFieldChanged(field) ? 'corrected' : 'kept'
      next[hint.id] = { field, result }
    } else delete next[hint.id]
    findingReviews.value = next
    findingsDirty.value = true
    scheduleDraftSave()
  }

  const {
    prevTaskId,
    nextTaskId,
    taskPosition,
    taskCount,
    canNavigatePrev,
    canNavigateNext,
    neighborsState,
    neighborsError,
    resetNeighbors,
    loadNeighbors
  } = useTaskNeighbors(page, async (currentPage) => {
    const userId = currentUserId.value
    if (!userId) throw new Error('登录状态已失效，请重新登录后重试。')
    if (!currentPage?.project) return []
    const settled = await Promise.allSettled([
      listProofreaderNeighborTasks(currentPage.project, userId),
      listReviewedProofreads(currentPage.project)
    ])
    const active = settled[0].status === 'fulfilled' ? settled[0].value : []
    const reviewed = settled[1].status === 'fulfilled' ? settled[1].value.items : []
    if (settled[0].status === 'rejected' && (!ownReview.value || settled[1].status === 'rejected'))
      throw settled[0].reason
    if (settled[1].status === 'rejected' && ownReview.value) throw settled[1].reason
    return mergeOwnTasks(active, reviewed)
  })

  const keyboardAvailable = ref(false)
  const {
    index: fieldIndex,
    overview,
    mobile,
    current: currentField,
    select: selectField,
    next: nextField
  } = useFieldNavigation(rowHeaders, () => page.value?.id)
  const fieldSelections = new Map()
  watch(
    () => page.value?.id,
    () => {
      fieldSelections.clear()
      keyboardAvailable.value = false
    }
  )
  watch([currentField, mobile], ([field]) => {
    if (!field) return
    activeField.value = field
    activeSelection.value = fieldSelections.get(field) || { field, start: null, end: null }
  })

  const {
    scheduleDraftSave,
    flushDraft,
    restoreDraft,
    receiveVerificationContext,
    clearDraftTimer
  } = useProofreadDrafts({
    draftReady,
    draftStatus,
    ownReview,
    page,
    currentUserId,
    initialRowJson,
    hasUnsavedChanges,
    findingReviews,
    findingsDirty,
    stringifyEditedRow,
    verificationContext,
    restoredLocalDraft,
    staleLocalDrafts,
    replaceEditedRow,
    originalRow
  })
  useDraftExitRegistration({
    userId: editorUserId,
    flush: () => flushDraft({ preserveExisting: true }),
    captureReturn() {
      const field = activeField.value || currentField.value || rowHeaders.value[0]
      const target = textareaRefs.get(field)
      const pageId = page.value?.id
      const start = target?.selectionStart,
        end = target?.selectionEnd
      const direction = target?.selectionDirection
      return () => {
        if (
          !target?.isConnected ||
          page.value?.id !== pageId ||
          getCurrentUserId() !== editorUserId
        )
          return
        target.focus({ preventScroll: true })
        if (Number.isInteger(start) && Number.isInteger(end))
          target.setSelectionRange(start, end, direction)
      }
    },
    allowNavigation() {
      const previous = leaseNavigationAllowed.value
      leaseNavigationAllowed.value = true
      return () => {
        leaseNavigationAllowed.value = previous
      }
    }
  })
  const {
    saveClaimedLease,
    clearStoredLease,
    restoreOrAcquireLease,
    stopLeaseRenewal,
    handleLeaseActivation,
    markLeaseLost,
    isLeaseFailure,
    releaseCurrentTask,
    reclaimTask
  } = useProofreadLease({
    page,
    currentUserId,
    leaseToken,
    leaseExpiresAt,
    leaseLost,
    saveError,
    reviewingSubmission,
    renewingLease,
    reclaiming,
    releasing,
    leaseNavigationAllowed,
    verificationPanel,
    flushDraft,
    glyphQueueFor,
    router,
    captureCase,
    isCurrentCase,
    returnTarget: workReturnTarget,
    taskEditTarget
  })
  const {
    openReturnModal,
    closeReturnModal,
    persistQueueMode,
    confirmReturn,
    batchReturn,
    returnConfirmButton
  } = useProofreadReturn({
    ownReview,
    page,
    currentUserId,
    returnReason,
    returnBasis,
    queueMode,
    returnQueue,
    returnModalOpen,
    returning,
    saveError,
    saveClaimedLease,
    glyphQueueFor,
    clearGlyphQueue,
    router,
    captureCase,
    isCurrentCase,
    leaseNavigationAllowed,
    returnTarget: workReturnTarget,
    taskEditTarget
  })
  const {
    onTextChange,
    insertText,
    setTextareaRef,
    activateField,
    rememberSelection,
    isFieldChanged,
    locateHint,
    clearHintLocation,
    sourceSegments,
    findingsState,
    loadFindings,
    restoreField,
    invalidateFindings
  } = useProofreadFields({
    sourceChecked,
    saved,
    saveError,
    markChanged,
    scheduleDraftSave,
    ownReview,
    saving,
    submittedHere,
    leaseLost,
    leaseToken,
    mobile,
    overview,
    currentField,
    activeField,
    rowHeaders,
    textareaRefs,
    activeSelection,
    fieldSelections,
    insertIntoActiveField,
    selectField,
    changedFields,
    fieldHints,
    rawFindings,
    originalRow,
    locatedSpan,
    page,
    researchSession,
    findingsTruncated,
    findingsSuppressed,
    editedRow
  })
  const { submitProofread, retryClaimNext } = useProofreadSubmission({
    ownReview,
    saving,
    page,
    leaseLost,
    leaseToken,
    researchDecided,
    sourceChecked,
    saved,
    saveError,
    claimNextFailure,
    currentUserId,
    stringifyEditedRow,
    editedText,
    verificationPanel,
    researchTelemetry,
    reviewingSubmission,
    initialRowJson,
    submittedHere,
    noNextTask,
    resetNeighbors,
    clearStoredLease,
    draftStatus,
    glyphQueueFor,
    saveClaimedLease,
    router,
    taskEditTarget,
    clearGlyphQueue,
    loadResearchNotice,
    isLeaseFailure,
    markLeaseLost,
    retryingClaim,
    captureCase,
    isCurrentCase,
    leaseNavigationAllowed,
    submitConfirmButton
  })

  watch(
    () => route.params.id,
    async () => {
      await loadPage()
    },
    { immediate: true }
  )

  onBeforeRouteLeave(() => {
    if (getCurrentUserId() !== editorUserId) return true
    if (leaseNavigationAllowed.value) return true
    if (!confirmDiscardChanges()) return false
  })

  onBeforeRouteUpdate((to, from) => {
    if (getCurrentUserId() !== editorUserId) return true
    if (leaseNavigationAllowed.value) return true
    if (to.params.id !== from.params.id && !confirmDiscardChanges()) return false
  })

  onMounted(() => {
    updateConnectionStatus()
    window.addEventListener('online', updateConnectionStatus)
    window.addEventListener('offline', updateConnectionStatus)
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('keydown', handleEditorShortcut)
    window.addEventListener('focus', handleLeaseActivation)
    document.addEventListener('visibilitychange', handleLeaseActivation)
    void loadResearchNotice()
  })

  onBeforeUnmount(() => {
    caseVersion += 1
    invalidateFindings()
    flushDraft({ preserveExisting: true })
    clearDraftTimer()
    stopLeaseRenewal()
    window.removeEventListener('beforeunload', handleBeforeUnload)
    window.removeEventListener('keydown', handleEditorShortcut)
    window.removeEventListener('focus', handleLeaseActivation)
    window.removeEventListener('online', updateConnectionStatus)
    window.removeEventListener('offline', updateConnectionStatus)
    document.removeEventListener('visibilitychange', handleLeaseActivation)
  })

  async function loadPage() {
    const editorStartedAt = performance.now()
    const version = ++caseVersion
    const pageId = route.params.id
    clearDraftTimer()
    stopLeaseRenewal()
    reviewingSubmission.value = false
    saving.value = false
    releasing.value = false
    reclaiming.value = false
    renewingLease.value = false
    returning.value = false
    sourceChecked.value = false
    verificationContext.value = null
    restoredLocalDraft.value = null
    staleLocalDrafts.value = []
    rawFindings.value = []
    researchSession.value = null
    draftReady.value = false
    loadingPage.value = true
    page.value = null
    resetNeighbors()
    saveError.value = ''
    saved.value = ''
    previousSubmission.value = ''
    initialRowJson.value = ''
    draftStatus.value = ''
    activeSelection.value = { field: '', start: null, end: null }
    leaseToken.value = ''
    leaseExpiresAt.value = ''
    leaseLost.value = false
    leaseNavigationAllowed.value = false
    submittedHere.value = false
    noNextTask.value = false
    claimNextFailure.value = false
    retryingClaim.value = false
    textareaRefs.clear()
    fieldHints.value = prepareFieldHints([])
    findingReviews.value = {}
    findingsDirty.value = false
    findingsTruncated.value = false
    findingsSuppressed.value = 0
    locatedSpan.value = null
    invalidateFindings()

    try {
      const loaded = await loadAssignedOrOwnReview(pageId)
      if (version !== caseVersion) return
      page.value = loaded
      if (!page.value) return
      ownReview.value = page.value?.readonly === true
      if (ownReview.value) {
        hydrateForReview(page.value)
        await loadNeighbors()
      } else {
        hydrateForProofread(page.value)
        initialRowJson.value = stringifyEditedRow()
        restoreDraft()
        await restoreOrAcquireLease()
        if (version !== caseVersion) return
        void loadFindings(page.value.id)
        await loadNeighbors()
      }
      if (version !== caseVersion) return
      const flash = takeTaskFlash(window.sessionStorage, { userId: currentUserId.value, pageId })
      if (flash) {
        saved.value = flash.message
        if (flash.kind === 'submission') previousSubmission.value = flash.message
      }
      await nextTick()
      if (version !== caseVersion) return
      onboardingRef.value?.startIfUnseen()
    } catch (e) {
      if (version !== caseVersion) return
      saveError.value = formatClaimConflict(e, '加载任务失败，请返回项目大厅刷新后重试')
    } finally {
      if (version === caseVersion) {
        draftReady.value = Boolean(page.value) && !ownReview.value
        loadingPage.value = false
        if (page.value && !saveError.value) {
          await nextTick()
          requestAnimationFrame(() => {
            if (version === caseVersion)
              measureBusiness('editor_ready', performance.now() - editorStartedAt)
          })
        }
      }
    }
  }

  async function loadAssignedOrOwnReview(pageId) {
    try {
      return await getProofreaderTask(pageId)
    } catch (error) {
      if (getPbStatus(error) !== 403) throw error
      return getProofreaderTask(pageId, { review: true })
    }
  }

  function gotoPrevTask() {
    if (!canSwitchPrev.value) return
    router.push(taskEditTarget(prevTaskId.value))
  }

  function gotoNextTask() {
    if (!canSwitchNext.value) return
    router.push(taskEditTarget(nextTaskId.value))
  }

  async function loadResearchNotice() {
    researchError.value = ''
    try {
      researchNotice.value = await getResearchNotice()
    } catch (error) {
      researchNotice.value = { decided: false }
      researchError.value = getPbMessage(error, '研究用途告知暂时没有加载出来，请稍后再选择。')
    } finally {
      researchLoaded.value = true
    }
  }

  async function chooseResearchNotice(choice) {
    if (researchSaving.value) return
    researchSaving.value = true
    researchError.value = ''
    try {
      researchNotice.value = await saveResearchNotice(choice)
    } catch (error) {
      researchError.value = getPbMessage(error, '研究用途选择没有记下，请再试一次。')
    } finally {
      researchSaving.value = false
    }
  }

  async function openSubmitReview() {
    if (ownReview.value) return
    if (mobile.value && !overview.value) {
      overview.value = true
      return
    }
    if (!researchDecided.value) return
    if (saving.value || loadingPage.value || !page.value || leaseLost.value || !leaseToken.value)
      return
    flushDraft()
    reviewingSubmission.value = true
    await nextTick()
    submitConfirmButton.value?.focus()
  }

  function closeSubmitReview() {
    if (saving.value) return
    reviewingSubmission.value = false
  }

  function confirmDiscardChanges() {
    if (saving.value || releasing.value || reclaiming.value || returning.value) return false
    if (ownReview.value) return true
    if (
      hasUnsavedChanges.value &&
      !window.confirm('当前校对内容尚未提交，确定要离开吗？本地草稿会保留。')
    )
      return false
    // Route updates reuse this component; flush before loadPage cancels the
    // debounce timer and replaces the old page/row refs.
    flushDraft()
    return true
  }

  function handleBeforeUnload(event) {
    flushDraft()
    if (!hasUnsavedChanges.value && !findingsDirty.value) return
    event.preventDefault()
    event.returnValue = ''
  }

  function handleEditorShortcut(event) {
    if (researchOpen.value) return
    if (shouldIgnoreEditorShortcut(event, onboardingRef.value)) return
    const control = event.ctrlKey || event.metaKey
    // Help, status and recovery dialogs own keyboard input while open. The
    // explicit submission confirmation alone keeps its existing submit shortcut.
    if (
      document.querySelector(
        '[role="dialog"][aria-modal="true"]:not([aria-labelledby="submit-review-title"])'
      )
    ) {
      if (
        (control && (event.key.toLowerCase() === 's' || event.key === 'Enter')) ||
        (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key))
      )
        event.preventDefault()
      return
    }
    if (event.key === 'Escape' && reviewingSubmission.value) {
      event.preventDefault()
      closeSubmitReview()
      return
    }
    if (ownReview.value && control && (event.key.toLowerCase() === 's' || event.key === 'Enter')) {
      event.preventDefault()
      return
    }
    if (control && event.key.toLowerCase() === 's') {
      event.preventDefault()
      flushDraft()
      return
    }
    if (control && event.key === 'Enter') {
      event.preventDefault()
      if (reviewingSubmission.value) submitProofread()
      else openSubmitReview()
      return
    }
    if (!event.altKey || control || reviewingSubmission.value) return
    if (event.key === 'ArrowLeft' && canSwitchPrev.value) {
      event.preventDefault()
      gotoPrevTask()
    } else if (event.key === 'ArrowRight' && canSwitchNext.value) {
      event.preventDefault()
      gotoNextTask()
    }
  }

  function glyphQueueFor(projectId) {
    return loadGlyphQueue(window.sessionStorage, { userId: currentUserId.value, projectId })
  }

  function clearGlyphQueue(projectId) {
    saveGlyphQueue(window.sessionStorage, { userId: currentUserId.value, projectId, glyph: false })
  }

  return {
    page,
    loadPage,
    readOnly,
    taskHeaderProps,
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
    projectName,
    navigationLabel,
    navigationHint,
    neighborsState,
    submittedHere,
    noNextTask,
    ownSubmissionsTarget,
    availableTasksTarget,
    practiceGuide,
    returnTarget: workReturnTarget,
    canSwitchPrev,
    canSwitchNext,
    releasing,
    activeField,
    taskFeedback,
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
    draftStatus,
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
  }
}
