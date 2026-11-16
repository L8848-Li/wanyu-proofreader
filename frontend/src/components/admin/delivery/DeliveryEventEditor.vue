<template>
  <section ref="root" class="card mb-6 delivery-event-editor">
    <h2 ref="heading" tabindex="-1">登记：{{ selected.recipient }} 第 {{ selected.version }} 版</h2>
    <p class="text-muted">
      保存会追加一条凭据。冲突或失败需由上游修复，再使用新交接清单关联前包重发。
    </p>
    <form class="settings-form" @submit.prevent="saveEvent">
      <fieldset class="delivery-form-section" :disabled="busy">
        <legend>1 · 记录发生了什么</legend>
        <label class="form-group"
          ><span class="form-label">动作</span
          ><select v-model="kind" class="form-control">
            <option v-for="(label, value) in eventLabels" :key="value" :value="value">
              {{ label }}
            </option>
          </select></label
        >
        <template v-if="kind === 'receipt'">
          <p class="text-sm text-muted">
            对方自动回传尚未接入。这条记录是人工回执，写在当前包标识和第
            {{ selected.version }} 版上。失败会记成整体失败，不会改成尚未回执。
          </p>
          <label class="form-group"
            ><span class="form-label">消费方导入结果</span
            ><select v-model="status" class="form-control">
              <option value="success">全部成功</option>
              <option value="partial_conflict">部分冲突</option>
              <option value="failed_rolled_back">整体失败并回滚</option>
            </select></label
          >
          <label class="form-group"
            ><span class="form-label">影响条数（冲突时填冲突条数）</span
            ><input
              v-model.number="affected"
              type="number"
              min="0"
              :max="selected.reconciliation.payload_count"
              class="form-control"
              required
          /></label>
        </template>
      </fieldset>
      <fieldset class="delivery-form-section" :disabled="busy">
        <legend>2 · 填写说明与核查者</legend>
        <label class="form-group"
          ><span class="form-label">原因／处置说明</span
          ><textarea v-model.trim="reason" class="form-control" required maxlength="1000" />
        </label>
        <label class="form-group"
          ><span class="form-label">人工核查者</span
          ><input v-model.trim="reviewer" class="form-control" required maxlength="200"
        /></label>
        <label class="form-group"
          ><span class="form-label">修复／通知责任人</span
          ><input v-model.trim="responsible" class="form-control" maxlength="200"
        /></label>
      </fieldset>
      <fieldset class="delivery-form-section" :disabled="busy">
        <legend>3 · 补充处置关联与凭据</legend>
        <p class="text-sm text-muted">
          正常导入可不填写退回位置。涉及停用、失败或上游修复时，请按实际处置留下凭据。
        </p>
        <label class="form-group"
          ><span class="form-label">退回环节</span
          ><select v-model="target" class="form-control">
            <option value="">不涉及上游退回</option>
            <option v-for="target in returnTargets" :key="target" :value="target">
              {{ stageLabel(target) }}
            </option>
          </select></label
        >
        <label class="form-group"
          ><span class="form-label">处置凭据（停用时填升级记录；失败时填回滚凭据）</span
          ><input v-model.trim="evidence" class="form-control" maxlength="1000"
        /></label>
        <label v-if="kind === 'resolution'" class="form-group"
          ><span class="form-label">已处置的待办</span
          ><select v-model="resolves" class="form-control" required>
            <option value="">请选择待办记录</option>
            <option
              v-for="event in selected.pending_action_events || []"
              :key="event.id"
              :value="event.id"
            >
              {{ eventLabel(event.kind) }} · {{ event.created }} · {{ event.payload.reason }}
            </option>
          </select></label
        >
      </fieldset>
      <div class="delivery-form-actions">
        <AppButton type="submit" variant="primary" :loading="busy" loading-label="正在保存…"
          >保存凭据</AppButton
        ><AppButton type="button" :disabled="busy" @click="emit('cancel')"> 取消 </AppButton>
      </div>
    </form>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import AppButton from '@/components/AppButton.vue'
const props = defineProps({
  selected: Object,
  busy: Boolean,
  eventLabels: Object,
  returnTargets: Array,
  stageLabel: Function
})
const eventLabel = (value) => props.eventLabels[value] || value
const kind = defineModel('kind', { type: String, required: true })
const status = defineModel('status', { type: String, required: true })
const affected = defineModel('affected', { type: [Number, String], required: true })
const reason = defineModel('reason', { type: String, required: true })
const reviewer = defineModel('reviewer', { type: String, required: true })
const responsible = defineModel('responsible', { type: String, required: true })
const target = defineModel('target', { type: String, required: true })
const evidence = defineModel('evidence', { type: String, required: true })
const resolves = defineModel('resolves', { type: String, required: true })
const emit = defineEmits(['save', 'cancel'])
const saveEvent = (...args) => emit('save', ...args)
const root = ref(null),
  heading = ref(null)
defineExpose({
  focusEditor() {
    root.value?.scrollIntoView({ block: 'start' })
    heading.value?.focus({ preventScroll: true })
  }
})
</script>
