import { unref } from 'vue'
import {
  clearTaskLease,
  isTransientLeaseRenewalError,
  loadTaskLease,
  saveTaskLease
} from '../../lib/taskLease.js'
import {
  claimNextProjectPage,
  releaseTaskLease,
  renewTaskLease
} from '../../services/pagesService.js'
import { setTaskFlash } from '../../lib/taskDraft.js'
import { getPbMessage } from '../../utils/pbErrors.js'

export function useProofreadLease({
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
  returnTarget,
  taskEditTarget,
  captureCase,
  isCurrentCase
}) {
  let leaseRenewTimer = null
  let leaseRetryTimer = null

  function saveClaimedLease(claimedPage) {
    if (!claimedPage?.id || !claimedPage.leaseToken) return false
    saveTaskLease(window.sessionStorage, {
      userId: currentUserId.value,
      pageId: claimedPage.id,
      token: claimedPage.leaseToken,
      expiresAt: claimedPage.leaseExpiresAt
    })
    if (claimedPage.id === page.value?.id) {
      leaseToken.value = claimedPage.leaseToken
      leaseExpiresAt.value = claimedPage.leaseExpiresAt || ''
      leaseLost.value = false
      saveError.value = ''
      startLeaseRenewal()
    }
    return true
  }

  function clearStoredLease() {
    if (page.value?.id && currentUserId.value) {
      clearTaskLease(window.sessionStorage, { userId: currentUserId.value, pageId: page.value.id })
    }
    leaseToken.value = ''
    leaseExpiresAt.value = ''
    stopLeaseRenewal()
  }

  async function restoreOrAcquireLease() {
    const scope = captureCase()
    const stored = loadTaskLease(window.sessionStorage, {
      userId: currentUserId.value,
      pageId: page.value?.id
    })
    if (stored) {
      leaseToken.value = stored.token
      leaseExpiresAt.value = stored.expiresAt
      await renewCurrentLease({ force: true })
      if (!isCurrentCase(scope)) return
      if (!leaseLost.value) startLeaseRenewal()
      return
    }
    await reclaimTask()
  }

  function startLeaseRenewal() {
    // 只重置 interval：恢复入口首次续期遇瞬时错误安排的短重试必须保留，
    // 清理 retry 属于 stopLeaseRenewal（离场/判丢等停止路径）。
    if (leaseRenewTimer) window.clearInterval(leaseRenewTimer)
    leaseRenewTimer = window.setInterval(() => renewCurrentLease(), 2 * 60 * 1000)
  }

  function stopLeaseRenewal() {
    if (leaseRetryTimer) {
      window.clearTimeout(leaseRetryTimer)
      leaseRetryTimer = null
    }
    if (!leaseRenewTimer) return
    window.clearInterval(leaseRenewTimer)
    leaseRenewTimer = null
  }

  function scheduleLeaseRetry() {
    if (leaseRetryTimer) return
    leaseRetryTimer = window.setTimeout(() => {
      leaseRetryTimer = null
      renewCurrentLease({ force: true })
    }, 20 * 1000)
  }

  function handleLeaseActivation() {
    if (document.visibilityState === 'visible') renewCurrentLease()
  }

  async function renewCurrentLease({ force = false } = {}) {
    if (renewingLease.value || leaseLost.value || !page.value?.id || !leaseToken.value) return
    if (!force && (document.visibilityState !== 'visible' || !document.hasFocus())) return
    const scope = captureCase()
    renewingLease.value = true
    try {
      const result = await renewTaskLease(page.value.id, leaseToken.value)
      if (!isCurrentCase(scope)) return
      leaseExpiresAt.value = result.leaseExpiresAt || ''
      saveTaskLease(window.sessionStorage, {
        userId: currentUserId.value,
        pageId: page.value.id,
        token: leaseToken.value,
        expiresAt: leaseExpiresAt.value
      })
      if (leaseRetryTimer) {
        window.clearTimeout(leaseRetryTimer)
        leaseRetryTimer = null
      }
    } catch (e) {
      if (!isCurrentCase(scope)) return
      if (e?.isAbort || e?.name === 'AbortError') return
      if (isTransientLeaseRenewalError(e)) {
        // 断网几秒不代表租约被服务端收回：保留令牌稍后重试，避免被迫重领换任务。
        scheduleLeaseRetry()
        return
      }
      markLeaseLost(getPbMessage(e, '任务租约续期失败，本地草稿仍然保留，请重新领取任务。'))
    } finally {
      if (isCurrentCase(scope)) renewingLease.value = false
    }
  }

  function markLeaseLost(message) {
    flushDraft()
    clearStoredLease()
    leaseLost.value = true
    saveError.value = message
    reviewingSubmission.value = false
  }

  function isLeaseFailure(message) {
    return /租约|重新领取|不属于你|被重新领取/.test(String(message || ''))
  }

  async function reclaimTask() {
    if (reclaiming.value || !page.value?.project || !currentUserId.value) return
    const scope = captureCase()
    reclaiming.value = true
    flushDraft()
    try {
      const claimedPage = await claimNextProjectPage(
        page.value.project,
        currentUserId.value,
        '',
        '',
        glyphQueueFor(page.value.project)
      )
      if (!isCurrentCase(scope)) return
      if (!claimedPage?.id || !saveClaimedLease(claimedPage)) {
        markLeaseLost('当前项目暂无可重新领取的任务，本地草稿仍然保留。')
        return
      }
      if (claimedPage.id !== page.value.id) {
        setTaskFlash(
          window.sessionStorage,
          '原任务已被重新领取；本地草稿仍保留，已为你打开另一条任务。',
          { userId: currentUserId.value, pageId: claimedPage.id }
        )
        leaseNavigationAllowed.value = true
        await router.push(taskEditTarget(claimedPage.id))
      }
    } catch (e) {
      if (!isCurrentCase(scope)) return
      markLeaseLost(getPbMessage(e, '重新领取失败，本地草稿仍然保留。'))
    } finally {
      if (isCurrentCase(scope)) reclaiming.value = false
    }
  }

  async function releaseCurrentTask() {
    if (releasing.value || !page.value?.id || !leaseToken.value) return
    if (!window.confirm('释放后其他校对员可以领取此任务；当前本地草稿会保留。确定释放吗？')) return
    const scope = captureCase()
    releasing.value = true
    flushDraft()
    try {
      await verificationPanel.value?.persistDraft()
      if (!isCurrentCase(scope)) return
      await releaseTaskLease(page.value.id, leaseToken.value)
      if (!isCurrentCase(scope)) return
      clearStoredLease()
      leaseNavigationAllowed.value = true
      await router.push(unref(returnTarget) || '/tasks')
    } catch (e) {
      if (!isCurrentCase(scope)) return
      const message = getPbMessage(e, '释放任务失败，请稍后重试。')
      if (isLeaseFailure(message)) markLeaseLost(message)
      else saveError.value = message
    } finally {
      if (isCurrentCase(scope)) releasing.value = false
    }
  }

  return {
    saveClaimedLease,
    clearStoredLease,
    restoreOrAcquireLease,
    stopLeaseRenewal,
    handleLeaseActivation,
    markLeaseLost,
    isLeaseFailure,
    releaseCurrentTask,
    reclaimTask
  }
}
