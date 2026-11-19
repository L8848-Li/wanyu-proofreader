const DRAFT_PREFIX = 'fangji:task-draft:v1'
const FLASH_KEY = 'fangji:task-flash:v1'

export function taskDraftKey(userId, pageId) {
  return `${DRAFT_PREFIX}:${String(userId || '')}:${String(pageId || '')}`
}

export function saveTaskDraft(
  storage,
  {
    userId,
    pageId,
    sourceSignature,
    row,
    contextBasis,
    findingReviews,
    savedAt = new Date().toISOString()
  }
) {
  if (!storage || !userId || !pageId || !sourceSignature || !row) return null
  const payload = {
    version: 1,
    userId: String(userId),
    pageId: String(pageId),
    sourceSignature: String(sourceSignature),
    row,
    savedAt
  }
  if (contextBasis) payload.contextBasis = String(contextBasis)
  if (contextBasis && Object.keys(findingReviews || {}).length)
    payload.findingReviews = findingReviews
  let previous = null
  try {
    previous = JSON.parse(storage.getItem(taskDraftKey(userId, pageId)) || 'null')
  } catch {
    /* A corrupt old payload is not a recoverable draft. */
  }
  if (
    previous?.userId === String(userId) &&
    previous?.pageId === String(pageId) &&
    (previous.sourceSignature !== payload.sourceSignature ||
      (previous.contextBasis && previous.contextBasis !== payload.contextBasis))
  ) {
    // Quota/storage failures must propagate: replacing the current value before
    // its old version is retained would silently lose an incompatible draft.
    storage.setItem(
      `${taskDraftKey(userId, pageId)}:history:${previous.savedAt || savedAt}`,
      JSON.stringify(previous)
    )
  }
  storage.setItem(taskDraftKey(userId, pageId), JSON.stringify(payload))
  return payload
}

export function loadTaskDraft(storage, { userId, pageId, sourceSignature, onStale }) {
  if (!storage || !userId || !pageId || !sourceSignature) return null
  const key = taskDraftKey(userId, pageId)
  const raw = storage.getItem(key)
  if (!raw) return null

  try {
    const draft = JSON.parse(raw)
    if (
      draft?.version !== 1 ||
      draft.userId !== String(userId) ||
      draft.pageId !== String(pageId) ||
      !draft.row ||
      Array.isArray(draft.row) ||
      typeof draft.row !== 'object'
    ) {
      storage.removeItem(key)
      return null
    }
    if (draft.sourceSignature !== String(sourceSignature)) {
      onStale?.(draft)
      return null
    }
    return draft
  } catch {
    storage.removeItem(key)
    return null
  }
}

export function archiveTaskDraft(storage, draft) {
  if (!storage || !draft?.userId || !draft?.pageId || !draft?.savedAt) return
  storage.setItem(
    `${taskDraftKey(draft.userId, draft.pageId)}:history:${draft.savedAt}`,
    JSON.stringify(draft)
  )
}

export function loadTaskDraftHistory(storage, { userId, pageId }) {
  const prefix = `${taskDraftKey(userId, pageId)}:history:`
  const rows = []
  for (let i = 0; i < Number(storage?.length || 0); i++) {
    const key = storage.key(i)
    if (!key?.startsWith(prefix)) continue
    try {
      const draft = JSON.parse(storage.getItem(key))
      if (draft.userId === String(userId) && draft.pageId === String(pageId)) rows.push(draft)
    } catch {
      /* Leave a corrupt history entry out of the view. */
    }
  }
  return rows
}

export function clearTaskDraft(storage, { userId, pageId, savedAt }) {
  if (!storage || !userId || !pageId) return
  const key = taskDraftKey(userId, pageId)
  if (savedAt) {
    const raw = storage.getItem(key)
    let current
    try {
      current = JSON.parse(raw)
    } catch {
      // Leave the entry in place if we cannot verify which draft it belongs to.
      return
    }
    if (current?.savedAt !== savedAt) return
  }
  storage.removeItem(key)
}

export function setTaskFlash(storage, message, { userId, pageId, kind = 'notice' }) {
  if (!storage || !message) return
  storage.setItem(FLASH_KEY, JSON.stringify({ message: String(message), userId, pageId, kind }))
}

export function takeTaskFlash(storage, { userId, pageId }) {
  if (!storage) return null
  const raw = storage.getItem(FLASH_KEY)
  storage.removeItem(FLASH_KEY)
  if (!raw) return null
  try {
    const flash = JSON.parse(raw)
    if (flash?.userId === userId && flash?.pageId === pageId && typeof flash?.message === 'string')
      return flash
  } catch {
    // Older tabs stored a plain notice. It does not establish a submission.
    return { kind: 'notice', message: raw }
  }
  return null
}
