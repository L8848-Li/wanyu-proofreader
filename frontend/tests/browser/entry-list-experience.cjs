const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const base = process.env.REVIEW_BASE_URL
const backend = process.env.PB_URL
const output = path.resolve(__dirname, '../../../output/playwright/entry-list-experience')
async function api(endpoint, token, body, method = 'POST') {
  const form = body instanceof FormData
  const response = await fetch(backend + endpoint, {
    method,
    headers: {
      Authorization: token || '',
      ...(!form ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {})
  })
  const raw = await response.text()
  assert.ok(response.ok, `${endpoint}: ${response.status} ${raw}`)
  return raw ? JSON.parse(raw) : null
}
;(async () => {
  assert.ok(base && backend && process.env.FANGJI_TEST_DATA_DIR, 'Use a disposable harness backend')
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(backend).hostname))
  const admin = await api('/api/collections/users/auth-with-password', '', {
    identity: process.env.APP_ADMIN_EMAIL,
    password: process.env.APP_ADMIN_PASSWORD
  })
  const project = await api('/api/fangji/projects', admin.token, {
    name: '合成条目样板 · 字符与交互验收'
  })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    const upload = new FormData()
    upload.set(
      'file',
      new Blob([
        'PDF页码,索引,记音,释义,备注\n1,𠮷,a̤̍⁵³³,  保留空白  ,  注\t释  \n2,食,ia̍h,吃,\n3,囝,kiâ,孩子,\n4,目,ba̍k,眼睛,\n'
      ]),
      'synthetic-entry-list.csv'
    )
    const job = await api(`/api/fangji/projects/${project.id}/imports/csv`, admin.token, upload)
    for (let i = 0; i < 100; i++) {
      const state = await api(
        `/api/collections/import_jobs/records/${job.id}`,
        admin.token,
        null,
        'GET'
      )
      assert.notEqual(state.status, 'failed', state.error_message)
      if (state.status === 'completed') break
      assert.ok(i < 99, 'import must finish')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    let rows = await api(
      `/api/fangji/projects/${project.id}/pages?page=1&perPage=25`,
      admin.token,
      null,
      'GET'
    )
    // Exercise saved field fidelity through the existing manager correction API.
    // CSV import currently trims edges before storing; this presentation test
    // deliberately verifies values that actually contain legal whitespace.
    const imported = rows.items[0]
    const corrected = {
      ...JSON.parse(imported.ocr_row_json),
      释义: '  保留空白  ',
      备注: '  注\t释  '
    }
    await api(`/api/fangji/projects/${project.id}/pages/${imported.id}/content`, admin.token, {
      rowJson: JSON.stringify(corrected),
      headersJson: imported.row_headers_json,
      expectedUpdated: imported.updated
    })
    rows = await api(
      `/api/fangji/projects/${project.id}/pages?page=1&perPage=25`,
      admin.token,
      null,
      'GET'
    )
    const expected = rows.items[0].ocr_text
    const expectedRow = JSON.parse(rows.items[0].ocr_row_json)
    assert.equal(expectedRow.释义, '  保留空白  ')
    await api(
      `/api/fangji/projects/${project.id}/column-roles`,
      admin.token,
      {
        roles: { 索引: 'headword', 记音: 'reading', 释义: 'meaning', 备注: 'note' }
      },
      'PUT'
    )
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
      ({ backend, admin }) => {
        window.__FANGJI_BACKEND_URL__ = backend
        localStorage.setItem('pocketbase_auth', JSON.stringify(admin))
      },
      { backend, admin }
    )
    await fs.mkdir(output, { recursive: true })
    await page.route(
      `**/api/fangji/projects/${project.id}/column-roles`,
      (route) => route.fulfill({ status: 503, json: { message: '合成列用途读取故障' } }),
      { times: 1 }
    )
    await page.goto(base + `/admin/projects/${project.id}?section=work&view=entries`)
    const section = page.locator('#project-entries')
    await section.locator('tbody tr').first().waitFor()
    assert.equal(await section.locator('tbody tr').count(), 4)
    assert.equal(await section.locator('input[type=checkbox]').count(), 0)
    await section.getByRole('alert').filter({ hasText: '列用途暂时无法读取' }).waitFor()
    assert.equal(
      await section.locator('.entry-field--headword').count(),
      0,
      'Unavailable roles remain neutral'
    )
    assert.equal(
      await section.locator('[data-entry-field="索引"] .entry-field-value').first().textContent(),
      expectedRow.索引
    )
    await section.getByRole('button', { name: '重试列用途', exact: true }).click()
    const firstEntry = section.locator('tbody tr').first()
    await firstEntry.locator('.entry-field--headword').waitFor()
    for (const [name, value] of Object.entries(expectedRow)) {
      assert.equal(
        await firstEntry.locator(`[data-entry-field="${name}"] .entry-field-value`).textContent(),
        value
      )
    }
    assert.equal(
      await firstEntry.locator('.entry-field--reading .entry-field-value').textContent(),
      'a̤̍⁵³³'
    )
    const originals = firstEntry.locator('.entry-original-values')
    assert.equal(await originals.getAttribute('data-state'), 'closed')
    assert.equal(
      await section.locator('.entry-original-text').count(),
      0,
      'Closed original values are not mounted before first use'
    )
    assert.equal(await section.locator('.entry-original-values [data-field-value-text]').count(), 0)
    await originals.getByRole('button', { name: '查看原值', exact: true }).click()
    await originals.locator('.entry-original-text').waitFor({ state: 'visible' })
    assert.equal(await originals.locator('.entry-original-text').textContent(), expected)
    const originalTextNode = await originals.locator('.entry-original-text').elementHandle()
    for (const [name, value] of Object.entries(expectedRow)) {
      assert.equal(
        await originals
          .locator('dl > div')
          .filter({ has: page.locator('dt', { hasText: name }) })
          .locator('dd')
          .textContent(),
        value
      )
    }
    await originals.getByRole('button', { name: '查看原值', exact: true }).click()
    await originals.locator('.entry-original-text').waitFor({ state: 'hidden' })
    assert.equal(
      await originals
        .locator('.entry-original-text')
        .evaluate((node, saved) => node === saved, originalTextNode),
      true,
      'First-open original values remain the same DOM after closing'
    )
    await originals.getByRole('button', { name: '查看原值', exact: true }).click()
    await originals.locator('.entry-original-text').waitFor({ state: 'visible' })
    assert.equal(
      await originals
        .locator('.entry-original-text')
        .evaluate((node, saved) => node === saved, originalTextNode),
      true,
      'Reopening retains the original DOM'
    )
    assert.equal(await originals.locator('.entry-original-text').textContent(), expected)
    await originals.getByRole('button', { name: '查看原值', exact: true }).click()
    await originals.locator('.entry-original-text').waitFor({ state: 'hidden' })
    assert.equal(
      await section
        .locator('.entry-progress-cell .badge-pending')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgba(0, 0, 0, 0)'
    )
    const firstRow = await section.locator('tbody tr').first().boundingBox()
    const secondRow = await section.locator('tbody tr').nth(1).boundingBox()
    assert.ok(firstRow.height <= 140, `Short entry with note stays compact: ${firstRow.height}px`)
    assert.ok(
      secondRow.height <= 118,
      `Short entry without note stays compact: ${secondRow.height}px`
    )
    const word = await firstEntry.locator('.entry-field--headword').boundingBox()
    const reading = await firstEntry.locator('.entry-field--reading').boundingBox()
    const meaning = await firstEntry.locator('.entry-field--meaning').boundingBox()
    assert.ok(
      Math.max(word.y, reading.y, meaning.y) <
        Math.min(word.y + word.height, reading.y + reading.height, meaning.y + meaning.height),
      'Word, reading and short meaning share a reading line'
    )
    const location = await firstEntry.locator('.entry-content-location').boundingBox()
    const originalTrigger = await originals
      .getByRole('button', { name: '查看原值', exact: true })
      .boundingBox()
    assert.ok(
      originalTrigger.y < location.y + location.height &&
        originalTrigger.y + originalTrigger.height > location.y,
      'Original values action shares the location line'
    )
    assert.equal(
      await firstEntry
        .locator('.entry-content-cell')
        .evaluate((el) => getComputedStyle(el).display),
      'table-cell'
    )
    await page.screenshot({ path: path.join(output, 'desktop-list.png'), fullPage: true })
    await page.evaluate(async () => {
      await document.fonts.ready
      const originalLoad = document.fonts.load.bind(document.fonts)
      window.__entryUnchangedTextFontLoads = 0
      document.fonts.load = (...args) => {
        window.__entryUnchangedTextFontLoads++
        return originalLoad(...args)
      }
    })
    await section.getByRole('button', { name: '批量选择', exact: true }).click()
    await section.getByRole('button', { name: '全选待校对', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('#project-entries input[type=checkbox]:checked').length === 4
    )
    await section.getByRole('button', { name: '退出批量', exact: true }).click()
    assert.equal(await section.locator('input[type=checkbox]').count(), 0)
    assert.equal(
      await page.evaluate(() => window.__entryUnchangedTextFontLoads),
      0,
      'Unchanged list content does not restart font checks during batch selection'
    )
    await section.getByRole('button', { name: '查看第 1 条详情与修正', exact: true }).click()
    await page.getByRole('dialog').getByRole('heading', { name: '修正识别结果' }).waitFor()
    assert.equal(
      await page.getByRole('dialog').getByLabel('记音', { exact: true }).inputValue(),
      'a̤̍⁵³³'
    )
    await page.keyboard.press('Escape')
    await section.getByRole('button', { name: '第 1 条的更多操作', exact: true }).click()
    assert.equal(
      await page.getByRole('menuitem', { name: '上移', exact: true }).getAttribute('aria-disabled'),
      'true'
    )
    await page.getByRole('menuitem', { name: '设置质量状态', exact: true }).click()
    const quality = page.getByRole('dialog')
    await quality.getByRole('heading', { name: '设置条目质量状态' }).waitFor()
    assert.equal(
      await quality.getByRole('button', { name: '保存', exact: true }).isDisabled(),
      true
    )
    await quality.getByLabel('依据（必填）', { exact: true }).fill('合成界面验收：已核对来源')
    await quality.getByRole('button', { name: '保存', exact: true }).click()
    await quality.waitFor({ state: 'hidden' })
    await section.getByRole('button', { name: '筛选', exact: true }).click()
    await section.getByRole('combobox', { name: '质量状态', exact: true }).click()
    await page.getByRole('option', { name: '已确认', exact: true }).click()
    await page.waitForURL((url) => url.searchParams.get('qualityState') === 'validated')
    await page.waitForFunction(
      () => document.querySelectorAll('#project-entries tbody tr').length === 1
    )
    await page.reload()
    await section.getByRole('combobox', { name: '质量状态', exact: true }).waitFor()
    await section.getByRole('button', { name: '清除筛选', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('#project-entries tbody tr').length === 4
    )
    const search = section.getByRole('searchbox', { name: '搜索条目', exact: true })
    await page.route(
      `**/api/fangji/projects/${project.id}/pages?*`,
      (route) => route.fulfill({ status: 503, json: { message: '合成读取故障' } }),
      { times: 1 }
    )
    await search.fill('  𠮷  ')
    await section.getByRole('alert').filter({ hasText: '当前仍显示上次结果' }).waitFor()
    assert.equal(await section.locator('tbody tr').count(), 4)
    await section.getByRole('button', { name: '重新加载', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('#project-entries tbody tr').length === 1
    )
    assert.equal(new URL(page.url()).searchParams.get('q'), '𠮷')
    // A successful empty result belongs to that query. It must not announce
    // that a later pending or failed query is empty too.
    await search.fill('没有这条合成记录')
    await section.getByText('没有符合当前条件的条目', { exact: true }).waitFor()
    let releaseEmptyQuery, notifyEmptyQuery
    const emptyGate = new Promise((resolve) => {
      releaseEmptyQuery = resolve
    })
    const emptyRequested = new Promise((resolve) => {
      notifyEmptyQuery = resolve
    })
    const pagesRoute = `**/api/fangji/projects/${project.id}/pages?*`
    await page.route(pagesRoute, async (route) => {
      if (new URL(route.request().url()).searchParams.get('q') !== '食') return route.continue()
      notifyEmptyQuery()
      await emptyGate
      await route.fulfill({ status: 503, json: { message: '合成空态后续读取故障' } })
    })
    await search.fill('食')
    await emptyRequested
    await section.getByRole('status').filter({ hasText: '正在更新条目' }).waitFor()
    assert.equal(await section.getByText('没有符合当前条件的条目', { exact: true }).count(), 0)
    releaseEmptyQuery()
    await section.getByRole('alert').filter({ hasText: '合成空态后续读取故障' }).waitFor()
    assert.equal(await section.getByText('没有符合当前条件的条目', { exact: true }).count(), 0)
    await page.unroute(pagesRoute)
    await section.getByRole('button', { name: '重新加载', exact: true }).click()
    await section.locator('tbody tr').first().waitFor()
    assert.match(
      await section.locator('.entry-field--headword .entry-field-value').first().textContent(),
      /食/
    )
    await search.fill('𠮷')
    await page.waitForFunction(
      (expected) =>
        document.querySelector('#project-entries .entry-field--headword .entry-field-value')
          ?.textContent === expected,
      expectedRow.索引
    )
    const superuser = await api('/api/collections/_superusers/auth-with-password', '', {
      identity: process.env.PB_SUPER_EMAIL,
      password: process.env.PB_SUPER_PASSWORD
    })
    const rawText = '\n  原值回退  𠮷\ta̤̍⁵³³  ' + '原样保留'.repeat(40) + '  \n'
    await api('/api/collections/pages/records', superuser.token, {
      project: project.id,
      page_number: 5,
      status: 'pending',
      ocr_text: rawText,
      ocr_row_json: '',
      row_headers_json: ''
    })
    await search.fill('原值回退')
    await page.waitForFunction(
      (value) =>
        document.querySelector('#project-entries .entry-content-text')?.textContent === value,
      rawText
    )
    assert.equal(
      await section.locator('.entry-content-fields').count(),
      0,
      'Free-form text is not split into invented fields'
    )
    await section
      .locator('.entry-original-values')
      .getByRole('button', { name: '查看原值', exact: true })
      .click()
    assert.equal(await section.locator('.entry-original-text').textContent(), rawText)
    await search.fill('𠮷')
    await page.waitForFunction(
      () => document.querySelectorAll('#project-entries tbody tr').length === 2
    )
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await section.locator('tbody tr').first().waitFor()
    await page.evaluate(() => scrollTo(0, 0))
    await section.locator('.entry-mobile-status').first().waitFor({ state: 'visible' })
    assert.match(
      await section.locator('.entry-mobile-status').first().innerText(),
      /待校对.*0\/2.*质量已确认/s
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    const tableGeometry = await section
      .locator('.table-wrapper')
      .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }))
    assert.ok(tableGeometry.scroll <= tableGeometry.width, JSON.stringify(tableGeometry))
    const mobileText = await section.locator('.entry-content-cell').first().boundingBox()
    assert.ok(mobileText.width > 190)
    const mobileRow = await section.locator('tbody tr').first().boundingBox()
    const mobileOriginalTrigger = await section
      .locator('tbody tr')
      .first()
      .locator('.entry-original-values')
      .getByRole('button', { name: '查看原值', exact: true })
      .boundingBox()
    assert.ok(
      mobileOriginalTrigger.height >= 44,
      'Mobile original values action keeps its touch target'
    )
    await page.screenshot({ path: path.join(output, 'mobile-list.png'), fullPage: true })
    await section.getByRole('button', { name: '第 1 条的更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '设置质量状态', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    const summaryUrl = `**/api/fangji/projects/${project.id}/verification-summary`
    await page.route(summaryUrl, (route) =>
      route.fulfill({ status: 503, json: { message: '合成来源复核统计读取失败' } })
    )
    await page.goto(`${base}/admin/projects/${project.id}?section=work&view=queue`)
    const queue = page.getByRole('region', { name: '选择待办队列' })
    const reviewRow = queue.getByRole('listitem').filter({
      has: page.getByRole('heading', { name: '来源复核', exact: true })
    })
    const errorPanel = reviewRow.getByRole('alert')
    await errorPanel.getByText('合成来源复核统计读取失败').waitFor()
    await queue.getByRole('link', { name: '处理仲裁', exact: true }).first().waitFor()
    await page.screenshot({ path: path.join(output, 'mobile-queue-retry.png'), fullPage: true })
    await page.unroute(summaryUrl)
    await errorPanel.getByRole('button', { name: '重试读取', exact: true }).press('Enter')
    await errorPanel.waitFor({ state: 'hidden' })
    assert.equal(
      await reviewRow
        .getByRole('link', { name: '打开复核队列', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    )
    assert.deepEqual(errors, [])
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          synthetic: true,
          desktopFirstRowY: firstRow.y,
          desktopFirstRowHeight: firstRow.height,
          desktopShortRowHeight: secondRow.height,
          mobileContentWidth: mobileText.width,
          mobileFirstRowY: mobileRow.y,
          checks: [
            'structured field roles from authorized API with neutral failure and retry',
            'exact structured values and lazy original disclosure retaining DOM after first open',
            'batch controls do not restart unchanged font checks',
            'unstructured raw fallback retains whitespace and full text without splitting',
            'compact desktop rows with shared location/action and word/reading/meaning line',
            'neutral pending',
            'batch enter/select/exit',
            'content detail IPA',
            'quality required basis and save',
            'filter URL reload',
            'failed fetch retains rows and retry',
            'empty result is not reused for a pending or failed query',
            '390px summary and menu'
          ],
          pageErrors: errors
        },
        null,
        2
      )
    )
    console.log(
      'PASS entry list sample: real API, exact text, batch, details, quality/menu, filters/retry and 390px summary'
    )
  } finally {
    await browser.close()
    const superuser = await api('/api/collections/_superusers/auth-with-password', '', {
      identity: process.env.PB_SUPER_EMAIL,
      password: process.env.PB_SUPER_PASSWORD
    })
    await api(`/api/collections/projects/records/${project.id}`, superuser.token, null, 'DELETE')
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
