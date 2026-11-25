import pb from '@/lib/pocketbase'
import { createPageListLoader } from '../lib/pageListLoader.js'
import { PAGE_STATUS, PROOFREADER_ACTIVE_STATUSES, statusFilter } from '@/constants/pageStatus'

function relationFilter(field, id) {
  return `${field}="${id}"`
}

// Injectable implementation is exercised against the same PocketBase contract
// in native Node tests; production retains this public service signature.
export const listPagesWithFallback = createPageListLoader(pb)

export async function countPages(filter) {
  const result = await pb.collection('pages').getList(1, 1, {
    filter,
    fields: 'id',
    requestKey: null
  })
  return Number(result.totalItems || 0)
}

export async function countProjectPages(projectId) {
  return countPages(relationFilter('project', projectId))
}

export async function listProjectPageWindow(projectId, startIndex, endIndex) {
  const pageSize = 100
  const firstPage = Math.floor(startIndex / pageSize) + 1
  const lastPage = Math.floor(endIndex / pageSize) + 1
  const filter = relationFilter('project', projectId)
  const rows = []
  let totalItems = 0
  for (let page = firstPage; page <= lastPage; page++) {
    const result = await listPagesWithFallback({
      page,
      perPage: pageSize,
      filter,
      sort: 'page_number',
      fields: 'id,status,page_number'
    })
    rows.push(...(result.items || []))
    totalItems = Number(result.totalItems || 0)
  }
  const offset = startIndex - (firstPage - 1) * pageSize
  return {
    items: rows.slice(offset, offset + endIndex - startIndex + 1),
    totalItems
  }
}

export async function listPendingProofreadTasks(page, perPage) {
  return listPagesWithFallback({
    page,
    perPage,
    filter: `status="${PAGE_STATUS.PENDING}"`,
    sort: 'page_number',
    expand: 'project',
    fields: 'id,page_number,pdf_page,project,status,expand.project.id,expand.project.name'
  })
}

export async function listProjectQueueSummaries(page = 1, perPage = 12, options = {}) {
  return pb.send('/api/fangji/proofreading-queues', {
    query: {
      page,
      perPage,
      ...(options.filter ? { filter: options.filter } : {}),
      ...(options.project ? { project: options.project } : {})
    },
    signal: options.signal,
    requestKey: null
  })
}

export async function listAdminProjectPages(projectId, options = {}) {
  const { signal, ...query } = options
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pages`, {
    query,
    signal,
    requestKey: null
  })
}

export async function getAdminProjectPageStats(projectId, options = {}) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pages/stats`, {
    signal: options.signal,
    requestKey: null
  })
}

export async function listProofreaderTasks(userId, page, perPage) {
  return listPagesWithFallback({
    page,
    perPage,
    filter: relationFilter('proofreader', userId),
    sort: '-updated',
    expand: 'project',
    fields: 'id,page_number,pdf_page,project,status,expand.project.id,expand.project.name'
  })
}

export async function countActiveProofreaderTasks(userId) {
  return countPages(
    `${relationFilter('proofreader', userId)} && (${statusFilter(PROOFREADER_ACTIVE_STATUSES)})`
  )
}

export async function getPage(pageId, options = {}) {
  return pb.collection('pages').getOne(pageId, {
    requestKey: null,
    ...options
  })
}

export async function getProofreaderTask(pageId, { review = false } = {}) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/task`, {
    ...(review ? { query: { mode: 'review' } } : {}),
    requestKey: null
  })
}

export async function listReviewedProofreads(projectId, { signal } = {}) {
  if (!projectId) return { items: [], position: 0, total: 0 }
  const result = await pb.send(
    `/api/fangji/projects/${encodeURIComponent(projectId)}/tasks/reviewed`,
    {
      signal,
      requestKey: null
    }
  )
  const items = Array.isArray(result?.items) ? result.items : []
  return {
    items,
    position: Number(result?.position) || 0,
    total: Number.isFinite(Number(result?.total)) ? Number(result.total) : items.length
  }
}

export async function reorderPendingPages(projectId, orderedIds) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pages/reorder`, {
    method: 'POST',
    body: { orderedIds },
    requestKey: null
  })
}

export async function deletePendingPages(projectId, ids) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pages/delete-pending`, {
    method: 'POST',
    body: { ids },
    requestKey: null
  })
}

// #124：管理员修正「识别产出」（导入原文）内容。
// expectedUpdated 用于乐观锁，服务端比对不符返回 409。
// ocr_text 由服务端按 rowJson + headersJson 生成，不接受调用方传入。
export async function updatePageContent(
  projectId,
  pageId,
  { rowJson, headersJson, expectedUpdated }
) {
  return pb.send(
    `/api/fangji/projects/${encodeURIComponent(projectId)}/pages/${encodeURIComponent(pageId)}/content`,
    {
      method: 'POST',
      body: { rowJson, headersJson, expectedUpdated },
      requestKey: null
    }
  )
}

export async function listAllProjectPages(projectId, options = {}) {
  return pb.collection('pages').getFullList({
    filter: `project="${projectId}"`,
    sort: 'page_number',
    requestKey: null,
    ...options
  })
}

export async function getPagedProjectPages(projectId, page, perPage, options = {}) {
  return pb.collection('pages').getList(page, perPage, {
    filter: `project="${projectId}"`,
    sort: 'page_number',
    requestKey: null,
    ...options
  })
}

export async function listProofreaderNeighborTasks(projectId, userId) {
  if (!projectId || !userId) return []
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/tasks/mine`, {
    requestKey: null
  })
}

export async function claimNextProjectPage(
  projectId,
  userId,
  previousTaskId = '',
  tier = '',
  glyph = false
) {
  if (!projectId || !userId) throw new Error('缺少项目或校对员身份')
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/claim`, {
    method: 'POST',
    // tier 为空串 = 交给服务端按"默认优先 A、没有标签数据则退回原顺序"处理；
    // 传 A/B/C = 只在该层级里领。前端不自己排序，也不猜层级。
    // glyph = true 只领「缺字待登记」队列（missing_glyph=true 的条目）。
    body: { previousTaskId, tier, glyph },
    requestKey: null
  })
}

export async function renewTaskLease(pageId, leaseToken) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/lease/renew`, {
    method: 'POST',
    body: { leaseToken },
    requestKey: null
  })
}

export async function releaseTaskLease(pageId, leaseToken) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/release`, {
    method: 'POST',
    body: { leaseToken },
    requestKey: null
  })
}

export async function returnToSource(pageId, { reason, basis }) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/return-to-source`, {
    method: 'POST',
    body: { reason, basis },
    requestKey: null
  })
}

export async function submitTwoPassProofread(
  pageId,
  userId,
  { rowJson, text, leaseToken, ...verification }
) {
  if (!pageId || !userId) throw new Error('缺少任务或校对员身份')
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/submit`, {
    method: 'POST',
    body: { rowJson, text, leaseToken, ...verification },
    requestKey: null
  })
}

export async function getPageFindings(pageId, { signal } = {}) {
  const result = await pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/findings`, {
    requestKey: null,
    signal
  })
  if (!Array.isArray(result?.hints) || (result.page && result.page !== pageId))
    throw new Error('疑点响应无效')
  return {
    hints: result.hints,
    truncated: Boolean(result.truncated),
    suppressedByGate: Number.isFinite(Number(result.suppressed_by_gate))
      ? Math.max(0, Math.floor(Number(result.suppressed_by_gate)))
      : 0,
    research: result.research || null
  }
}
