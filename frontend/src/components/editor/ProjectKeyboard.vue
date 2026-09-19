<template>
  <div v-if="selectedKeyboard" class="ipa-keyboard">
    <div class="ipa-keyboard-heading">
      <div>
        <div class="ipa-keyboard-title">{{ selectedKeyboard.name }}</div>
        <p>{{ selectedKeyboard.description || (mobile ? '切换分组，字符插入当前字段。' : '字符会插入当前字段的光标位置；展开需要的分组即可。') }}</p>
      </div>
      <label v-if="keyboards.length > 1" class="keyboard-switcher">
        <span class="sr-only">切换项目键盘</span>
        <select v-model="selectedKeyboardId" class="form-control">
          <option v-for="keyboard in keyboards" :key="keyboard.keyboardId" :value="keyboard.keyboardId">{{ keyboard.name }}</option>
        </select>
      </label>
      <span v-else>{{ keyCount }} 个字符</span>
    </div>

    <div v-if="mobile && sections.length > 1" class="keyboard-section-switcher" role="group" aria-label="字符分组">
      <button v-for="section in sections" :key="section.id" type="button"
        :aria-pressed="activeSection === section.id" :aria-controls="`${keyboardUid}-${section.id}`"
        @mousedown.prevent @click="activeSection = section.id">
        {{ section.label }} <span>{{ section.keys.length }}</span>
      </button>
    </div>
    <details
      v-for="section in sections"
      :key="`${section.id}-${mobile}`"
      :id="`${keyboardUid}-${section.id}`"
      v-show="!mobile || activeSection === section.id"
      :aria-label="section.label"
      class="ipa-section"
      :open="mobile || section.defaultOpen"
    >
      <summary class="ipa-section-label">
        <span>{{ section.label }}</span>
        <span>{{ section.keys.length }}</span>
      </summary>
      <div class="ipa-keys">
        <button
          v-for="(key, index) in section.keys"
          :key="`${section.id}-${index}-${key.value}`"
          type="button"
          class="ipa-key"
          :title="key.hint || `插入 ${key.value}`"
          :aria-label="key.hint || `插入字符 ${key.value}`"
          @mousedown.prevent
          @click="$emit('insert', key.value)"
        >{{ key.label || key.value }}</button>
      </div>
    </details>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, useId, watch } from 'vue'
import { currentUserId } from '@/services/authService'
import { getProjectKeyboards } from '@/services/keyboardsService'
import { chooseProjectKeyboard, countKeyboardValues, keyboardPreferenceKey } from '@/lib/keyboardSelection'

const props = defineProps({ projectId: { type: String, default: '' } })
const emit = defineEmits(['insert', 'availability'])

const keyboards = ref([])
const projectDefaultId = ref('')
const selectedKeyboardId = ref('')
let loadGeneration = 0
const keyboardUid = useId()
const mobile = ref(false)
const activeSection = ref('')
const updateMobile = () => { mobile.value = window.innerWidth <= 768 }
onMounted(() => { updateMobile(); window.addEventListener('resize', updateMobile) })
onBeforeUnmount(() => window.removeEventListener('resize', updateMobile))

const selectedKeyboard = computed(() => keyboards.value.find((item) => item.keyboardId === selectedKeyboardId.value) || null)
const sections = computed(() => selectedKeyboard.value?.definition?.sections || [])
watch(selectedKeyboard, (keyboard) => {
  emit('availability', Boolean(keyboard))
  activeSection.value = sections.value.find((section) => section.defaultOpen)?.id || sections.value[0]?.id || ''
}, { immediate: true })
const keyCount = computed(() => countKeyboardValues(sections.value))

watch(() => props.projectId, load, { immediate: true })
watch(selectedKeyboardId, (keyboardId) => {
  if (!keyboardId || !props.projectId) return
  try { localStorage.setItem(keyboardPreferenceKey(currentUserId(), props.projectId), keyboardId) } catch { /* private mode or quota: a lost preference must not break the editor */ }
})

async function load(projectId) {
  const generation = ++loadGeneration
  keyboards.value = []
  selectedKeyboardId.value = ''
  if (!projectId) return
  try {
    const result = await getProjectKeyboards(projectId)
    if (generation !== loadGeneration) return
    keyboards.value = Array.isArray(result.items) ? result.items : []
    projectDefaultId.value = result.defaultKeyboardId || ''
    let remembered = ''
    try { remembered = localStorage.getItem(keyboardPreferenceKey(currentUserId(), projectId)) || '' } catch { /* an unreadable preference falls back to the project default */ }
    selectedKeyboardId.value = chooseProjectKeyboard(keyboards.value, projectDefaultId.value, remembered)?.keyboardId || ''
  } catch {
    if (generation === loadGeneration) keyboards.value = []
  }
}
</script>
