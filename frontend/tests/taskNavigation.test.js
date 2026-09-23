import test from 'node:test'
import assert from 'node:assert/strict'
import { canGoNext, canGoPrev, positionOf, stepIndex } from '../src/lib/taskNavigation.js'

test('empty and missing tasks have no position or navigation target', () => {
  assert.equal(positionOf([], 'a'), -1)
  assert.equal(positionOf([{ id: 'a' }], 'missing'), -1)
  assert.equal(canGoPrev(-1, 0), false)
  assert.equal(canGoNext(-1, 2), false)
  assert.equal(stepIndex(-1, 2, 'next'), -1)
})

test('a single task has a position but no adjacent task', () => {
  assert.equal(positionOf([{ id: 'a' }], 'a'), 0)
  assert.equal(canGoPrev(0, 1), false)
  assert.equal(canGoNext(0, 1), false)
  assert.equal(stepIndex(0, 1, 'prev'), -1)
})

test('navigation is bounded at first and last tasks', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.equal(positionOf(tasks, 'b'), 1)
  assert.equal(canGoPrev(0, 3), false)
  assert.equal(canGoNext(0, 3), true)
  assert.equal(stepIndex(0, 3, 'next'), 1)
  assert.equal(stepIndex(1, 3, 'prev'), 0)
  assert.equal(stepIndex(1, 3, 'next'), 2)
  assert.equal(canGoNext(2, 3), false)
  assert.equal(stepIndex(2, 3, 'next'), -1)
})

test('two tasks cannot send both controls to the same destination', () => {
  assert.equal(stepIndex(0, 2, 'prev'), -1)
  assert.equal(stepIndex(0, 2, 'next'), 1)
  assert.equal(stepIndex(1, 2, 'prev'), 0)
  assert.equal(stepIndex(1, 2, 'next'), -1)
})
