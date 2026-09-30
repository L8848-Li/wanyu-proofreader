export const SOURCE_STATUS_LABELS = Object.freeze({
  unregistered: '未入册',
  pending_rights: '待权利确认',
  confirmed: '已确认可用',
  restricted: '受限'
})

export const SOURCE_ORIGIN_LABELS = Object.freeze({
  original: '原始',
  derived: '派生'
})

export const USAGE_PURPOSE_LABELS = Object.freeze({
  public_display: '公开展示',
  internal_research: '内部研究',
  model_training: '模型训练',
  commercial_use: '商业使用',
  redistribution: '再分发',
  raw_third_party_transfer: '原始材料转交第三方'
})

export const USAGE_DECISION_LABELS = Object.freeze({
  allow: '允许',
  deny: '禁止',
  unknown: '未知'
})

export function sourceStatusClass(status) {
  if (status === 'confirmed') return 'badge-approved'
  if (status === 'restricted') return 'badge-rejected'
  if (status === 'pending_rights') return 'badge-arbitration'
  return 'badge-pending'
}
