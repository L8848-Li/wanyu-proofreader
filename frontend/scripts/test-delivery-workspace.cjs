const assert = require('node:assert/strict')
const { readFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

;(async () => {
  const fixture = JSON.parse(readFileSync(process.env.DELIVERY_BROWSER_FIXTURE, 'utf8'))
  const { backend, admin, project, batch, delivery, source, pendingPage, excludedPage } = fixture
  async function api(endpoint, method = 'GET', body, status = 200) {
    const response = await fetch(backend + endpoint, {
      method,
      headers: { Authorization: admin.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    const value = await response.json()
    assert.equal(response.status, status, JSON.stringify(value))
    return value
  }
  const origin = process.env.FRONTEND_URL || 'http://127.0.0.1:5197'
  const out = process.env.DELIVERY_BROWSER_OUTPUT || '/tmp/wanyu-delivery-browser'
  mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.context().addInitScript(
      ({ backend, admin }) => {
        globalThis.__FANGJI_BACKEND_URL__ = backend
        localStorage.setItem(
          'pocketbase_auth',
          JSON.stringify({ token: admin.token, record: admin.record })
        )
      },
      { backend, admin }
    )
    const projectPath = `${origin}/admin/projects/${project.id}`
    const deliveryPath = new URL(`${projectPath}/deliveries`).pathname
    const isDeliveryDetail = (url, tab) =>
      url.pathname === deliveryPath &&
      Boolean(url.searchParams.get('package')) &&
      url.searchParams.get('tab') === tab &&
      url.searchParams.get('page') === '1' &&
      url.searchParams.get('listPage') === '1'
    await page.goto(`${projectPath}/adoption?batch=${batch.id}&tab=overview&page=1`)
    await page.getByRole('heading', { name: batch.recipient, exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: batch.recipient, exact: true }).waitFor()
    await page.getByRole('button', { name: '判断与历史', exact: true }).click()
    await page.waitForURL('**/adoption?batch=*&tab=history&page=1')
    await page.goBack()
    await page.getByRole('link', { name: '准备交付包', exact: true }).waitFor()
    await page.screenshot({ path: path.join(out, 'adoption-deep-link.png'), fullPage: true })
    await page.getByRole('link', { name: '准备交付包', exact: true }).click()
    await page.getByRole('heading', { name: '准备交付包', exact: true }).waitFor()
    const reviewer = page.getByLabel('本次人工核查者', { exact: true })
    await reviewer.fill('Synthetic browser reviewer')
    await page.getByRole('button', { name: '返回交付记录', exact: true }).click()
    await page.getByRole('heading', { name: '离开当前工作区？', exact: true }).waitFor()
    await page.getByRole('button', { name: '继续处理', exact: true }).click()
    assert.equal(await reviewer.inputValue(), 'Synthetic browser reviewer')
    await page
      .getByRole('button', { name: '这是重发版本（首次交付无需填写）', exact: true })
      .click()
    await page.getByLabel('前一版本包标识（首次留空）', { exact: true }).fill(delivery.id)
    await page
      .getByLabel('重发变更说明', { exact: true })
      .fill('Synthetic browser replay validation')
    const transfer = '/api/fangji/sources/' + source.id + '/usages/raw_third_party_transfer'
    await api(transfer, 'PUT', { decision: 'deny', evidence_ref: 'synthetic fixture denial' })
    const preflight = page.getByRole('button', { name: '检查本批交付范围', exact: true })
    await preflight.click()
    const rights = page.getByRole('link', { name: '核对来源许可 · 原始材料转交第三方' })
    await rights.waitFor()
    assert.equal(await page.getByRole('button', { name: '生成交付包', exact: true }).count(), 0)
    const [sourceTab] = await Promise.all([page.waitForEvent('popup'), rights.click()])
    await sourceTab.waitForURL(
      (url) =>
        url.pathname === '/admin/sources' &&
        url.searchParams.get('sourceId') === source.id &&
        url.searchParams.get('purpose') === 'raw_third_party_transfer'
    )
    const permission = sourceTab.getByRole('region', { name: '核对交付所需的来源许可' })
    await permission.getByRole('heading', { name: source.title }).waitFor()
    assert.equal(await permission.getByLabel('用途结论').inputValue(), 'deny')
    assert.equal(await permission.getByRole('button', { name: '保存用途结论' }).isDisabled(), true)
    await sourceTab.screenshot({
      path: path.join(out, 'delivery-source-permission.png'),
      fullPage: true
    })
    await permission.getByLabel('用途结论').selectOption('allow')
    await permission.getByLabel('授权证据位置').fill('synthetic fixture restored authorization')
    await permission.getByRole('button', { name: '保存用途结论' }).click()
    await permission.getByText('用途结论已保存。', { exact: true }).waitFor()
    assert.equal(
      (await api('/api/fangji/sources/' + source.id)).usages.find(
        ({ purpose }) => purpose === 'raw_third_party_transfer'
      ).decision,
      'allow'
    )
    await sourceTab.close()
    assert.equal(await reviewer.inputValue(), 'Synthetic browser reviewer')
    assert.equal(
      await page.getByRole('combobox', { name: '编选批次', exact: true }).inputValue(),
      batch.id
    )
    assert.equal(
      await page.getByLabel('前一版本包标识（首次留空）', { exact: true }).inputValue(),
      delivery.id
    )
    await preflight.click()
    await page.getByRole('heading', { name: '数量一致，等待人工决定', exact: true }).waitFor()
    await page.screenshot({ path: path.join(out, 'delivery-native-preflight.png'), fullPage: true })
    // Actual generation remains a synthetic human-action fixture, never a real
    // release approval. The persisted contract still says human_required.
    await page.locator('.delivery-confirmation input[type="checkbox"]').check()
    await page.getByRole('button', { name: /生成交付包/ }).click()
    await page.waitForURL((url) => isDeliveryDetail(url, 'summary'))
    await page.getByRole('button', { name: '下载交付包', exact: true }).waitFor()
    const generatedURL = new URL(page.url())
    const generatedPackage = generatedURL.searchParams.get('package')
    assert.notEqual(generatedPackage, delivery.id, '生成后应打开新交付包，而不是前一版本')
    await page.reload()
    await page.getByRole('button', { name: '下载交付包', exact: true }).waitFor()
    await page.getByRole('button', { name: '回执与处置', exact: true }).click()
    await page.waitForURL(
      (url) =>
        isDeliveryDetail(url, 'events') && url.searchParams.get('package') === generatedPackage
    )
    await page.getByRole('button', { name: '登记回执或处置', exact: true }).click()
    await page.getByRole('heading', { name: /^登记：/ }).waitFor()
    assert.equal(
      await page
        .getByRole('heading', { name: /^登记：/ })
        .evaluate((element) => element === document.activeElement),
      true,
      'opening the extracted receipt panel focuses its heading'
    )
    await page.getByLabel('原因／处置说明', { exact: true }).fill('unsaved synthetic receipt')
    await page.getByRole('button', { name: '登记回执或处置', exact: true }).click()
    assert.equal(
      await page.getByLabel('原因／处置说明', { exact: true }).inputValue(),
      'unsaved synthetic receipt'
    )
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await page.getByRole('heading', { name: /^登记：/ }).focus()
      await page.evaluate(() => window.scrollTo(0, 0))
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `receipt editor must fit ${width}px without page overflow`
      )
      await page.screenshot({ path: path.join(out, `receipt-${width}.png`), fullPage: true })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: '范围与凭据', exact: true }).click()
    await page.getByRole('heading', { name: '离开当前工作区？', exact: true }).waitFor()
    await page.getByRole('button', { name: '继续处理', exact: true }).click()
    assert.ok(isDeliveryDetail(new URL(page.url()), 'events'))
    await page.getByRole('button', { name: '范围与凭据', exact: true }).click()
    await page.getByRole('button', { name: '确认离开', exact: true }).click()
    await page.waitForURL(generatedURL.href)
    await page.screenshot({ path: path.join(out, 'delivery-detail.png'), fullPage: true })
    await page.getByRole('button', { name: '返回交付记录', exact: true }).click()
    await page.waitForURL(
      ({ pathname, searchParams }) =>
        pathname === deliveryPath &&
        searchParams.get('view') === 'records' &&
        searchParams.get('page') === '1' &&
        !searchParams.has('listPage') &&
        !searchParams.has('package')
    )
    await page.getByRole('heading', { name: '交付记录', exact: true }).waitFor()
    await api('/api/fangji/pages/' + pendingPage + '/blocked-reason', 'PUT', {
      reason: 'unknown',
      basis: 'synthetic fixture pending classification'
    })
    const pendingDraft = await api(
      '/api/fangji/projects/' + project.id + '/adoption-batches',
      'POST',
      {
        purpose: batch.purpose,
        recipient: 'Synthetic pending recipient',
        rule: batch.rule
      },
      201
    )
    const batchEndpoint = '/api/fangji/adoption-batches/' + pendingDraft.id
    const recordedDecision = await api(batchEndpoint + '/exceptions', 'POST', {
      page: excludedPage,
      decision: 'exclude',
      reason: 'unknown',
      note: 'synthetic fixture intentionally excluded'
    })
    await api(batchEndpoint + '/preview', 'POST')
    const confirmedPending = await api(batchEndpoint + '/confirm', 'POST')
    assert.equal(confirmedPending.counts.pending, 1)
    await page.goto(projectPath + '/deliveries?view=prepare&adoption=' + confirmedPending.id)
    await reviewer.fill('Synthetic exceptions reviewer')
    await preflight.click()
    const exceptions = page.getByRole('link', { name: '查看本批编选例外', exact: true })
    await exceptions.waitFor()
    assert.equal(
      await page.getByRole('button', { name: '生成交付包', exact: true }).isDisabled(),
      true
    )
    const [adoptionTab] = await Promise.all([page.waitForEvent('popup'), exceptions.click()])
    await adoptionTab.waitForURL(
      (url) =>
        url.pathname.endsWith('/adoption') &&
        url.searchParams.get('batch') === confirmedPending.id &&
        url.searchParams.get('tab') === 'exceptions'
    )
    await adoptionTab.getByText(/1 条待处理。当前页 1 条/).waitFor()
    assert.equal(await adoptionTab.getByRole('button', { name: '保存这一条' }).count(), 0)
    await adoptionTab.screenshot({
      path: path.join(out, 'delivery-adoption-pending.png'),
      fullPage: true
    })
    await adoptionTab.getByRole('button', { name: '沿用范围创建并预览' }).click()
    await adoptionTab.waitForURL((url) => {
      const replacement = url.searchParams.get('batch')
      return (
        replacement &&
        replacement !== confirmedPending.id &&
        url.searchParams.get('tab') === 'exceptions'
      )
    })
    const replacementId = new URL(adoptionTab.url()).searchParams.get('batch')
    const replacementEndpoint = '/api/fangji/adoption-batches/' + replacementId
    const replacement = await api(replacementEndpoint)
    assert.equal(replacement.recipient, confirmedPending.recipient)
    assert.equal(replacement.purpose, confirmedPending.purpose)
    assert.deepEqual(replacement.rule, confirmedPending.rule)
    assert.equal(replacement.status, 'previewed')
    const copiedDecisions = await api(replacementEndpoint + '/exceptions')
    assert.deepEqual(copiedDecisions.exceptions, [recordedDecision.exception])
    const conflict = await api(batchEndpoint + '/continue', 'POST', undefined, 409)
    assert.equal(conflict.batch.id, replacementId)
    await api(replacementEndpoint + '/continue', 'POST', undefined, 400)
    await adoptionTab
      .getByLabel('依据', { exact: true })
      .fill('synthetic fixture reviewed original')
    await adoptionTab.getByRole('button', { name: '保存这一条', exact: true }).click()
    await adoptionTab.getByText('没有待处理的例外。', { exact: true }).waitFor()
    await adoptionTab.getByRole('button', { name: '返回核对数量', exact: true }).click()
    await adoptionTab.getByRole('button', { name: '预览并核对数量', exact: true }).click()
    await adoptionTab.getByRole('button', { name: '确认本批采用范围', exact: true }).click()
    const adoptConfirm = adoptionTab.getByRole('dialog')
    await adoptConfirm.getByRole('button', { name: '确认并保留本批范围', exact: true }).click()
    await adoptionTab.getByRole('link', { name: '准备交付包', exact: true }).click()
    await adoptionTab.waitForURL((url) => url.searchParams.get('adoption') === replacementId)
    await adoptionTab
      .getByLabel('本次人工核查者', { exact: true })
      .fill('Synthetic replacement reviewer')
    await adoptionTab.getByRole('button', { name: '检查本批交付范围', exact: true }).click()
    await adoptionTab
      .getByRole('heading', { name: '数量一致，等待人工决定', exact: true })
      .waitFor()
    assert.equal((await api(batchEndpoint)).counts.pending, 1, 'confirmed history stays immutable')
    await adoptionTab.close()
    await page.getByRole('button', { name: '重新检查本批交付范围', exact: true }).click()
    await exceptions.waitFor()
    // A successful create is already saved. It must continue to its detail
    // without asking users to discard the form they have just submitted.
    await page.goto(`${projectPath}/adoption?view=create`)
    await page.getByLabel('接收方', { exact: true }).fill('Synthetic usability recipient')
    await page.getByRole('button', { name: '下一步：选择范围', exact: true }).click()
    await page.getByRole('button', { name: '创建并预览数量', exact: true }).click()
    await page
      .getByRole('heading', { name: 'Synthetic usability recipient', exact: true })
      .waitFor()
    assert.equal(
      await page.getByRole('heading', { name: '离开当前工作区？', exact: true }).count(),
      0
    )
    await page.screenshot({ path: path.join(out, 'adoption-created.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    await page.evaluate(() => window.scrollTo(0, 0))
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'adoption summary must fit the mobile viewport'
    )
    await page.screenshot({ path: path.join(out, 'adoption-created-mobile.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log(
      'PASS browser: source permission deep link and recheck, adoption continuation with original rules and decisions, native generation, delivery detail/receipt and navigation guards; synthetic only'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
