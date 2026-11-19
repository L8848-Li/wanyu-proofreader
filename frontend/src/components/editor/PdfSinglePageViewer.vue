<template>
  <div ref="viewerRef" class="pdf-viewer">
    <slot name="context" />
    <div
      v-show="!error || !retryEnabled || isFullscreen"
      class="pdf-toolbar"
      role="toolbar"
      aria-label="原文工具"
    >
      <slot name="range" />
      <div class="pdf-toolbar-group pdf-page-tools">
        <slot name="navigation" />
        <span class="pdf-page-label" aria-live="polite"
          >第 {{ sourcePageNumber || safePageLabel }} /
          {{ sourceTotalPages || totalPages || '—' }} 页</span
        >
      </div>
      <div class="pdf-toolbar-group">
        <button
          type="button"
          class="pdf-tool"
          :disabled="zoomPercent <= minZoom"
          aria-label="缩小"
          @click="setZoom((zoomPercent - 25) / 100)"
        >
          －
        </button>
        <label class="pdf-zoom-control">
          <input
            class="form-control pdf-zoom-input"
            type="number"
            inputmode="numeric"
            :min="minZoom"
            :max="maxZoom"
            :value="zoomDraft ?? zoomPercent"
            aria-label="原文缩放百分比"
            @input="zoomDraft = $event.target.value"
            @change="applyZoomInput"
            @blur="zoomDraft !== null && applyZoomInput($event)"
            @keydown.enter.prevent="applyZoomInput"
          />
          <span aria-hidden="true">%</span>
        </label>
        <button
          type="button"
          class="pdf-tool"
          :disabled="zoomPercent >= maxZoom"
          aria-label="放大"
          @click="setZoom((zoomPercent + 25) / 100)"
        >
          ＋
        </button>
        <button type="button" class="pdf-tool" @click="resetView">适合宽度</button>
      </div>
      <details class="pdf-display-options" @keydown.esc="closeDisplayOptions">
        <summary class="pdf-tool">显示选项</summary>
        <div class="pdf-display-controls">
          <div class="pdf-toolbar-group">
            <button type="button" class="pdf-tool" @click="rotateClockwise">旋转 90°</button>
            <button type="button" class="pdf-tool" @click="toggleFullscreen">
              {{ isFullscreen ? '退出全屏' : '全屏' }}
            </button>
            <label class="pdf-zoom-slider">
              <span>缩放</span>
              <input
                class="pdf-zoom-range"
                type="range"
                :min="minZoom"
                :max="maxZoom"
                :value="zoomPercent"
                aria-label="原文缩放滑块"
                :aria-valuetext="`${zoomPercent}%`"
                @input="setZoom($event.target.valueAsNumber / 100)"
              />
            </label>
          </div>
          <slot name="display-help" />
        </div>
      </details>
    </div>

    <div v-if="fullscreenError" class="alert alert-warning pdf-fullscreen-notice" role="status">
      {{ fullscreenError }}
    </div>
    <div v-if="error" class="alert alert-error pdf-error" role="alert">
      <p>{{ error }}</p>
      <button
        v-if="retryEnabled"
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="loading"
        @click="emit('retry')"
      >
        重新读取原文
      </button>
    </div>
    <div
      v-else
      ref="wrapRef"
      class="pdf-scroll"
      role="region"
      tabindex="0"
      aria-label="PDF 原文"
      @wheel="zoomWithWheel"
      @gesturestart="startTrackpadGesture"
      @gesturechange="updateTrackpadGesture"
      @gestureend="endTrackpadGesture"
      @touchstart="startTouchPinch"
      @touchmove="updateTouchPinch"
      @touchend="touchPinch = null"
      @touchcancel="touchPinch = null"
    >
      <div
        ref="stageRef"
        class="pdf-canvas-stage"
        :class="{ 'pdf-canvas-stage--local': crop }"
        :style="{
          width: `${canvasCssWidth}px`,
          height: `${canvasCssHeight}px`,
          visibility: loading || (rendering && !hasCanvasPage) ? 'hidden' : 'visible'
        }"
      >
        <img
          v-if="pageImage"
          class="pdf-page-image"
          :src="src"
          :width="pageImage.width"
          :height="pageImage.height"
          :style="imageStyle"
          :alt="crop ? '本条原文局部' : '原文页面'"
          @error="emit('image-error')"
          @load="reportSourceVisible"
        />
        <canvas
          v-else
          ref="canvasRef"
          class="pdf-canvas"
          role="img"
          :aria-label="crop ? '本条原文局部' : 'PDF 页面图像'"
        ></canvas>
        <div
          v-if="src && watermarkUserId"
          class="pdf-identity-watermark"
          :class="{ 'pdf-identity-watermark--compact': compactWatermark }"
          aria-hidden="true"
        >
          <span
            v-for="tile in watermarkTileCount"
            :key="tile"
            class="pdf-identity-watermark-tile"
            >{{ compactWatermark ? `UID ${watermarkUserId}` : identityStamp }}</span
          >
        </div>
      </div>
      <div v-if="loading || (rendering && !hasCanvasPage)" class="pdf-loading-mask" role="status">
        PDF 加载中...
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { measureBusiness } from '@/lib/businessMetrics'
import { sourceViewFit } from '@/lib/sourceRegion'

let sourceStartedAt = performance.now()
let sourceGeneration = 0
let sourceReported = false
function reportSourceVisible() {
  const generation = sourceGeneration
  requestAnimationFrame(() => {
    if (generation !== sourceGeneration || sourceReported || document.hidden) return
    sourceReported = true
    measureBusiness('source_visible', performance.now() - sourceStartedAt)
  })
}
const emit = defineEmits(['image-error', 'show-full-page', 'retry', 'document-loaded'])

const props = defineProps({
  src: { type: String, default: '' },
  retryEnabled: { type: Boolean, default: false },
  pageImage: { type: Object, default: null },
  sourceRegion: { type: Object, default: null },
  watermarkUserId: { type: String, default: '' },
  watermarkProjectId: { type: String, default: '' },
  pageNumber: { type: Number, default: 1 },
  sourcePageNumber: { type: Number, default: 0 },
  sourceTotalPages: { type: Number, default: 0 }
})
watch(
  [() => props.src, () => props.pageNumber],
  () => {
    sourceGeneration++
    sourceStartedAt = performance.now()
    sourceReported = false
  },
  { immediate: true }
)

const viewerRef = ref(null)
const wrapRef = ref(null)
const stageRef = ref(null)
const canvasRef = ref(null)
const loading = ref(false)
const rendering = ref(false)
const hasCanvasPage = ref(false)
const error = ref('')
const fullscreenError = ref('')
const minZoom = 50
const maxZoom = 300
const zoom = ref(1)
const zoomPercent = computed(() => Math.round(zoom.value * 100))
const zoomDraft = ref(null)
const rotation = ref(0)
const crop = computed(() => (rotation.value === 0 ? props.sourceRegion?.rect : null))
const regionIdentity = computed(() => {
  const region = props.sourceRegion
  return region
    ? [region.entryId, region.physicalPage, ...Object.values(region.rect)].join(':')
    : ''
})
const totalPages = ref(0)
const canvasCssWidth = ref(1)
const canvasCssHeight = ref(1)
const isFullscreen = ref(false)

let pdfDocTask = null
let pdfDoc = null
let renderTask = null
let resizeObserver = null
let pdfjsLib = null
let loadGeneration = 0
let renderGeneration = 0
let sourceReadController = null
let zoomRenderTimer = null
let touchPinch = null
let trackpadStartZoom = null
let pendingAnchor = null
let anchorQueued = false
// Keep the access time stable while reading; renew it for a new viewer or
// asset without changing the underlying shared image/PDF.
const accessedAt = ref('')
watch(
  [() => props.src, () => props.watermarkUserId, () => props.watermarkProjectId],
  () => {
    accessedAt.value = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  },
  { immediate: true }
)
const identityStamp = computed(
  () =>
    `万语校坊 · UID ${props.watermarkUserId}\n项目 ${props.watermarkProjectId}\n${accessedAt.value}`
)
const compactWatermark = computed(() => crop.value && canvasCssHeight.value < 95)
const watermarkTileCount = computed(
  () =>
    Math.max(1, Math.floor(canvasCssWidth.value / 210)) *
    Math.max(1, Math.ceil(canvasCssHeight.value / 100))
)
const imageStyle = computed(() => {
  if (!props.pageImage) return {}
  if (crop.value) {
    const { x, y, width, height } = crop.value
    const fullWidth = canvasCssWidth.value / width
    const fullHeight = canvasCssHeight.value / height
    return {
      width: `${fullWidth}px`,
      height: `${fullHeight}px`,
      position: 'absolute',
      left: `${-x * fullWidth}px`,
      top: `${-y * fullHeight}px`
    }
  }
  const odd = rotation.value % 180 !== 0
  const width = odd ? canvasCssHeight.value : canvasCssWidth.value
  const height = odd ? canvasCssWidth.value : canvasCssHeight.value
  return {
    width: `${width}px`,
    height: `${height}px`,
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: `translate(-50%, -50%) rotate(${rotation.value}deg)`
  }
})

const safePageLabel = computed(() => {
  const max = totalPages.value || 1
  return Math.max(1, Math.min(max, Number(props.pageNumber) || 1))
})

watch(
  [() => props.src, () => props.pageImage],
  async ([newSrc]) => {
    await loadPdf(newSrc)
  },
  { immediate: true }
)

watch([() => props.pageNumber, regionIdentity], async ([, currentRegion], [, previousRegion]) => {
  hasCanvasPage.value = false
  if (currentRegion !== previousRegion) {
    zoom.value = 1
    zoomDraft.value = null
    if (currentRegion) rotation.value = 0
    if (wrapRef.value) {
      wrapRef.value.scrollTop = 0
      wrapRef.value.scrollLeft = 0
    }
    await renderCurrentPage(null)
    return
  }
  await renderCurrentPage()
})

onMounted(() => {
  document.addEventListener('fullscreenchange', syncFullscreenState)
})

async function loadPdf(src) {
  const generation = ++loadGeneration
  sourceReadController?.abort()
  sourceReadController = null
  cleanupRenderOnly()
  pdfDoc = null
  error.value = ''
  fullscreenError.value = ''
  totalPages.value = 0

  if (!src) {
    pdfDoc = null
    loading.value = false
    return
  }

  if (props.pageImage) {
    const previousTask = pdfDocTask
    if (previousTask) {
      try {
        await previousTask.destroy()
      } catch {
        /* already gone */
      }
    }
    if (generation !== loadGeneration) return
    if (pdfDocTask === previousTask) pdfDocTask = null
    pdfDoc = null
    loading.value = false
    await nextTick()
    await renderCurrentPage()
    attachResizeObserver()
    return
  }

  loading.value = true
  let readController = null
  try {
    const lib = await ensurePdfJsLib()
    if (generation !== loadGeneration) return
    lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.js'

    const previousTask = pdfDocTask
    if (previousTask) {
      try {
        await previousTask.destroy()
      } catch {
        /* the previous document may already be gone */
      }
    }
    // Source replacement/unmount can happen while the previous worker exits.
    // An obsolete loader must never create or take ownership of a new worker.
    if (generation !== loadGeneration) return
    if (pdfDocTask === previousTask) pdfDocTask = null
    // The parent already fetched this authorized preview into a bounded blob.
    // Read it before creating PDF.js's worker: cancelling its URL transport
    // during ReaderHeadersReady makes PDF.js 3.11 throw from onFailure after
    // Terminate. The public data API transfers these unchanged bytes instead.
    readController = new AbortController()
    sourceReadController = readController
    const response = await fetch(src, { signal: readController.signal })
    if (!response.ok) throw new Error(`读取 PDF 原文失败（${response.status}）`)
    const data = new Uint8Array(await response.arrayBuffer())
    if (generation !== loadGeneration) return
    const loadingTask = lib.getDocument({
      data,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      isEvalSupported: false
    })
    pdfDocTask = loadingTask
    const document = await loadingTask.promise
    if (generation !== loadGeneration) {
      await document.destroy()
      return
    }
    pdfDoc = document
    totalPages.value = pdfDoc.numPages || 0
    emit('document-loaded', totalPages.value)
    await nextTick()
    await renderCurrentPage()
    attachResizeObserver()
  } catch (e) {
    if (generation !== loadGeneration) return
    pdfDoc = null
    error.value = pdfFailureMessage(e, 'PDF 加载失败')
  } finally {
    if (sourceReadController === readController) sourceReadController = null
    if (generation === loadGeneration) loading.value = false
  }
}

function pdfFailureMessage(error, fallback) {
  switch (error?.name) {
    case 'InvalidPDFException':
      return 'PDF 文件结构无效，无法预览。可重新读取；若仍失败，请联系项目管理员检查来源文件。'
    case 'PasswordException':
      return '此 PDF 受密码保护，当前无法预览。请联系项目管理员提供可预览的来源文件。'
    case 'MissingPDFException':
      return '未找到原文 PDF，请重新读取或联系项目管理员核对来源文件。'
    default:
      return error?.message || fallback
  }
}

async function ensurePdfJsLib() {
  if (pdfjsLib) return pdfjsLib
  if (window.pdfjsLib) {
    pdfjsLib = window.pdfjsLib
    return pdfjsLib
  }
  await loadScript('/pdfjs/pdf.min.js')
  if (!window.pdfjsLib) {
    throw new Error('PDF.js 初始化失败')
  }
  pdfjsLib = window.pdfjsLib
  return pdfjsLib
}

function loadScript(src, type = 'text/javascript') {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.type = type
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('加载 PDF.js 资源失败'))
    document.head.appendChild(script)
  })
}

async function renderCurrentPage(anchor) {
  clearTimeout(zoomRenderTimer)
  if (props.pageImage && wrapRef.value) {
    const odd = rotation.value % 180 !== 0
    const width = odd ? props.pageImage.height : props.pageImage.width
    const height = odd ? props.pageImage.width : props.pageImage.height
    const fit = sourceViewFit(
      width,
      height,
      Math.max(1, wrapRef.value.clientWidth - 16),
      crop.value
    )
    resizeStage(fit.width * zoom.value, fit.height * zoom.value, anchor)
    return
  }
  if (!pdfDoc || !canvasRef.value || !wrapRef.value) return
  rendering.value = true
  const generation = ++renderGeneration
  const safePage = safePageLabel.value

  if (renderTask) {
    try {
      renderTask.cancel()
    } catch {
      /* the task may have already settled */
    }
    renderTask = null
  }

  let nextCanvas = null
  try {
    const page = await pdfDoc.getPage(safePage)
    if (generation !== renderGeneration) return
    const baseViewport = page.getViewport({
      scale: 1,
      rotation: (page.rotate + rotation.value) % 360
    })
    const availableWidth = Math.max(1, wrapRef.value.clientWidth - 16)
    const fit = sourceViewFit(baseViewport.width, baseViewport.height, availableWidth, crop.value)
    const viewport = page.getViewport({
      scale: fit.scale * zoom.value,
      rotation: (page.rotate + rotation.value) % 360
    })

    const canvas = canvasRef.value
    // The displayed canvas keeps the previous bitmap while PDF.js draws the new one.
    nextCanvas = document.createElement('canvas')
    const cssWidth = Math.max(1, Math.floor(fit.width * zoom.value))
    const cssHeight = Math.max(1, Math.floor(fit.height * zoom.value))
    resizeStage(cssWidth, cssHeight, anchor)
    // A displayed bitmap and a pending one may coexist. Bound the backing
    // store separately from the reader's chosen CSS zoom, including on Retina.
    const outputScale = Math.min(
      window.devicePixelRatio || 1,
      4096 / Math.max(cssWidth, cssHeight),
      Math.sqrt(12_000_000 / (cssWidth * cssHeight))
    )
    nextCanvas.width = Math.max(1, Math.floor(cssWidth * outputScale))
    nextCanvas.height = Math.max(1, Math.floor(cssHeight * outputScale))

    renderTask = page.render({
      canvasContext: nextCanvas.getContext('2d'),
      viewport,
      transform:
        outputScale === 1 && !crop.value
          ? null
          : [
              outputScale,
              0,
              0,
              outputScale,
              -fit.x * zoom.value * outputScale,
              -fit.y * zoom.value * outputScale
            ]
    })
    await renderTask.promise
    if (generation === renderGeneration) {
      renderTask = null
      canvas.width = nextCanvas.width
      canvas.height = nextCanvas.height
      canvas.getContext('2d').drawImage(nextCanvas, 0, 0)
      hasCanvasPage.value = true
      reportSourceVisible()
    }
  } catch (e) {
    if (generation === renderGeneration && e?.name !== 'RenderingCancelledException') {
      error.value = pdfFailureMessage(e, '渲染失败')
    }
  } finally {
    if (nextCanvas) {
      nextCanvas.width = 0
      nextCanvas.height = 0
    }
    if (generation === renderGeneration) rendering.value = false
  }
}

function readAnchor(clientX, clientY) {
  if (!stageRef.value || !wrapRef.value || canvasCssWidth.value <= 1) return null
  const stage = stageRef.value.getBoundingClientRect()
  if (!stage.width || !stage.height) return null
  const wrap = wrapRef.value.getBoundingClientRect()
  const x = clientX ?? wrap.left + wrap.width / 2
  const y = clientY ?? wrap.top + wrap.height / 2
  return {
    x: Math.max(0, Math.min(1, (x - stage.left) / stage.width)),
    y: Math.max(0, Math.min(1, (y - stage.top) / stage.height)),
    clientX: x,
    clientY: y
  }
}

function resizeStage(width, height, anchor) {
  if (anchor === null) pendingAnchor = null
  if (width === canvasCssWidth.value && height === canvasCssHeight.value) return
  pendingAnchor = anchor === undefined ? pendingAnchor || readAnchor() : anchor
  canvasCssWidth.value = width
  canvasCssHeight.value = height
  if (!pendingAnchor || anchorQueued) return
  anchorQueued = true
  nextTick(() => {
    const target = pendingAnchor
    pendingAnchor = null
    anchorQueued = false
    if (!target || !wrapRef.value || !stageRef.value) return
    const stage = stageRef.value.getBoundingClientRect()
    wrapRef.value.scrollLeft += stage.left + stage.width * target.x - target.clientX
    wrapRef.value.scrollTop += stage.top + stage.height * target.y - target.clientY
  })
}

function setZoom(factor, clientX, clientY) {
  if (!Number.isFinite(factor)) return
  const nextZoom = Math.max(minZoom / 100, Math.min(maxZoom / 100, factor))
  if (nextZoom === zoom.value) return
  const ratio = nextZoom / zoom.value
  zoom.value = nextZoom
  resizeStage(
    canvasCssWidth.value * ratio,
    canvasCssHeight.value * ratio,
    readAnchor(clientX, clientY)
  )
  if (props.pageImage) return
  clearTimeout(zoomRenderTimer)
  zoomRenderTimer = setTimeout(renderCurrentPage, 120)
}

function applyZoomInput(event) {
  const input = event.target
  setZoom(Math.round(input.valueAsNumber) / 100)
  zoomDraft.value = null
  input.value = zoomPercent.value
}

function closeDisplayOptions(event) {
  const disclosure = event.currentTarget
  if (!disclosure.open) return
  event.preventDefault()
  event.stopPropagation()
  disclosure.open = false
  disclosure.querySelector('summary')?.focus()
}

function zoomWithWheel(event) {
  if (!event.ctrlKey || !event.deltaY || !event.cancelable || canvasCssWidth.value <= 1) return
  event.preventDefault()
  if (trackpadStartZoom !== null || touchPinch) return
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? wrapRef.value.clientHeight : 1
  setZoom(zoom.value * Math.exp((-event.deltaY * unit) / 180), event.clientX, event.clientY)
}

function startTrackpadGesture(event) {
  if (canvasCssWidth.value <= 1 || !event.cancelable) return
  event.preventDefault()
  if (!touchPinch) trackpadStartZoom = zoom.value
}

function updateTrackpadGesture(event) {
  if (trackpadStartZoom === null && !touchPinch) return
  if (event.cancelable) event.preventDefault()
  if (trackpadStartZoom !== null) {
    setZoom(trackpadStartZoom * event.scale, event.clientX, event.clientY)
  }
}

function endTrackpadGesture(event) {
  if (trackpadStartZoom === null && !touchPinch) return
  if (event.cancelable) event.preventDefault()
  trackpadStartZoom = null
}

function touchGeometry(event) {
  if (event.touches.length !== 2 || canvasCssWidth.value <= 1) return null
  const a = event.touches[0]
  const b = event.touches[1]
  if (!wrapRef.value.contains(a.target) || !wrapRef.value.contains(b.target)) return null
  return {
    distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2
  }
}

function startTouchPinch(event) {
  const geometry = touchGeometry(event)
  if (!geometry?.distance || !event.cancelable) return
  event.preventDefault()
  if (trackpadStartZoom === null) {
    touchPinch = { distance: geometry.distance, zoom: zoom.value }
  }
}

function updateTouchPinch(event) {
  if (!touchPinch) return
  const geometry = touchGeometry(event)
  if (!geometry) return
  if (event.cancelable) event.preventDefault()
  setZoom((touchPinch.zoom * geometry.distance) / touchPinch.distance, geometry.x, geometry.y)
}

async function resetView() {
  zoom.value = 1
  rotation.value = 0
  if (wrapRef.value) {
    wrapRef.value.scrollTop = 0
    wrapRef.value.scrollLeft = 0
  }
  await renderCurrentPage(null)
}

function rotateClockwise() {
  rotation.value = (rotation.value + 90) % 360
  if (props.sourceRegion) {
    emit('show-full-page')
    return
  }
  renderCurrentPage()
}

async function toggleFullscreen() {
  if (!viewerRef.value) return
  fullscreenError.value = ''
  const generation = loadGeneration
  const exiting = Boolean(document.fullscreenElement)
  try {
    if (exiting) {
      await document.exitFullscreen()
    } else {
      await viewerRef.value.requestFullscreen()
    }
  } catch {
    if (generation === loadGeneration) {
      fullscreenError.value = exiting
        ? '浏览器未允许退出全屏模式，请重试。'
        : '浏览器未允许进入全屏模式，请重试。'
    }
  }
}

function syncFullscreenState() {
  fullscreenError.value = ''
  isFullscreen.value = document.fullscreenElement === viewerRef.value
  nextTick(() => renderCurrentPage())
}

function attachResizeObserver() {
  if (resizeObserver || !wrapRef.value) return
  resizeObserver = new ResizeObserver(() => {
    renderCurrentPage()
  })
  resizeObserver.observe(wrapRef.value)
}

function cleanupRenderOnly() {
  clearTimeout(zoomRenderTimer)
  touchPinch = null
  trackpadStartZoom = null
  renderGeneration++
  rendering.value = false
  if (renderTask) {
    try {
      renderTask.cancel()
    } catch {
      /* the task may have already settled */
    }
    renderTask = null
  }
}

onBeforeUnmount(async () => {
  loadGeneration++
  sourceReadController?.abort()
  sourceReadController = null
  cleanupRenderOnly()
  document.removeEventListener('fullscreenchange', syncFullscreenState)
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  const previousTask = pdfDocTask
  if (previousTask) {
    try {
      await previousTask.destroy()
    } catch {
      /* the previous document may already be gone */
    }
    if (pdfDocTask === previousTask) pdfDocTask = null
  }
  pdfDoc = null
})
</script>

<style scoped>
.pdf-error {
  margin: var(--space-4);
}
.pdf-viewer {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--pdf-track);
}

.pdf-viewer:fullscreen {
  min-height: 100vh;
  background: var(--pdf-track-strong);
}

.pdf-fullscreen-notice {
  flex: 0 0 auto;
  margin: var(--space-2) var(--space-3);
}

.pdf-toolbar {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem 0.75rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--pdf-track-strong);
  background: var(--pdf-toolbar);
}

.pdf-toolbar-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  max-width: 100%;
  gap: 0.4rem;
}

.pdf-toolbar :deep(.pdf-tool) {
  min-height: var(--control-height-sm);
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--pdf-track-strong);
  border-radius: var(--radius-nav);
  background: var(--surface);
  color: var(--pdf-ink);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.pdf-toolbar :deep(.pdf-tool:hover:not(:disabled)),
.pdf-display-options[open] > summary {
  border-color: var(--primary);
  background: var(--primary-glow-soft);
}

.pdf-display-options {
  margin-inline-start: auto;
}

.pdf-display-options > summary {
  align-content: center;
}

.pdf-display-controls {
  position: absolute;
  z-index: var(--z-dropdown);
  top: 100%;
  inset-inline-end: 0;
  width: min(100%, 22rem);
  padding: var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  background: var(--surface);
  animation: pdf-display-enter var(--motion-normal) var(--ease-out);
}

.pdf-display-controls :slotted(p) {
  margin: var(--space-2) 0 0;
  color: var(--ink-muted);
}

@keyframes pdf-display-enter {
  from {
    opacity: 0.78;
    transform: translateY(-4px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pdf-toolbar :deep(.pdf-tool) {
    transition: none;
  }
  .pdf-display-controls {
    animation: none;
  }
}

.pdf-toolbar :deep(.pdf-tool:disabled) {
  opacity: 0.45;
  cursor: not-allowed;
}

.pdf-page-label {
  min-width: 48px;
  color: var(--ink-muted);
  font-size: 0.8rem;
  text-align: center;
  white-space: nowrap;
}

.pdf-zoom-control {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  color: var(--ink-muted);
  font-size: 0.8rem;
}

.pdf-zoom-input {
  width: 4.2rem;
  padding: 0.25rem 0.4rem;
}

.pdf-zoom-slider {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-height-sm);
  color: var(--ink-muted);
  font-size: var(--text-xs);
}

.pdf-zoom-range {
  width: clamp(4.5rem, 9vw, 7rem);
  accent-color: var(--primary);
}

.pdf-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  overflow-anchor: none;
  padding: 8px;
  touch-action: pan-x pan-y;
}

.pdf-canvas-stage {
  position: relative;
  margin: 0 auto;
  background: var(--surface);
  box-shadow: 0 2px 8px var(--slate-shadow);
}

.pdf-canvas-stage--local {
  overflow: hidden;
}
.pdf-canvas {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--surface);
}

.pdf-page-image {
  display: block;
}
.pdf-identity-watermark {
  position: absolute;
  inset: 0;
  z-index: var(--z-mask);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  grid-auto-rows: 100px;
  pointer-events: none;
  user-select: none;
  color: var(--pdf-grid);
  overflow: hidden;
}
.pdf-canvas-stage--local .pdf-identity-watermark {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
  grid-auto-rows: min(100%, 100px);
}
.pdf-identity-watermark--compact .pdf-identity-watermark-tile {
  transform: none;
  line-height: 1;
}
.pdf-identity-watermark-tile {
  align-self: center;
  justify-self: center;
  transform: rotate(-15deg);
  font-size: var(--text-xs);
  line-height: 1.4;
  white-space: pre;
}

.pdf-loading-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--pdf-mask);
  color: var(--ink-muted);
  font-size: 14px;
  pointer-events: none;
}

@media (max-width: 768px) {
  .pdf-toolbar :deep(.pdf-tool) {
    min-height: var(--control-height-touch);
  }
}

@media (max-width: 700px) {
  .pdf-toolbar {
    align-items: flex-start;
    padding: 0.25rem;
  }
  .pdf-tool,
  .pdf-zoom-slider {
    white-space: nowrap;
  }
}
</style>
