// The workflow state comes from the complete event history. The receipt
// field remains useful for explaining a conflict or a recorded receipt.
export const receiptLabel = (item) => {
  if (item.workflow_state === 'withdrawn' || item.withdrawn) return '已停用'
  if (item.workflow_state === 'returned_resolved') return '退回已处置'
  if (item.workflow_state === 'pending_resolution') {
    if (item.receipt_state === 'partial_conflict') return '部分冲突，待上游处置'
    if (item.receipt_state === 'failed_rolled_back') return '整体失败并回滚，待上游处置'
    return '退回待处置'
  }
  const base =
    {
      awaiting_receipt: '对方尚未回执',
      success: '全部成功',
      partial_conflict: '部分冲突',
      failed_rolled_back: '整体失败并回滚'
    }[item.receipt_state] ||
    item.receipt_state ||
    '回执状态未记录'
  const label =
    item.receipt_state === 'partial_conflict'
      ? item.pending_actions?.length
        ? `${base}，待上游处理`
        : `${base}，已登记处置`
      : base
  if (item.receipt_channel === 'manual') return `${label}（人工回执，对方自动回传未接入）`
  return label
}

export const receiptEventNote = (event) => {
  const payload = event?.payload || {}
  const channel = payload.channel || 'manual'
  return `影响 ${payload.affected} 条 · ${channel === 'manual' ? '人工回执' : channel}`
}
