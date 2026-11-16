<template>
  <article class="adoption-pending">
    <h3>第 {{ item.pageNumber }} 条 · {{ reasonLabel(item.reason) }}</h3>
    <template v-if="!readonly">
      <div class="adoption-form-grid">
        <AppField layout="plain"
          ><template #label>结论 </template
          ><select v-model="decision" class="form-control">
            <option value="select">{{ DECISION_LABELS.select }}</option>
            <option value="exclude">{{ DECISION_LABELS.exclude }}</option>
          </select>
        </AppField>
        <AppField v-if="decision === 'exclude'" layout="plain"
          ><template #label>理由 </template
          ><select v-model="reason" class="form-control">
            <option value="">请选择理由</option>
            <option v-for="code in reasonCodes" :key="code" :value="code">
              {{ reasonLabel(code) }}
            </option>
          </select>
        </AppField>
      </div>
      <AppField layout="plain"
        ><template #label>依据 </template
        ><input
          v-model="note"
          class="form-control"
          maxlength="500"
          placeholder="写清为什么这样判，例如取得书面许可、缺字表已补齐"
        />
      </AppField>
      <button
        class="btn btn-secondary btn-sm mt-3"
        :disabled="busy || loading"
        @click="decide(item.page)"
      >
        保存这一条
      </button>
    </template>
  </article>
</template>

<script setup>
import AppField from '@/components/AppField.vue'
import { DECISION_LABELS, reasonLabel } from '@/lib/adoption'
defineProps({
  item: Object,
  readonly: Boolean,
  reasonCodes: Array,
  busy: Boolean,
  loading: Boolean
})
const decision = defineModel('decision', { type: String, required: true })
const reason = defineModel('reason', { type: String, required: true })
const note = defineModel('note', { type: String, required: true })
const emit = defineEmits(['save'])
const decide = (...args) => emit('save', ...args)
</script>
