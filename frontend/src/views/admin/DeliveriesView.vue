<template>
  <main class="container page workspace-page delivery-workspace">
    <WorkspaceLeaveGuard
      :dirty="dirty"
      :preserve-query="false"
      :bypass="accessLost || unavailable"
    />
    <ProjectWorkspaceNav :project-id="projectId" active="delivery" />
    <header class="page-heading">
      <div>
        <div class="page-eyebrow">项目交付</div>
        <h1>
          {{
            view === 'prepare'
              ? '准备交付包'
              : view === 'detail'
                ? '交付详情'
                : view === 'impacts'
                  ? '来源变更影响'
                  : '交付包与回执'
          }}
        </h1>
        <p>核对交付范围，保留每次交付与后续处置的凭据。</p>
      </div>
      <AppButton
        v-if="!accessLost && !projectUnavailable && view === 'records'"
        variant="primary"
        :disabled="busy"
        @click="navigate({ view: 'prepare' })"
      >
        准备新交付
      </AppButton>
      <AppButton v-else :disabled="busy" @click="navigate({ view: 'records' })">
        返回交付记录
      </AppButton>
    </header>
    <BatchReportReturn :project-id="projectId" />
    <nav class="delivery-tabs" aria-label="交付工作">
      <button
        type="button"
        :disabled="busy"
        :aria-current="['records', 'detail'].includes(view) ? 'page' : undefined"
        @click="navigate({ view: 'records' })"
      >
        交付记录
      </button>
      <button
        type="button"
        :disabled="busy"
        :aria-current="view === 'prepare' ? 'page' : undefined"
        @click="navigate({ view: 'prepare' })"
      >
        准备交付
      </button>
      <button
        type="button"
        :disabled="busy"
        :aria-current="view === 'impacts' ? 'page' : undefined"
        @click="navigate({ view: 'impacts' })"
      >
        来源变更影响
      </button>
    </nav>
    <div
      v-if="loadError && (view !== 'records' || accessLost || projectUnavailable)"
      class="alert alert-error"
      role="alert"
    >
      {{ loadError }}
      <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="load">
        重新加载
      </button>
    </div>
    <RouterLink v-if="projectUnavailable" to="/admin" class="btn btn-secondary mb-4">
      返回项目列表
    </RouterLink>
    <div v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</div>
    <div v-if="success" class="alert alert-success" role="status">{{ success }}</div>

    <section
      v-if="!accessLost && !projectUnavailable && view === 'prepare' && !unavailable"
      class="card mb-6"
    >
      <div class="delivery-steps" aria-label="交付准备步骤">
        <span :aria-current="!preview ? 'step' : undefined">1 选择清单</span
        ><span :aria-current="preview && !preview.can_generate ? 'step' : undefined"
          >2 检查范围</span
        ><span :aria-current="preview?.can_generate ? 'step' : undefined">3 人工确认与生成</span>
      </div>
      <h2>{{ preview ? '核对本次交付范围' : '选择本次交付的编选批次' }}</h2>
      <p class="text-muted">
        使用已确认的编选交接清单。范围外与待处理条目只声明标识和理由，默认不携带正文。
      </p>
      <p v-if="batchReportContext" class="text-sm text-muted">
        下方列出本项目的编选批次，请核对用途与接收方。
      </p>
      <RouterLink :to="adoptionTarget" class="btn btn-quiet btn-sm"
        >前往用途编选，确认交付范围 →</RouterLink
      >
      <p v-if="!nativeDeliveryEnabled" class="text-muted">
        编选直接出包暂未开放，请使用已核查的交接清单。
      </p>
      <div v-if="nativeDeliveryEnabled && !preview" class="form-group mt-3">
        <label for="delivery-adoption-batch" class="form-label">编选批次</label>
        <select
          id="delivery-adoption-batch"
          :value="nativeBatch?.id || ''"
          class="form-control"
          :disabled="busy || legacyMode"
          @change="chooseAdoption($event.target.value)"
        >
          <option value="">选择已确认的编选批次</option>
          <option
            v-if="nativeBatch && !adoptionChoices.some((item) => item.id === nativeBatch.id)"
            :value="nativeBatch.id"
          >
            {{ nativeBatch.recipient }} · {{ purposeLabel(nativeBatch.purpose) }}
          </option>
          <option
            v-for="batch in adoptionChoices"
            :key="batch.id"
            :value="batch.id"
            :disabled="batch.status !== 'confirmed'"
          >
            {{ batch.recipient }} · {{ purposeLabel(batch.purpose) }} ·
            {{ batch.status === 'confirmed' ? '已确认' : '待确认' }}
          </option>
        </select>
      </div>
      <AppPagination
        v-if="nativeDeliveryEnabled && !preview"
        :page="adoptionPage"
        :total-pages="adoptionPages"
        :busy="busy || loading"
        label="选择编选批次分页"
        @change="loadAdoptions"
      />
      <p v-if="nativeBatch">
        交给 {{ nativeBatch.recipient }} ·
        {{ purposeLabel(nativeBatch.purpose) }}；将重新核查完整批次与确认范围。
      </p>
      <div v-if="sourceFixTarget || adoptionFixTarget" class="delivery-blocker-actions mt-3">
        <RouterLink
          v-if="sourceFixTarget"
          :to="sourceFixTarget"
          target="_blank"
          rel="noopener"
          class="btn btn-secondary btn-sm"
        >
          核对来源许可 · {{ purposeLabel(preflightProblem.purpose) }}
        </RouterLink>
        <RouterLink
          v-if="adoptionFixTarget"
          :to="adoptionFixTarget"
          target="_blank"
          rel="noopener"
          class="btn btn-secondary btn-sm"
        >
          查看本批编选例外
        </RouterLink>
        <p class="text-sm text-muted">
          处理页面在新标签页打开。处理后切回这里重新检查，接收方和批次范围会保留。
        </p>
      </div>
      <AppDisclosure v-if="nativeDeliveryEnabled && !preview" class="mt-3" label="兼容旧交接清单">
        <label
          ><input v-model="legacyMode" type="checkbox" :disabled="busy" /> 使用人工核查过的旧 JSON
          清单</label
        >
      </AppDisclosure>
      <form v-if="!preview" class="settings-form mt-3" @submit.prevent="preflight">
        <div v-if="legacyMode" class="form-group">
          <span class="form-label">批次交接清单</span
          ><input
            ref="handoffInput"
            type="file"
            aria-label="批次交接清单"
            accept=".json,application/json"
            class="file-input-hidden"
            :disabled="busy"
            @change="readHandoff"
          />
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="busy"
            @click="handoffInput.click()"
          >
            选择交接清单 JSON
          </button>
          <p v-if="handoffFilename" class="text-sm mt-2 delivery-filename">
            {{ handoffFilename }}
          </p>
        </div>
        <label class="form-group"
          ><span class="form-label">本次人工核查者</span
          ><input
            v-model.trim="reviewer"
            class="form-control"
            required
            maxlength="200"
            :disabled="busy"
            @input="invalidatePreview"
        /></label>
        <p v-if="handoff" class="text-sm">
          交给 {{ handoff.recipient }} · {{ purposeLabel(handoff.purpose) }}
        </p>
        <AppDisclosure
          v-if="!legacyMode"
          label="这是重发版本（首次交付无需填写）"
          :default-open="Boolean(previous)"
        >
          <label class="form-group"
            ><span class="form-label">前一版本包标识（首次留空）</span
            ><input v-model.trim="previous" class="form-control" maxlength="200" :disabled="busy"
          /></label>
        </AppDisclosure>
        <label v-if="!legacyMode && previous" class="form-group"
          ><span class="form-label">重发变更说明</span
          ><input
            v-model.trim="changeReason"
            class="form-control"
            required
            maxlength="500"
            :disabled="busy"
        /></label>
        <p v-if="legacyMode ? !handoff : !nativeBatch" class="text-sm text-muted">
          {{
            legacyMode
              ? '先选择交接清单，再填写核查者并检查范围。'
              : '先选择已确认的编选批次，再填写核查者并检查范围。'
          }}
        </p>
        <AppButton
          type="submit"
          variant="primary"
          :loading="busy"
          loading-label="正在检查…"
          :disabled="legacyMode ? !handoff : !nativeBatch"
        >
          检查本批交付范围
        </AppButton>
      </form>
      <div v-if="preview" class="mt-4" role="status">
        <p v-if="preview.selection_project_counts" class="text-muted">
          编选项目范围共 {{ preview.selection_project_counts.total }} 条，采用
          {{ preview.selection_project_counts.selected }} 条。 本包只覆盖所选入站批次的
          {{ preview.reconciliation.source_total }} 条，下面按本包范围对账。
        </p>
        <label class="form-group delivery-reviewer"
          ><span class="form-label">本次人工核查者</span
          ><input
            v-model.trim="reviewer"
            class="form-control"
            required
            maxlength="200"
            :disabled="busy"
            @input="invalidatePreview"
        /></label>
        <h3>
          {{
            preview.reconciliation.status === 'consistent'
              ? '数量一致，等待人工决定'
              : '检查不通过，已阻止出包'
          }}
        </h3>
        <dl class="delivery-counts">
          <div>
            <dt>采用</dt>
            <dd>{{ preview.reconciliation.counts.adopted }}</dd>
          </div>
          <div>
            <dt>范围外</dt>
            <dd>{{ preview.reconciliation.counts.excluded }}</dd>
          </div>
          <div>
            <dt>待处理</dt>
            <dd>{{ preview.reconciliation.counts.pending }}</dd>
          </div>
          <div>
            <dt>来源覆盖</dt>
            <dd>
              {{ preview.reconciliation.source_covered }} /
              {{ preview.reconciliation.source_total }}
            </dd>
          </div>
        </dl>
        <p>范围外及待处理占比 {{ percent(preview.reconciliation.outside_ratio) }}</p>
        <ul v-if="preview.reconciliation.problems.length">
          <li v-for="problem in preview.reconciliation.problems" :key="problem">{{ problem }}</li>
        </ul>
        <p class="text-sm text-muted">对账一致不代表可发布。仍须核查许可、交付范围及接收方要求。</p>
        <p v-if="!preview.can_generate" class="alert alert-warning" role="alert">
          本次检查未满足出包条件。请按上方原因核对编选范围与来源许可，处理后重新检查。
        </p>
        <div v-if="preview.can_generate" class="delivery-confirmation">
          <label class="flex gap-2 items-center"
            ><input
              v-model="confirmed"
              type="checkbox"
              :disabled="busy"
            />我已核查范围并决定生成本次交付包</label
          ><AppButton
            variant="primary"
            class="mt-3"
            :loading="busy"
            loading-label="正在生成…"
            :disabled="!confirmed"
            @click="generate"
          >
            生成交付包
          </AppButton>
        </div>
        <AppButton
          v-if="adoptionFixTarget || !preview.can_generate"
          type="button"
          class="mt-3"
          :loading="busy"
          loading-label="正在重新检查…"
          @click="preflight"
        >
          重新检查本批交付范围
        </AppButton>
        <button
          type="button"
          class="btn btn-quiet mt-3"
          :disabled="busy"
          @click="invalidatePreview"
        >
          返回更换清单或核查者
        </button>
      </div>
      <details class="mt-4">
        <summary class="text-sm text-muted">当前交付方式与范围</summary>
        <p class="text-sm text-muted">
          当前提供文件往返与人工回执。采用已确认编选批次，服务端核对范围与来源。消费方实测与双方签字仍须完成；对账一致不代表可发布。
        </p>
      </details>
    </section>

    <DeliveryRecordsPanel
      v-if="!accessLost && !projectUnavailable && view === 'records'"
      :metrics="metrics"
      :batch-report-context="batchReportContext"
      :loading="loading"
      :busy="busy"
      :load-error="loadError"
      :items="items"
      :list-page="listPage"
      :list-pages="listPages"
      @retry="load"
      @prepare="navigate({ view: 'prepare' })"
      @page="changePage"
      @open="openDelivery"
    />

    <section v-if="!accessLost && !projectUnavailable && view === 'detail'" class="mb-6">
      <nav class="delivery-tabs" aria-label="交付详情">
        <button
          :aria-current="detailTab === 'summary' ? 'page' : undefined"
          :disabled="busy"
          @click="navigate({ package: selectedPackageId, tab: 'summary', page: 1 })"
        >
          范围与凭据</button
        ><button
          :aria-current="detailTab === 'events' ? 'page' : undefined"
          :disabled="busy"
          @click="navigate({ package: selectedPackageId, tab: 'events', page: 1 })"
        >
          回执与处置
        </button>
      </nav>
      <article v-for="item in visibleDeliveries" :key="item.id" class="card">
        <div class="section-heading">
          <div>
            <h2>{{ item.recipient }} · 第 {{ item.version }} 版</h2>
            <p>
              {{ purposeLabel(item.purpose) }} ·
              <strong :class="{ 'text-danger': item.workflow_state === 'pending_resolution' }">
                {{ receiptLabel(item) }}
              </strong>
            </p>
          </div>
          <AppButton
            variant="primary"
            :loading="operationKind === 'download'"
            loading-label="正在获取交付包…"
            :disabled="busy || item.withdrawn || item.rights_blocked"
            @click="download(item)"
          >
            下载交付包
          </AppButton>
        </div>
        <p
          v-if="
            batchReportContext && item.import_job && item.import_job !== batchReportContext.batchId
          "
          class="text-sm text-muted"
        >
          当前交付包属于另一个导入批次。
        </p>
        <p v-if="item.withdrawn" class="alert alert-warning" role="alert">
          已停用 ·
          {{ item.notice_state === 'manual_notice_recorded' ? '已登记人工通知' : '待通知消费方' }}
        </p>
        <p v-else-if="item.rights_blocked" class="alert alert-warning" role="alert">
          当前来源用途许可已阻断下载。请核对来源变更并按实际情况追加处置记录。
        </p>
        <p v-if="item.pending_actions.length" class="alert alert-warning" role="alert">
          上游待办 {{ item.pending_actions.length }} 项，处置完成后才能重发。
        </p>
        <p
          v-if="item.awaiting_receipt === true && Number.isFinite(item.waiting_seconds)"
          class="text-muted"
        >
          等待回执
          {{
            item.waiting_seconds < 3600
              ? '不足 1 小时'
              : `${Math.floor(item.waiting_seconds / 3600)} 小时`
          }}。接收方实际核对后，再登记导入结果；下载交付包不会改变回执状态。
        </p>
        <h3 class="text-sm text-muted mt-4">生成时范围</h3>
        <dl class="delivery-counts delivery-saved-scope">
          <div>
            <dt>正文</dt>
            <dd>{{ item.reconciliation.payload_count }}</dd>
          </div>
          <div>
            <dt>采用</dt>
            <dd>{{ item.reconciliation.counts.adopted }}</dd>
          </div>
          <div>
            <dt>范围外</dt>
            <dd>{{ item.reconciliation.counts.excluded }}</dd>
          </div>
          <div>
            <dt>包内待定</dt>
            <dd>{{ item.reconciliation.counts.pending }}</dd>
          </div>
        </dl>
        <button class="btn btn-secondary mt-3" :disabled="busy" @click="selectEvent(item)">
          登记回执或处置
        </button>
        <AppDisclosure class="mt-4" label="包标识与来源凭据">
          <p class="text-sm">
            包标识：{{ item.package_id }}<br />来源：{{ item.source_ref }} · 批次：{{
              item.import_job
            }}
          </p>
          <p v-if="item.legacy_cross_job_previous" class="alert alert-warning" role="alert">
            此历史版本沿用旧的跨导入批次关联；历史凭据保持原样。
          </p>
          <p v-if="item.previous" class="text-sm">
            前包：{{ item.previous }} · 变更：{{ item.change_reason }}
          </p>
          <p class="text-sm delivery-digest">SHA-256：{{ item.sha256 }}</p>
        </AppDisclosure>
        <section v-if="detailTab === 'events'" class="delivery-history mt-4">
          <AppPagination
            v-if="eventPages > 1"
            :page="eventsPage"
            :total-pages="eventPages"
            :busy="busy || loading"
            label="交付事件分页"
            @change="changeEventsPage"
          />
          <h3>回执与处置记录</h3>
          <p v-if="!item.events.length" class="text-muted">尚无回执或处置记录。</p>
          <article v-for="event in item.events" :key="event.id">
            <strong>{{ eventLabel(event.kind) }} · {{ event.created }}</strong>
            <p>{{ event.payload.reason }} · 核查者 {{ event.payload.reviewer }}</p>
            <p v-if="event.payload.target || event.payload.responsible">
              <template v-if="event.payload.target">
                退回环节 {{ deliveryStageLabel(event.payload.target) }}
              </template>
              <template v-if="event.payload.responsible">
                {{ event.payload.target ? ' · ' : '' }}责任人 {{ event.payload.responsible }}
              </template>
            </p>
            <p v-if="event.kind === 'receipt'">{{ receiptEventNote(event) }}</p>
            <p v-if="event.payload.evidence">凭据：{{ event.payload.evidence }}</p>
            <details>
              <summary class="text-sm text-muted">记录标识</summary>
              <p class="text-sm">事件 {{ event.id }} · 操作者 {{ event.actor }}</p>
            </details>
          </article>
        </section>
      </article>
      <p v-if="!visibleDeliveries.length" class="card text-muted">
        这份交付记录暂时不可用，请返回列表重新选择。
      </p>
    </section>

    <DeliveryEventEditor
      v-if="!accessLost && !projectUnavailable && view === 'detail' && selected"
      ref="eventEditor"
      :selected="selected"
      :busy="busy"
      :event-labels="eventLabels"
      :return-targets="returnTargets"
      :stage-label="deliveryStageLabel"
      v-model:kind="eventForm.kind"
      v-model:status="eventForm.status"
      v-model:affected="eventForm.affected"
      v-model:reason="eventForm.reason"
      v-model:reviewer="eventForm.reviewer"
      v-model:responsible="eventForm.responsible"
      v-model:target="eventForm.target"
      v-model:evidence="eventForm.evidence"
      v-model:resolves="eventForm.resolves"
      @save="saveEvent"
      @cancel="navigate({ ...route.query, editor: route.query.editor ? undefined : 'closed' })"
    />

    <section v-if="!accessLost && !projectUnavailable && view === 'impacts'" class="card">
      <h2>来源权利变更后的影响</h2>
      <p>查询受影响的历史包，再逐包追加停用凭据、升级记录和消费方通知。历史包保持原样。</p>
      <form class="settings-form" @submit.prevent="findImpacts">
        <ProjectSourcePicker
          v-model="sourceRef"
          label="需要核对的来源"
          empty-label="选择要查询的来源"
          empty-hint="当前没有可查询的来源，可以填写已登记的来源标识。"
          @access-error="pageScope.invalidate($event)"
          :disabled="busy"
        /><button class="btn btn-secondary mt-3" :disabled="busy || !sourceRef">
          查询受影响交付包
        </button>
      </form>
      <div v-if="impacts" class="mt-3" role="status">
        <p>找到 {{ impacts.length }} 包</p>
        <ul class="delivery-records">
          <li v-for="item in impacts" :key="item.id">
            <div>
              <strong>{{ item.recipient }} · 第 {{ item.version }} 版</strong>
              <p>
                {{ item.reconciliation.payload_count }} 条 ·
                {{ item.rights_blocked ? '当前权利已阻断下载' : '当前用途许可允许' }} ·
                {{ item.withdrawn ? '已追加停用' : '尚未追加停用' }}
              </p>
            </div>
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="busy"
              @click="openImpact(item)"
            >
              查看与处置
            </button>
          </li>
        </ul>
      </div>
    </section>
  </main>
</template>

<script setup>
import { onBeforeUnmount } from 'vue'
import { createDeliveryWorkspace } from '@/composables/createDeliveryWorkspace'
import DeliveryRecordsPanel from '@/components/admin/delivery/DeliveryRecordsPanel.vue'
import DeliveryEventEditor from '@/components/admin/delivery/DeliveryEventEditor.vue'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import WorkspaceLeaveGuard from '@/components/admin/project/WorkspaceLeaveGuard.vue'
import AppButton from '@/components/AppButton.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import AppPagination from '@/components/AppPagination.vue'
import { getAdoptionBatch, listAdoptionBatches } from '@/services/adoptionService'
import ProjectWorkspaceNav from '@/components/admin/project/ProjectWorkspaceNav.vue'
import ProjectSourcePicker from '@/components/admin/project/ProjectSourcePicker.vue'
import BatchReportReturn from '@/components/admin/project/BatchReportReturn.vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  appendDeliveryEvent,
  checkDelivery,
  createDelivery,
  downloadDelivery,
  findDeliveryImpacts,
  listDeliveries,
  getDelivery,
  listDeliveryEvents,
  checkAdoptionDelivery,
  createAdoptionDelivery
} from '@/services/deliveryService'
import { receiptLabel, receiptEventNote } from '@/lib/deliveryPresentation'

const route = useRoute()
const router = useRouter()
const workspace = createDeliveryWorkspace({
  route,
  router,
  useProtectedPageScope,
  onBeforeUnmount,
  services: {
    getAdoptionBatch,
    listAdoptionBatches,
    appendDeliveryEvent,
    checkDelivery,
    createDelivery,
    downloadDelivery,
    findDeliveryImpacts,
    listDeliveries,
    getDelivery,
    listDeliveryEvents,
    checkAdoptionDelivery,
    createAdoptionDelivery
  }
})
const {
  dirty,
  accessLost,
  unavailable,
  projectId,
  view,
  projectUnavailable,
  busy,
  operationKind,
  navigate,
  loadError,
  loading,
  load,
  operationError,
  success,
  preview,
  batchReportContext,
  adoptionTarget,
  nativeDeliveryEnabled,
  nativeBatch,
  legacyMode,
  chooseAdoption,
  adoptionChoices,
  purposeLabel,
  adoptionPage,
  adoptionPages,
  loadAdoptions,
  sourceFixTarget,
  adoptionFixTarget,
  preflightProblem,
  preflight,
  readHandoff,
  handoffInput,
  handoffFilename,
  reviewer,
  invalidatePreview,
  handoff,
  previous,
  changeReason,
  percent,
  confirmed,
  generate,
  metrics,
  items,
  listPage,
  listPages,
  changePage,
  openDelivery,
  detailTab,
  selectedPackageId,
  visibleDeliveries,
  download,
  selectEvent,
  eventPages,
  eventsPage,
  changeEventsPage,
  eventLabel,
  deliveryStageLabel,
  selected,
  eventLabels,
  returnTargets,
  eventForm,
  saveEvent,
  findImpacts,
  sourceRef,
  pageScope,
  impacts,
  openImpact,
  eventEditor
} = workspace
</script>

<style src="../../styles/delivery-workspace.css"></style>
