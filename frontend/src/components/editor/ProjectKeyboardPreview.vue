<template>
  <p v-if="pending" role="status">正在读取项目键盘…</p>
  <div v-else-if="error" role="alert">
    {{ error }}
    <AppButton type="button" variant="secondary" size="sm" @click="load">重试</AppButton>
  </div>
  <template v-else-if="keyboard">
    <label v-if="data.items.length > 1">
      选择要查看的键盘
      <select v-model="selection" class="form-control">
        <option v-for="item in data.items" :key="item.keyboardId" :value="item.keyboardId">
          {{ item.name }}
        </option>
      </select>
    </label>
    <p v-else>{{ keyboard.name }}</p>
    <div
      class="project-keyboard-entries"
      role="region"
      :aria-label="keyboard.name + '符号说明'"
      tabindex="0"
    >
      <KeyboardGuideEntries :sections="keyboard.definition.sections" />
    </div>
  </template>
  <p v-else>本项目尚未配置字符键盘。</p>
</template>
<script setup>
import { computed, ref, onMounted } from 'vue'
import AppButton from '@/components/AppButton.vue'
import KeyboardGuideEntries from './KeyboardGuideEntries.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { chooseProjectKeyboard } from '@/lib/keyboardSelection'
import { getProjectKeyboards } from '@/services/keyboardsService'
import { getPbMessage } from '@/utils/pbErrors'

const props = defineProps({ projectId: { type: String, required: true } })
const selection = ref('')
const { data, pending, error, reload } = useAsyncResource(
  ({ signal }) => getProjectKeyboards(props.projectId, { signal }),
  { formatError: (cause) => getPbMessage(cause, '项目键盘暂时无法读取。') }
)
const keyboard = computed(() =>
  chooseProjectKeyboard(data.value?.items, data.value?.defaultKeyboardId, selection.value)
)
async function load() {
  const result = await reload()
  if (result.ok && keyboard.value) selection.value = keyboard.value.keyboardId
}
onMounted(load)
</script>

<style scoped>
.project-keyboard-entries {
  max-block-size: min(60vh, 32rem);
  overflow-y: auto;
}
</style>
