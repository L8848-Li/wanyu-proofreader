export function positionOf(tasks, taskId) {
  if (!taskId) return -1
  return tasks.findIndex((task) => task.id === taskId)
}

export function canGoPrev(index, count) {
  return Number.isInteger(index) && index > 0 && index < count
}

export function canGoNext(index, count) {
  return Number.isInteger(index) && index >= 0 && index < count - 1
}

export function stepIndex(index, count, direction) {
  if (direction === 'prev' && canGoPrev(index, count)) return index - 1
  if (direction === 'next' && canGoNext(index, count)) return index + 1
  return -1
}
