import { nextTick } from 'vue'
import { measureBusiness } from '../../lib/businessMetrics.js'
import { claimNextProjectPage, submitTwoPassProofread } from '../../services/pagesService.js'
import { clearTaskDraft, setTaskFlash } from '../../lib/taskDraft.js'
import { PAGE_STATUS } from '../../constants/pageStatus.js'
import { getPbMessage, getPbStatus } from '../../utils/pbErrors.js'

export function useProofreadSubmission({
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
}) {
  async function submitProofread() {
    if (
      ownReview.value ||
      saving.value ||
      !page.value ||
      leaseLost.value ||
      !leaseToken.value ||
      !researchDecided.value ||
      !sourceChecked.value
    )
      return
    const scope = captureCase()
    const pageId = page.value.id
    const token = leaseToken.value
    saving.value = true
    saved.value = ''
    saveError.value = ''
    claimNextFailure.value = false
    noNextTask.value = false
    const projectId = page.value?.project
    const userId = currentUserId.value
    const rowJson = stringifyEditedRow()
    const text = editedText.value
    try {
      const verification = await verificationPanel.value.prepareSubmit()
      if (!isCurrentCase(scope)) return
      const telemetry = await researchTelemetry.value?.flush()
      if (!isCurrentCase(scope)) return
      const submittedAt = performance.now()
      const result = await submitTwoPassProofread(pageId, userId, {
        rowJson,
        text,
        leaseToken: token,
        sourceChecked: sourceChecked.value,
        ...verification,
        ...telemetry
      })
      if (!isCurrentCase(scope)) return
      reviewingSubmission.value = false
      initialRowJson.value = rowJson
      page.value.status = result.status
      submittedHere.value = true
      measureBusiness('submit_ack', performance.now() - submittedAt)
      resetNeighbors()
      clearTaskDraft(window.localStorage, {
        userId,
        pageId
      })
      clearStoredLease()
      draftStatus.value = ''
      saved.value =
        result.message ||
        (result.status === PAGE_STATUS.APPROVED
          ? '该条目已完成。'
          : result.status === PAGE_STATUS.ARBITRATION
            ? '该条目将由管理员继续处理。'
            : '校对已提交。')

      try {
        const nextPage = await claimNextProjectPage(
          projectId,
          userId,
          page.value.id,
          '',
          glyphQueueFor(projectId)
        )
        if (!isCurrentCase(scope)) return
        if (nextPage?.id) {
          saveClaimedLease(nextPage)
          setTaskFlash(window.sessionStorage, saved.value, {
            userId,
            pageId: nextPage.id,
            kind: 'submission'
          })
          leaseNavigationAllowed.value = true
          await router.push(taskEditTarget(nextPage.id))
          return
        }
        clearGlyphQueue(projectId)
        noNextTask.value = true
      } catch (claimError) {
        if (!isCurrentCase(scope)) return
        // 缺字专队耗尽（后端 404）要明确结束，而不是卡在"自动领取失败/重试"里循环。
        if (glyphQueueFor(projectId) && getPbStatus(claimError) === 404) {
          clearGlyphQueue(projectId)
          claimNextFailure.value = false
          noNextTask.value = true
          saved.value += ' 缺字待登记队列已清空。'
        } else {
          claimNextFailure.value = true
          noNextTask.value = false
          console.warn('Failed to claim next page after successful proofread submit:', claimError)
        }
      }
    } catch (e) {
      if (!isCurrentCase(scope)) return
      const message = getPbMessage(e, '提交失败，请重试')
      if (message.includes('研究用途')) await loadResearchNotice()
      if (!isCurrentCase(scope)) return
      if (isLeaseFailure(message)) markLeaseLost(message)
      else saveError.value = message
    } finally {
      if (isCurrentCase(scope)) {
        saving.value = false
        if (saveError.value && reviewingSubmission.value) {
          await nextTick()
          if (isCurrentCase(scope)) submitConfirmButton.value?.focus()
        }
      }
    }
  }

  async function retryClaimNext() {
    if (retryingClaim.value || !page.value || !currentUserId.value) return
    const scope = captureCase()
    retryingClaim.value = true
    try {
      const nextPage = await claimNextProjectPage(
        page.value.project,
        currentUserId.value,
        page.value.id,
        '',
        glyphQueueFor(page.value.project)
      )
      if (!isCurrentCase(scope)) return
      if (nextPage?.id) {
        saveClaimedLease(nextPage)
        setTaskFlash(window.sessionStorage, saved.value, {
          userId: currentUserId.value,
          pageId: nextPage.id,
          kind: 'submission'
        })
        claimNextFailure.value = false
        leaseNavigationAllowed.value = true
        await router.push(taskEditTarget(nextPage.id))
        return
      }
      claimNextFailure.value = false
      noNextTask.value = true
    } catch (claimError) {
      if (!isCurrentCase(scope)) return
      if (glyphQueueFor(page.value.project) && getPbStatus(claimError) === 404) {
        clearGlyphQueue(page.value.project)
        claimNextFailure.value = false
        noNextTask.value = true
        saved.value = '缺字待登记队列已清空。'
      } else {
        claimNextFailure.value = true
        noNextTask.value = false
        console.warn('Failed to retry claim after proofread submit:', claimError)
      }
    } finally {
      if (isCurrentCase(scope)) retryingClaim.value = false
    }
  }

  return { submitProofread, retryClaimNext }
}
