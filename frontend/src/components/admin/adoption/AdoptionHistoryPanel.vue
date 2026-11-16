<template>
  <section class="card mb-4" :aria-busy="loading">
    <h2>编选批次</h2>
    <AppStatusPanel v-if="loading" state="pending" message="正在加载历史批次…" />
    <div v-if="loadError" class="alert alert-error" role="alert">
      {{ loadError }}
      <button class="btn btn-secondary btn-sm" :disabled="loading" @click="load()">重试</button>
    </div>
    <AppStatusPanel
      v-if="!loading && !loadError && !batches.length"
      state="empty"
      reason="none"
      message="这个项目还没有编选批次。"
    />
    <ul class="adoption-history">
      <li
        v-for="item in batches"
        :key="item.id"
        :class="{ 'adoption-history-current': item.id === currentId }"
      >
        <button
          class="btn btn-quiet adoption-history-trigger"
          :disabled="busy || loading"
          @click="selectBatch(item.id)"
        >
          <strong>{{ item.recipient }}</strong><span class="adoption-hint"
            >{{ purposeLabel(item.purpose) }} · {{ batchStatusLabel(item.status) }} ·
            {{ item.counts.selected }}/{{ item.counts.total }} 条进入本批</span
          >
        </button>
        <span class="adoption-hint">{{ new Date(item.created).toLocaleString('zh-CN') }}</span>
      </li>
    </ul>
    <AppPagination
      v-if="historyTotalItems"
      :page="historyPage"
      :total-pages="historyTotalPages"
      :busy="busy || loading"
      label="编选历史分页"
      button-class="btn btn-secondary btn-sm"
      @change="changePage"
    >
      <template #position
        >第 {{ historyPage }} / {{ historyTotalPages }} 页 · 共 {{ historyTotalItems }} 批</template
      >
    </AppPagination>
  </section>
</template>

<script setup>
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import AppPagination from '@/components/AppPagination.vue'
import { purposeLabel, batchStatusLabel } from '@/lib/adoption'
defineProps({
  loading: Boolean,
  busy: Boolean,
  loadError: String,
  batches: Array,
  currentId: String,
  historyPage: Number,
  historyTotalPages: Number,
  historyTotalItems: Number
})
const emit = defineEmits(['retry', 'select', 'page'])
const load = (...args) => emit('retry', ...args)
const selectBatch = (...args) => emit('select', ...args)
const changePage = (...args) => emit('page', ...args)
</script>
