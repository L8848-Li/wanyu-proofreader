import test from 'node:test'
import assert from 'node:assert/strict'
import {
  queueReturnTarget,
  rememberQueueTransition,
  retargetTodoPosition,
  takeQueuePosition
} from '../src/lib/queueReturn.js'
const memory = () => {
  const data = new Map()
  return {
    getItem: (key) => data.get(key),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  }
}
const task = { name: 'ProofreadEditor', params: { id: 'task1' } }
const arbitration = { name: 'Arbitration', params: { projectId: 'project1', pageId: 'page1' } }

test('unified todo restores its exact filters and row after continuing detail, once per account', () => {
  const storage = memory()
  const projectId = 'practiceproj001'
  const list = {
    name: 'AdminTodos',
    fullPath: '/admin/todos?stage=arbitration&project=' + projectId
  }
  const returnPath = '/admin/todos?project=' + projectId + '&stage=arbitration'
  const returned = { name: 'AdminTodos', fullPath: returnPath }
  const detail = {
    ...arbitration,
    params: { projectId, pageId: 'page1' },
    query: { todoFrom: projectId + ':arbitration?stage=arbitration&row=arbitration' }
  }
  rememberQueueTransition(storage, 'alice', detail, list, { top: 530, todoPath: returnPath })
  const next = { ...detail, params: { ...detail.params, pageId: 'page2' } }
  rememberQueueTransition(storage, 'alice', next, detail)
  rememberQueueTransition(storage, 'alice', returned, next)
  assert.equal(takeQueuePosition(storage, 'bob', returnPath), null)
  const correctedPath = returnPath + '&page=2'
  retargetTodoPosition(storage, 'alice', returnPath, correctedPath)
  assert.equal(takeQueuePosition(storage, 'alice', returnPath), null)
  assert.deepEqual(takeQueuePosition(storage, 'alice', correctedPath), {
    top: 530,
    left: 0,
    focusId: projectId + ':arbitration'
  })
  assert.equal(takeQueuePosition(storage, 'alice', correctedPath), null)
})

test('task return keeps queue filters and restores its position exactly once after data is ready', () => {
  const storage = memory(),
    queue = { name: 'TaskHall', fullPath: '/tasks?project=project1&view=active&page=2' }
  rememberQueueTransition(storage, 'alice', task, queue, { top: 640, left: 0 })
  assert.equal(queueReturnTarget(storage, 'alice', task), queue.fullPath)
  assert.equal(queueReturnTarget(storage, 'bob', task), '/tasks')
  rememberQueueTransition(storage, 'alice', queue, task)
  assert.equal(takeQueuePosition(storage, 'alice', '/tasks'), null)
  assert.deepEqual(takeQueuePosition(storage, 'alice', queue.fullPath), { top: 640, left: 0 })
  assert.equal(takeQueuePosition(storage, 'alice', queue.fullPath), null)
})

test('continuing within a queue keeps context while a different project or direct link uses a safe fallback', () => {
  const storage = memory(),
    queue = {
      name: 'SourceFidelity',
      fullPath: '/admin/projects/project1/verification?view=review'
    }
  rememberQueueTransition(storage, 'alice', arbitration, queue)
  rememberQueueTransition(
    storage,
    'alice',
    { ...arbitration, params: { ...arbitration.params, pageId: 'page2' } },
    arbitration
  )
  assert.equal(queueReturnTarget(storage, 'alice', arbitration), queue.fullPath)
  assert.equal(
    queueReturnTarget(storage, 'alice', { ...arbitration, params: { projectId: 'project2' } }),
    '/admin/projects/project2?section=work&status=arbitration'
  )
  rememberQueueTransition(storage, 'alice', task, { fullPath: '/workspace' })
  assert.equal(queueReturnTarget(storage, 'alice', task), '/tasks')
})

test('storage errors and external destinations do not interrupt navigation', () => {
  const storage = memory()
  rememberQueueTransition(storage, 'alice', task, { fullPath: 'https://example.test/tasks' })
  assert.equal(queueReturnTarget(storage, 'alice', task), '/tasks')
  const denied = {
    getItem() {
      throw Error('denied')
    },
    setItem() {
      throw Error('denied')
    },
    removeItem() {
      throw Error('denied')
    }
  }
  assert.doesNotThrow(() => rememberQueueTransition(denied, 'alice', task, { fullPath: '/tasks' }))
  assert.equal(queueReturnTarget(denied, 'alice', task), '/tasks')
})
