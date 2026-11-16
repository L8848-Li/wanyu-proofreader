import { projectWorkspaceSubviews } from '../src/lib/projectWorkspace.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DECISION_LABELS,
  EVENT_KIND_LABELS,
  PAGE_STATUS_LABELS,
  PURPOSE_LABELS,
  REASON_LABELS,
  QUALITY_STATE_LABELS,
  countsConsistent,
  defaultRule,
  eventKindLabel,
  includeLabel,
  manifestFilename,
  normalizeCounts,
  purposeLabel,
  reasonLabel,
  ruleFromForm,
  ruleSummary
} from '../src/lib/adoption.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

function jsStringArray(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`))
  assert.ok(match, `${name} not found in the JS source`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1])
}

test('三个数之和必须等于总数，缺字段按 0 处理', () => {
  assert.equal(countsConsistent({ total: 10, selected: 6, excluded: 3, pending: 1 }), true)
  assert.equal(countsConsistent({ total: 10, selected: 6, excluded: 3, pending: 0 }), false)
  assert.equal(countsConsistent({}), true)
  // 负数与字符串不是合法计数，归零而不是让 NaN 传到界面上。
  assert.deepEqual(normalizeCounts({ total: '12', selected: -1, pending: null }), {
    total: 12,
    selected: 0,
    excluded: 0,
    pending: 0,
    complete: false
  })
})

test('规则表单挡住空状态与形状不对的批次 id', () => {
  const built = ruleFromForm({
    statuses: ['proofread'],
    qualityStates: ['validated'],
    requirePinyin: true,
    importJobsText: 'aaaaaaaaaaaaaaa, bbbbbbbbbbbbbbb'
  })
  assert.deepEqual(built.rule, {
    statuses: ['proofread'],
    qualityStates: ['validated'],
    importJobs: ['aaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbb'],
    requirePinyin: true
  })
  assert.match(ruleFromForm({ statuses: [] }).error, /至少要选一个校对状态/)
  assert.match(
    ruleFromForm({ statuses: ['proofread'], importJobsText: 'not-an-id' }).error,
    /15 位/
  )
  // 中文逗号也要能分开：管理员多半是从表格里粘过来的。
  assert.deepEqual(
    ruleFromForm({ statuses: ['approved'], importJobsText: 'aaaaaaaaaaaaaaa，bbbbbbbbbbbbbbb' })
      .rule.importJobs,
    ['aaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbb']
  )
})

test('规则摘要读得出来，不只是一个结果数字', () => {
  assert.equal(ruleSummary(defaultRule()), '校对状态：已校对、已通过')
  assert.match(
    ruleSummary({
      statuses: ['approved'],
      qualityStates: ['validated'],
      importJobs: ['aaaaaaaaaaaaaaa'],
      requirePinyin: true
    }),
    /质量状态：已确认；限定 1 个导入批次；要求拼音已定稿/
  )
})

test('枚举中文名覆盖后端全部取值，词表与源定义不漂移', () => {
  // 五桶与 backend/pb_hooks/lib/assist_difficulty.js 的 BLOCKED_BUCKETS 同源。
  const difficulty = read('../../backend/pb_hooks/lib/assist_difficulty.js')
  for (const bucket of jsStringArray(difficulty, 'BLOCKED_BUCKETS')) {
    assert.ok(bucket in REASON_LABELS, `${bucket} 没有中文名`)
  }
  // 六类用途与 source_registry.js 的 PURPOSES 同源。
  const registry = read('../../backend/pb_hooks/lib/source_registry.js')
  assert.deepEqual(Object.keys(PURPOSE_LABELS).sort(), jsStringArray(registry, 'PURPOSES').sort())
  // 后端理由码全集：Go 侧每个码都要有中文名，否则导出里会出现英文码。
  const go = read('../../backend/adoption.go')
  for (const code of Object.keys(REASON_LABELS)) {
    assert.match(go, new RegExp(`"${code}"`), `${code} 不在 backend/adoption.go 里`)
  }
  assert.deepEqual(Object.keys(DECISION_LABELS).sort(), ['exclude', 'select'])
  for (const code of Object.keys(QUALITY_STATE_LABELS)) assert.ok(code)
  for (const code of Object.keys(PAGE_STATUS_LABELS)) assert.ok(code)
})

test('漏翻的取值原样返回，不假装认识', () => {
  assert.equal(purposeLabel('something_new'), 'something_new')
  assert.equal(reasonLabel(''), '')
  assert.equal(includeLabel('all'), '导出全部条目（含未采用与待处理，需平台管理员）')
  assert.equal(
    manifestFilename({ purpose: 'public_display', id: 'abc' }),
    '编选-public_display-abc.json'
  )
})

test('事件类型与 Go 侧同源，且「权利变过」与「重评过」不混用', () => {
  const go = read('../../backend/adoption_events.go')
  for (const kind of Object.keys(EVENT_KIND_LABELS)) {
    assert.match(go, new RegExp(`"${kind}"`), `${kind} 不在 backend/adoption_events.go 里`)
  }
  assert.notEqual(EVENT_KIND_LABELS.rights_changed, EVENT_KIND_LABELS.reevaluated)
  assert.equal(eventKindLabel('rights_changed'), '用途权利变更')
  assert.equal(eventKindLabel('future_kind'), 'future_kind')
})

test('重评只追加记录：界面必须说清不改写确认时的数字', () => {
  const view = [
    '../src/views/admin/AdoptionView.vue',
    '../src/components/admin/adoption/AdoptionBatchDetails.vue',
    '../src/components/admin/adoption/AdoptionSummaryPanel.vue',
    '../src/components/admin/adoption/AdoptionExceptionEditor.vue'
  ]
    .map(read)
    .join('\n')
  assert.match(view, /按当前数据重新评估/)
  assert.match(view, /重评只会追加一条记录，\s*不会改写确认时的数字/)
  assert.match(view, /已确认的数字没有改/)
  // 度量取确认时的值，需重评不等于已修正。
  assert.match(view, /数字取各批确认时的值/)
  assert.match(view, /不等于已经改过范围/)
  assert.match(view, /已确认批次的排除理由分布/)
  assert.match(view, /需重评/)
})

test('编选页把「不得静默遗漏」写进界面，而不是只留在接口里', () => {
  const view = [
    '../src/views/admin/AdoptionView.vue',
    '../src/components/admin/adoption/AdoptionBatchDetails.vue',
    '../src/components/admin/adoption/AdoptionSummaryPanel.vue',
    '../src/components/admin/adoption/AdoptionExceptionEditor.vue'
  ]
    .map(read)
    .join('\n')
  // 三个数各自可见，且总数对不上时不允许照抄。
  assert.match(view, /进入本批/)
  assert.match(view, /已定不进入/)
  assert.match(view, /待处理（规则判不了）/)
  assert.match(view, /countsConsistent/)
  assert.match(view, /不会把部分结果冒充全量/)
  // 导出默认只带采用范围内的条目，范围外必须显式请求。
  assert.match(view, /导出默认只含进入本批的条目/)
  assert.match(view, /需平台管理员/)
  // D7：与仲裁台的字段级「采用」区分开。
  assert.match(view, /不是仲裁台里选哪一份校对结果的/)
  // 例外必须写依据；理由只在「不进入本批」时出现。
  assert.match(view, /处理例外必须写明依据/)
  assert.match(view, /判为不进入本批时必须选一个理由/)
  // 不新增裸表格与内联样式（UI 债务门禁按类计数）。
  assert.doesNotMatch(view, /<table/)
  assert.doesNotMatch(view, /style="/)
})

test('批次详情以 URL 和独立 ID 请求恢复，分页历史不决定当前批次', () => {
  const view = read('../src/views/admin/AdoptionView.vue')
  assert.match(view, /function selectBatch\(id\)[\s\S]*?navigate\(\{ batch: id/)
  assert.match(view, /getAdoptionBatch\(batchId, \{ signal \}\)/)
  assert.match(view, /const nextId = currentId.value/)
  assert.match(view, /record.project !== projectId.value/)
  assert.match(view, /<WorkspaceLeaveGuard[\s\S]*?:dirty="dirty"[\s\S]*?:preserve-query="false"/)
})

test('路由与项目页入口都指向编选页', () => {
  const router = read('../src/router/index.js')
  assert.match(router, /path: 'projects\/:id\/adoption'/)
  assert.match(router, /name: 'ProjectAdoption'/)
  const links = projectWorkspaceSubviews('project-1', 'delivery')
  assert.deepEqual(
    links.find((item) => item.key === 'adoption'),
    { key: 'adoption', label: '用途编选', to: '/admin/projects/project-1/adoption' }
  )
  assert.equal(
    links.find((item) => item.key === 'deliveries').to,
    '/admin/projects/project-1/deliveries'
  )
})

test('服务层只走 /api/fangji 路由，不直接读集合', () => {
  const service = read('../src/services/adoptionService.js')
  assert.match(
    service,
    /\/api\/fangji\/projects\/\$\{encodeURIComponent\(projectId\)\}\/adoption-batches/
  )
  assert.match(service, /\/manifest\?/)
  assert.match(service, /\/events`/)
  assert.match(service, /\/reevaluate`/)
  assert.match(service, /adoption-summary/)
  assert.doesNotMatch(service, /pb\.collection\('adoption/)
})
