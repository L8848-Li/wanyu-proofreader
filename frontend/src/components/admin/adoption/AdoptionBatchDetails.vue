<template>
  <section class="card mb-4">
    <header class="adoption-batch-head">
      <h2>{{ current.recipient }}</h2>
      <span class="badge">{{ batchStatusLabel(current.status) }}</span>
    </header>
    <p>{{ purposeLabel(current.purpose) }} · 规则：{{ ruleSummary(current.rule) }}</p>
    <p v-if="current.note">{{ current.note }}</p>

    <template v-if="detailTab === 'overview'">
      <p class="adoption-next-step">
        <strong>下一步</strong>
        {{ nextStepHint }}
      </p>
      <div class="adoption-counts">
        <div class="adoption-count">
          <span class="adoption-count-value">{{ counts.total }}</span><span>项目条目</span>
        </div>
        <div class="adoption-count">
          <span class="adoption-count-value">{{ counts.selected }}</span><span>进入本批</span>
        </div>
        <div class="adoption-count">
          <span class="adoption-count-value">{{ counts.excluded }}</span><span>已定不进入</span>
        </div>
        <div class="adoption-count">
          <span class="adoption-count-value">{{ counts.pending }}</span><span
            title="待处理（规则判不了）"
            >待处理</span
          >
        </div>
      </div>
      <p v-if="current.status !== 'draft'" class="text-sm text-muted">
        项目条目是统计时的项目总数。进入本批只计实际选入的条目，所选导入范围之外的条目计入「已定不进入」。
      </p>
      <p v-if="!consistent" class="alert alert-warning" role="alert">
        三个数之和对不上总数，界面不照抄：请重新预览；若仍不一致，说明数据被绕过接口改过。
      </p>
      <div v-else-if="counts.pending > 0" class="alert alert-warning" role="alert">
        <p>
          还有
          {{ counts.pending }} 条待处理。确认当前范围后，本批资料仍会明确标记为尚未完整处理。
        </p>
        <details class="mt-2">
          <summary>查看清单标记</summary>
          <p>确认后导出的清单会写明 <code>complete: false</code>，不会把部分结果冒充全量。</p>
        </details>
      </div>
      <p v-if="batchEvents.stale" class="alert alert-warning" role="alert">
        这一批确认之后，来源的用途权利变过。采用范围可能需要重评——重评只会追加一条记录，
        不会改写确认时的数字。
      </p>

      <details v-if="current.reasons.length" class="mt-3">
        <summary>查看范围外与待定理由</summary>
        <ul class="adoption-reasons">
          <li v-for="item in current.reasons" :key="item.code">
            {{ reasonLabel(item.code) }} · {{ item.count }} 条
          </li>
        </ul>
      </details>

      <div class="adoption-actions">
        <RouterLink
          v-if="current.status === 'confirmed' && nativeDeliveryEnabled"
          class="btn btn-primary"
          :to="{
            path: `/admin/projects/${projectId}/deliveries`,
            query: { view: 'prepare', adoption: current.id, ...reportQuery }
          }"
          >准备交付包</RouterLink
        >
        <button
          v-if="current.status === 'confirmed'"
          class="btn"
          :class="nativeDeliveryEnabled ? 'btn-secondary' : 'btn-primary'"
          :disabled="busy || loading"
          @click="exportManifest('select')"
        >
          导出本批清单
        </button>
        <button
          v-else-if="counts.pending > 0 && current.status === 'previewed'"
          class="btn btn-primary"
          :disabled="busy || loading"
          @click="changeTab('exceptions')"
        >
          处理 {{ counts.pending }} 条待定条目
        </button>
        <button
          v-else-if="current.status === 'previewed'"
          class="btn btn-primary"
          :disabled="busy || loading || !consistent"
          @click="openConfirmation"
        >
          确认本批采用范围
        </button>
        <button v-else class="btn btn-primary" :disabled="busy || loading" @click="preview">
          预览并核对数量
        </button>
        <details class="adoption-more">
          <summary>更多操作</summary>
          <div class="adoption-actions">
            <button
              class="btn btn-secondary"
              :disabled="busy || loading || current.status === 'confirmed'"
              @click="preview"
            >
              重新预览数量
            </button>
            <button
              v-if="current.status !== 'confirmed' && counts.pending > 0"
              class="btn btn-secondary"
              :disabled="busy || loading || !consistent || current.status !== 'previewed'"
              @click="openConfirmation"
            >
              确认当前范围（保留待处理记录）
            </button>
            <button class="btn btn-secondary" :disabled="busy || loading" @click="reevaluate">
              按当前数据重新评估
            </button>
            <button
              v-if="current.status !== 'confirmed'"
              class="btn btn-secondary"
              :disabled="busy || loading"
              @click="exportManifest('select')"
            >
              导出本批清单
            </button>
            <button
              class="btn btn-quiet"
              :disabled="busy || loading"
              @click="exportManifest('all')"
            >
              导出全部条目（需平台管理员）
            </button>
            <button
              v-if="current.status !== 'confirmed'"
              class="btn btn-quiet"
              :disabled="busy || loading"
              @click="openRemoval"
            >
              删除这一批
            </button>
          </div>
        </details>
      </div>
      <p class="adoption-hint">导出默认只含进入本批的条目；清单另附未采用与待处理的数量。</p>
    </template>
    <template v-if="detailTab === 'history'">
      <AppPagination
        :page="batchEvents.page || 1"
        :total-pages="batchEvents.totalPages || 1"
        :busy="loading || busy"
        label="编选事件分页"
        @change="changePage"
      />
      <p v-if="!batchEvents.events.length" class="text-muted">这一批还没有重评或权利变更记录。</p>
      <details v-if="batchEvents.events.length" class="mt-3" open>
        <summary>这一批的事件（{{ batchEvents.events.length }}）</summary>
        <ul class="adoption-reasons">
          <li v-for="item in batchEvents.events" :key="item.id">
            {{ eventKindLabel(item.kind) }} · {{ item.created }}
            <span v-if="item.affected"> · 涉及 {{ item.affected }} 条</span>
            <div>{{ item.note }}</div>
            <div v-if="item.stored" class="adoption-hint">
              确认时 {{ item.stored.selected }}/{{ item.stored.total }} → 重评时
              {{ item.current.selected }}/{{ item.current.total }}
            </div>
          </li>
        </ul>
      </details>
    </template>
  </section>
</template>

<script setup>
import { RouterLink } from 'vue-router'
import AppPagination from '@/components/AppPagination.vue'
import {
  batchStatusLabel,
  purposeLabel,
  ruleSummary,
  reasonLabel,
  eventKindLabel
} from '@/lib/adoption'
defineProps({
  current: Object,
  detailTab: String,
  nextStepHint: String,
  counts: Object,
  consistent: Boolean,
  batchEvents: Object,
  nativeDeliveryEnabled: Boolean,
  projectId: String,
  reportQuery: Object,
  busy: Boolean,
  loading: Boolean
})
const emit = defineEmits(['export', 'tab', 'confirm', 'preview', 'reevaluate', 'remove', 'page'])
const exportManifest = (...args) => emit('export', ...args)
const changeTab = (...args) => emit('tab', ...args)
const openConfirmation = (...args) => emit('confirm', ...args)
const preview = (...args) => emit('preview', ...args)
const reevaluate = (...args) => emit('reevaluate', ...args)
const openRemoval = (...args) => emit('remove', ...args)
const changePage = (...args) => emit('page', ...args)
</script>
