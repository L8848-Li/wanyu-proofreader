import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { useTaskNeighbors } from '../src/composables/useTaskNeighbors.js'

const ref = (value) => ({ value })

async function neighborsFor(page, list) {
  const loaded = ref(page)
  const api = useTaskNeighbors(loaded, async () => list)
  await api.loadNeighbors()
  return api
}

test('an unreadable page has no position and no neighbours', async () => {
  const api = await neighborsFor(null, [{ id: 'a' }, { id: 'b' }])
  assert.equal(api.taskPosition.value, 0)
  assert.equal(api.taskCount.value, 0)
  assert.equal(api.canNavigatePrev.value, false)
  assert.equal(api.canNavigateNext.value, false)
  assert.equal(api.prevTaskId.value, '')
  assert.equal(api.nextTaskId.value, '')
})

test('a lone task reports 1/1 without inventing navigation targets', async () => {
  const api = await neighborsFor({ id: 'a', project: 'p1' }, [{ id: 'a' }])
  assert.equal(api.taskPosition.value, 1)
  assert.equal(api.taskCount.value, 1)
  assert.equal(api.canNavigatePrev.value, false)
  assert.equal(api.canNavigateNext.value, false)
  assert.equal(api.prevTaskId.value, '')
  assert.equal(api.nextTaskId.value, '')
})

test('the counter is one-based and the neighbours are the adjacent records', async () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const api = await neighborsFor({ id: 'b', project: 'p1' }, list)
  assert.equal(`${api.taskPosition.value}/${api.taskCount.value}`, '2/3')
  assert.equal(api.prevTaskId.value, 'a')
  assert.equal(api.nextTaskId.value, 'c')
  assert.equal(api.canNavigatePrev.value, true)
  assert.equal(api.canNavigateNext.value, true)
})

test('first and last tasks cannot wrap around', async () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const first = await neighborsFor({ id: 'a', project: 'p1' }, list)
  assert.equal(first.taskPosition.value, 1)
  assert.equal(first.prevTaskId.value, '')
  assert.equal(first.nextTaskId.value, 'b')
  assert.equal(first.canNavigatePrev.value, false)

  const last = await neighborsFor({ id: 'c', project: 'p1' }, list)
  assert.equal(`${last.taskPosition.value}/${last.taskCount.value}`, '3/3')
  assert.equal(last.prevTaskId.value, 'b')
  assert.equal(last.nextTaskId.value, '')
  assert.equal(last.canNavigateNext.value, false)
})

test('a task outside the loaded page reports position zero rather than a wrong index', async () => {
  const api = await neighborsFor({ id: 'zz', project: 'p1' }, [{ id: 'a' }, { id: 'b' }])
  assert.equal(api.taskPosition.value, 0)
  assert.equal(api.taskCount.value, 2)
  assert.equal(api.prevTaskId.value, '')
  assert.equal(api.nextTaskId.value, '')
})

test('a page without a project is treated as no task at all', async () => {
  const api = await neighborsFor({ id: 'a' }, [{ id: 'a' }, { id: 'b' }])
  assert.equal(api.taskCount.value, 0)
  assert.equal(api.canNavigatePrev.value, false)
  assert.equal(api.canNavigateNext.value, false)
})

test('reloading a shorter list clears the previous neighbours', async () => {
  const page = ref({ id: 'a', project: 'p1' })
  let list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const api = useTaskNeighbors(page, async () => list)
  await api.loadNeighbors()
  assert.equal(api.nextTaskId.value, 'b')

  page.value = null
  await api.loadNeighbors()
  assert.equal(api.prevTaskId.value, '')
  assert.equal(api.nextTaskId.value, '')
  assert.equal(api.taskPosition.value, 0)
  assert.equal(api.taskCount.value, 0)

  page.value = { id: 'b', project: 'p1' }
  list = [{ id: 'b' }]
  await api.loadNeighbors()
  assert.equal(api.taskPosition.value, 1)
  assert.equal(api.canNavigatePrev.value, false, 'stale neighbours must not survive a shrink')
  assert.equal(api.canNavigateNext.value, false)
})

test('list failure is distinct from an empty list and can be retried', async () => {
  let fail = true
  const page = ref({ id: 'a', project: 'p1' })
  const api = useTaskNeighbors(page, async () => {
    if (fail) throw new Error('offline')
    return [{ id: 'a' }]
  })
  await api.loadNeighbors()
  assert.equal(api.neighborsState.value, 'error')
  assert.equal(api.neighborsError.value, 'offline')
  assert.equal(api.taskPosition.value, 0)
  fail = false
  await api.loadNeighbors()
  assert.equal(api.neighborsState.value, 'ready')
  assert.equal(api.taskPosition.value, 1)
})

test('a stale response cannot replace the current task list', async () => {
  const page = ref({ id: 'a', project: 'p1' })
  let resolveOld
  const api = useTaskNeighbors(page, (current) => current.id === 'a'
    ? new Promise((resolve) => { resolveOld = resolve })
    : Promise.resolve([{ id: 'b' }]))
  const oldLoad = api.loadNeighbors()
  page.value = { id: 'b', project: 'p1' }
  await api.loadNeighbors()
  resolveOld([{ id: 'a' }])
  await oldLoad
  assert.equal(api.taskPosition.value, 1)
  assert.equal(api.taskCount.value, 1)
  assert.equal(api.neighborsState.value, 'ready')
})

test('list failures expose PocketBase details and localize generic errors', async () => {
  const page = ref({ id: 'a', project: 'p1' })
  let error = { message: 'Something went wrong while processing your request.' }
  const api = useTaskNeighbors(page, async () => { throw error })
  await api.loadNeighbors()
  assert.equal(api.neighborsError.value, '获取进行中任务失败，请重试。')
  error = { response: { data: { project: { message: '当前账号无权访问此项目' } } } }
  await api.loadNeighbors()
  assert.equal(api.neighborsError.value, '当前账号无权访问此项目')
})

test('editor loader reports a lost identity as an error and recovers after login', async () => {
  const source = readFileSync(new URL('../src/views/proofreader/ProofreadEditorView.vue', import.meta.url), 'utf8')
  const loaderBody = source.match(/useTaskNeighbors\(page, async \(currentPage\) => \{([\s\S]*?)\n\}\)/)?.[1]
  assert.ok(loaderBody, 'exercise the actual editor loader')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const loader = new AsyncFunction('currentPage', 'currentUserId', 'listProofreaderNeighborTasks', loaderBody)
  const user = ref('')
  let calls = 0
  const api = useTaskNeighbors(ref({ id: 'a', project: 'p1' }), (page) => loader(page, user, async (project, userId) => {
    calls += 1
    assert.equal(project, 'p1')
    assert.equal(userId, 'u1')
    return [{ id: 'a' }, { id: 'b' }]
  }))
  await api.loadNeighbors()
  assert.equal(api.neighborsState.value, 'error')
  assert.equal(api.neighborsError.value, '登录状态已失效，请重新登录后重试。')
  assert.equal(api.canNavigateNext.value, false)
  assert.equal(calls, 0)
  user.value = 'u1'
  await api.loadNeighbors()
  assert.equal(api.neighborsState.value, 'ready')
  assert.equal(api.neighborsError.value, '')
  assert.equal(api.canNavigateNext.value, true)
  assert.equal(calls, 1)
})
