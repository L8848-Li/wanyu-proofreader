import test from 'node:test'
import assert from 'node:assert/strict'
import {
  carryTodoReturn,
  todoActionTarget,
  todoFilterError,
  todoReturnRow,
  todoReturnTarget
} from '../src/lib/unifiedTodos.js'

test('return to a filtered todo follows the same project workflow and never crosses projects', () => {
  const id = 'practiceproj001'
  const path = `/admin/projects/${id}/deliveries`
  const target = { path, query: { package: 'practicepack001', tab: 'events' } }
  const resolve = (location) => ({ ...location, name: 'ProjectDeliveries', params: { id } })
  const filters = { project: id, stage: 'delivery_return', page: 3 }
  const detail = resolve(
    todoActionTarget({ project: { id }, target, stage: 'delivery_return' }, resolve, filters)
  )
  const expectedReturn = { path: '/admin/todos', query: { ...filters, page: '3' } }
  assert.deepEqual(todoReturnTarget(detail), expectedReturn)
  assert.equal(todoReturnRow(detail), id + ':delivery_return')
  const summary = resolve({ path, query: { package: target.query.package, tab: 'summary' } })
  const continued = carryTodoReturn(summary, detail)
  assert.deepEqual(todoReturnTarget(resolve(continued)), expectedReturn)
  assert.equal(Object.hasOwn(continued, 'replace'), false)

  const unrelated = {
    ...detail,
    path: '/admin/projects/practiceproj002/deliveries',
    params: { id: 'practiceproj002' }
  }
  assert.equal(todoReturnTarget(unrelated), '')
  assert.equal(carryTodoReturn(unrelated, detail).query.todoFrom, undefined)
  const differentFlow = {
    ...detail,
    name: 'ProjectDetail',
    path: `/admin/projects/${id}`,
    query: { ...detail.query, section: 'work', view: 'entries' }
  }
  assert.equal(carryTodoReturn(differentFlow, detail).query.todoFrom, undefined)
  assert.equal(
    todoActionTarget({ project: { id }, target: { path: '//example.invalid' } }, resolve, filters),
    null
  )
  assert.match(todoFilterError({ project: [id] }), /项目筛选链接无效/)
  assert.match(todoFilterError({ stage: 'not-a-stage' }), /阶段筛选链接无效/)
})
