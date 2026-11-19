const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL || process.env.FRONTEND_URL
const backend = process.env.PB_URL
const suffix = process.env.FANGJI_DEMO_SUFFIX || 'workbench-browser'
const password = process.env.FANGJI_DEMO_PASSWORD || 'Demo12345678!'
const output =
  process.env.WORKBENCH_OUTPUT || path.resolve(__dirname, '../../../output/playwright/workbench')

async function api(endpoint, token, method = 'GET', body) {
  const response = await fetch(backend + endpoint, {
    method,
    headers: { Authorization: token || '', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await response.json()
  assert.ok(response.ok, `${endpoint}: ${response.status} ${JSON.stringify(data)}`)
  return data
}
async function login(page, identity) {
  await page.goto(base + '/login')
  await page.getByLabel('昵称或邮箱', { exact: true }).fill(identity)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL('**/workspace')
  await page.locator('.workbench-start').waitFor()
}
async function logout(page) {
  await page.locator('.shell-account > summary').click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/login')
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
}
async function primaryWorkFits(page, mobile = false) {
  const section = page.getByRole('region', { name: '当前工作', exact: true })
  const action = section.locator('.btn-primary')
  await action.first().waitFor()
  assert.equal(await action.count(), 1, 'Current work exposes one primary action')
  const copy = await section.locator('.workbench-start__copy').boundingBox()
  const button = await action.boundingBox()
  const bounds = await section.boundingBox()
  assert.ok(bounds.height <= (mobile ? 240 : 160), 'Current work is a compact group')
  if (mobile) {
    assert.ok(button.y >= copy.y + copy.height - 1)
    assert.ok(button.y + button.height <= bounds.y + bounds.height)
  } else {
    assert.ok(button.x >= copy.x + copy.width + 12)
    assert.ok(button.x <= copy.x + copy.width + 33, 'The action stays beside its task context')
    assert.ok(button.y < copy.y + copy.height && button.y + button.height > copy.y)
  }
  await noOverflow(page)
}
async function catalogFits(page) {
  await page.locator('.work-catalog').waitFor()
  const bounds = await page.locator('.work-catalog').boundingBox()
  assert.ok(bounds.width <= 1201, 'Catalog shares the workbench content width')
  const headingSize = await page
    .locator('.work-catalog h1')
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
  assert.ok(
    headingSize >= 24 && headingSize <= 28.1,
    'Catalog title stays within the shared hierarchy'
  )
  await noOverflow(page)
}

;(async () => {
  assert.ok(
    base && backend && process.env.FANGJI_TEST_DATA_DIR,
    'Use a disposable harness backend and seed_demo.mjs, never production'
  )
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(new URL(backend).hostname),
    'Workbench acceptance only uses a loopback disposable backend'
  )
  await fs.mkdir(output, { recursive: true })
  const administrator = await api('/api/collections/users/auth-with-password', '', 'POST', {
    identity: process.env.APP_ADMIN_EMAIL,
    password: process.env.APP_ADMIN_PASSWORD
  })
  const publicProject = await api('/api/fangji/projects', administrator.token, 'POST', {
    name: '合成公开项目 · 工作台验收',
    description: '只用于临时实例的真实接口验收',
    accessMode: 'public'
  })
  const readerEmail = `demo-reader1-${suffix}@example.com`
  const reader = await api('/api/collections/users/auth-with-password', '', 'POST', {
    identity: readerEmail,
    password
  })
  const queues = await api('/api/fangji/proofreading-queues', reader.token)
  const project = queues.items.find((queue) => queue.project.name.startsWith('演示项目'))?.project
  assert.ok(project, 'Run seed_demo.mjs with the same suffix before this browser suite')
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript((url) => {
      globalThis.__FANGJI_BACKEND_URL__ = url
    }, backend)
    const errors = [],
      writes = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (
        request.method() !== 'GET' &&
        /\/(claim|submit|draft|renew|return-to-source)$/.test(new URL(request.url()).pathname)
      )
        writes.push(request.url())
    })
    page.on('dialog', (dialog) => dialog.accept())
    await login(page, readerEmail)
    await page.getByRole('button', { name: '开始校对', exact: true }).waitFor()
    await primaryWorkFits(page)
    const guidePath = `/api/fangji/projects/${project.id}/keyboards`
    const guidesRead = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === guidePath) guidesRead.push(request.method())
    })
    await page.getByRole('link', { name: '查看项目键盘说明' }).click()
    const guideTrigger = page.getByRole('button', { name: '查看项目键盘说明' })
    await guideTrigger.waitFor()
    const guide = page.getByRole('region', { name: '莆仙方言键盘符号说明' })
    await guide.waitFor()
    const definitions = (await api(guidePath, reader.token)).items[0].definition.sections
    const uniqueKeys = new Set(
      definitions.flatMap((section) => section.keys.map((key) => key.value))
    )
    assert.ok(uniqueKeys.size > 0)
    assert.equal(await guide.locator('.keyboard-guide-entry').count(), uniqueKeys.size)
    assert.match(await guide.innerText(), /尚无经核对的本项目依据/)
    assert.deepEqual(guidesRead, ['GET'])
    assert.deepEqual(writes, [], 'Reading the guide before the first claim is read-only')
    await guide.evaluate((region) => region.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: path.join(output, 'desktop-preclaim-keyboard-guide.png') })
    await guideTrigger.click()
    await page.goto(base + `/tasks?view=available&project=${project.id}`)
    await guideTrigger.waitFor()
    assert.equal(await guideTrigger.getAttribute('aria-expanded'), 'false')
    assert.deepEqual(guidesRead, ['GET'])
    await page.setViewportSize({ width: 390, height: 844 })
    await guideTrigger.focus()
    await page.keyboard.press('Enter')
    await guide.waitFor()
    await noOverflow(page)
    await guide.evaluate((region) => region.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: path.join(output, 'mobile-preclaim-keyboard-guide.png') })
    assert.deepEqual(guidesRead, ['GET', 'GET'])
    assert.deepEqual(writes, [])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(base + '/workspace')
    const claimAction = page.getByRole('button', { name: '开始校对', exact: true })
    const idleAction = await claimAction.boundingBox()
    let finishClaim, claimStarted
    const claimGate = new Promise((resolve) => {
      finishClaim = resolve
    })
    const claimRequested = new Promise((resolve) => {
      claimStarted = resolve
    })
    const claimRequest = `**/api/fangji/projects/${project.id}/claim`
    await page.route(claimRequest, async (route) => {
      claimStarted()
      await claimGate
      await route.continue()
    })
    await page.getByRole('button', { name: '开始校对', exact: true }).click()
    await claimRequested
    const busyAction = page.getByRole('button', { name: '正在打开…', exact: true })
    await busyAction.waitFor()
    assert.equal(await busyAction.isDisabled(), true)
    assert.equal(await busyAction.getAttribute('aria-busy'), 'true')
    const openingAction = await busyAction.boundingBox()
    assert.deepEqual(openingAction, idleAction, 'Claiming keeps the primary action geometry stable')
    await page.screenshot({ path: path.join(output, 'desktop-current-work-opening.png') })
    finishClaim()
    await page.waitForURL('**/tasks/*/edit')
    await page.unroute(claimRequest)
    await page.locator('.proofread-textarea').first().waitFor()
    assert.equal(await page.locator('.app-sidebar').count(), 0)
    const shell = await page.locator('.shell-header').boundingBox()
    const workspace = await page.locator('.experience-workspace').boundingBox()
    assert.equal(Math.round(shell.height), 56)
    assert.ok(workspace.y >= shell.y + shell.height - 1 && workspace.y + workspace.height <= 901)
    await noOverflow(page)
    await page.screenshot({ path: path.join(output, 'desktop-editor-with-shell.png') })
    await page.getByRole('link', { name: '返回队列', exact: true }).click()
    await page.waitForURL('**/tasks')
    const queuePath = `/tasks?view=active&project=${project.id}&page=1#project-list-title`
    await page.goto(base + queuePath)
    await page.getByRole('button', { name: '继续校对', exact: false }).waitFor()
    await catalogFits(page)
    assert.ok(
      (await page.locator('.catalog-summary').boundingBox()).height < 120,
      'Queue statistics stay compact'
    )
    await page.screenshot({ path: path.join(output, 'desktop-task-catalog.png') })
    const shellGeometry = await page.evaluateHandle(() =>
      ['.app-canvas', '.shell-header', '.app-page'].map((selector) => {
        const node = document.querySelector(selector)
        const { x, width } = node.getBoundingClientRect()
        return { selector, node, x, width }
      })
    )
    const assertShellGeometry = async () => {
      assert.equal(
        await shellGeometry.evaluate((elements) =>
          elements.every(({ selector, node, x, width }) => {
            const current = document.querySelector(selector)
            const bounds = current.getBoundingClientRect()
            return current === node && bounds.x === x && bounds.width === width
          })
        ),
        true,
        'The shared shell stays in place across catalog and immersive routes'
      )
    }
    await page.route(
      claimRequest,
      async (route) => {
        // Exercise navigation beyond Chromium's recent-input exclusion window.
        await new Promise((resolve) => setTimeout(resolve, 650))
        await route.continue()
      },
      { times: 1 }
    )
    await page.getByRole('button', { name: '继续校对', exact: false }).click()
    await page.waitForURL('**/tasks/*/edit')
    await page.locator('.experience-workspace').waitFor()
    await assertShellGeometry()
    await page.getByRole('link', { name: '返回队列', exact: true }).click()
    await page.waitForURL(base + queuePath)
    await assertShellGeometry()
    await shellGeometry.dispose()
    let releaseQueue, queueStarted
    const queueGate = new Promise((resolve) => {
      releaseQueue = resolve
    })
    const queueRequested = new Promise((resolve) => {
      queueStarted = resolve
    })
    const queuesUrl = '**/api/fangji/proofreading-queues?*'
    await page.route(queuesUrl, async (route) => {
      if (new URL(route.request().url()).searchParams.get('filter') !== 'reviewed')
        return route.continue()
      queueStarted()
      await queueGate
      await route.continue()
    })
    await page.getByRole('link', { name: '已提交', exact: true }).click()
    await queueRequested
    await page.locator('[data-task-list-updating]').waitFor()
    assert.equal(
      await page.getByText('还没有本人提交记录', { exact: true }).count(),
      0,
      'A pending filter must not claim empty'
    )
    releaseQueue()
    await page.getByRole('button', { name: '回看已提交', exact: true }).waitFor()
    await page.unroute(queuesUrl)
    let releaseReviewed, reviewedStarted
    const reviewGate = new Promise((resolve) => {
      releaseReviewed = resolve
    })
    const reviewRequested = new Promise((resolve) => {
      reviewedStarted = resolve
    })
    const reviewUrl = `**/api/fangji/projects/${project.id}/tasks/reviewed`
    await page.route(reviewUrl, async (route) => {
      reviewedStarted()
      await reviewGate
      await route.continue().catch(() => {})
    })
    await page.goto(base + `/tasks?view=reviewed&project=${project.id}`)
    await reviewRequested
    await page.getByRole('link', { name: '进行中', exact: true }).click()
    await page.getByRole('button', { name: '继续校对', exact: false }).waitFor()
    assert.equal(await page.getByLabel('正在加载项目', { exact: true }).count(), 0)
    releaseReviewed()
    await page.unroute(reviewUrl)
    await page.goto(base + '/workspace')
    await page.getByRole('link', { name: '继续校对', exact: true }).waitFor()
    await primaryWorkFits(page)
    await page.screenshot({ path: path.join(output, 'desktop-reader-workbench.png') })
    assert.equal(
      await page.getByRole('link', { name: '继续校对', exact: true }).count(),
      1,
      'the current task has one resume action'
    )
    await page.getByRole('link', { name: '继续校对', exact: true }).click()
    await page.waitForURL('**/tasks/*/edit')
    await page.goto(base + `/tasks?view=reviewed&project=${project.id}`)
    await page.getByRole('button', { name: '回看已提交', exact: true }).waitFor()
    writes.length = 0
    await page.getByRole('button', { name: '回看已提交', exact: true }).click()
    await page.locator('[data-task-feedback="readonly"]').waitFor()
    assert.equal(
      await page
        .locator('.proofread-textarea')
        .evaluateAll((inputs) => inputs.every((input) => input.readOnly)),
      true
    )
    assert.deepEqual(writes, [], 'Own review must not claim, save drafts, renew or submit')
    await page.goto(base + '/projects?view=mine')
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await catalogFits(page)
    await page.screenshot({ path: path.join(output, 'desktop-project-catalog.png') })
    await page.getByRole('link', { name: '可加入', exact: true }).click()
    const joinForm = page.getByRole('form', { name: publicProject.name, exact: true })
    await joinForm.getByRole('button', { name: '加入项目', exact: true }).click()
    await page.getByText(`已加入 ${publicProject.name}`, { exact: true }).waitFor()
    await page.getByRole('link', { name: '我的项目', exact: true }).click()
    await page.getByRole('heading', { name: publicProject.name, exact: true }).waitFor()
    await logout(page)
    await login(page, `demo-manager-${suffix}@example.com`)
    await page.getByRole('heading', { name: '项目进展', exact: true }).waitFor()
    await primaryWorkFits(page)
    assert.equal(await page.getByRole('heading', { name: '我的校对', exact: true }).count(), 0)
    await page.reload()
    await page
      .getByRole('region', { name: '项目进展', exact: true })
      .getByRole('link')
      .filter({ hasText: project.name })
      .waitFor()
    await page.screenshot({ path: path.join(output, 'desktop-manager-workbench.png') })
    await page.locator('.app-sidebar').getByRole('link', { name: '我的任务', exact: true }).focus()
    await page.keyboard.press('Tab')
    const projectNavigation = page
      .locator('.app-sidebar')
      .getByRole('link', { name: '项目', exact: true })
    assert.equal(
      await projectNavigation.evaluate((element) => document.activeElement === element),
      true
    )
    assert.equal(
      await projectNavigation.evaluate((element) => getComputedStyle(element).outlineWidth),
      '3px',
      'Sidebar keyboard navigation has a visible focus indicator'
    )
    await page.goto(base + '/projects?view=mine')
    await page.getByRole('link', { name: '项目管理', exact: true }).click()
    await page.waitForURL('**/admin')
    await page.getByRole('region', { name: '项目进展表', exact: true }).waitFor()
    await catalogFits(page)
    assert.equal(await page.locator('.admin-project-table thead').isVisible(), true)
    assert.equal(
      await page
        .locator('.admin-project-table')
        .evaluate((element) => getComputedStyle(element).display),
      'table'
    )
    const managedRow = page.locator(
      `.admin-project-table tbody tr[data-project-id="${project.id}"]`
    )
    const managedName = managedRow.locator('.project-name-link')
    const managedAction = managedRow.getByRole('link', { name: /处理 \d+ 条待仲裁/ })
    const managedSettings = managedRow.getByRole('link', {
      name: `${project.name}：项目设置`,
      exact: true
    })
    await managedSettings.waitFor()
    assert.deepEqual(await page.getByRole('columnheader').allTextContents(), [
      '项目',
      '待仲裁',
      '校对中',
      '完成进度',
      '操作'
    ])
    await managedRow
      .locator('.project-created')
      .getByText(/创建于/)
      .waitFor()
    assert.equal(
      await managedSettings.getAttribute('href'),
      `/admin/projects/${project.id}/settings`
    )
    await page.screenshot({ path: path.join(output, 'desktop-managed-catalog.png') })
    await page.getByRole('button', { name: '筛选待仲裁项目', exact: true }).click()
    await page.waitForURL('**/admin?filter=attention')
    await managedAction.click()
    await page.waitForURL(
      `**/admin/projects/${project.id}?section=work&view=entries&status=arbitration`
    )
    await page.goBack()
    await page.getByRole('button', { name: '全部', exact: true }).click()
    await page.waitForURL('**/admin')
    await managedSettings.waitFor()
    const dashboardRequest = '**/api/fangji/project-insights?*'
    await page.route(dashboardRequest, (route) =>
      route.fulfill({ status: 503, json: { message: '合成测试：项目目录暂时不可用' } })
    )
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '合成测试：项目目录暂时不可用' }).waitFor()
    await page.getByRole('region', { name: '项目进展表', exact: true }).waitFor()
    await page.screenshot({ path: path.join(output, 'desktop-managed-catalog-error.png') })
    await page.unroute(dashboardRequest)
    await page.getByRole('button', { name: '重新加载', exact: true }).click()
    await page
      .getByRole('alert')
      .filter({ hasText: '合成测试：项目目录暂时不可用' })
      .waitFor({ state: 'hidden' })
    await page.getByLabel('搜索项目名或简介', { exact: true }).fill('合成验收：不存在的精修项目')
    await page.getByText('没有符合条件的项目', { exact: true }).waitFor()
    await noOverflow(page)
    await page.screenshot({ path: path.join(output, 'desktop-managed-catalog-empty.png') })
    await page.getByRole('button', { name: '清除搜索与筛选', exact: true }).click()
    await page.getByRole('region', { name: '项目进展表', exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await catalogFits(page)
    const managedTable = page.getByRole('region', { name: '项目进展表', exact: true })
    assert.equal(
      await managedTable.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      'Mobile management actions do not need horizontal scrolling'
    )
    assert.equal(await managedAction.count(), 1)
    assert.equal(await managedSettings.count(), 1)
    for (const element of [managedName, managedAction, managedSettings]) {
      const bounds = await element.boundingBox()
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 845,
        'Project identity and actions stay on the first mobile screen'
      )
    }
    assert.equal(await managedRow.locator('.project-created').isVisible(), true)
    await page.screenshot({ path: path.join(output, 'mobile-managed-catalog.png') })
    await page.setViewportSize({ width: 320, height: 844 })
    await page.evaluate(() => scrollTo(0, 0))
    await catalogFits(page)
    const narrowAction = await managedAction.boundingBox()
    assert.ok(
      narrowAction.x >= 0 &&
        narrowAction.x + narrowAction.width <= 320 &&
        narrowAction.y + narrowAction.height <= 845,
      'Two-column management summary keeps the first project action on the 320px screen'
    )
    assert.equal(
      await page
        .locator('.admin-summary')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
      2
    )
    await page.screenshot({ path: path.join(output, 'narrow-managed-catalog.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '打开导航', exact: true }).click()
    const drawer = page.getByRole('dialog')
    await drawer.getByRole('link', { name: '工作台', exact: true }).click()
    await drawer.waitFor({ state: 'hidden' })
    await page.waitForURL('**/workspace')
    await noOverflow(page)
    await primaryWorkFits(page, true)
    await page.screenshot({ path: path.join(output, 'mobile-manager-workbench.png') })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const workbenchProject = page.locator('.workbench-project').first()
    await workbenchProject.hover()
    assert.equal(
      await workbenchProject
        .locator(':scope > .app-icon')
        .evaluate((element) => getComputedStyle(element).transform),
      'none',
      'Reduced motion disables directional row movement'
    )
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await logout(page)
    await login(page, readerEmail)
    await page.getByRole('link', { name: '继续校对', exact: true }).waitFor()
    await primaryWorkFits(page, true)
    assert.equal(
      await page.getByRole('link', { name: '继续校对', exact: true }).count(),
      1,
      'the current task has one resume action'
    )
    await page.goto(base + '/tasks?view=active')
    await page.getByRole('button', { name: '继续校对', exact: false }).waitFor()
    await catalogFits(page)
    assert.ok(
      (await page.locator('.project-work-card').first().boundingBox()).y < 600,
      'Mobile catalog exposes the first task without a screen of statistics'
    )
    await page.screenshot({ path: path.join(output, 'mobile-task-catalog.png') })
    await page.setViewportSize({ width: 320, height: 844 })
    await page.evaluate(() => scrollTo(0, 0))
    await catalogFits(page)
    const narrowTask = await page
      .getByRole('button', { name: '继续校对', exact: true })
      .first()
      .boundingBox()
    assert.ok(
      narrowTask.x >= 0 &&
        narrowTask.x + narrowTask.width <= 320 &&
        narrowTask.y + narrowTask.height <= 845,
      'The current task action remains on the first 320px screen'
    )
    await page.screenshot({ path: path.join(output, 'narrow-task-catalog.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(base + '/projects?view=mine')
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await catalogFits(page)
    await page.screenshot({ path: path.join(output, 'mobile-project-catalog.png') })
    await page.goto(base + '/workspace')
    await page.getByRole('link', { name: '继续校对', exact: true }).waitFor()
    await page.getByRole('link', { name: '继续校对', exact: true }).click()
    await page.waitForURL('**/tasks/*/edit')
    const input = page.locator('.proofread-textarea').first()
    await input.focus()
    await input.scrollIntoViewIfNeeded()
    const field = await input.boundingBox()
    const panel = await page.locator('.fields-panel').boundingBox()
    assert.ok(field.y >= panel.y && field.y + field.height <= panel.y + panel.height)
    const controls = page.locator(
      '.mobile-field-navigation button:not(:disabled), .mobile-field-navigation select'
    )
    for (const control of await controls.all()) {
      assert.equal(
        await control.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2
          )
          return element === hit || element.contains(hit)
        }),
        true,
        'Header guidance must not cover field navigation'
      )
    }
    await noOverflow(page)
    await page.screenshot({ path: path.join(output, 'mobile-editor-with-shell.png') })
    assert.deepEqual(errors, [])
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          fullApp: true,
          realApi: true,
          disposableData: true,
          homeStartOneClick: true,
          homeResumeOneClick: true,
          originalQueueQueryAndHash: true,
          ownReviewNoWrites: true,
          projectJoining: true,
          managementOnlyHome: true,
          mobileNavigation: true,
          accountReplacement: true,
          shellEditorHeight: true,
          mobileInputVisible: true,
          reviewedTabCancellation: true,
          guidanceDoesNotCoverControls: true,
          catalogHierarchyAndMobileFit: true,
          narrowManagementActionVisible: true,
          catalogEmptyRecovery: true,
          workbenchReducedMotion: true,
          sidebarKeyboardFocus: true,
          managementMenuRoute: true,
          managementRefreshFailureRetention: true,
          compactPrimaryWork: true,
          claimingActionStableGeometry: true,
          mobileManagementActionsInView: true,
          managementDetailsDisclosure: true,
          nativeKeyboardVerified: false
        },
        null,
        2
      )
    )
    console.log(
      'PASS full App + real API workbench: start/resume, queue return query/hash, own-review no writes, project join, manager home, mobile drawer, account replacement and editor fit'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
