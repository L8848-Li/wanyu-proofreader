<template>
  <main
    ref="workspace"
    class="editor-layout experience-workspace"
    :class="{
      'has-keyboard': keyboardAvailable && !suspended,
      'keyboard-open': keyboardOpen && !suspended,
      'pdf-collapsed': sourceCollapsed,
      'pdf-unavailable': !loading && !pdfLoading && !pdfUrl && !pdfError,
      'is-resizing': resizing,
      'source-toggle-inline': inlineSourceToggle
    }"
    :style="viewportStyle"
    @pointerdown="onOutsidePointer"
    @click="onNavigationInteraction"
    @change="onNavigationInteraction"
  >
    <div class="mobile-source-toggle">
      <button
        class="btn btn-secondary btn-sm"
        :aria-expanded="!sourceCollapsed"
        aria-controls="review-source"
        @click="toggleSource"
      >
        {{ sourceCollapsed ? '查看原文' : '收起原文' }}
      </button>
    </div>
    <section
      id="review-source"
      ref="sourcePanel"
      tabindex="-1"
      class="editor-panel source-panel"
      aria-label="来源原文"
    >
      <h2 id="source-panel-title" class="sr-only">来源 PDF · 物理第 {{ currentPdfPage }} 页</h2>
      <div class="editor-panel-body editor-panel-body--pdf">
        <div
          v-if="loading || pdfLoading"
          class="panel-loading pdf-transition-mask"
          aria-live="polite"
        >
          <span>正在加载原文…</span>
          <small v-if="!loading && currentPdfPage">PDF 第 {{ currentPdfPage }} 页</small>
        </div>
        <div v-else-if="!pdfEnabled" class="alert alert-error" role="alert">
          任务租约已失效，请重新领取。
        </div>
        <div v-else-if="!page" class="alert alert-error" role="alert">页面不存在</div>
        <div v-else-if="pdfError" class="alert alert-error editor-inline-alert" role="alert">
          <p>{{ pdfError }}</p>
          <button
            ref="sourceRetry"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="!canReloadSource"
            @click="reloadSource"
          >
            重新读取原文
          </button>
        </div>
        <div
          v-if="pdfPageWarning && !loading && !pdfLoading"
          class="alert alert-warning editor-inline-alert"
          role="status"
        >
          {{ pdfPageWarning }}
        </div>
        <PdfSinglePageViewer
          v-if="pdfUrl"
          :key="pdfViewerKey"
          :class="{ 'pdf-preview-pending': loading || pdfLoading }"
          :inert="loading || pdfLoading"
          :src="pdfUrl"
          :page-image="pageImage"
          :source-region="visibleSourceRegion"
          :watermark-user-id="watermarkUserId"
          :watermark-project-id="page?.project || ''"
          @image-error="fallbackToPdf"
          :retry-enabled="canReloadSource"
          @retry="reloadSource"
          @show-full-page="preferLocalSource = false"
          :page-number="localPdfPage"
          :source-page-number="currentPdfPage"
          :source-total-pages="totalPdfPages"
        >
          <template #context>
            <p
              v-if="findingSource && !pdfLoading && currentPdfPage === allowedPdfPages[0]"
              class="source-finding-note text-sm"
              role="status"
            >
              原文第 {{ currentPdfPage }} 页<template v-if="findingSource.field">
                · 核对「{{ findingSource.field }}」</template
              >
            </p>
          </template>
          <template #range>
            <div
              v-if="hasSourceRegion"
              class="source-view-options"
              role="group"
              aria-label="原文显示范围"
            >
              <button
                ref="localSource"
                type="button"
                class="pdf-tool"
                :aria-pressed="Boolean(visibleSourceRegion)"
                @click="showLocalSource"
              >
                本条局部
              </button>
              <button
                type="button"
                class="pdf-tool"
                :aria-pressed="!visibleSourceRegion"
                @click="preferLocalSource = false"
              >
                整页
              </button>
            </div>
          </template>
          <template #navigation>
            <div class="editor-toolbar pdf-page-navigation" role="group" aria-label="PDF 页码导航">
              <button
                ref="previousPage"
                class="pdf-tool"
                :disabled="currentPdfPage <= allowedPdfPages[0]"
                aria-label="上一页原文"
                @click="navigatePdfPage(currentPdfPage - 1, 'previousPage')"
              >
                ‹
              </button>
              <label class="pdf-page-control"
                ><span class="sr-only">PDF 页码</span
                ><input
                  ref="pageNumber"
                  v-model.number="pdfPageInput"
                  type="number"
                  class="form-control pdf-page-input"
                  :min="allowedPdfPages[0]"
                  :max="allowedPdfPages[1]"
                  aria-label="PDF 页码"
                  @change="applyPdfPageInput"
                  @keydown.enter.prevent="applyPdfPageInput"
              /></label>
              <button
                ref="nextPage"
                class="pdf-tool"
                :disabled="currentPdfPage >= allowedPdfPages[1]"
                aria-label="下一页原文"
                @click="navigatePdfPage(currentPdfPage + 1, 'nextPage')"
              >
                ›
              </button>
            </div>
          </template>
          <template #display-help>
            <p class="source-recall-note" role="note">已经下载的副本无法收回。</p>
          </template>
        </PdfSinglePageViewer>
        <div
          v-else-if="!loading && !pdfLoading && !pdfError && pdfEnabled && page"
          class="empty-state"
        >
          <div class="empty-state-text">暂无可预览的 PDF</div>
          <p>{{ emptyPdfDescription }}</p>
        </div>
      </div>
    </section>

    <div
      class="workspace-divider"
      role="separator"
      tabindex="0"
      aria-label="调整原文与编辑区宽度"
      aria-orientation="vertical"
      :aria-valuenow="Math.round(sourceWidth)"
      aria-valuemin="30"
      aria-valuemax="65"
      @pointerdown.prevent="startResize"
      @pointermove="resize"
      @pointerup="stopResize"
      @pointercancel="stopResize"
      @keydown="resizeWithKeyboard"
    >
      <span></span>
    </div>
    <section class="editor-panel fields-panel" :aria-labelledby="contentLabelledBy">
      <slot
        name="panel-header"
        :source-collapsed="sourceCollapsed"
        :toggle-source="toggleSource"
        :compact="compact"
      ></slot>
      <div class="editor-panel-body editor-panel-body--fields">
        <slot :input-mode="compact && keyboardOpen && !suspended ? 'none' : 'text'"></slot>
      </div>
    </section>
    <div class="workspace-navigation"><slot name="navigation"></slot></div>
    <aside
      v-show="keyboardAvailable && !suspended"
      class="keyboard-panel"
      aria-label="项目字符键盘"
    >
      <details v-if="showKeyboardHint" class="keyboard-discovery">
        <summary>特殊字符输入提示</summary>
        <div role="note">
          <span>{{ keyboardDiscoveryNotice }}</span>
          <button type="button" class="btn btn-quiet btn-sm" @click="dismissHint">知道了</button>
        </div>
      </details>
      <div class="keyboard-dock-controls">
        <button
          class="btn btn-secondary btn-sm keyboard-toggle"
          :aria-expanded="keyboardOpen && !suspended"
          aria-controls="project-character-tray"
          aria-label="字符键盘"
          @click="keyboardOpen ? closeKeyboard() : openKeyboard()"
        >
          <AppIcon name="keyboard" class="keyboard-toggle-icon" /><span
            class="keyboard-toggle-label"
            >字符键盘</span
          ><span class="keyboard-toggle-chevron" aria-hidden="true">{{
            keyboardOpen && !suspended ? '⌄' : '⌃'
          }}</span>
        </button>
        <template v-if="keyboardOpen && !suspended">
          <button
            v-if="compact"
            class="btn btn-secondary btn-sm"
            :aria-pressed="pinned"
            @click="pinned = !pinned"
          >
            {{ pinned ? '取消钉住' : '钉住' }}
          </button>
          <button class="btn btn-quiet btn-sm" aria-label="系统输入 / 收起" @click="closeKeyboard">
            系统输入 / 收起
          </button>
        </template>
      </div>
      <div id="project-character-tray" class="keyboard-dock-content">
        <slot name="keyboard"></slot>
      </div>
    </aside>
  </main>
</template>

<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  toRef,
  useTemplateRef,
  watch
} from 'vue'
import '@/editor-experience.css'
import { clampSourceWidth, editorPreferenceKey, readEditorPreference } from '@/lib/editorExperience'
import { currentUserId } from '@/services/authService'
import PdfSinglePageViewer from '@/components/editor/PdfSinglePageViewer.vue'
import AppIcon from '@/components/AppIcon.vue'
import { useProjectPdf } from '@/composables/useProjectPdf'
import {
  KEYBOARD_DISCOVERY_NOTICE,
  dismissKeyboardHint,
  isKeyboardHintDismissed
} from '@/lib/proofreadNotices'

const props = defineProps({
  keyboardAvailable: { type: Boolean, default: false },
  inlineSourceToggle: { type: Boolean, default: false },
  suspended: { type: Boolean, default: false },
  page: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  pdfEnabled: { type: Boolean, default: true },
  watermarkUserId: { type: String, default: '' },
  returnTo: { type: String, default: '' },
  returnLabel: { type: String, default: '返回' },
  contentLabelledBy: { type: String, default: '' },
  emptyPdfDescription: {
    type: String,
    default: '仍可根据已导入的结构化字段继续处理。'
  }
})

const workspace = ref(null)
const keyboardOpen = ref(false)
const keyboardHintDismissed = ref(false)
const keyboardDiscoveryNotice = KEYBOARD_DISCOVERY_NOTICE
const showKeyboardHint = computed(
  () => props.keyboardAvailable && !keyboardHintDismissed.value && !props.suspended
)
const pinned = ref(false)
const pdfCollapsed = ref(true)
const sourceWidth = ref(45)
const resizing = ref(false)
const preferenceKey = computed(() => editorPreferenceKey(currentUserId(), props.page?.project))
const compact = ref(false)
const systemKeyboardOpen = ref(false)
const viewportHeight = ref(0)
const sourceCollapsed = computed(
  () =>
    compact.value &&
    (pdfCollapsed.value || ((keyboardOpen.value || systemKeyboardOpen.value) && !props.suspended))
)
function toggleSource() {
  const show = sourceCollapsed.value
  keyboardOpen.value = false
  if (show && document.activeElement?.tagName === 'TEXTAREA') document.activeElement.blur()
  pdfCollapsed.value = !show
  if (!show) void nextTick(scrollCurrentInput)
}
const viewportStyle = computed(() => ({
  ...(viewportHeight.value ? { height: `${viewportHeight.value}px` } : {}),
  '--source-width': `${sourceWidth.value}fr`,
  '--fields-width': `${100 - sourceWidth.value}fr`
}))
function updateViewport() {
  compact.value = window.innerWidth <= 1100
  const viewport = window.visualViewport
  systemKeyboardOpen.value = Boolean(viewport && window.innerHeight - viewport.height > 150)
  viewportHeight.value = Math.max(
    160,
    (viewport?.height || window.innerHeight) -
      Math.max(0, workspace.value?.getBoundingClientRect().top || 0)
  )
  if (systemKeyboardOpen.value) void nextTick(scrollCurrentInput)
}
function scrollCurrentInput() {
  if (!compact.value || props.suspended) return
  const input = [...(workspace.value?.querySelectorAll('.fields-panel textarea') || [])].find(
    (element) => element.getClientRects().length > 0
  )
  input?.scrollIntoView({ block: 'nearest' })
}
function onNavigationInteraction(event) {
  if (event.target.closest('.mobile-field-navigation')) void nextTick(scrollCurrentInput)
}
function dismissHint() {
  keyboardHintDismissed.value = true
  dismissKeyboardHint(window.localStorage)
}
function openKeyboard() {
  if (props.suspended) return
  if (document.activeElement?.tagName === 'TEXTAREA') document.activeElement.blur()
  keyboardOpen.value = true
  dismissHint()
  void nextTick(scrollCurrentInput)
}
function closeKeyboard() {
  keyboardOpen.value = false
  pinned.value = false
}
function savePreference() {
  try {
    localStorage.setItem(
      preferenceKey.value,
      JSON.stringify({ sourceWidth: sourceWidth.value, keyboardOpen: keyboardOpen.value })
    )
  } catch {
    /* an unavailable preference never blocks editing */
  }
}
watch(
  preferenceKey,
  (key) => {
    let preference
    try {
      preference = readEditorPreference(window.localStorage, key)
    } catch {
      preference = readEditorPreference(null, key)
    }
    sourceWidth.value = preference.sourceWidth
    keyboardOpen.value = preference.keyboardOpen
    pinned.value = false
  },
  { immediate: true }
)
watch([sourceWidth, keyboardOpen], () => {
  if (!resizing.value) savePreference()
})
function startResize(event) {
  resizing.value = true
  event.currentTarget.setPointerCapture(event.pointerId)
}
function resize(event) {
  if (!resizing.value) return
  const bounds = workspace.value.getBoundingClientRect()
  sourceWidth.value = clampSourceWidth(((event.clientX - bounds.left) / bounds.width) * 100)
}
function stopResize() {
  resizing.value = false
  savePreference()
}
function resizeWithKeyboard(event) {
  const amounts = { ArrowLeft: -2, ArrowRight: 2 }
  if (event.key in amounts)
    sourceWidth.value = clampSourceWidth(sourceWidth.value + amounts[event.key])
  else if (event.key === 'Home') sourceWidth.value = 30
  else if (event.key === 'End') sourceWidth.value = 65
  else return
  event.preventDefault()
}

function onOutsidePointer(event) {
  if (compact.value && !pinned.value && !event.target.closest('.keyboard-panel'))
    keyboardOpen.value = false
}
onMounted(() => {
  keyboardHintDismissed.value = isKeyboardHintDismissed(window.localStorage)
  updateViewport()
  window.addEventListener('resize', updateViewport)
  window.visualViewport?.addEventListener('resize', updateViewport)
  window.visualViewport?.addEventListener('scroll', updateViewport)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewport)
  window.visualViewport?.removeEventListener('resize', updateViewport)
  window.visualViewport?.removeEventListener('scroll', updateViewport)
})
const pdfPageInput = ref(1)
const pageRef = toRef(props, 'page')
const {
  pdfError,
  pdfLoading,
  currentPdfPage,
  pdfPageWarning,
  allowedPdfPages,
  pdfUrl,
  pdfViewerKey,
  pageImage,
  entryRegion,
  assetRegion,
  fallbackToPdf,
  retryProjectPdf,
  localPdfPage,
  totalPdfPages,
  resetPdf,
  resolveProjectPdf,
  clampPdfPage
} = useProjectPdf(pageRef)

const sourcePanel = ref(null)
const sourceRetry = useTemplateRef('sourceRetry')
const pdfNavigationControls = {
  previousPage: useTemplateRef('previousPage'),
  pageNumber: useTemplateRef('pageNumber'),
  nextPage: useTemplateRef('nextPage'),
  localSource: useTemplateRef('localSource')
}
let pendingPdfFocus = null
const canReloadSource = computed(() =>
  Boolean(props.page?.id && props.pdfEnabled && !props.loading && !pdfLoading.value)
)
function reloadSource() {
  if (!canReloadSource.value) return
  // The retry button disappears with the failed viewer; keep keyboard focus in
  // the persistent source region without selecting or changing editor fields.
  sourcePanel.value?.focus({ preventScroll: true })
  return retryProjectPdf()
}

const findingSource = ref(null)
const preferLocalSource = ref(true)
const hasSourceRegion = computed(() =>
  Boolean(entryRegion.value && entryRegion.value.entryId === props.page?.id)
)
const visibleSourceRegion = computed(() =>
  preferLocalSource.value &&
  hasSourceRegion.value &&
  assetRegion.value?.entryId === props.page?.id &&
  assetRegion.value?.physicalPage === currentPdfPage.value
    ? assetRegion.value
    : null
)
watch(
  () => props.page?.id,
  () => {
    preferLocalSource.value = true
    findingSource.value = null
  }
)

async function revealEntrySource(field) {
  if (!props.pdfEnabled) return
  const pageId = props.page?.id
  closeKeyboard()
  pdfCollapsed.value = false
  findingSource.value = { field }
  preferLocalSource.value = true
  currentPdfPage.value = allowedPdfPages.value[0]
  if (field) return
  await nextTick()
  if (pageId === props.page?.id) sourcePanel.value?.focus({ preventScroll: true })
}

function clearFindingSource() {
  findingSource.value = null
}

defineExpose({ revealEntrySource, clearFindingSource })

function showLocalSource() {
  if (!hasSourceRegion.value) return
  preferLocalSource.value = true
  navigatePdfPage(entryRegion.value.physicalPage, 'localSource')
}

function navigatePdfPage(number, controlName) {
  const target = clampPdfPage(number)
  // On the same page, the source view updates in place without moving focus.
  if (target === currentPdfPage.value) return
  const control = pdfNavigationControls[controlName]?.value
  currentPdfPage.value = target
  if (control && document.activeElement === control) {
    // Loading a different page image detaches the viewer and its toolbar.
    pendingPdfFocus = { controlName, entryId: props.page?.id }
    sourcePanel.value?.focus({ preventScroll: true })
  }
}

watch(
  [currentPdfPage, pdfLoading],
  ([, loading]) => {
    if (loading || !pendingPdfFocus) return
    const { controlName, entryId } = pendingPdfFocus
    pendingPdfFocus = null
    if (
      entryId !== props.page?.id ||
      !canReloadSource.value ||
      sourceCollapsed.value ||
      document.activeElement !== sourcePanel.value
    )
      return
    const control = pdfNavigationControls[controlName].value
    const restoredControl = pdfError.value
      ? sourceRetry.value
      : control && !control.disabled
        ? control
        : pdfNavigationControls.pageNumber.value
    const destination = restoredControl ?? sourcePanel.value
    destination?.focus({ preventScroll: true })
  },
  { flush: 'post' }
)

watch(currentPdfPage, (value) => {
  pdfPageInput.value = value
})

watch(
  [() => props.page?.id, () => props.loading, () => props.pdfEnabled],
  async ([pageId, loading, enabled]) => {
    if (!enabled) {
      resetPdf()
      return
    }
    if (loading) return
    if (!pageId) {
      resetPdf()
      return
    }
    await resolveProjectPdf()
    pdfPageInput.value = currentPdfPage.value
  },
  { immediate: true }
)

onBeforeUnmount(resetPdf)

function applyPdfPageInput() {
  navigatePdfPage(pdfPageInput.value, 'pageNumber')
  pdfPageInput.value = currentPdfPage.value
}
</script>

<style scoped>
.source-finding-note {
  margin: 0;
  padding: var(--space-1) var(--space-2);
}

.source-view-options {
  display: inline-flex;
  max-width: 100%;
  gap: var(--space-1);
}
.source-view-options .pdf-tool[aria-pressed='true'] {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-glow-soft);
}
.editor-panel-body--pdf {
  position: relative;
}
.pdf-transition-mask {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  position: absolute;
  inset: 0;
  z-index: var(--z-mask);
  background: var(--surface);
}
.pdf-transition-mask small {
  color: var(--ink-muted);
}
.pdf-preview-pending {
  opacity: 0;
}
</style>
