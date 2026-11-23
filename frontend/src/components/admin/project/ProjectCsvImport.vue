<template>
  <!-- CSV upload -->
  <div ref="panelElement">
    <h4 class="font-semibold mb-2">从 CSV 导入条目</h4>
    <p v-if="!csvJobTarget" class="text-sm text-muted mb-3">
      选择一列定位 PDF 物理页，再检查并确认导入。其余列保留为校对内容。
    </p>
    <details v-if="!csvJobTarget" class="mb-3">
      <summary class="text-sm text-muted">查看 CSV 格式要求</summary>
      <p class="text-sm text-muted">
        CSV 第一行填写列名，不能有空白或重复列名。页码从 1 开始，使用 PDF 文件中的实际页序，
        封面也算一页。仅有一个常见页码列名时会为你预选。
      </p>
    </details>
    <div v-if="invalidCsvLink" class="alert alert-warning mt-3" role="alert">
      此 CSV 检查链接无效，请在批次台账重新选择。
    </div>
    <RouterLink v-if="csvJobTarget || invalidCsvLink" :to="ledgerTarget" class="back-link"
      >返回批次台账</RouterLink
    >
    <AppButton
      v-if="csvJobTarget || invalidCsvLink"
      class="ml-2"
      variant="ghost"
      size="sm"
      :disabled="uploadingCsv"
      @click="startAnotherCsv"
      >{{ hasLocalDraft ? '返回未检查的 CSV' : '检查另一个 CSV' }}</AppButton
    >
    <template v-if="!csvJobTarget && !invalidCsvLink">
      <p v-if="mappingChanged && !csvFile" class="text-sm text-muted mt-3" role="status">
        请重新选择原 CSV 文件，再选择页码列并检查。先前的检查记录仍可在批次台账中查看。
      </p>
      <ProjectSourcePicker
        v-model="sourceId"
        class="form-group mt-3"
        :disabled="uploadingCsv || csvJob?.status === 'validated'"
      />
      <input
        type="file"
        accept=".csv"
        @change="onCsvSelected"
        ref="csvInput"
        class="file-input-hidden"
        :disabled="uploadingCsv"
      />
      <AppButton
        ref="csvFileButton"
        variant="secondary"
        :disabled="uploadingCsv"
        @click="csvInput.click()"
      >
        选择 CSV 文件
      </AppButton>
      <span v-if="csvFile" class="csv-selected-file text-sm ml-2">{{ csvFile.name }}</span>
    </template>
    <template v-if="csvFile && !csvJobTarget && !invalidCsvLink">
      <p v-if="readingColumns" class="text-sm text-muted mt-3" role="status">正在读取 CSV 表头…</p>
      <div v-else-if="columnsError" class="alert alert-error mt-3" role="alert">
        <p>{{ columnsError }}</p>
        <AppButton variant="secondary" size="sm" @click="loadCsvColumns">重新读取表头</AppButton>
      </div>
      <div v-else-if="csvColumns" class="csv-mapping" role="group" aria-label="页码列设置">
        <AppField label="PDF 物理页码列">
          <select
            ref="pageColumnInput"
            v-model="pdfPageColumn"
            aria-label="PDF 物理页码列"
            class="form-control"
            :disabled="uploadingCsv"
          >
            <option value="">选择 CSV 中对应的列</option>
            <option v-for="header in csvColumns.headers" :key="header" :value="header">
              {{ header }}
            </option>
          </select>
        </AppField>
        <p v-if="mappingChanged" class="text-sm text-muted">更改后请重新检查，再确认导入。</p>
        <p v-else-if="!pdfPageColumn" class="text-sm text-muted">
          {{
            csvColumns.page_column_candidates?.length > 1
              ? '检测到多个常见页码列，请选择记录 PDF 实际页序的那一列。'
              : '请选出记录 PDF 实际页序的列。'
          }}
        </p>
        <p
          v-else-if="csvColumns.suggested_page_column === pdfPageColumn"
          class="text-sm text-muted"
        >
          已按列名预选，可更改。
        </p>
        <ul v-if="columnSamples.length" class="csv-mapping-samples" aria-label="所选列原值样本">
          <li v-for="item in columnSamples" :key="item.line">
            <span>第 {{ item.line }} 行</span>
            <AppFieldValue :value="item.value" empty-label="空白" :font-notice="false" />
          </li>
        </ul>
        <AppButton
          variant="primary"
          class="mt-3"
          @click="uploadCsv"
          :disabled="!pdfPageColumn"
          :loading="uploadingCsv"
          loading-label="正在检查"
        >
          检查 CSV
        </AppButton>
      </div>
    </template>
    <JobStatusPanel
      v-if="csvJobTarget && csvStatusVisible"
      label="CSV 导入"
      kind="csv"
      :observation="csvObservation"
      @retry="refreshCsvJob"
    />
    <div
      v-if="csvError && !csvJob"
      role="alert"
      class="alert alert-error mt-3 preserve-line-breaks"
    >
      {{ csvError }}
    </div>
    <div v-if="csvJob" class="csv-inspection mt-3">
      <template v-if="csvJob.status === 'validated'">
        <h5 class="csv-inspection-title">检查完成，待确认</h5>
        <p class="text-sm text-muted mt-2" role="status">
          尚未写入校对条目。请核对页码列、来源和样本，再确认导入。
        </p>
      </template>
      <p v-if="csvJob.original_filename" class="csv-selected-file text-sm mt-2">
        CSV 文件：<strong>{{ csvJob.original_filename }}</strong>
      </p>
      <p v-if="csvJob.project_file" class="csv-selected-file text-sm text-muted mt-2">
        绑定原文 PDF：{{ csvPdf?.name || '正在读取文件名…' }}
        <span v-if="csvJob.pdf_page_limit > 0"> · {{ csvJob.pdf_page_limit }} 页</span>
      </p>
      <p v-else-if="csvJob.pdf_snapshot_captured" class="text-sm text-muted mt-2">
        检查时未绑定原文 PDF。
      </p>
      <div
        v-if="csvSuccess && csvJob.status !== 'validated'"
        class="alert mt-2"
        :class="csvJob.failed_count > 0 ? 'alert-warning' : 'alert-success'"
        role="status"
      >
        {{ csvSuccess }}
      </div>
      <p v-if="confirmableCsvJob && csvPdfIssue" class="alert alert-warning mt-2" role="alert">
        {{ csvPdfIssue }}
        <AppButton v-if="csvJob.project_file" variant="ghost" size="sm" @click="refreshCsvJob">
          重新核对原文 PDF
        </AppButton>
      </p>
      <p v-if="csvSourcePending" class="text-sm text-muted mt-2" role="status">正在核对作业来源…</p>
      <p v-else-if="csvActualSource" class="csv-inspection-source text-sm mt-2" role="note">
        本次实际来源：<strong>{{ csvActualSource.title }}</strong
        >。
        {{ csvJob.status === 'validated' ? '确认导入将沿用这个来源。' : '来源以此作业记录为准。' }}
      </p>
      <p v-if="csvSourceMismatch" class="alert alert-warning mt-2" role="alert">
        刚才选择的「{{ requestedSourceLabel }}」未应用：相同文件沿用了已有作业，实际来源为「{{
          csvActualSource.title
        }}」。此处不会改写已有作业的来源。
      </p>
      <p v-if="csvSourceError" class="alert alert-warning mt-2" role="alert">
        {{ csvSourceError }} 暂不能确认导入。
        <AppButton variant="ghost" size="sm" @click="refreshCsvJob">重新核对来源</AppButton>
      </p>
      <p v-if="csvInspection?.pdfPageField" class="csv-inspection-source text-sm mt-2">
        本次页码列：<strong>{{ csvInspection.pdfPageField }}</strong>
        <span v-if="samplePdfPages.length">
          · 样本为 PDF 第 {{ samplePdfPages.join('、') }} 页</span
        >
      </p>
      <p
        v-if="csvJob.status === 'validated' && !csvMappingReady"
        class="alert alert-warning mt-2"
        role="alert"
      >
        本次检查记录的页码列无法确认，请重新检查。
      </p>
      <dl v-if="csvInspection" class="csv-inspection-counts" aria-label="CSV 检查数量">
        <div>
          <dt>文件行数</dt>
          <dd>{{ csvInspection.totalRows }}</dd>
        </div>
        <div>
          <dt>可导入</dt>
          <dd>{{ csvInspection.validRows }}</dd>
        </div>
        <div :class="{ 'csv-inspection-counts__warning': csvInspection.invalidRows > 0 }">
          <dt>需跳过</dt>
          <dd>{{ csvInspection.invalidRows }}</dd>
        </div>
      </dl>
      <p v-if="csvInspection?.invalidRows > 0" class="csv-inspection-warning" role="note">
        {{ csvInspection.invalidRows }} 行无法导入，确认后将跳过这些行。
        可先查看下方错误记录，修改原 CSV 后重新检查。
      </p>
      <p v-if="csvJob.skipped_count > 0" class="csv-inspection-warning" role="note">
        重复跳过 {{ csvJob.skipped_count }} 条，不新增入库。
      </p>
      <div v-if="csvError" role="alert" class="alert alert-error mt-3 preserve-line-breaks">
        {{ csvError }}
      </div>
      <ImportErrorsPanel
        v-if="csvJob.id && (csvJob.failed_count > 0 || csvJob.status === 'failed')"
        :project-id="projectId"
        :job-id="csvJob.id"
        :revision="`${csvJob.status}:${csvJob.updated || ''}`"
      />
      <div v-if="csvInspection && confirmableCsvJob" class="csv-inspection-action">
        <AppButton
          variant="primary"
          @click="confirmCsvImport"
          :loading="uploadingCsv"
          loading-label="正在确认导入"
          :disabled="
            uploadingCsv ||
            csvObservation.state !== 'live' ||
            !csvSourceReady ||
            !csvMappingReady ||
            !csvPdfReady
          "
        >
          确认导入
        </AppButton>
        <AppButton
          v-if="canChangeColumn && !hasLocalDraft"
          variant="secondary"
          :disabled="uploadingCsv"
          @click="editPageColumn"
        >
          更改页码列
        </AppButton>
        <span v-if="!csvSourceReady" class="text-sm text-muted">等待作业来源核对完成</span>
        <span
          v-if="canChangeColumn && !hasLocalDraft && !canReuseLocalFile"
          class="text-sm text-muted"
        >
          更改页码列需重新选择原 CSV 并检查。
        </span>
      </div>
      <AppButton
        v-else-if="canChangeColumn && !hasLocalDraft"
        variant="secondary"
        class="mt-3"
        :disabled="uploadingCsv"
        @click="editPageColumn"
        >更改页码列</AppButton
      >
      <RareCharacterNotice
        v-if="csvInspection"
        :texts="[
          ...csvInspection.headers,
          ...csvInspection.preview.flatMap((row) => Object.values(row))
        ]"
      />
      <AppDisclosure
        v-if="csvInspection"
        :key="csvJob?.id"
        v-model="samplesOpen"
        class="csv-preview-disclosure mt-3"
        :label="`查看预览样本（${csvInspection.preview.length} 条）`"
        lazy
      >
        <p class="text-sm text-muted">
          只读预览前 {{ csvInspection.previewLimit }} 条有效记录，当前显示
          {{ csvInspection.preview.length }} 条。
          这是样本，不代表其余记录均正确；需要修改时，请修改原 CSV 后重新检查。
        </p>
        <CsvSampleSource
          v-if="active && samplesOpen && previewFile && selectedSampleOption"
          ref="sampleViewer"
          :key="csvJob.id"
          :file="previewFile"
          :row="csvInspection.preview[selectedSample]"
          :headers="csvInspection.headers"
          :location="selectedSampleOption.location"
          :sample-options="sampleOptions"
          :sample-index="selectedSample"
          @select="selectedSample = $event"
          @close="closeSample(true)"
        />
        <p v-else-if="csvInspection.preview.length && !previewFile" class="text-sm text-muted mt-2">
          这次预检没有可读取的绑定 PDF。
        </p>
        <AppDataTable
          label="CSV 预检内容"
          v-if="csvInspection.preview.length"
          class="table-wrapper mt-2"
          ><template #head>
            <tr>
              <th>原 CSV 行号</th>
              <th>PDF 物理页码</th>
              <th v-if="previewFile">原文</th>
              <th v-for="header in csvPreviewHeaders" :key="header">{{ header }}</th>
            </tr>
          </template>
          <tr v-for="(row, index) in csvInspection.preview" :key="index">
            <td>{{ csvInspection.previewLocations[index]?.csvLine ?? '旧记录未保存' }}</td>
            <td>{{ csvInspection.previewLocations[index]?.pdfPage ?? '旧记录未保存' }}</td>
            <td v-if="previewFile">
              <AppButton
                v-if="csvInspection.previewLocations[index]?.pdfPage"
                variant="ghost"
                size="sm"
                :aria-label="`对照 CSV 样本 ${index + 1} 的原文`"
                :aria-pressed="selectedSample === index"
                @click="openSample(index, $event)"
                >对照原文</AppButton
              >
            </td>
            <td v-for="header in csvPreviewHeaders" :key="header">
              <AppFieldValue
                :value="row[header]"
                :lang="fieldValueLanguage(header)"
                :font-notice="false"
              />
            </td>
          </tr>
        </AppDataTable>
        <p v-if="!csvInspection.preview.length" class="text-sm text-muted mt-2">
          此作业没有可显示的预览样本，请核对检查数量与错误记录。
        </p>
      </AppDisclosure>
      <AppDisclosure :key="`process:${csvJob.id}`" class="mt-2" label="查看检查与导入详情" lazy>
        <JobStatusPanel
          v-if="!csvStatusVisible"
          label="CSV 导入"
          kind="csv"
          :observation="csvObservation"
          @retry="refreshCsvJob"
        />
        <p class="text-sm">{{ csvJobProgressText(csvJob) }}</p>
        <p
          v-if="csvJob.error_message && csvJob.status !== 'failed'"
          class="text-sm text-muted mt-2 preserve-line-breaks"
        >
          {{ csvJob.error_message }}
        </p>
        <p class="text-sm text-muted mt-2">
          作业：{{ csvJob.id }}；来源关联：{{ csvJob.source_link }}；来源记录：{{
            csvJob.source || '未关联'
          }}；来源标识：{{ csvActualSource?.logical_id || '未读取或未关联' }}
        </p>
        <template v-if="csvInspection">
          <p class="text-sm mt-2">
            编码：{{ csvInspection.encoding || '未知' }}； 页码字段：<code>{{
              csvInspection.pdfPageField
            }}</code
            >； 页码范围：{{
              csvInspection.minPdfPage && csvInspection.maxPdfPage
                ? `${csvInspection.minPdfPage}–${csvInspection.maxPdfPage}`
                : '无有效页码'
            }}。
          </p>
          <p class="text-sm mt-2">
            检测到的表头：<code>{{ csvInspection.headers.join('、') }}</code>
          </p>
        </template>
      </AppDisclosure>
    </div>
  </div>
</template>

<script setup>
import AppButton from '@/components/AppButton.vue'
import AppField from '@/components/AppField.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import CsvSampleSource from '@/components/admin/project/CsvSampleSource.vue'
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import AppFieldValue from '@/components/AppFieldValue.vue'
import { fieldValueLanguage } from '@/lib/fieldValue'
import ProjectSourcePicker from '@/components/admin/project/ProjectSourcePicker.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import ImportErrorsPanel from '@/components/admin/project/ImportErrorsPanel.vue'
import JobStatusPanel from '@/components/admin/project/JobStatusPanel.vue'
import { useJobObserver } from '@/composables/useJobObserver'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
import { listSources } from '@/services/sourcesService'
import { getProjectFile } from '@/services/projectFilesService'
import {
  commitCsvImport,
  createCsvInspection,
  getImportJob,
  readCsvColumns
} from '@/services/importJobsService'
import {
  csvFatalMessage,
  csvFixedSource,
  csvImportResultText,
  csvJobProgressText,
  parseCsvInspection
} from '@/lib/csvInspection'
import { getPbMessage, getUploadErrorMessage } from '@/utils/pbErrors'
const props = defineProps({
  projectId: { type: String, required: true },
  active: { type: Boolean, default: true },
  jobLink: { type: String, default: '' },
  refreshPages: { type: Function, required: true },
  refreshStats: { type: Function, required: true },
  refreshQuality: { type: Function, required: true },
  refreshLedger: { type: Function, required: true },
  clearSelection: { type: Function, required: true }
})
const emit = defineEmits(['job-change'])
const projectId = props.projectId
const ledgerTarget = projectWorkspaceTarget(projectId, 'materials', 'batches')
const invalidCsvLink = computed(() =>
  Boolean(props.jobLink && !/^[a-z0-9]{15}$/.test(props.jobLink))
)
const loadPages = props.refreshPages
const loadPageStats = props.refreshStats
const loadQualitySummary = props.refreshQuality
const loadLedger = props.refreshLedger
const csvInput = ref(null)
const csvFileButton = ref(null)
const pageColumnInput = ref(null)

const csvFile = ref(null)
const csvColumns = ref(null)
const pdfPageColumn = ref('')
const checkedLocalFile = ref(false)
const hasLocalDraft = computed(() => Boolean(csvFile.value && !checkedLocalFile.value))
const readingColumns = ref(false)
const columnsError = ref('')
const mappingChanged = ref(false)
let columnsRequest

const sourceId = ref('')

const uploadingCsv = ref(false)

const csvSuccess = ref('')

const csvError = ref('')

const panelElement = ref(null)
const csvJobTarget = ref(null)
const {
  snapshot: csvJob,
  observation: csvObservation,
  retry: retryCsvJob,
  seed: seedCsvJob
} = useJobObserver({
  projectId: () => props.projectId,
  kind: 'csv',
  job: csvJobTarget,
  panel: panelElement,
  read: readCsvJob
})

const csvActualSource = ref(null)
const csvPdf = ref(null)
const samplesOpen = ref(false)
const selectedSample = ref(null)
const sampleViewer = ref(null)
let sampleTrigger
const previewFile = computed(() => {
  const record = csvPdf.value?.record
  return csvJob.value?.project_file === record?.id && record?.status === 'ready' && record?.file
    ? record
    : null
})
async function openSample(index, event) {
  sampleTrigger = event.currentTarget
  selectedSample.value = index
  await nextTick()
  sampleViewer.value?.focus()
}
function closeSample(restoreFocus = false) {
  selectedSample.value = null
  if (restoreFocus) sampleTrigger?.focus()
  sampleTrigger = null
}
watch(
  () => csvJob.value?.id,
  () => {
    samplesOpen.value = false
    closeSample()
  }
)
watch([() => props.active, samplesOpen], ([active, open]) => {
  if (!active || !open) closeSample()
})
let csvPdfRequest
const csvPdfReady = computed(
  () =>
    csvJob.value?.pdf_snapshot_captured === true &&
    (!csvJob.value.project_file ||
      (csvPdf.value?.id === csvJob.value.project_file && csvPdf.value.ready))
)
const csvPdfIssue = computed(() => {
  if (!csvJob.value?.pdf_snapshot_captured)
    return '这次检查未记录绑定的原文 PDF，请重新选择原 CSV 并检查。'
  if (csvPdf.value && csvPdf.value.id === csvJob.value.project_file && !csvPdf.value.ready)
    return '这次检查绑定的原文 PDF 当前无法使用。请核对原文后重新检查 CSV。'
  return ''
})
const csvSourcePending = ref(false)
const csvSourceError = ref('')
const requestedSourceId = ref(null)
const requestedSourceLabel = ref('未关联来源')
const csvSourceReady = computed(
  () =>
    !csvSourcePending.value &&
    !csvSourceError.value &&
    (!csvJob.value?.source || Boolean(csvActualSource.value))
)
const csvSourceMismatch = computed(
  () =>
    requestedSourceId.value !== null &&
    Boolean(csvActualSource.value && csvActualSource.value.logical_id !== requestedSourceId.value)
)
const csvStatusVisible = computed(
  () =>
    !['validated', 'completed', 'completed_with_errors'].includes(csvJob.value?.status) ||
    ['loading', 'stale', 'offline', 'unauthorized', 'unavailable'].includes(
      csvObservation.value.state
    ) ||
    Boolean(csvObservation.value.error) ||
    Boolean(csvSourceError.value)
)

let csvPollGeneration = 0

const csvInspection = computed(() => parseCsvInspection(csvJob.value?.inspection_json))
const sampleOptions = computed(() =>
  (csvInspection.value?.preview || [])
    .map((_, index) => ({ index, location: csvInspection.value.previewLocations[index] }))
    .filter(({ location }) => location?.pdfPage)
)
const selectedSampleOption = computed(() =>
  sampleOptions.value.find(({ index }) => index === selectedSample.value)
)

const csvPreviewHeaders = computed(() => {
  const inspection = csvInspection.value
  return inspection?.headers.filter((header) => header !== inspection.pdfPageField) || []
})

const columnSamples = computed(() => {
  const index = csvColumns.value?.headers.indexOf(pdfPageColumn.value) ?? -1
  if (index < 0) return []
  return (csvColumns.value.preview || []).slice(0, 3).map((row) => ({
    line: row.line,
    value: row.values[index] ?? ''
  }))
})
const samplePdfPages = computed(() =>
  [
    ...new Set(csvInspection.value?.previewLocations.map((row) => row.pdfPage).filter(Boolean))
  ].slice(0, 3)
)
const csvMappingReady = computed(() => {
  const field = csvInspection.value?.pdfPageField
  const recorded = csvJob.value?.csv_pdf_page_column
  return (
    Boolean(field && csvInspection.value.headers.includes(field)) &&
    (!recorded || recorded === field) &&
    (requestedSourceId.value === null || pdfPageColumn.value === field)
  )
})
const canReuseLocalFile = computed(() =>
  Boolean(
    csvFile.value && csvColumns.value && checkedLocalFile.value && requestedSourceId.value !== null
  )
)
const confirmableCsvJob = computed(
  () => csvJob.value?.mode === 'skip_invalid' && csvJob.value.status === 'validated'
)
const canChangeColumn = computed(
  () =>
    csvJob.value?.mode === 'skip_invalid' && ['validated', 'failed'].includes(csvJob.value.status)
)

async function readCsvJob(id, options) {
  const job = await getImportJob(id, options)
  if (job?.id !== id || job.project !== projectId || !['skip_invalid', 'strict'].includes(job.mode))
    throw Object.assign(new Error('此 CSV 检查记录不属于当前项目。'), { status: 404 })
  return job
}

function resetCsvCheck() {
  csvPollGeneration++
  csvSuccess.value = ''
  csvError.value = ''
  csvJobTarget.value = null
  csvActualSource.value = null
  csvSourcePending.value = false
  csvSourceError.value = ''
  csvPdfRequest?.abort()
  csvPdf.value = null
  requestedSourceId.value = null
}

function editPageColumn() {
  if (!canChangeColumn.value || uploadingCsv.value) return
  if (!canReuseLocalFile.value) {
    sourceId.value = csvActualSource.value?.logical_id || ''
    clearCsvFile()
  } else {
    checkedLocalFile.value = false
  }
  resetCsvCheck()
  emit('job-change', '')
  mappingChanged.value = true
  nextTick(() => (csvFile.value ? pageColumnInput.value : csvFileButton.value)?.focus())
}

function clearCsvFile() {
  columnsRequest?.abort()
  csvFile.value = null
  csvColumns.value = null
  pdfPageColumn.value = ''
  checkedLocalFile.value = false
  readingColumns.value = false
  columnsError.value = ''
}

function startAnotherCsv() {
  if (uploadingCsv.value) return
  if (!hasLocalDraft.value) clearCsvFile()
  resetCsvCheck()
  emit('job-change', '')
  nextTick(() => csvFileButton.value?.focus())
}

function onCsvSelected(event) {
  const file = event.target.files[0]
  if (!file) return
  event.target.value = ''
  resetCsvCheck()
  uploadingCsv.value = false
  checkedLocalFile.value = false
  csvFile.value = file
  mappingChanged.value = false
  void loadCsvColumns()
}

async function loadCsvColumns() {
  if (!csvFile.value) return
  columnsRequest?.abort()
  const request = new AbortController()
  columnsRequest = request
  readingColumns.value = true
  columnsError.value = ''
  csvColumns.value = null
  pdfPageColumn.value = ''
  try {
    const result = await readCsvColumns({ projectId, file: csvFile.value, signal: request.signal })
    if (request.signal.aborted) return
    if (!Array.isArray(result?.headers) || !result.headers.length)
      throw new Error('未读取到 CSV 列名，请检查文件第一行。')
    csvColumns.value = result
    pdfPageColumn.value = result.headers.includes(result.suggested_page_column)
      ? result.suggested_page_column
      : ''
  } catch (cause) {
    if (!request.signal.aborted)
      columnsError.value = getPbMessage(cause, '暂时无法读取 CSV 表头，请重试。')
  } finally {
    if (!request.signal.aborted) readingColumns.value = false
  }
}

let csvSourceRead = null
function readCsvSource(job, generation) {
  const key = `${generation}:${job.id}:${job.source || ''}`
  if (csvSourceRead?.key === key) return csvSourceRead.promise
  const promise = performReadCsvSource(job, generation).finally(() => {
    if (csvSourceRead?.promise === promise) csvSourceRead = null
  })
  csvSourceRead = { key, promise }
  return promise
}

async function performReadCsvSource(job, generation) {
  csvSourcePending.value = true
  csvSourceError.value = ''
  csvActualSource.value = null
  try {
    const items = job.source ? (await listSources()).items || [] : []
    if (generation !== csvPollGeneration) return
    requestedSourceLabel.value =
      items.find((item) => item.logical_id === requestedSourceId.value)?.title ||
      requestedSourceId.value ||
      '未关联来源'
    csvActualSource.value = csvFixedSource(job, items)
    if (!csvActualSource.value)
      csvSourceError.value = '当前权限下未能读取此作业实际关联的来源资料。'
  } catch (cause) {
    if (generation === csvPollGeneration)
      csvSourceError.value = getPbMessage(cause, '作业来源暂时无法读取。')
  } finally {
    if (generation === csvPollGeneration) csvSourcePending.value = false
  }
}

async function readCsvPdf(id) {
  csvPdfRequest?.abort()
  csvPdf.value = null
  if (!id) return
  const controller = new AbortController()
  csvPdfRequest = controller
  const unavailable = { id, name: '文件名不可用', ready: false }
  try {
    const file = await getProjectFile(id, { signal: controller.signal })
    if (controller.signal.aborted) return
    csvPdf.value =
      file.id === id && file.project === projectId
        ? {
            id,
            name: file.original_filename || unavailable.name,
            ready: file.status === 'ready',
            record: file
          }
        : unavailable
  } catch {
    if (!controller.signal.aborted) csvPdf.value = unavailable
  }
}
watch(
  () => [csvJob.value?.id, csvJob.value?.project_file],
  ([, id]) => readCsvPdf(id)
)

watch(
  () => [csvJob.value?.id, csvJob.value?.status, csvJob.value?.source],
  async ([id, status], previous) => {
    if (!id || (id === previous?.[0] && status === previous?.[1])) return
    const generation = csvPollGeneration
    const job = csvJob.value
    csvError.value = csvFatalMessage(job)
    csvSuccess.value = ['validated', 'completed', 'completed_with_errors'].includes(status)
      ? csvImportResultText(job)
      : ''
    if (csvActualSource.value?.id !== (job.source || '')) await readCsvSource(job, generation)
    if (generation !== csvPollGeneration) return
    if (['completed', 'completed_with_errors'].includes(status)) {
      if (checkedLocalFile.value && requestedSourceId.value !== null) clearCsvFile()
      props.clearSelection()
      try {
        await Promise.all([loadPages(), loadPageStats(), loadQualitySummary(), loadLedger()])
      } catch (error) {
        if (generation === csvPollGeneration)
          csvError.value = getPbMessage(error, '导入已完成，项目列表暂时未更新，请刷新项目。')
      }
    } else if (['validated', 'failed'].includes(status)) {
      try {
        await loadLedger()
      } catch (error) {
        if (generation === csvPollGeneration)
          csvError.value = getPbMessage(error, '作业状态已更新，批次台账暂时未更新，请刷新项目。')
      }
    }
  }
)

function observeCsvJob(job) {
  csvJobTarget.value = job
  seedCsvJob(job)
}

async function uploadCsv() {
  if (!csvFile.value || !pdfPageColumn.value || uploadingCsv.value) return
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  csvJobTarget.value = null
  const generation = ++csvPollGeneration
  requestedSourceId.value = sourceId.value
  try {
    const job = await createCsvInspection({
      projectId,
      file: csvFile.value,
      sourceId: sourceId.value,
      pdfPageColumn: pdfPageColumn.value
    })
    if (generation !== csvPollGeneration) return
    checkedLocalFile.value = true
    observeCsvJob(job)
    emit('job-change', job.id)
    await readCsvSource(job, generation)
    if (generation !== csvPollGeneration) return
  } catch (e) {
    if (generation === csvPollGeneration)
      csvError.value = csvJob.value?.id
        ? getPbMessage(e, '读取进度失败，已保留原作业，请原地刷新重试。')
        : getUploadErrorMessage(e, 'csv')
  } finally {
    if (generation === csvPollGeneration) uploadingCsv.value = false
  }
}

async function confirmCsvImport() {
  if (
    !confirmableCsvJob.value ||
    csvObservation.value.state !== 'live' ||
    uploadingCsv.value ||
    !csvSourceReady.value ||
    !csvMappingReady.value ||
    !csvPdfReady.value
  )
    return
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  const generation = ++csvPollGeneration
  try {
    const job = await commitCsvImport(csvJob.value.id)
    if (generation !== csvPollGeneration) return
    observeCsvJob(job)
    if (csvActualSource.value?.id !== (job.source || '')) await readCsvSource(job, generation)
  } catch (e) {
    if (generation === csvPollGeneration)
      csvError.value = getPbMessage(e, '确认导入失败，请稍后重试。')
  } finally {
    if (generation === csvPollGeneration) uploadingCsv.value = false
  }
}

async function refreshCsvJob() {
  if (!csvJobTarget.value?.id || uploadingCsv.value) return
  const generation = csvPollGeneration
  csvError.value = ''
  await retryCsvJob()
  if (generation === csvPollGeneration && csvJob.value)
    await Promise.all([
      readCsvSource(csvJob.value, generation),
      readCsvPdf(csvJob.value.project_file)
    ])
}
watch(
  () => props.jobLink,
  (id) => {
    if ((id || '') === (csvJobTarget.value?.id || '')) return
    resetCsvCheck()
    uploadingCsv.value = false
    if (id && !invalidCsvLink.value) csvJobTarget.value = { id }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  csvPollGeneration += 1
  columnsRequest?.abort()
  csvPdfRequest?.abort()
})
defineExpose({
  hasPendingWork: computed(() => hasLocalDraft.value || (uploadingCsv.value && !csvJobTarget.value))
})
</script>

<style scoped>
.csv-selected-file {
  overflow-wrap: anywhere;
}
.csv-mapping {
  padding-block: var(--space-3);
  max-width: 32rem;
}
.csv-mapping .form-group {
  margin-bottom: var(--space-2);
}
.csv-mapping-samples {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
  margin: var(--space-2) 0 0;
}
.csv-mapping-samples li {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  max-width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.csv-mapping-samples li > span:first-child {
  white-space: nowrap;
  color: var(--ink-muted);
}
.csv-inspection-title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}
.csv-inspection-source {
  line-height: 1.7;
}
.csv-inspection-counts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--primary-line);
}
.csv-inspection-counts dt {
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.csv-inspection-counts dd {
  margin: var(--space-1) 0 0;
  color: var(--ink);
  font-size: var(--text-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.csv-inspection-counts__warning dd {
  color: var(--warn-ink);
}
.csv-inspection-warning {
  margin-top: var(--space-3);
  color: var(--warn-ink);
  font-size: var(--text-sm);
  line-height: 1.7;
}
.csv-inspection-action {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-4) 0;
}
.csv-preview-disclosure {
  border-top: 1px solid var(--primary-line);
  padding-top: var(--space-2);
}
.csv-preview-disclosure :deep(th) {
  text-transform: none;
}
</style>
