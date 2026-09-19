import test from 'node:test'
import assert from 'node:assert/strict'

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
  assert.equal(api.hasNeighborTasks.value, false)
  assert.equal(api.prevTaskId.value, '')
  assert.equal(api.nextTaskId.value, '')
})

test('a lone task reports 1/1 without inventing navigation targets', async () => {
  const api = await neighborsFor({ id: 'a', project: 'p1' }, [{ id: 'a' }])
  assert.equal(api.taskPosition.value, 1)
  assert.equal(api.taskCount.value, 1)
  assert.equal(api.hasNeighborTasks.value, false, 'a single task must not advertise prev/next')
  assert.equal(api.prevTaskId.value, '')
  assert.equal(api.nextTaskId.value, '')
})

test('the counter is one-based and the neighbours are the adjacent records', async () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const api = await neighborsFor({ id: 'b', project: 'p1' }, list)
  assert.equal(`${api.taskPosition.value}/${api.taskCount.value}`, '2/3')
  assert.equal(api.prevTaskId.value, 'a')
  assert.equal(api.nextTaskId.value, 'c')
  assert.equal(api.hasNeighborTasks.value, true)
})

test('stepping off either end wraps around', async () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const first = await neighborsFor({ id: 'a', project: 'p1' }, list)
  assert.equal(first.taskPosition.value, 1)
  assert.equal(first.prevTaskId.value, 'c')
  assert.equal(first.nextTaskId.value, 'b')

  const last = await neighborsFor({ id: 'c', project: 'p1' }, list)
  assert.equal(`${last.taskPosition.value}/${last.taskCount.value}`, '3/3')
  assert.equal(last.prevTaskId.value, 'b')
  assert.equal(last.nextTaskId.value, 'a')
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
  assert.equal(api.hasNeighborTasks.value, false)
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
  assert.equal(api.hasNeighborTasks.value, false, 'stale neighbours must not survive a shrink')
})
