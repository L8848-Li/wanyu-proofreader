import { useAsyncResource } from '@/composables/useAsyncResource'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  adminPageRouteQuery,
  normalizeAdminPageQuery,
  parseRangeInput,
  pendingBatchFilter,
  pendingIdsInWindow
} from '@/lib/adminPageList'
import { summarizePages } from '@/lib/workspaceInsights'
import { PAGE_STATUS, PAGE_STATUS_LABELS } from '@/constants/pageStatus'
import {
  countProjectPages,
  deletePendingPages,
  getAdminProjectPageStats,
  listAdminProjectPages,
  listAllProjectPages,
  listProjectPageWindow,
  reorderPendingPages
} from '@/services/pagesService'
import { getProjectQualitySummary, setPageQualityState } from '@/services/qualityStateService'
import { QUALITY_STATES, QUALITY_STATE_LABELS, QUALITY_STATE } from '@/constants/qualityState'
import {
  normalizeQualityState,
  qualityStateLabel,
  qualityStateNeedsBasis,
  qualityStateSummaryRows
} from '@/lib/qualityState'
import { getPbMessage } from '@/utils/pbErrors'

export function useProjectEntries(projectId, project, refreshLedger) {
  const loadLedger = refreshLedger
  const pagesResource = useAsyncResource(({ signal }, query) =>
    listAdminProjectPages(projectId, { ...query, signal })
  )
  const statsResource = useAsyncResource(({ signal }) =>
    getAdminProjectPageStats(projectId, { signal })
  )
  const qualityResource = useAsyncResource(() => getProjectQualitySummary(projectId))
  const route = useRoute()
  const router = useRouter()
  const ACTIVE_STATUS_FILTER = 'active'

  const listQueryOptions = {
    statuses: [ACTIVE_STATUS_FILTER, ...Object.keys(PAGE_STATUS_LABELS)],
    qualityStates: QUALITY_STATES,
    pageSizes: [10, 25, 50, 100]
  }

  const initialListQuery = normalizeAdminPageQuery(route.query, listQueryOptions)

  const pages = ref([])

  // Inputs/URL retain the requested query so retry repeats the failed request.
  // Rows and pagination describe the last successfully loaded result.
  const displayedListQuery = ref(null)

  const pagesError = ref('')

  const loadingPages = ref(true)

  const hasLoadedPages = ref(false)

  const pageStats = ref(summarizePages([]))

  const loadingPageStats = ref(true)

  const hasLoadedPageStats = ref(false)

  const pageStatsError = ref('')

  const totalFilteredItems = ref(0)

  const serverTotalPages = ref(1)

  const minPdfPage = ref(initialListQuery.minPage)

  const maxPdfPage = ref(initialListQuery.maxPage)

  let pageLoadGeneration = 0

  let pageStatsLoadGeneration = 0

  let searchTimer

  const mutatingRows = ref(false)

  const mutationSuccess = ref('')

  const mutationError = ref('')

  const entriesSection = ref(null)

  const selectedPendingIds = ref([])

  const rangeSelectInput = ref('')

  const searchQuery = ref(initialListQuery.q)

  const selectedStatus = ref(initialListQuery.status)
  const importJob = ref(initialListQuery.importJob || '')

  const currentListPage = ref(initialListQuery.page)

  const listPageSize = ref(initialListQuery.perPage)

  const selectedQualityState = ref(initialListQuery.qualityState)

  const qualitySummary = ref(null)

  const qualitySummaryError = ref('')

  const qualityTarget = ref(null)

  const qualityDraftState = ref(QUALITY_STATE.VALIDATED)

  const qualityDraftBasis = ref('')

  const qualitySubmitting = ref(false)

  const qualityDialogError = ref('')
  let qualitySubmissionGeneration = 0

  const statusOptions = Object.entries(PAGE_STATUS_LABELS).map(([value, label]) => ({
    value,
    label
  }))

  const qualityStateOptions = QUALITY_STATES.map((value) => ({
    value,
    label: QUALITY_STATE_LABELS[value]
  }))

  const qualitySummaryRows = computed(() => qualityStateSummaryRows(qualitySummary.value))

  const qualityBasisRequired = computed(() => qualityStateNeedsBasis(qualityDraftState.value))

  const qualitySubmitDisabled = computed(
    () => qualitySubmitting.value || (qualityBasisRequired.value && !qualityDraftBasis.value.trim())
  )

  const approvedPct = computed(() => pageStats.value.completionPct)

  const filteredPages = computed(() => pages.value)

  const listPagination = computed(() => ({
    page: displayedListQuery.value?.page ?? currentListPage.value,
    perPage: displayedListQuery.value?.perPage ?? listPageSize.value,
    totalItems: totalFilteredItems.value,
    totalPages: serverTotalPages.value
  }))

  const displayedPages = computed(() => pages.value)

  const displayedPageOffset = computed(
    () => (listPagination.value.page - 1) * listPagination.value.perPage
  )

  const hasRefinements = computed(() =>
    Boolean(
      searchQuery.value.trim() ||
      selectedStatus.value ||
      selectedQualityState.value ||
      minPdfPage.value ||
      maxPdfPage.value
    )
  )

  const hasActiveListFilter = computed(() => Boolean(importJob.value) || hasRefinements.value)

  const allPendingSelected = computed(() => {
    return (
      hasLoadedPageStats.value &&
      pageStats.value.unstarted > 0 &&
      selectedPendingIds.value.length === pageStats.value.unstarted
    )
  })

  function applyListQuery(query) {
    const normalized = normalizeAdminPageQuery(query, listQueryOptions)
    const nextImportJob = normalized.importJob || ''
    if (nextImportJob !== importJob.value) {
      pagesResource.cancel()
      pageLoadGeneration++
      pages.value = []
      displayedListQuery.value = null
      hasLoadedPages.value = false
      totalFilteredItems.value = 0
      serverTotalPages.value = 1
      selectedPendingIds.value = []
      importJob.value = nextImportJob
    }
    searchQuery.value = normalized.q
    selectedStatus.value = normalized.status
    selectedQualityState.value = normalized.qualityState
    minPdfPage.value = normalized.minPage
    maxPdfPage.value = normalized.maxPage
    currentListPage.value = normalized.page
    listPageSize.value = normalized.perPage
  }

  function currentListQuery() {
    return {
      q: searchQuery.value.trim(),
      status: selectedStatus.value,
      qualityState: selectedQualityState.value,
      minPage: minPdfPage.value,
      maxPage: maxPdfPage.value,
      page: currentListPage.value,
      perPage: listPageSize.value,
      ...(importJob.value ? { importJob: importJob.value } : {})
    }
  }

  function commitListQuery({ page = currentListPage.value, push = false } = {}) {
    currentListPage.value = page
    const next = adminPageRouteQuery(currentListQuery())
    const current = adminPageRouteQuery(normalizeAdminPageQuery(route.query, listQueryOptions))
    if (JSON.stringify(next) === JSON.stringify(current)) {
      loadPages()
      return
    }
    const query = { ...route.query }
    for (const key of [
      'q',
      'status',
      'qualityState',
      'minPage',
      'maxPage',
      'page',
      'perPage',
      'importJob'
    ])
      delete query[key]
    Object.assign(query, next)
    router[push ? 'push' : 'replace']({ query })
  }

  function queueListQuery() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => commitListQuery({ page: 1 }), 300)
  }

  function changeListPage(page) {
    if (page < 1 || page > serverTotalPages.value || page === listPagination.value.page) return
    commitListQuery({ page, push: true })
  }

  async function loadPages() {
    const generation = ++pageLoadGeneration
    loadingPages.value = true
    pagesError.value = ''
    const requestedQuery = currentListQuery()
    try {
      const response = await pagesResource.reload(requestedQuery)
      if (response.cancelled) return
      if (!response.ok) throw response.error
      const result = response.data
      if (generation !== pageLoadGeneration) return
      const pageWasClamped = currentListPage.value !== result.page
      pages.value = result.items
      totalFilteredItems.value = result.totalItems
      serverTotalPages.value = result.totalPages
      currentListPage.value = result.page
      displayedListQuery.value = {
        ...requestedQuery,
        page: result.page,
        perPage: result.perPage || requestedQuery.perPage
      }
      hasLoadedPages.value = true
      if (pageWasClamped) commitListQuery({ page: result.page })
    } catch (e) {
      if (generation === pageLoadGeneration) {
        const message = getPbMessage(e, '条目列表加载失败，请稍后重试。')
        pagesError.value = hasLoadedPages.value ? `${message} 当前仍显示上次结果。` : message
      }
    } finally {
      if (generation === pageLoadGeneration) loadingPages.value = false
    }
  }

  async function loadPageStats() {
    const generation = ++pageStatsLoadGeneration
    loadingPageStats.value = true
    pageStatsError.value = ''
    try {
      const response = await statsResource.reload()
      if (response.cancelled) return
      if (!response.ok) throw response.error
      const result = response.data
      if (generation !== pageStatsLoadGeneration) return
      pageStats.value = result
      hasLoadedPageStats.value = true
    } catch (e) {
      if (generation === pageStatsLoadGeneration) {
        const message = getPbMessage(e, '项目状态统计加载失败。')
        pageStatsError.value = hasLoadedPageStats.value
          ? `${message} 当前仍显示上次结果。`
          : message
      }
    } finally {
      if (generation === pageStatsLoadGeneration) loadingPageStats.value = false
    }
  }

  async function pendingOperationRows() {
    mutatingRows.value = true
    try {
      return await listAllProjectPages(projectId, {
        fields: 'id,status,page_number',
        sort: 'page_number,id',
        filter: pendingBatchFilter(projectId)
      })
    } finally {
      mutatingRows.value = false
    }
  }

  async function loadQualitySummary() {
    try {
      const result = await qualityResource.reload()
      if (result.cancelled) return
      if (!result.ok) throw result.error
      qualitySummary.value = result.data
      qualitySummaryError.value = ''
    } catch (e) {
      qualitySummary.value = null
      qualitySummaryError.value = getPbMessage(e, '质量状态汇总加载失败。')
    }
  }

  function openQualityDialog(page) {
    if (qualitySubmitting.value) return
    qualityTarget.value = page
    qualityDialogError.value = ''
    qualityDraftBasis.value = ''
    const current = normalizeQualityState(page.quality_state)
    qualityDraftState.value =
      current === QUALITY_STATE.VALIDATED ? QUALITY_STATE.WITHHELD : QUALITY_STATE.VALIDATED
  }

  function closeQualityDialog() {
    if (qualitySubmitting.value) return
    qualityTarget.value = null
    qualitySubmitting.value = false
  }

  const contentEditTarget = ref(null)
  const contentEditBusy = ref(false)

  function openContentEdit(page) {
    if (contentEditBusy.value) return
    contentEditTarget.value = page
  }

  function closeContentEdit() {
    if (contentEditBusy.value) return
    contentEditTarget.value = null
  }

  async function onContentSaved(pageId) {
    mutationSuccess.value = `第 ${contentEditTarget.value?.page_number ?? ''} 条已修正。`
    await loadPages()
  }

  async function submitQualityChange() {
    if (!qualityTarget.value || qualitySubmitDisabled.value) return
    const target = qualityTarget.value
    const generation = ++qualitySubmissionGeneration
    qualitySubmitting.value = true
    qualityDialogError.value = ''
    try {
      const updated = await setPageQualityState(projectId, target.id, {
        state: qualityDraftState.value,
        basis: qualityDraftBasis.value.trim()
      })
      if (generation !== qualitySubmissionGeneration || qualityTarget.value?.id !== target.id)
        return
      const index = pages.value.findIndex((page) => page.id === target.id)
      if (index >= 0) {
        pages.value[index] = {
          ...pages.value[index],
          quality_state: updated.qualityState,
          quality_state_by: updated.qualityBy,
          quality_state_at: updated.qualityAt,
          quality_state_basis: updated.qualityBasis
        }
      }
      mutationSuccess.value = `第 ${target.page_number} 条已标为「${qualityStateLabel(updated.qualityState)}」。`
      qualitySubmitting.value = false
      closeQualityDialog()
      await loadQualitySummary()
    } catch (e) {
      // 状态转移的裁决只在服务端（backend/quality_state.go），这里原样显示它的理由，
      // 不在前端复算一遍规则——复算会漂，而漂了的症状是「界面允许、后端 400」。
      if (generation === qualitySubmissionGeneration)
        qualityDialogError.value = getPbMessage(e, '保存质量状态失败，请稍后重试。')
    } finally {
      if (generation === qualitySubmissionGeneration) qualitySubmitting.value = false
    }
  }

  function resetListFilters() {
    searchQuery.value = ''
    minPdfPage.value = ''
    maxPdfPage.value = ''
    selectedStatus.value = ''
    selectedQualityState.value = ''
    listPageSize.value = 25
    commitListQuery({ page: 1 })
  }

  function clearImportJobFilter() {
    const query = { ...route.query }
    delete query.importJob
    delete query.page
    router.push({ query })
  }

  function filterActivePages() {
    filterByStatus(ACTIVE_STATUS_FILTER)
  }

  async function filterByStatus(status) {
    selectedStatus.value = selectedStatus.value === status ? '' : status
    commitListQuery({ page: 1 })
    await nextTick()
    scrollToEntries()
  }

  function scrollToEntries() {
    entriesSection.value?.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start'
    })
  }

  function clearMutationFeedback() {
    mutationSuccess.value = ''
    mutationError.value = ''
  }

  function isPending(row) {
    return row?.status === PAGE_STATUS.PENDING
  }

  function toggleRowSelection(id, checked) {
    if (mutatingRows.value) return
    if (checked) {
      if (!selectedPendingIds.value.includes(id)) selectedPendingIds.value.push(id)
      return
    }
    selectedPendingIds.value = selectedPendingIds.value.filter((x) => x !== id)
  }

  async function toggleSelectAllPending() {
    if (mutatingRows.value || importJob.value) return
    if (allPendingSelected.value) {
      selectedPendingIds.value = []
      return
    }
    try {
      selectedPendingIds.value = (await pendingOperationRows()).map((p) => p.id)
    } catch (e) {
      mutationError.value = getPbMessage(e, '选择失败，请重试')
    }
  }

  function canMoveUp(id) {
    return Number(pages.value.find((row) => row.id === id)?.page_number) > 1
  }

  function canMoveDown(id) {
    return Number(pages.value.find((row) => row.id === id)?.page_number) < pageStats.value.total
  }

  async function movePendingRow(id, direction) {
    if (mutatingRows.value || importJob.value) return
    let pending
    try {
      pending = await pendingOperationRows()
    } catch (e) {
      mutationError.value = getPbMessage(e, '加载顺序失败')
      return
    }
    const idx = pending.findIndex((row) => row.id === id)
    if (idx < 0) return
    const targetIdx = idx + direction
    if (targetIdx < 0 || targetIdx >= pending.length) return

    const current = pending[idx]
    if (!current || !pending[targetIdx]) return

    mutatingRows.value = true
    clearMutationFeedback()
    try {
      const currentPageNum = Number(current.page_number)
      const orderedIds = pending.map((page) => page.id)
      ;[orderedIds[idx], orderedIds[targetIdx]] = [orderedIds[targetIdx], orderedIds[idx]]
      await reorderPendingPages(projectId, orderedIds)
      await loadPages()
      mutationSuccess.value = `第 ${currentPageNum} 条已${direction < 0 ? '上移' : '下移'}。`
    } catch (e) {
      mutationError.value = getPbMessage(e, '顺序调整失败，请重试')
    } finally {
      mutatingRows.value = false
    }
  }

  async function selectByRange() {
    if (mutatingRows.value || importJob.value) return
    clearMutationFeedback()
    mutatingRows.value = true
    try {
      // total 与窗口必须来自同一个权限过滤后的排序集合；不能从物理页号或异步 stats 推断。
      const total = await countProjectPages(projectId)
      const indexes = parseRangeInput(rangeSelectInput.value, total)
      if (!indexes.length) {
        mutationError.value = '范围格式无效，请输入如 1-33 或 1,3,5-8。'
        return
      }
      const startIndex = indexes[0]
      const endIndex = indexes[indexes.length - 1]
      const window = await listProjectPageWindow(projectId, startIndex, endIndex)
      const ids = pendingIdsInWindow(window.items || [], indexes, startIndex)
      selectedPendingIds.value = ids
      if (!ids.length) {
        mutationError.value = '该范围内没有可操作的待校对条目（仅待校对状态可选）。'
      } else {
        mutationSuccess.value = `已按范围选择 ${ids.length} 条待校对条目。`
      }
    } catch (e) {
      mutationError.value = getPbMessage(e, '选择失败，请重试')
    } finally {
      mutatingRows.value = false
    }
  }

  async function applyPendingOrderByIds(orderedPendingIds) {
    if (!orderedPendingIds.length) return
    await reorderPendingPages(projectId, orderedPendingIds)
  }

  async function moveSelectedRowsDown() {
    if (mutatingRows.value || importJob.value || selectedPendingIds.value.length === 0) return
    let pending
    try {
      pending = await pendingOperationRows()
    } catch (e) {
      mutationError.value = getPbMessage(e, '加载顺序失败')
      return
    }
    if (!pending.length) return

    const ids = pending.map((p) => p.id)
    const selectedSet = new Set(selectedPendingIds.value)
    const reordered = [...ids]

    let moved = false
    for (let i = reordered.length - 2; i >= 0; i--) {
      const curr = reordered[i]
      const next = reordered[i + 1]
      if (selectedSet.has(curr) && !selectedSet.has(next)) {
        reordered[i] = next
        reordered[i + 1] = curr
        moved = true
      }
    }

    if (!moved) {
      clearMutationFeedback()
      mutationError.value = '所选条目已经位于可下移范围的末尾。'
      return
    }

    mutatingRows.value = true
    clearMutationFeedback()
    try {
      await applyPendingOrderByIds(reordered)
      await loadPages()
      mutationSuccess.value = `已下移 ${selectedPendingIds.value.length} 条待校对条目。`
    } catch (e) {
      mutationError.value = getPbMessage(e, '批量下移失败，请重试')
    } finally {
      mutatingRows.value = false
    }
  }

  async function deleteSelectedRows() {
    if (mutatingRows.value || importJob.value || selectedPendingIds.value.length === 0) return
    const ok = window.confirm(
      `确认删除已选择的 ${selectedPendingIds.value.length} 条待校对条目吗？此操作不可恢复。`
    )
    if (!ok) return

    const deleteCount = selectedPendingIds.value.length
    mutatingRows.value = true
    clearMutationFeedback()
    try {
      await deletePendingPages(projectId, selectedPendingIds.value)
      selectedPendingIds.value = []
      // 同上：删除同样改变条目总数，汇总不跟着走就会与表格对不上账。
      await Promise.all([loadPages(), loadPageStats(), loadQualitySummary(), loadLedger()])
      mutationSuccess.value = `已删除 ${deleteCount} 条待校对条目，并重新整理条号。`
    } catch (e) {
      mutationError.value = getPbMessage(e, '批量删除失败，请重试')
    } finally {
      mutatingRows.value = false
    }
  }

  function formatItemNo(pageNumber, fallbackIndex) {
    const n = Number(pageNumber)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
    return fallbackIndex + 1
  }

  watch(
    () => route.query,
    () => {
      applyListQuery(route.query)
      clearTimeout(searchTimer)
      if (project.value) loadPages()
    }
  )
  onBeforeUnmount(() => {
    qualitySubmissionGeneration += 1
    pageLoadGeneration += 1
    pageStatsLoadGeneration += 1
    clearTimeout(searchTimer)
  })
  async function jumpToPdfPage(page) {
    if (!Number.isInteger(page)) return
    minPdfPage.value = String(page)
    maxPdfPage.value = String(page)
    commitListQuery({ page: 1 })
    await nextTick()
    scrollToEntries()
  }

  return {
    jumpToPdfPage,
    ACTIVE_STATUS_FILTER,
    allPendingSelected,
    applyListQuery,
    approvedPct,
    canMoveDown,
    canMoveUp,
    changeListPage,
    closeQualityDialog,
    contentEditTarget,
    contentEditBusy,
    closeContentEdit,
    clearImportJobFilter,
    deleteSelectedRows,
    displayedPageOffset,
    displayedPages,
    entriesSection,
    filterActivePages,
    filterByStatus,
    filteredPages,
    formatItemNo,
    hasActiveListFilter,
    hasRefinements,
    hasLoadedPageStats,
    hasLoadedPages,
    importJob,
    isPending,
    listPageSize,
    listPagination,
    loadPageStats,
    loadPages,
    loadQualitySummary,
    loadingPageStats,
    loadingPages,
    maxPdfPage,
    minPdfPage,
    movePendingRow,
    moveSelectedRowsDown,
    mutatingRows,
    mutationError,
    mutationSuccess,
    onContentSaved,
    openContentEdit,
    openQualityDialog,
    pageStats,
    pageStatsError,
    pagesError,
    qualityBasisRequired,
    qualityDialogError,
    qualityDraftBasis,
    qualityDraftState,
    qualityStateOptions,
    qualitySubmitDisabled,
    qualitySubmitting,
    qualitySummary,
    qualitySummaryError,
    qualitySummaryRows,
    qualityTarget,
    queueListQuery,
    rangeSelectInput,
    resetListFilters,
    scrollToEntries,
    searchQuery,
    selectByRange,
    selectedPendingIds,
    selectedQualityState,
    selectedStatus,
    statusOptions,
    submitQualityChange,
    toggleRowSelection,
    toggleSelectAllPending,
    totalFilteredItems
  }
}
