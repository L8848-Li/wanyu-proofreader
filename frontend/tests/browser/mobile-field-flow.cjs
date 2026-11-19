const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'
const output =
  process.env.MOBILE_FIELD_FLOW_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/mobile-field-flow')

const uncovered = (element) => {
  const r = element.getBoundingClientRect()
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return r.y >= 0 && r.bottom <= innerHeight && (hit === element || element.contains(hit))
}
async function setup(browser, viewport, { admin = false, readOnly = false } = {}) {
  const page = await browser.newPage({ viewport })
  const pageErrors = [],
    writes = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      (readOnly || /\/(submit|arbitrate)$/.test(new URL(request.url()).pathname))
    )
      writes.push(request.url())
  })
  await installReviewRoutes(page)
  if (readOnly)
    await page.route('**/api/fangji/pages/page1/task*', (route) =>
      route.fulfill({
        json: {
          id: 'page1',
          project: 'project1',
          page_number: 1,
          pdf_page: 5,
          readonly: true,
          status: 'approved',
          ocr_row_json: JSON.stringify({ 字词: '测试', 读音: 'tɛ', 释义: '演示材料' }),
          proofread_row_json: JSON.stringify({ 字词: '已校测试', 读音: 'tɛ', 释义: '演示材料' })
        }
      })
    )
  await page.goto(base + '/tests/fixtures/review.html' + (admin ? '?admin' : ''))
  await page
    .locator(admin ? '.arbitration-field' : '.proofread-field')
    .first()
    .waitFor()
  return { page, pageErrors, writes }
}
;(async () => {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const report = { synthetic: true, nativeMobileKeyboardVerified: false, cases: [], checks: {} }
  try {
    for (const [width, height] of [
      [390, 844],
      [320, 844],
      [640, 400]
    ]) {
      const { page, pageErrors, writes } = await setup(browser, { width, height })
      const nav = page.getByRole('navigation', { name: '字段导航', exact: true })
      const first = page.locator('.proofread-textarea').first()
      await page.waitForFunction(
        () => document.querySelector('.proofread-textarea')?.readOnly === false
      )
      await first.fill('甲乙')
      await first.evaluate((el) => {
        window.__flowInput = el
        el.setSelectionRange(1, 1)
        el.dispatchEvent(new Event('select'))
      })
      assert.equal(await nav.getByRole('combobox').inputValue(), '0')
      await nav.getByRole('button', { name: '总览/提交', exact: true }).waitFor()
      assert.equal(
        await nav.getByRole('button', { name: '下一字段', exact: true }).innerText(),
        '下一字段'
      )
      await nav.getByRole('button', { name: '下一字段', exact: true }).click()
      assert.equal(await nav.getByRole('combobox').inputValue(), '1')
      assert.equal(
        await page
          .locator('.proofread-field:visible')
          .evaluate((el) => el === document.activeElement),
        true,
        'Field navigation focuses the new field region without opening an input method'
      )
      await nav.getByRole('combobox').selectOption('0')
      assert.equal(await first.evaluate((el) => el === window.__flowInput), true)
      const controls = await nav.boundingBox()
      assert.ok(controls.height <= 60, `${width}: the footer stays on one compact row`)
      for (const target of await nav.locator('button, select').all()) {
        const bounds = await target.boundingBox()
        assert.ok(
          bounds.width >= 44 && bounds.height >= 44,
          `${width}: touch target ${await target.innerText()} ${JSON.stringify(bounds)}`
        )
      }
      const toggle = page.getByRole('button', { name: '字符键盘', exact: true })
      await toggle.click()
      await page.getByRole('button', { name: '钉住', exact: true }).click()
      assert.equal(
        await first.evaluate(uncovered),
        true,
        `${width}: the active field stays visible above the tray`
      )
      await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
      assert.equal(await first.inputValue(), '甲ɑ乙')
      assert.equal(await first.evaluate((el) => el === window.__flowInput), true)
      await page.screenshot({ path: path.join(output, `fields-${width}x${height}.png`) })
      // The overview is available from field one, rather than requiring a tour
      // through every field. Viewing it does not certify any source judgment.
      await nav.getByRole('button', { name: '总览/提交', exact: true }).click()
      assert.equal(await page.locator('.proofread-field:visible').count(), 3)
      assert.equal(
        await page
          .locator('.proofread-textarea')
          .evaluateAll((items) => items.every((el) => el.readOnly)),
        true
      )
      assert.equal(await page.locator('.keyboard-panel').isVisible(), false)
      assert.match(await nav.innerText(), /总览/)
      const submit = nav.getByRole('button', { name: '检查并提交', exact: true })
      await submit.click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      assert.equal(writes.length, 0)
      assert.equal(
        await dialog.getByRole('button', { name: '确认提交', exact: true }).isDisabled(),
        true
      )
      await page.keyboard.press('Escape')
      assert.equal(await submit.evaluate((el) => el === document.activeElement), true)
      await page.screenshot({ path: path.join(output, `overview-${width}x${height}.png`) })
      await nav.getByRole('button', { name: '返回编辑', exact: true }).click()
      assert.equal(await nav.getByRole('combobox').inputValue(), '0')
      assert.equal(await first.inputValue(), '甲ɑ乙')
      assert.equal(await first.evaluate((el) => el === window.__flowInput), true)
      assert.equal(await first.evaluate(uncovered), true)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      assert.deepEqual(pageErrors, [])
      report.cases.push({
        viewport: [width, height],
        footerHeight: controls.height,
        firstFieldOverview: true,
        textNextAction: true,
        inputUncoveredWithTray: true,
        caretInsertion: '甲ɑ乙',
        originalTextareaRetained: true,
        overviewDoesNotSubmit: true,
        confirmationRetained: true,
        pageErrors
      })
      await page.close()
    }
    {
      const { page, pageErrors, writes } = await setup(
        browser,
        { width: 390, height: 844 },
        { admin: true }
      )
      const nav = page.getByRole('navigation', { name: '字段导航', exact: true })
      await nav.getByRole('button', { name: '总览/提交', exact: true }).click()
      assert.equal(
        await nav.getByRole('button', { name: '检查并仲裁', exact: true }).isDisabled(),
        true
      )
      await nav.getByRole('button', { name: '返回编辑', exact: true }).click()
      await page
        .locator('.arbitration-field:visible')
        .getByRole('button', { name: '采用导入值', exact: true })
        .click()
      await nav.getByRole('button', { name: '总览/提交', exact: true }).click()
      await nav.getByRole('button', { name: '检查并仲裁', exact: true }).click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '确认完成仲裁', exact: true })
        .waitFor()
      assert.equal(writes.length, 0)
      await page.keyboard.press('Escape')
      await page.screenshot({ path: path.join(output, 'arbitration-overview-390.png') })
      assert.deepEqual(pageErrors, [])
      report.checks.arbitrationUnresolvedBlocked = true
      report.checks.arbitrationConfirmationRetained = true
      await page.close()
    }
    {
      const { page, pageErrors, writes } = await setup(
        browser,
        { width: 320, height: 844 },
        { readOnly: true }
      )
      const nav = page.getByRole('navigation', { name: '字段导航', exact: true })
      await nav.getByRole('button', { name: '整条总览', exact: true }).click()
      assert.equal(await nav.getByRole('button', { name: /提交|仲裁/ }).count(), 0)
      assert.equal(await page.getByRole('button', { name: '查看此字段', exact: true }).count(), 3)
      assert.equal(await page.getByRole('button', { name: '修改此字段', exact: true }).count(), 0)
      await nav.getByRole('button', { name: '返回查看', exact: true }).click()
      assert.equal(await page.locator('.proofread-textarea:visible').getAttribute('readonly'), '')
      assert.equal(writes.length, 0)
      assert.deepEqual(pageErrors, [])
      report.checks.readOnlyHasNoSubmitEntry = true
      await page.screenshot({ path: path.join(output, 'readonly-field-320.png') })
      await page.close()
    }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(
      'PASS: mobile field → overview → confirmation path, 320/390/640, input/caret/DOM, read-only and arbitration gates; zero submissions'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
