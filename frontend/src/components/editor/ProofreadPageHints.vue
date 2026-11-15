<template>
  <section
    v-if="state !== 'idle'"
    class="proofread-findings"
    aria-labelledby="proofread-finding-title"
  >
    <div class="proofread-findings__heading">
      <h2 id="proofread-finding-title" ref="heading" tabindex="-1">本条疑点</h2>
      <span v-if="state === 'ready'" class="text-sm text-muted" role="status">
        <template v-if="hints.length">
          {{
            sequential
              ? `待核对 ${pendingCount} · 已核对 ${hints.length - pendingCount}`
              : `${hints.length} 条`
          }}
        </template>
        <template v-else>
          {{ gatedNoticeText ? '当前没有已开放的疑点' : '暂无可显示的疑点' }}
        </template>
      </span>
      <span v-else-if="state === 'loading'" class="text-sm text-muted" role="status"
        >正在读取疑点…</span
      >
      <span v-else class="text-sm text-muted" role="status">疑点读取失败，可继续校对。</span>
      <button
        v-if="state === 'error'"
        type="button"
        class="btn btn-secondary btn-sm"
        @click="emit('retry')"
      >
        重试读取疑点
      </button>
      <button
        v-if="sequential && pendingCount"
        :disabled="state !== 'ready'"
        type="button"
        class="btn btn-secondary btn-sm"
        @click="emit('next')"
      >
        下一处待核对
      </button>
      <button
        v-if="hints.length && (compact || overflow > 0)"
        type="button"
        class="btn btn-quiet btn-sm"
        :aria-expanded="expanded"
        aria-controls="proofread-finding-list"
        @click="expanded = !expanded"
      >
        {{
          compact
            ? expanded
              ? '收起列表'
              : '查看疑点列表'
            : expanded
              ? '收起其余疑点'
              : `展开其余 ${overflow} 个疑点`
        }}
      </button>
    </div>
    <ul
      v-show="visibleHints.length"
      id="proofread-finding-list"
      class="field-hint-list"
      :class="{ 'field-hint-list--compact': compact }"
    >
      <li v-for="hint in visibleHints" :key="hint.key">
        <div :data-finding-id="!compact ? hint.id || undefined : undefined">
          <span class="field-hint-chip" :class="{ 'field-hint-chip--strong': hint.highlight }">
            <b aria-hidden="true">疑</b>{{ hintKindLabel(hint.kind) }}
          </span>
          <strong>{{ hint.field || '整条' }}</strong>
          <span v-if="compact" class="text-sm text-muted">
            {{ Object.hasOwn(reviews, hint.id) ? '已核对' : '待核对' }}
          </span>
          <p v-if="!compact">{{ hint.text }}</p>
          <p v-if="!compact && hint.inputStatus === 'different_input'" class="text-sm text-muted">
            导入文本已变化，请按字段对照原文。
          </p>
        </div>
        <div class="proofread-findings__actions">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :data-locate-finding="hint.id || undefined"
            @click="emit('locate', hint)"
          >
            {{ compact ? '查看证据' : '定位原文' }}
          </button>
          <button
            v-if="!compact && hint.id && canReport"
            type="button"
            class="btn btn-quiet btn-sm"
            @click="emit('report', hint)"
          >
            报告问题
          </button>
        </div>
      </li>
    </ul>
  </section>
  <p v-if="findingsTruncated" class="field-hint-truncated text-sm text-muted" role="status">
    本条疑点超出读取上限，请继续逐字段核对原文。
  </p>
  <p v-if="gatedNoticeText" class="field-hint-gated text-sm text-muted" role="status">
    {{ gatedNoticeText }}
  </p>
</template>

<script setup>
import { computed, ref } from 'vue'
import { HINT_DISPLAY_LIMIT, hintKindLabel } from '@/lib/fieldHints'

const props = defineProps({
  hints: { type: Array, default: () => [] },
  reviews: { type: Object, required: true },
  state: { type: String, required: true },
  compact: Boolean,
  sequential: Boolean,
  canReport: Boolean,
  findingsTruncated: Boolean,
  gatedNoticeText: String
})
const emit = defineEmits(['locate', 'report', 'retry', 'next'])
const expanded = defineModel('expanded', { type: Boolean, default: false })
const heading = ref(null)
defineExpose({ focus: () => heading.value?.focus() })
const overflow = computed(() => props.hints.length - HINT_DISPLAY_LIMIT)
const pendingCount = computed(
  () => props.hints.filter((hint) => !Object.hasOwn(props.reviews, hint.id)).length
)
const visibleHints = computed(() =>
  expanded.value ? props.hints : props.compact ? [] : props.hints.slice(0, HINT_DISPLAY_LIMIT)
)
</script>

<style scoped>
.proofread-findings {
  margin-block-end: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-raised);
}
.proofread-findings__heading,
.proofread-findings__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.proofread-findings__heading {
  justify-content: flex-start;
}
.proofread-findings__heading h2 {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-md);
}
.field-hint-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.field-hint-list li {
  padding-block: var(--space-2);
  border-top: 1px solid var(--line);
}
.field-hint-list strong {
  margin-inline-start: var(--space-2);
}
.field-hint-list--compact {
  max-height: min(28vh, 16rem);
  overflow: auto;
  margin-block-start: var(--space-2);
}
.field-hint-list--compact li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.field-hint-list--compact .text-muted {
  margin-inline-start: var(--space-2);
}
.field-hint-list p {
  margin-block: var(--space-1);
  font-size: var(--text-sm);
}
</style>
