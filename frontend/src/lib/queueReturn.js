import { importJobScope, validImportJob } from './adminPageList.js'
import { todoReturnRow, todoReturnTarget } from './unifiedTodos.js'

const prefix = 'wanyu:queue-return:v1'
const key = (userId, kind) => `${prefix}:${encodeURIComponent(userId || '')}:${kind}`
const kindOf = (route) =>
  route?.name === 'ProofreadEditor'
    ? 'proofread'
    : route?.name === 'Arbitration'
      ? 'arbitration'
      : ''

export function browserSessionStorage() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function safeQueuePath(path, kind) {
  if (typeof path !== 'string' || path.length > 2048 || /[\\\r\n]/.test(path)) return false
  if (kind === 'todo') return /^\/admin\/todos(?:[?#].*)?$/.test(path)
  return kind === 'proofread'
    ? /^\/tasks(?:[?#].*)?$/.test(path)
    : /^\/admin(?:\/projects\/[a-z0-9]+(?:\/verification)?)?(?:[?#].*)?$/.test(path)
}

function read(storage, userId, kind, pathKind = kind) {
  if (!storage || !userId || !kind) return null
  try {
    const value = JSON.parse(storage.getItem(key(userId, kind)) || 'null')
    return safeQueuePath(value?.path, pathKind) ? value : null
  } catch {
    return null
  }
}

export function queueReturnTarget(storage, userId, route) {
  const kind = kindOf(route)
  const context = read(storage, userId, kind)
  const importJob = importJobScope(route.query?.importJob)
  if (kind === 'arbitration' && importJob && !validImportJob(importJob))
    return `/admin/projects/${route.params.projectId}?section=materials&view=batches#project-ledger`
  if (
    context &&
    (kind !== 'arbitration' ||
      (context.projectId === String(route.params?.projectId || '') &&
        validImportJob(
          new URL(context.path, 'https://queue.invalid').searchParams.get('importJob')
        ) === importJob))
  )
    return context.path
  if (kind === 'arbitration')
    return route.query?.mode === 'verification'
      ? `/admin/projects/${route.params.projectId}/verification?view=review`
      : `/admin/projects/${route.params.projectId}?section=work&status=arbitration${importJob ? `&importJob=${importJob}` : ''}`
  return '/tasks'
}

export function rememberQueueTransition(storage, userId, to, from, position = {}) {
  if (!storage || !userId) return
  const next = kindOf(to),
    previous = kindOf(from)
  try {
    if (from?.name === 'AdminTodos' && to.name !== 'AdminTodos') {
      if (safeQueuePath(from.fullPath, 'todo') && safeQueuePath(position.todoPath, 'todo'))
        storage.setItem(
          key(userId, 'todo'),
          JSON.stringify({
            path: from.fullPath,
            returnPath: position.todoPath,
            focusId: todoReturnRow(to),
            left: Number(position.left) || 0,
            top: Number(position.top) || 0
          })
        )
      else storage.removeItem(key(userId, 'todo'))
    }
    if (todoReturnTarget(from) && !todoReturnTarget(to)) {
      const context = read(storage, userId, 'todo')
      storage.removeItem(key(userId, 'todo'))
      if (context && (context.path === to.fullPath || context.returnPath === to.fullPath))
        storage.setItem(key(userId, 'pending'), JSON.stringify({ ...context, path: to.fullPath }))
    }
    if (next && next !== previous) {
      if (safeQueuePath(from?.fullPath, next))
        storage.setItem(
          key(userId, next),
          JSON.stringify({
            path: from.fullPath,
            projectId: String(to.params?.projectId || ''),
            left: Number(position.left) || 0,
            top: Number(position.top) || 0
          })
        )
      else storage.removeItem(key(userId, next))
    }
    if (previous && !next) {
      const context = read(storage, userId, previous)
      if (context?.path === to.fullPath)
        storage.setItem(key(userId, 'pending'), JSON.stringify(context))
    }
  } catch {
    /* Returning to a queue also works without browser storage. */
  }
}

export function retargetTodoPosition(storage, userId, from, to) {
  const context = read(storage, userId, 'pending', 'todo')
  if (!context || context.path !== from || !safeQueuePath(to, 'todo')) return
  try {
    storage.setItem(key(userId, 'pending'), JSON.stringify({ ...context, path: to }))
  } catch {
    /* The browser can still restore its native scroll position. */
  }
}

export function takeQueuePosition(storage, userId, path) {
  if (!storage || !userId) return null
  try {
    const value = JSON.parse(storage.getItem(key(userId, 'pending')) || 'null')
    if (value?.path !== path) return null
    storage.removeItem(key(userId, 'pending'))
    return {
      left: Math.max(0, Math.min(10000000, Number(value.left) || 0)),
      top: Math.max(0, Math.min(10000000, Number(value.top) || 0)),
      ...(typeof value.focusId === 'string' && { focusId: value.focusId })
    }
  } catch {
    return null
  }
}
