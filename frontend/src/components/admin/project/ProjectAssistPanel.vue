<template>
  <!-- #234 机器疑点：列级/页级与跨行判据只能整批跑，此前只有 curl 能触发 -->
  <section id="project-assist" class="card project-section mb-6">
    <div class="section-heading">
      <div>
        <h2>机器疑点</h2>
        <p>重算后可在批次报告查看列格式与 PDF 分页疑点。</p>
      </div>
      <div class="assist-actions">
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="assistBusy"
          @click="runIdentityRecompute"
        >
          重算跨行身份
        </button>
        <button type="button" class="btn" :disabled="assistBusy" @click="runFindingsRecompute">
          {{ assistBusy ? '正在重算…' : '按项目重算疑点' }}
        </button>
      </div>
    </div>

    <RareCharacterNotice :texts="assistRows.map(assistWording)" />
    <p v-if="assistError" class="alert alert-error" role="alert">{{ assistError }}</p>
    <p v-if="assistNotice" class="text-muted">{{ assistNotice }}</p>
    <p v-if="assistFindingsNotice" class="alert alert-warning" role="alert">
      {{ assistFindingsNotice }}
    </p>

    <p class="assist-summary">
      本页 {{ assistRows.length }} 条
      <span v-for="entry in assistKinds" :key="entry.kind"
        >{{ entry.label }} {{ entry.count }}、</span
      >
      strong {{ assistStrong }} / warn {{ assistWarn }} / info {{ assistInfo }}；
      <template v-if="assistGatedOff.total">{{ assistGatedOffText }}，校对员今天看不到；</template>
    </p>

    <div v-if="assistKinds.length" class="assist-filter">
      <label
        >只看某类
        <select v-model="assistKind" @change="applyAssistKindFilter">
          <option value="">全部（本页）</option>
          <option v-for="entry in assistKinds" :key="entry.kind" :value="entry.kind">
            {{ entry.label }}（本页 {{ entry.count }} 条）
          </option>
        </select>
      </label>
      <button
        v-if="assistKind"
        type="button"
        class="btn btn-sm btn-secondary"
        @click="clearAssistKind"
      >
        清除筛选
      </button>
    </div>

    <ul v-if="assistRows.length" class="assist-list">
      <li v-for="view in assistViewRows" :key="view.row.id" class="assist-row">
        <strong>{{ assistKindLabel(view.row.kind) }}</strong>
        <span class="assist-field">{{ view.row.field || '整条' }}</span>
        <span v-if="view.row.audience === 'batch'" class="assist-locator">批次检查</span>
        <span v-else class="assist-locator">
          {{ view.locator.entryText
          }}<template v-if="view.locator.pdfText"> · {{ view.locator.pdfText }}</template>
        </span>
        <RouterLink
          v-if="view.row.audience === 'batch' && view.row.evidence?.batch"
          :to="{
            name: 'ProjectBatchReport',
            params: { id: projectId, batchId: view.row.evidence.batch },
            hash: '#report-findings'
          }"
          class="btn btn-sm btn-quiet"
          >查看批次报告</RouterLink
        >
        <button
          v-else-if="view.row.audience !== 'batch' && view.locator.jumpable"
          type="button"
          class="btn btn-sm btn-quiet"
          @click="jumpToEntryPage(view)"
        >
          只看这页
        </button>
        <span :class="['assist-severity', `assist-severity--${view.row.severity}`]">{{
          assistSeverityLabel(view.row.severity)
        }}</span>
        <AppFieldValue
          class="assist-wording"
          :value="assistWording(view.row)"
          :font-notice="false"
        />
        <span v-if="view.row.audience !== 'batch'" class="assist-span">{{ view.span }}</span>
        <span v-if="view.row.audience === 'diagnostic'" class="assist-gate">供管理端抽样</span>
        <span v-else-if="view.row.audience !== 'batch'" class="assist-gate"
          >gate {{ view.row.gate }} · 样本 {{ view.row.gate_sample_n }}</span
        >
      </li>
    </ul>
    <p v-else class="text-muted assist-empty">{{ assistEmptyText }}</p>

    <nav v-if="assistRows.length" class="assist-pager" aria-label="疑点分页">
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        :disabled="assistPage <= 1 || assistBusy"
        @click="stepAssistPage(-1)"
      >
        上一页
      </button>
      <span>第 {{ assistPage }} 页</span>
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        :disabled="!assistHasMore || assistBusy"
        @click="stepAssistPage(1)"
      >
        下一页
      </button>
    </nav>

    <!-- #240：条目阻塞结论。写入口只对平台管理员开放（后端 blocked_reason.pb.js 里
             三个路由都是 requireAuth + isPlatformAdmin），所以这里连控件都不给别的身份渲染。
             控件不在 ≠ 能力被关掉了：机器路径本来就只把桶当判档输入，从不写回这一列。 -->
    <div v-if="auth.isPlatformAdmin" class="blocked-conclusion">
      <h3>条目阻塞结论</h3>
      <p class="text-muted">
        机器认不出「这条为什么卡住」时，需要一个人事先把判断写下来，并在依据里说清出处。
        登记与撤销都会立刻重算这一条的难度层级。
      </p>
      <AppField class="form-group"
        ><template #label>选择条目（本页）</template>
        <select v-model="blockedPageId" class="form-control" @change="loadBlockedConclusion">
          <option value="">—</option>
          <option v-for="(pg, idx) in displayedPages" :key="pg.id" :value="pg.id">
            第 {{ formatItemNo(pg.page_number, displayedPageOffset + idx) }} 条 ·
            {{ statusLabel(pg.status) }}
          </option>
        </select>
      </AppField>
      <template v-if="blockedPageId">
        <p class="blocked-conclusion__current">{{ blockedConclusionText }}</p>
        <AppField class="form-group"
          ><template #label>阻塞原因</template>
          <select v-model="blockedForm.reason" class="form-control">
            <option value="">—</option>
            <option v-for="(label, key) in BUCKET_LABELS" :key="key" :value="key">
              {{ label }}
            </option>
          </select>
        </AppField>
        <AppField class="form-group"
          ><template #label>依据（必填）</template>
          <textarea
            v-model="blockedForm.basis"
            class="form-control"
            rows="2"
            maxlength="500"
            placeholder="例：授权邮件 2026-10-03；凡例 §4 第 2 条"
          ></textarea>
        </AppField>
        <div class="flex gap-2">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="blockedBusy || !blockedCanSubmit"
            @click="saveBlockedConclusion"
          >
            {{ blockedBusy ? '提交中…' : '登记结论' }}
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="blockedBusy || blockedState === 'unset'"
            @click="clearBlockedConclusion"
          >
            撤销结论
          </button>
        </div>
        <p v-if="blockedTier" class="text-sm text-muted">
          重算后难度：{{ taskTierLabel(blockedTier) }}
          <template v-if="blockedBasisText"> · 判断依据：{{ blockedBasisText }}</template>
        </p>
      </template>
      <p v-if="blockedError" class="alert alert-error" role="alert">{{ blockedError }}</p>
    </div>

    <h3>人工结论（不是冲突的分组）</h3>
    <p class="text-muted">
      标过的分组在重算时整组跳过；这些结论不跟着机器批次下线，也不随判定人消失。
    </p>
    <p v-if="assistDismissalsTruncated" class="alert alert-warning" role="alert">
      人工结论只列出最近 200
      条。更早的结论仍会在重算时整组生效，只是不在这份列表里，也无法在这里撤回——
      这不是"没有更早的结论"，别把它当成可以重新判定的依据。
    </p>
    <ul v-if="assistDismissals.length" class="assist-list">
      <li v-for="item in assistDismissals" :key="item.id" class="assist-row">
        <strong>{{ assistKindLabel(item.kind) }}</strong>
        <span class="assist-field">{{ item.group_key }}</span>
        <span class="assist-wording">{{ item.note || '（无备注）' }}</span>
        <span class="assist-gate"
          >{{ item.decided_by_name || '判定人已不在' }} · {{ item.created }}</span
        >
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="assistBusy"
          @click="revokeDismissal(item)"
        >
          撤回
        </button>
      </li>
    </ul>
    <p v-else class="text-muted assist-empty">还没有把任何分组标为「不是冲突」。</p>
  </section>
</template>

<script setup>
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import AppFieldValue from '@/components/AppFieldValue.vue'
import AppField from '@/components/AppField.vue'
import { computed, ref } from 'vue'
import { statusLabel } from '@/constants/pageStatus'
import {
  EMPTY_MESSAGES,
  SEVERITY_LABELS,
  emptyReason,
  findingLocator,
  findingSpanText,
  gatedOffNotice,
  gatedOffSplit,
  kindBreakdown,
  recomputeNotice,
  severityCount,
  truncatedNotice
} from '@/lib/assistOverview'
import { hintKindLabel } from '@/lib/fieldHints'
import { taskTierBasisText, taskTierLabel } from '@/lib/taskTiers'
import { renderFindingMessage } from '@/lib/findingMessages'
import {
  listProjectDismissals,
  listProjectFindings,
  recomputeProjectFindings,
  recomputeProjectIdentity,
  revokeGroupDismissal
} from '@/services/assistService'
import {
  BUCKET_LABELS,
  canSubmit as canSubmitBlocked,
  conclusionState,
  conclusionSummary
} from '@/lib/blockedReason'
import {
  clearBlockedReason,
  getBlockedReason,
  setBlockedReason
} from '@/services/blockedReasonService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'
const props = defineProps({
  projectId: { type: String, required: true },
  displayedPages: { type: Array, default: () => [] },
  displayedPageOffset: { type: Number, default: 0 },
  refreshPages: { type: Function, required: true }
})
const projectId = props.projectId
const auth = useAuthStore()
const emit = defineEmits(['jump-entry'])
const displayedPages = computed(() => props.displayedPages)
const displayedPageOffset = computed(() => props.displayedPageOffset)
const loadPages = props.refreshPages

function formatItemNo(pageNumber, fallbackIndex) {
  const n = Number(pageNumber)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  return fallbackIndex + 1
}

const assistRows = ref([])

const assistDismissals = ref([])

const assistPage = ref(1)

const assistHasMore = ref(false)

const assistFindingsNotice = ref('')

const assistDismissalsTruncated = ref(false)

const assistKind = ref('')

const assistBusy = ref(false)

const assistNotice = ref('')

const assistError = ref('')

const assistRuns = ref({ rules: false, identity: false })

const assistPagesScanned = ref(null)

const assistKinds = computed(() => kindBreakdown(assistRows.value))

const assistStrong = computed(() => severityCount(assistRows.value, 'strong'))

const assistWarn = computed(() => severityCount(assistRows.value, 'warn'))

const assistInfo = computed(() => severityCount(assistRows.value, 'info'))

const assistGatedOff = computed(() =>
  gatedOffSplit(assistRows.value.filter((row) => !row.audience || row.audience === 'entry'))
)

const assistGatedOffText = computed(() => gatedOffNotice(assistGatedOff.value))

const assistEmptyText = computed(
  () =>
    EMPTY_MESSAGES[
      emptyReason({
        items: assistRows.value,
        runs: assistRuns.value,
        pagesScanned: assistPagesScanned.value
      })
    ]
)

const assistViewRows = computed(() =>
  assistRows.value.map((row) => ({
    row,
    locator: findingLocator(row),
    span: findingSpanText(row)
  }))
)

function assistKindLabel(kind) {
  return hintKindLabel(kind)
}

function assistSeverityLabel(severity) {
  return SEVERITY_LABELS[severity] ?? severity ?? '未知等级'
}

function assistWording(row) {
  return renderFindingMessage(row?.message)
}

async function loadAssistFindings() {
  assistError.value = ''
  try {
    const view = await listProjectFindings(projectId, {
      kind: assistKind.value,
      page: assistPage.value
    })
    assistRows.value = view.items ?? []
    assistHasMore.value = !!view.hasMore
    // 只认后端明说的截断信号；文案由 assistOverview 的 truncatedNotice 生成，
    // 不在 UI 里另写一句（#235 评审：那句手写的告警与测试钉住的 helper 是两套，
    // 而 helper 在 frontend/src 里零消费）。
    assistFindingsNotice.value = truncatedNotice({
      gate_rows_truncated: view.gate_rows_truncated,
      hasMore: view.hasMore
    })
  } catch (e) {
    assistError.value = `疑点列表读取失败：${e?.message ?? e}`
  }
}

async function loadAssistDismissals() {
  try {
    const view = await listProjectDismissals(projectId)
    assistDismissals.value = view.items ?? []
    // 后端只回最近 200 条：被截断时说的是"人工结论"这件事，与疑点列表/门控表无关。
    assistDismissalsTruncated.value = !!view.truncated
  } catch (e) {
    assistError.value = `人工结论读取失败：${e?.message ?? e}`
  }
}

async function runFindingsRecompute() {
  if (assistBusy.value) return
  assistBusy.value = true
  assistError.value = ''
  try {
    const summary = await recomputeProjectFindings(projectId)
    assistRuns.value = { ...assistRuns.value, rules: true }
    assistPagesScanned.value = Number.isFinite(summary?.pages) ? summary.pages : null
    assistNotice.value = recomputeNotice(summary)
    assistPage.value = 1
    await loadAssistFindings()
  } catch (e) {
    assistError.value = `重算失败：${e?.message ?? e}`
  } finally {
    assistBusy.value = false
  }
}

async function runIdentityRecompute() {
  if (assistBusy.value) return
  assistBusy.value = true
  assistError.value = ''
  try {
    const summary = await recomputeProjectIdentity(projectId)
    // 只标 identity：跨行重算不刷新列级/页级判据，也不刷 tier
    assistRuns.value = { ...assistRuns.value, identity: true }
    assistPagesScanned.value = Number.isFinite(summary?.pages) ? summary.pages : null
    assistNotice.value = recomputeNotice(summary, { identity: true })
    assistPage.value = 1
    await loadAssistFindings()
  } catch (e) {
    assistError.value = `跨行重算失败：${e?.message ?? e}`
  } finally {
    assistBusy.value = false
  }
}

function stepAssistPage(delta) {
  const next = assistPage.value + delta
  if (next < 1) return
  assistPage.value = next
  loadAssistFindings()
}

function clearAssistKind() {
  assistKind.value = ''
  assistPage.value = 1
  loadAssistFindings()
}

function applyAssistKindFilter() {
  assistPage.value = 1
  loadAssistFindings()
}

async function revokeDismissal(item) {
  if (assistBusy.value) return
  assistBusy.value = true
  assistError.value = ''
  try {
    await revokeGroupDismissal(projectId, item.id)
    assistNotice.value = '人工结论已撤回（物理删除，不留痕）；下次跨行重算会重新报出这一组。'
    await loadAssistDismissals()
  } catch (e) {
    assistError.value = `撤回失败：${e?.message ?? e}`
  } finally {
    assistBusy.value = false
  }
}

const blockedPageId = ref('')

const blockedRecord = ref(null)

const blockedForm = ref({ reason: '', basis: '' })

const blockedBusy = ref(false)

const blockedError = ref('')

const blockedTier = ref('')

const blockedTierBasis = ref('')

const blockedBasisText = computed(() => taskTierBasisText(blockedTierBasis.value))

const blockedState = computed(() => conclusionState(blockedRecord.value))

const blockedConclusionText = computed(() => conclusionSummary(blockedRecord.value))

const blockedCanSubmit = computed(() => canSubmitBlocked(blockedForm.value))

function blockedMessage(error) {
  return getPbMessage(error) || error?.message || String(error)
}

async function loadBlockedConclusion() {
  blockedError.value = ''
  blockedRecord.value = null
  blockedForm.value = { reason: '', basis: '' }
  blockedTier.value = ''
  blockedTierBasis.value = ''
  if (!blockedPageId.value) return
  try {
    blockedRecord.value = await getBlockedReason(blockedPageId.value)
  } catch (error) {
    blockedError.value = `读取失败：${blockedMessage(error)}`
  }
}

async function reloadBlockedConclusion(result) {
  const tier = result?.difficulty_tier ?? ''
  const basis = result?.difficulty_basis ?? ''
  await loadBlockedConclusion()
  blockedTier.value = tier
  blockedTierBasis.value = basis
  await loadPages()
}

async function saveBlockedConclusion() {
  if (blockedBusy.value || !blockedCanSubmit.value) return
  blockedBusy.value = true
  blockedError.value = ''
  try {
    await reloadBlockedConclusion(
      await setBlockedReason(blockedPageId.value, { ...blockedForm.value })
    )
  } catch (error) {
    blockedError.value = `登记失败：${blockedMessage(error)}`
  } finally {
    blockedBusy.value = false
  }
}

async function clearBlockedConclusion() {
  if (blockedBusy.value || blockedState.value === 'unset') return
  blockedBusy.value = true
  blockedError.value = ''
  try {
    await reloadBlockedConclusion(await clearBlockedReason(blockedPageId.value))
  } catch (error) {
    blockedError.value = `撤销失败：${blockedMessage(error)}`
  } finally {
    blockedBusy.value = false
  }
}
function jumpToEntryPage(view) {
  emit('jump-entry', view?.locator?.pdfPage)
}
loadAssistFindings()
loadAssistDismissals()
</script>
