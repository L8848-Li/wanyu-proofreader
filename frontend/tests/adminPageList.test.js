import { projectDetailSource } from './helpers/projectDetailSource.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adminPageRouteQuery,
  normalizeAdminPageQuery,
  parseRangeInput,
  pendingBatchFilter,
  pendingIdsInWindow
} from '../src/lib/adminPageList.js'

const options = {
  statuses: ['active', 'pending', 'approved'],
  qualityStates: ['candidate', 'validated', 'withheld'],
  pageSizes: [10, 25, 50, 100]
}

test('parses normal, reversed and Chinese-comma ranges safely', () => {
  assert.deepEqual(parseRangeInput('1-3, 5，8-7', 8), [0, 1, 2, 4, 6, 7])
  assert.deepEqual(parseRangeInput('0, nope, 12', 8), [])
  assert.deepEqual(parseRangeInput('', 8), [])
})

test('normalizes URL filters and rejects unknown or invalid values', () => {
  assert.deepEqual(
    normalizeAdminPageQuery(
      {
        q: ['  方言  '],
        status: 'approved',
        qualityState: 'validated',
        minPage: '2',
        maxPage: '18',
        page: '3',
        perPage: '50'
      },
      options
    ),
    {
      q: '方言',
      status: 'approved',
      qualityState: 'validated',
      minPage: 2,
      maxPage: 18,
      page: 3,
      perPage: 50
    }
  )
  assert.deepEqual(
    normalizeAdminPageQuery(
      {
        q: 9,
        status: 'outsider',
        qualityState: 'unknown',
        minPage: '-2',
        maxPage: '1.5',
        page: '0',
        perPage: '1000'
      },
      options
    ),
    {
      q: '',
      status: '',
      qualityState: '',
      minPage: '',
      maxPage: '',
      page: 1,
      perPage: 25
    }
  )
})

test('serializes only non-default list state for clean shareable URLs', () => {
  assert.deepEqual(
    adminPageRouteQuery({
      q: '',
      status: '',
      qualityState: '',
      minPage: '',
      maxPage: '',
      page: 1,
      perPage: 25
    }),
    {}
  )
  assert.deepEqual(
    adminPageRouteQuery({
      q: '方言',
      status: 'active',
      qualityState: 'candidate',
      minPage: 2,
      maxPage: 18,
      page: 4,
      perPage: 100
    }),
    {
      q: '方言',
      status: 'active',
      qualityState: 'candidate',
      minPage: '2',
      maxPage: '18',
      page: '4',
      perPage: '100'
    }
  )
})

test('keeps detail pagination decoupled from stats and defers scheme loading', () => {
  const source = projectDetailSource()
  const loadPages = source.slice(
    source.indexOf('async function loadPages()'),
    source.indexOf('async function loadPageStats()')
  )
  const mounted = source.slice(
    source.indexOf('async function activate()'),
    source.indexOf('async function loadProject()')
  )
  assert.doesNotMatch(loadPages, /result\.stats|loadPageStats|pages\.value\s*=\s*\[\]/)
  assert.match(mounted, /loadPageStats\(\)/)
  assert.match(source, /const ProjectSchemePanel = lazyPanel/)
  assert.match(source, /onMounted\(setupSchemeObserver\)/)
  assert.doesNotMatch(mounted, /Promise\.all\(\[[^\]]*loadSchemeState/)
  assert.match(source, /new IntersectionObserver/)
})

test('detail stats failures stay unknown instead of becoming zero', () => {
  const source = projectDetailSource()
  const expression = source.match(/hasLoadedPageStats \? pageStats\.arbitration : '—'/)?.[0]
  assert.ok(expression, 'arbitration count must remain unknown until statistics arrive')
  const label = new Function('hasLoadedPageStats', 'pageStats', `return (${expression})`)
  assert.equal(label(false, { arbitration: 0 }), '—')
  assert.equal(label(true, { arbitration: 0 }), 0)
  assert.equal(label(true, { arbitration: 1 }), 1)
  assert.match(source, /pageStatsError/)
  assert.match(source, /重试统计/)
  assert.match(source, /项目总数暂不可用/)
  assert.doesNotMatch(source, /<p>共 \{\{ pageStats\.total \}\} 条/)
})

test('detail route changes are applied during project initialization', () => {
  const source = projectDetailSource()
  const routeWatch = source.match(
    /watch\(\s*\(\) => route.query,\s*\(\) => \{([\s\S]*?)\n\s*\}\s*\)/
  )?.[1]
  assert.ok(routeWatch, 'route observer must remain connected')
  const calls = []
  const project = { value: null }
  const callback = new Function(
    'applyListQuery',
    'route',
    'clearTimeout',
    'searchTimer',
    'project',
    'loadPages',
    routeWatch
  )
  const args = [
    () => calls.push('apply'),
    { query: {} },
    () => {},
    null,
    project,
    () => calls.push('load')
  ]
  callback(...args)
  assert.deepEqual(calls, ['apply'])
  project.value = {}
  callback(...args)
  assert.deepEqual(calls, ['apply', 'apply', 'load'])
  const mounted = source.slice(
    source.indexOf('async function activate()'),
    source.indexOf('async function loadProject()')
  )
  assert.match(mounted, /applyListQuery\(route\.query\)[\s\S]*Promise\.all\(\[loadPages\(\)/)
})

test('batch filter fetches only pending rows', () => {
  assert.equal(pendingBatchFilter('p1'), 'project="p1" && status="pending"')
})

test('range selection keeps sorted-position semantics inside a fetched window', () => {
  const dense = [
    { id: 'a', page_number: 1, status: 'pending' },
    { id: 'b', page_number: 2, status: 'approved' },
    { id: 'c', page_number: 3, status: 'pending' },
    { id: 'd', page_number: 4, status: 'claimed' }
  ]
  assert.deepEqual(pendingIdsInWindow(dense, [0, 1, 2, 3], 0), ['a', 'c'])
  assert.deepEqual(pendingIdsInWindow(dense.slice(2), [2, 3], 2), ['c'])
  assert.deepEqual(pendingIdsInWindow(dense, [1], 0), [])
  // 物理页号有缺号也不能改变位置语义：窗口第 2、3 条仍是可见排序位置 2、3。
  const gapped = [
    { id: 'a', page_number: 1, status: 'pending' },
    { id: 'c', page_number: 3, status: 'pending' },
    { id: 'e', page_number: 5, status: 'approved' }
  ]
  assert.deepEqual(pendingIdsInWindow(gapped, [0, 1, 2], 0), ['a', 'c'])
  assert.deepEqual(pendingIdsInWindow(gapped, [1], 0), ['c'])
  assert.deepEqual(pendingIdsInWindow(gapped, [2], 0), [])
})

test('batch operations wire to pending-only and bounded visible-position fetches', () => {
  const source = projectDetailSource()
  assert.match(source, /async function pendingOperationRows\(\)/)
  assert.match(source, /filter: pendingBatchFilter\(projectId\)/)
  assert.match(source, /await countProjectPages\(projectId\)/)
  assert.match(source, /await listProjectPageWindow\(projectId, startIndex, endIndex\)/)
  assert.match(source, /pendingIdsInWindow\(window\.items \|\| \[\], indexes, startIndex\)/)
  assert.doesNotMatch(source, /async function operationRows\(\)/)
  assert.doesNotMatch(source, /pageStats\.value\?\.total/)
  const moves = source.match(/pending = await pendingOperationRows\(\)/g) || []
  assert.equal(moves.length, 2)
})
