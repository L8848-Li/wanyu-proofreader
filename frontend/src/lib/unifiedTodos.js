export const TODOS_PATH = '/admin/todos'

export const TODO_STAGES = {
  arbitration: { label: '待仲裁', unit: '条', action: '处理仲裁' },
  source_problems: { label: '来源与成员问题', unit: '项', action: '处理问题' },
  source_review: { label: '待核验', unit: '条', action: '继续来源核验' },
  normalization: { label: '待归一复核', unit: '条', action: '打开归一复核' },
  adoption: { label: '编选例外', unit: '批', action: '处理编选例外' },
  delivery_receipt: { label: '待回执', unit: '包', action: '查看回执' },
  delivery_return: { label: '退回待处置', unit: '包', action: '处理退回' }
}

const isId = (value) => typeof value === 'string' && /^[a-z0-9]{15}$/.test(value)

export function todoFilterError(query) {
  if (query.project !== undefined && query.project !== '' && !isId(query.project))
    return '项目筛选链接无效，请清除后重新选择。'
  if (
    query.stage !== undefined &&
    query.stage !== '' &&
    (typeof query.stage !== 'string' || !Object.hasOwn(TODO_STAGES, query.stage))
  )
    return '阶段筛选链接无效，请清除后重新选择。'
  return ''
}

export function todoFilters(query = {}) {
  const page =
    typeof query.page === 'string' || typeof query.page === 'number' ? Number(query.page) : NaN
  return {
    project: isId(query.project) ? query.project : '',
    stage:
      typeof query.stage === 'string' && Object.hasOwn(TODO_STAGES, query.stage) ? query.stage : '',
    page: Number.isInteger(page) && page > 0 && page <= 1000000 ? page : 1
  }
}

export function todoListQuery(filters) {
  return {
    ...(filters.project ? { project: filters.project } : {}),
    ...(filters.stage ? { stage: filters.stage } : {}),
    ...(filters.page > 1 ? { page: String(filters.page) } : {})
  }
}

function todoFlow(route) {
  const project = route.params?.projectId || route.params?.id
  if (!isId(project)) return ''
  const view = route.query?.view
  const section = route.query?.section
  const flows = {
    Arbitration: route.query?.mode === 'verification' ? 'source' : 'arbitration',
    ProjectDetail:
      section === 'work' && view === 'normalization'
        ? 'normalization'
        : section === 'work' &&
            (!view || view === 'entries') &&
            route.query?.status === 'arbitration'
          ? 'arbitration'
          : '',
    SourceFidelity: !view || ['problems', 'review'].includes(view) ? 'source' : '',
    ProjectAdoption: view === 'create' ? '' : 'adoption',
    ProjectDeliveries: ['prepare', 'impacts'].includes(view) ? '' : 'delivery'
  }
  return flows[route.name] ? `${project}:${flows[route.name]}` : ''
}

function withTodoReturn(target, resolved, filters, stage) {
  const flow = todoFlow(resolved)
  if (!flow) return target
  const params = new URLSearchParams(todoListQuery(filters))
  if (typeof stage === 'string' && Object.hasOwn(TODO_STAGES, stage)) params.set('row', stage)
  const query = params.toString()
  return {
    ...target,
    query: { ...target.query, todoFrom: query ? `${flow}?${query}` : flow }
  }
}

function readTodoReturn(route) {
  const value = route?.query?.todoFrom
  if (typeof value !== 'string' || value.length > 180) return null
  const [flow, encoded = '', ...extra] = value.split('?')
  if (!flow || flow !== todoFlow(route) || extra.length) return null
  const query = Object.fromEntries(new URLSearchParams(encoded))
  if (todoFilterError(query)) return null
  return { flow, query }
}

export function todoReturnTarget(route) {
  const context = readTodoReturn(route)
  return context ? { path: TODOS_PATH, query: todoListQuery(todoFilters(context.query)) } : ''
}

export function todoReturnRow(route) {
  const context = readTodoReturn(route)
  if (!context || !Object.hasOwn(TODO_STAGES, context.query.row)) return ''
  return `${context.flow.split(':')[0]}:${context.query.row}`
}

// Keep the return link on detail/tab changes inside the same project workflow.
export function carryTodoReturn(to, from) {
  if (to.query?.todoFrom !== undefined) {
    if (todoReturnTarget(to)) return null
    const query = { ...to.query }
    delete query.todoFrom
    return { path: to.path, query, hash: to.hash }
  }
  const value = from.query?.todoFrom
  if (!value || !todoReturnTarget(from)) return null
  const previousFlow = todoFlow(from)
  const nextFlow = todoFlow(to)
  const toSourceArbitration =
    from.name === 'SourceFidelity' &&
    from.query.view === 'review' &&
    to.name === 'Arbitration' &&
    from.params.id === to.params.projectId
  if (!nextFlow || (nextFlow !== previousFlow && !toSourceArbitration)) return null
  const todoFrom = nextFlow + value.slice(previousFlow.length)
  return { path: to.path, query: { ...to.query, todoFrom }, hash: to.hash }
}

export function todoWait(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return '不足 1 分钟'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  const days = Math.floor(hours / 24)
  const remainder = hours % 24
  return remainder ? `${days} 天 ${remainder} 小时` : `${days} 天`
}

export function todoActionTarget(row, resolve, filters) {
  const target = row.target
  if (!isId(row.project?.id) || typeof target?.path !== 'string') return null
  const base = `/admin/projects/${row.project.id}`
  if (target.path !== base && !target.path.startsWith(`${base}/`)) return null
  const resolved = resolve(target)
  if (!todoFlow(resolved)) return null
  return withTodoReturn(target, resolved, filters, row.stage)
}
