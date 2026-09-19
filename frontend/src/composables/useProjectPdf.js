import { computed, ref, onBeforeUnmount } from 'vue'
import { createPdfPreviewCache } from '@/lib/pdfPreviewCache'
import pb from '@/lib/pocketbase'

export function useProjectPdf(page) {
  const pdfError = ref('')
  const pdfLoading = ref(false)
  const currentPdfPage = ref(1)
  const firstPage = ref(1)
  const lastPage = ref(1)
  const totalPdfPages = ref(0)
  const pdfUrl = ref(null)
  const cache = createPdfPreviewCache()
  let currentUser = pb.authStore.record?.id || pb.authStore.model?.id || ''
  const unsubscribe = pb.authStore.onChange((_token, record) => {
    if (!record || record.id !== currentUser) resetPdf()
    currentUser = record?.id || ''
  })
  onBeforeUnmount(() => { unsubscribe(); resetPdf() })
  let generation = 0
  let controller = null
  const basePdfPage = computed(() => Number(page.value?.pdf_page) || Number(page.value?.page_number) || 1)
  const pdfPageWarning = computed(() => page.value?.pdf_page ? '' : '此条目缺少 PDF 页码，暂按任务序号定位。')
  const allowedPdfPages = computed(() => [firstPage.value, lastPage.value])
  const localPdfPage = computed(() => currentPdfPage.value - firstPage.value + 1)

  function resetPdf() {
    generation++
    controller?.abort()
    cache.clear()
    pdfUrl.value = null
    pdfError.value = ''
    pdfLoading.value = false
    firstPage.value = lastPage.value = basePdfPage.value
    totalPdfPages.value = 0
    currentPdfPage.value = basePdfPage.value
  }
  async function resolveProjectPdf() {
    const request = ++generation
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    const userId = currentUser
    pdfLoading.value = true
    pdfError.value = ''
    try {
      const base = pb.buildURL(`/api/fangji/pages/${encodeURIComponent(page.value.id)}/pdf`)
      const options = { headers: { Authorization: pb.authStore.token }, signal, cache: 'no-store' }
      const info = await fetch(`${base}/descriptor`, options)
      if (!info.ok) {
        const body = await info.json().catch(() => ({}))
        throw new Error(body.message || '加载任务 PDF 失败')
      }
      let descriptor = await info.json()
      if (request !== generation) return
      let entry = cache.get(userId, descriptor)
      if (!entry) {
        // A different range/version must not keep showing the previous task PDF.
        cache.clear()
        pdfUrl.value = null
        const response = await fetch(base, options)
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body.message || '加载任务 PDF 失败')
        }
        const blob = await response.blob()
        if (request !== generation) return
        // The five-minute window or primary source can change between requests.
        descriptor = {
          key: response.headers.get('X-PDF-Preview-Key'), expiresAt: response.headers.get('X-PDF-Expires-At'),
          start: Number(response.headers.get('X-PDF-Start-Page')),
          end: Number(response.headers.get('X-PDF-End-Page')),
          total: Number(response.headers.get('X-PDF-Total-Pages'))
        }
        if (!descriptor.key || !Number.isFinite(Date.parse(descriptor.expiresAt))) throw new Error('PDF 预览信息无效，请刷新后重试')
        entry = cache.put(userId, descriptor, blob)
        currentPdfPage.value = descriptor.start
      }
      firstPage.value = descriptor.start
      lastPage.value = descriptor.end
      totalPdfPages.value = descriptor.total
      pdfUrl.value = entry.url
    } catch (error) {
      if (request === generation && error.name !== 'AbortError') {
        cache.clear(); pdfUrl.value = null
        pdfError.value = error.message || '加载任务 PDF 失败'
      }
    } finally {
      if (request === generation) pdfLoading.value = false
    }
  }
  function clampPdfPage(value) {
    return Math.max(firstPage.value, Math.min(lastPage.value, Number(value) || firstPage.value))
  }
  function switchPdfPage(delta) {
    currentPdfPage.value = clampPdfPage(currentPdfPage.value + delta)
  }
  return {
    pdfLoading, pdfError, currentPdfPage, basePdfPage, pdfPageWarning,
    allowedPdfPages, pdfUrl, localPdfPage, totalPdfPages,
    resetPdf, resolveProjectPdf, clampPdfPage, switchPdfPage
  }
}
