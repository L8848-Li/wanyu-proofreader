<template>
  <AppDisclosure class="keyboard-guide" label="字符用法与读音说明" lazy>
    <KeyboardGuideEntries :sections="sections" />
  </AppDisclosure>
</template>
<script setup>
import AppDisclosure from '@/components/AppDisclosure.vue'
import KeyboardGuideEntries from './KeyboardGuideEntries.vue'
defineProps({ sections: { type: Array, default: () => [] } })
</script>
<style scoped>
.keyboard-guide {
  padding: var(--space-2);
  border-bottom: 1px solid var(--line);
}
</style>
