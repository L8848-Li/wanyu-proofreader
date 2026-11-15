<template>
  <section
    class="proofread-finding-detail"
    :aria-label="hint.field ? hint.field + '的疑点证据' : '条目疑点证据'"
  >
    <div :data-finding-id="hint.id || undefined">
      <strong>{{ hintKindLabel(hint.kind) }}</strong>
      <p>{{ hint.text }}</p>
      <p v-if="hint.inputStatus === 'different_input'" class="text-muted">
        导入文本已变化，请按字段对照原文。
      </p>
      <p v-else-if="hint.field && !hint.targetField" class="text-muted">
        当前条目未显示「{{ hint.field }}」，请核对来源页。
      </p>
      <p v-if="review" class="text-muted">已核对 · {{ outcomeLabels[review.result] }}</p>
    </div>
    <div class="proofread-finding-detail__actions">
      <button
        v-if="hint.id && canReview"
        class="btn btn-secondary btn-sm"
        type="button"
        @click="emit('review', !review)"
      >
        {{
          review
            ? '重新列为待核对'
            : hint.targetField
              ? changed
                ? '已按原文修正'
                : '核对无误，保留原值'
              : '标为已核对'
        }}
      </button>
      <button v-if="hasNext" class="btn btn-secondary btn-sm" type="button" @click="emit('next')">
        下一处待核对
      </button>
      <button
        v-if="hint.id && canReport"
        class="btn btn-quiet btn-sm"
        type="button"
        @click="emit('report')"
      >
        报告问题
      </button>
      <button class="btn btn-quiet btn-sm" type="button" @click="emit('close')">收起证据</button>
    </div>
  </section>
</template>

<script setup>
import { hintKindLabel } from '@/lib/fieldHints'

defineProps({
  hint: { type: Object, required: true },
  review: Object,
  canReview: Boolean,
  canReport: Boolean,
  changed: Boolean,
  hasNext: Boolean
})
const emit = defineEmits(['review', 'next', 'report', 'close'])
const outcomeLabels = { kept: '保留原值', corrected: '已按原文修正', reviewed: '已核对来源页' }
</script>

<style scoped>
.proofread-finding-detail {
  border-inline-start: 2px solid var(--primary);
  padding: var(--space-2) var(--space-3);
  margin-block: var(--space-2);
  font-size: var(--text-sm);
  background: var(--surface-raised);
}
.proofread-finding-detail p {
  margin-block: var(--space-1);
}
.proofread-finding-detail__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
}
</style>
