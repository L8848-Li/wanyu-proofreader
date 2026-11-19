<template>
  <div>
    <p>
      先把光标放到字段，再点字符键。说明不改变插入内容；读法只引用已登记的方案，不能把不同资料的同形符号混用。
    </p>
    <p role="note">
      没有可靠读音或例词依据的键明确标为待核对。输入演示只展示组合方式，不是方言例词。
    </p>
    <dl class="keyboard-guide-list">
      <div v-for="item in items" :key="item.value" class="keyboard-guide-entry">
        <dt>
          <AppFieldValue :value="item.label" :font-notice="false" /> · {{ item.group }}
          <code>{{ item.codepoints }}</code>
        </dt>
        <dd>{{ item.usage }}</dd>
        <dd v-if="item.verified">
          {{ item.reading }}<br />资料例字／例词：{{ item.examples || '原表未列例词，待核对'
          }}<br /><small>依据：{{ item.source }}</small>
        </dd>
        <dd v-else>读音／例词：尚无经核对的本项目依据，请按资料说明确认。</dd>
        <dd v-if="item.inputExample">
          输入演示（非例词）：<AppFieldValue :value="item.inputExample" :font-notice="false" />
        </dd>
      </div>
    </dl>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import AppFieldValue from '@/components/AppFieldValue.vue'
import { keyboardGuide } from '@/lib/keyboardGuide'
const props = defineProps({ sections: { type: Array, default: () => [] } })
const items = computed(() => keyboardGuide(props.sections))
</script>
<style scoped>
.keyboard-guide-list {
  display: grid;
  gap: var(--space-3);
}
.keyboard-guide-entry {
  padding: var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.keyboard-guide-entry dt {
  font-weight: 600;
}
.keyboard-guide-entry dd {
  margin: var(--space-1) 0 0;
  overflow-wrap: anywhere;
}
</style>
