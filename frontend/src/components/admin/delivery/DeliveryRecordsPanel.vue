<template>
  <section class="card mb-6">
    <div class="section-heading">
      <div>
        <h2>交付记录</h2>
        <p v-if="metrics">
          共 {{ metrics.package_count }} 包
          <template v-if="Number.isFinite(metrics.awaiting_receipt_packages)">
            · 待回执 {{ metrics.awaiting_receipt_packages }} 包
          </template>
          · 已停用 {{ metrics.withdrawn_packages }} 包
        </p>
      </div>
      <button class="btn btn-secondary btn-sm" :disabled="busy || loading" @click="load">
        刷新
      </button>
    </div>
    <p v-if="batchReportContext" class="text-sm text-muted">显示此项目的全部交付包。</p>
    <p v-if="loading" role="status">正在加载交付记录…</p>
    <div v-else-if="loadError" class="text-muted">
      交付记录暂时无法读取，请用上方「重新加载」重试。
    </div>
    <div v-else-if="!items.length" class="empty-state">
      <div class="empty-state-text">还没有交付包</div>
      <p>检查通过并经人工确认后，首个包会显示在这里。</p>
      <button class="btn btn-secondary mt-3" @click="navigate({ view: 'prepare' })">
        准备首个交付包
      </button>
    </div>
    <AppPagination
      :page="listPage"
      :total-pages="listPages"
      :busy="busy || loading"
      label="交付记录分页"
      @change="changePage"
    />
    <ul class="delivery-records">
      <li v-for="item in items" :key="item.id">
        <div>
          <strong>{{ item.recipient }} · 第 {{ item.version }} 版</strong>
          <p>{{ purposeLabel(item.purpose) }} · 正文 {{ item.reconciliation.payload_count }} 条</p>
          <span
            class="text-sm"
            :class="
              item.withdrawn || item.rights_blocked || item.workflow_state === 'pending_resolution'
                ? 'text-danger'
                : 'text-muted'
            "
          >
            {{ receiptLabel(item) }}
            <template v-if="!item.withdrawn && item.rights_blocked">
              · 当前用途许可阻断下载</template
            >
          </span>
        </div>
        <button class="btn btn-secondary" :disabled="busy" @click="openDelivery(item)">
          查看交付详情
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup>
import AppPagination from '@/components/AppPagination.vue'
import { USAGE_PURPOSE_LABELS } from '@/constants/sourceRegistry'
import { receiptLabel } from '@/lib/deliveryPresentation'
const purposeLabel = (value) => USAGE_PURPOSE_LABELS[value] || value
defineProps({
  metrics: Object,
  batchReportContext: Object,
  loading: Boolean,
  busy: Boolean,
  loadError: String,
  items: Array,
  listPage: Number,
  listPages: Number
})
const emit = defineEmits(['retry', 'prepare', 'page', 'open'])
const load = (...args) => emit('retry', ...args)
const navigate = (...args) => emit('prepare', ...args)
const changePage = (...args) => emit('page', ...args)
const openDelivery = (...args) => emit('open', ...args)
</script>
