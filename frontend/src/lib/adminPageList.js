export function parseRangeInput(text, max) {
  const raw = String(text || '').trim()
  const safeMax = Math.max(0, Number(max) || 0)
  if (!raw || !safeMax) return []
  const indices = new Set()
  const parts = raw
    .split(/[,，]/)
    .map((value) => value.trim())
    .filter(Boolean)

  for (const part of parts) {
    if (part.includes('-')) {
      const [startText, endText] = part.split('-').map((value) => value.trim())
      const start = Number(startText)
      const end = Number(endText)
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue
      const from = Math.max(1, Math.min(start, end))
      const to = Math.min(safeMax, Math.max(start, end))
      for (let value = from; value <= to; value += 1) indices.add(value - 1)
      continue
    }

    const value = Number(part)
    if (Number.isInteger(value) && value >= 1 && value <= safeMax) {
      indices.add(value - 1)
    }
  }

  return Array.from(indices).sort((left, right) => left - right)
}

function queryValue(value) {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value, fallback = '') {
  const parsed = Number(queryValue(value))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function validImportJob(value) {
  return typeof value === 'string' && /^[a-z0-9]{15}$/.test(value) ? value : ''
}

export function importJobScope(value) {
  if (value === undefined || value === '') return ''
  return validImportJob(value) || 'invalid'
}

export function normalizeAdminPageQuery(query, { statuses, qualityStates, pageSizes }) {
  const status = String(queryValue(query.status) || '')
  const qualityState = String(queryValue(query.qualityState) || '')
  const perPage = positiveInteger(query.perPage, 25)
  const text = queryValue(query.q)
  const importJob = importJobScope(query.importJob)
  return {
    q: typeof text === 'string' ? text.trim() : '',
    status: statuses.includes(status) ? status : '',
    qualityState: qualityStates.includes(qualityState) ? qualityState : '',
    minPage: positiveInteger(query.minPage),
    maxPage: positiveInteger(query.maxPage),
    page: positiveInteger(query.page, 1),
    perPage: pageSizes.includes(perPage) ? perPage : 25,
    ...(importJob ? { importJob } : {})
  }
}

export function adminPageRouteQuery(state) {
  const query = {}
  if (state.importJob) query.importJob = state.importJob
  if (state.q) query.q = state.q
  if (state.status) query.status = state.status
  if (state.qualityState) query.qualityState = state.qualityState
  if (state.minPage) query.minPage = String(state.minPage)
  if (state.maxPage) query.maxPage = String(state.maxPage)
  if (state.page > 1) query.page = String(state.page)
  if (state.perPage !== 25) query.perPage = String(state.perPage)
  return query
}

export function pendingBatchFilter(projectId) {
  return `project="${projectId}" && status="pending"`
}

export function rangeBatchFilter(projectId, indexes) {
  const numbers = indexes.map((index) => index + 1)
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  return `project="${projectId}" && page_number >= ${min} && page_number <= ${max}`
}

// 批量操作按需取数：系统维护 page_number 连续 1..N（导入顺序赋号、删除后重编号），
// 范围位置与 page_number 一一对应，只需取回范围覆盖的行。
export function pendingIdsAtPositions(rows, indexes) {
  const byNumber = new Map(rows.map((row) => [Number(row.page_number), row]))
  const ids = []
  for (const index of indexes) {
    const row = byNumber.get(index + 1)
    if (row && row.status === 'pending') ids.push(row.id)
  }
  return ids
}
