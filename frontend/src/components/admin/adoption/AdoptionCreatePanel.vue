<template>
  <section class="card mb-4">
    <nav class="adoption-steps" aria-label="创建编选步骤">
      <span :aria-current="step === 1 ? 'step' : undefined">1 用途与接收方</span
      ><span :aria-current="step === 2 ? 'step' : undefined">2 条目范围</span
      ><span>3 数量与确认</span>
    </nav>
    <h2>{{ step === 1 ? '这批资料交给谁、用来做什么' : '选择本批需要交付的条目' }}</h2>
    <p class="text-muted">
      创建后先预览数量，再由你确认范围。来源用途未获允许时，仍会阻止进入交付范围。
    </p>
    <p v-if="step === 2" class="adoption-create-summary">
      <strong>{{ recipient }}</strong> · {{ purposeLabel(purpose) }}
    </p>
    <div v-if="reportScopeRequested" class="adoption-report-scope">
      <p v-if="reportScopePending" role="status">正在核对报告所用的导入批次…</p>
      <div v-else-if="reportScopeError" class="alert alert-warning" role="alert">
        <p>{{ reportScopeError }}</p>
        <button
          v-if="requestedReportBatch"
          type="button"
          class="btn btn-secondary btn-sm"
          @click="verifyReportScope"
        >
          重新核对批次
        </button>
      </div>
      <template v-else-if="verifiedReportBatch">
        <p v-if="customReportScope">
          自选导入批次。至少保留一个批次；若需整个项目，请返回编选列表新建。
        </p>
        <p v-else>
          导入范围仅限 <strong>{{ verifiedReportBatch.filename }}</strong> ·
          {{ verifiedReportBatch.entries }} 条已入册
        </p>
        <button
          v-if="step === 2 && !customReportScope"
          type="button"
          class="btn btn-quiet btn-sm"
          :disabled="busy"
          @click="openCustomReportScope"
        >
          改为自选范围
        </button>
      </template>
    </div>
    <form @submit.prevent="step === 1 ? nextCreateStep() : create()">
      <fieldset class="adoption-form-body" :disabled="busy || loading">
        <div v-show="step === 1" class="adoption-form-grid">
          <AppField layout="plain"
            ><template #label>用途 </template
            ><select v-model="purpose" class="form-control" required>
              <option v-for="code in purposes" :key="code" :value="code">
                {{ purposeLabel(code) }}
              </option>
            </select>
          </AppField>
          <AppField layout="plain"
            ><template #label>接收方 </template
            ><input
              v-model="recipient"
              class="form-control"
              maxlength="120"
              required
              placeholder="例如：乡声集盒春节版"
            />
          </AppField>
        </div>
        <div v-show="step === 2">
          <AppField
            ><template #label>校对范围</template
            ><select v-model="scopePreset" class="form-control" @change="applyScopePreset">
              <option value="ready">已校对或已通过的条目</option>
              <option value="custom">自定义校对状态</option>
            </select></AppField
          >
          <fieldset v-if="scopePreset === 'custom'" class="adoption-fieldset">
            <legend>选择校对状态</legend>
            <label v-for="code in pageStatuses" :key="code" class="adoption-check"
              ><input v-model="statuses" type="checkbox" :value="code" />{{
                statusLabel(code)
              }}</label
            >
          </fieldset>
          <AppDisclosure class="adoption-optional mb-3" label="质量与记音要求（可选）">
            <fieldset class="adoption-fieldset">
              <legend>质量状态（不勾选表示不限）</legend>
              <label v-for="code in qualityStates" :key="code" class="adoption-check"
                ><input v-model="qualitySelection" type="checkbox" :value="code" />{{
                  qualityStateLabel(code)
                }}</label
              >
            </fieldset>
            <label class="adoption-check"
              ><input v-model="requirePinyin" type="checkbox" />要求记音归一已定稿</label
            >
          </AppDisclosure>
          <ImportBatchPicker
            v-if="!reportScopeRequested || (verifiedReportBatch && customReportScope)"
            :require-selection="reportScopeRequested"
            v-model="importJobsText"
            :project-id="projectId"
            :disabled="busy"
            @access-error="emit('access-error', $event)"
          />
          <AppField layout="plain"
            ><template #label>说明（可选） </template
            ><textarea v-model="note" class="form-control" maxlength="500" rows="2"></textarea>
          </AppField>
        </div>
        <div class="adoption-actions">
          <AppButton v-if="step === 2" type="button" :disabled="busy || loading" @click="step = 1">
            上一步</AppButton
          ><AppButton
            type="submit"
            variant="primary"
            :loading="busy"
            :disabled="loading || !reportScopeReady || (step === 2 && !hasSelectedReportScope)"
            loading-label="正在创建…"
          >
            {{ step === 1 ? '下一步：选择范围' : '创建并预览数量' }}
          </AppButton>
        </div>
      </fieldset>
    </form>
  </section>
</template>

<script setup>
import AppField from '@/components/AppField.vue'
import AppButton from '@/components/AppButton.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import ImportBatchPicker from '@/components/admin/project/ImportBatchPicker.vue'
import { purposeLabel, statusLabel, qualityStateLabel } from '@/lib/adoption'
defineProps({
  purposes: Array,
  pageStatuses: Array,
  qualityStates: Array,
  busy: Boolean,
  loading: Boolean,
  reportScopeRequested: Boolean,
  reportScopePending: Boolean,
  reportScopeError: String,
  requestedReportBatch: String,
  verifiedReportBatch: Object,
  customReportScope: Boolean,
  reportScopeReady: Boolean,
  hasSelectedReportScope: Boolean,
  projectId: String
})
const purpose = defineModel('purpose', { type: String, required: true })
const recipient = defineModel('recipient', { type: String, required: true })
const statuses = defineModel('statuses', { type: Array, required: true })
const qualitySelection = defineModel('qualitySelection', { type: Array, required: true })
const requirePinyin = defineModel('requirePinyin', { type: Boolean, required: true })
const importJobsText = defineModel('importJobsText', { type: String, required: true })
const note = defineModel('note', { type: String, required: true })
const scopePreset = defineModel('scopePreset', { type: String, required: true })
const step = defineModel('step', { type: Number, required: true })
const emit = defineEmits([
  'verify-scope',
  'custom-scope',
  'next',
  'create',
  'scope-change',
  'access-error'
])
const verifyReportScope = (...args) => emit('verify-scope', ...args)
const openCustomReportScope = (...args) => emit('custom-scope', ...args)
const nextCreateStep = (...args) => emit('next', ...args)
const create = (...args) => emit('create', ...args)
const applyScopePreset = (...args) => emit('scope-change', ...args)
</script>
