// Presentation only: a local draft or an online event never confirms a server write.
export function proofreadTaskFeedback({
  loading,
  hasPage = true,
  ownReview,
  saving,
  leaseLost,
  saveError,
  submittedHere,
  claimNextFailure,
  retryingClaim,
  draftStatus,
  saved,
  previousSubmission,
  online = true
} = {}) {
  if (loading) return { kind: 'loading', label: '准备中', text: '正在读取当前任务' }
  if (!hasPage)
    return {
      kind: saveError ? 'error' : 'empty',
      label: '任务不可用',
      text: saveError ? '请查看原因后重新加载' : '请返回任务列表'
    }
  if (ownReview)
    return { kind: 'readonly', label: '只读回看', text: '已提交的结果，不能修改或再次提交' }
  if (submittedHere)
    return {
      kind: 'submitted',
      label: '已提交',
      text:
        saving || retryingClaim
          ? '正在领取下一条，当前结果已确认'
          : claimNextFailure
            ? '下一条尚未领取，可重试领取'
            : saved || '本条已由服务端确认',
      detail: saved || ''
    }
  if (saving)
    return { kind: 'submitting', label: '提交中', text: '正在等待服务端确认，请勿重复提交' }
  if (leaseLost) return { kind: 'error', label: '租约失效', text: '请保留本页输入，重新领取任务' }
  if (saveError) return { kind: 'error', label: '操作未完成', text: '请查看下方原因，再手动重试' }
  if (draftStatus?.includes('失败'))
    return { kind: 'error', label: '本机保存失败', text: '请保留当前页面，避免输入丢失' }
  if (!online)
    return {
      kind: 'offline',
      label: '检测到离线',
      text: '提交以服务端确认为准，请保留本页',
      detail: '浏览器报告当前离线，不表示本机草稿已保存；请保持本页，联网后手动核对操作结果。'
    }
  if (draftStatus)
    return {
      kind: 'draft',
      label: '本机草稿',
      text: draftStatus.includes('保存中')
        ? '正在保存到本机，尚未提交'
        : /^(草稿已保存于|已恢复)/.test(draftStatus)
          ? '已存本机，尚未提交'
          : draftStatus,
      detail: draftStatus
    }
  return {
    kind: 'editing',
    label: '待提交',
    text: previousSubmission
      ? '上一条已提交 · 当前条目尚未提交'
      : saved
        ? '当前条目尚未提交'
        : '核对完成后检查并提交',
    ...(previousSubmission && { detail: previousSubmission })
  }
}

export function proofreadSubmitLabel({ submittedHere, saving, retryingClaim } = {}) {
  if (submittedHere) return saving || retryingClaim ? '正在领取…' : '本条已提交'
  return saving ? '提交中…' : '检查并提交'
}
