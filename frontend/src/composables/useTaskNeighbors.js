import { computed, ref } from 'vue'
import { getPbMessage } from '../utils/pbErrors.js'
import { canGoNext, canGoPrev, positionOf, stepIndex } from '../lib/taskNavigation.js'

export function useTaskNeighbors(page, listLoader) {
  const tasks = ref([])
  const taskIndex = ref(-1)
  const neighborsState = ref('idle')
  const neighborsError = ref('')
  let generation = 0

  const taskCount = computed(() => tasks.value.length)
  const taskPosition = computed(() => taskIndex.value + 1)
  const canNavigatePrev = computed(() => neighborsState.value === 'ready' && canGoPrev(taskIndex.value, taskCount.value))
  const canNavigateNext = computed(() => neighborsState.value === 'ready' && canGoNext(taskIndex.value, taskCount.value))
  const prevTaskId = computed(() => tasks.value[stepIndex(taskIndex.value, taskCount.value, 'prev')]?.id || '')
  const nextTaskId = computed(() => tasks.value[stepIndex(taskIndex.value, taskCount.value, 'next')]?.id || '')

  function resetNeighbors() {
    generation += 1
    tasks.value = []
    taskIndex.value = -1
    neighborsState.value = 'idle'
    neighborsError.value = ''
  }

  async function loadNeighbors() {
    const currentPage = page.value
    if (!currentPage?.id || !currentPage?.project) {
      resetNeighbors()
      return
    }

    const request = ++generation
    tasks.value = []
    taskIndex.value = -1
    neighborsState.value = 'loading'
    neighborsError.value = ''
    try {
      const list = await listLoader(currentPage)
      if (request !== generation || page.value?.id !== currentPage.id) return
      tasks.value = list
      taskIndex.value = positionOf(list, currentPage.id)
      neighborsState.value = 'ready'
    } catch (error) {
      if (request !== generation || page.value?.id !== currentPage.id) return
      neighborsState.value = 'error'
      neighborsError.value = getPbMessage(error, '获取进行中任务失败，请重试。')
    }
  }

  return {
    prevTaskId,
    nextTaskId,
    taskPosition,
    taskCount,
    canNavigatePrev,
    canNavigateNext,
    neighborsState,
    neighborsError,
    resetNeighbors,
    loadNeighbors
  }
}
