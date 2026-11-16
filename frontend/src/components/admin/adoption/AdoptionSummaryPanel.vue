<template>
  <section class="card mb-4">
    <details>
      <summary>已确认批次统计与排除理由</summary>
      <p>
        数字取各批确认时的值（那是交付依据）；「需重评」只表示确认之后用途权利变过，
        不等于已经改过范围。
      </p>
      <dl class="adoption-metrics">
        <div class="adoption-metric">
          <dt>批次</dt>
          <dd>{{ summary.batches.total }}</dd>
          <small
            >草稿 {{ summary.batches.byStatus.draft || 0 }} · 已预览
            {{ summary.batches.byStatus.previewed || 0 }} · 已确认
            {{ summary.batches.byStatus.confirmed || 0 }}</small
          >
        </div>
        <div class="adoption-metric">
          <dt>已确认范围</dt>
          <dd>{{ summary.confirmed.selected }}/{{ summary.confirmed.total }}</dd>
          <small>条进入本批；待处理 {{ summary.confirmed.pending }} 条</small>
        </div>
        <div class="adoption-metric">
          <dt>例外</dt>
          <dd>{{ summary.exceptions.decided }}</dd>
          <small>条已处理</small>
        </div>
        <div class="adoption-metric">
          <dt>需重评</dt>
          <dd>{{ summary.events.staleBatches }}</dd>
          <small>批在确认后遇到权利变更（另有 {{ summary.events.reevaluated }} 次重评记录）</small>
        </div>
      </dl>
      <p v-if="!summary.confirmed.complete" class="adoption-hint">
        有已确认批次仍带待处理条目：它们导出的清单里 <code>complete</code> 是 <code>false</code>。
      </p>
      <div v-if="summary.reasons.length" class="mt-3">
        <h3 class="adoption-subhead">已确认批次的排除理由分布</h3>
        <ul class="adoption-reasons">
          <li v-for="item in summary.reasons" :key="item.code">
            {{ reasonLabel(item.code) }} · {{ item.count }} 条
          </li>
        </ul>
      </div>
    </details>
  </section>
</template>

<script setup>
import { reasonLabel } from '@/lib/adoption'
defineProps({ summary: Object })
</script>
