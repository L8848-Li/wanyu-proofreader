const assert = require('node:assert/strict')
const { mkdir, readFile } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

const output = path.resolve(__dirname, '../../../output/playwright/arbitration-field-navigation')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'
const preview = {
  key: 'fixture-pdf',
  expiresAt: '2099-01-01T00:00:00Z',
  start: 1,
  end: 1,
  total: 1
}
const original = { 词条: '合成条目', 释义: '合成释义' }
const attempt = (id, pass, row) => ({ id, pass_no: pass, row_json: JSON.stringify(row) })

async function main() {
  await mkdir(output, { recursive: true })
  const originalPdf = await readFile(
    path.resolve(__dirname, '../../public/examples/review-bundle-practice-v1/source.pdf')
  )
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || 'chrome'
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(() => {
      globalThis.__FANGJI_BACKEND_URL__ = location.origin
    })
    const errors = []
    let submissions = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/api/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.endsWith('/arbitration')) {
        return route.fulfill({
          json: {
            mode: 'arbitration',
            page: {
              id: 'first',
              project: 'syntheticproject',
              page_number: 1,
              pdf_page: 1,
              proofread_round: 1,
              ocr_row_json: JSON.stringify(original)
            },
            attempts: [
              attempt('synthetic-a', 1, original),
              attempt('synthetic-b', 2, { 词条: '异文', 释义: '待核对释义' })
            ]
          }
        })
      }
      if (pathname.endsWith('/arbitrate')) {
        submissions++
        return route.fulfill({ json: { status: 'approved' } })
      }
      if (pathname.endsWith('/verification'))
        return route.fulfill({
          json: {
            context: {
              pdf_page: 1,
              basis: 'synthetic',
              source_approved: true,
              policy_compatible: true
            },
            completion: { needs_review: false },
            judgments: [],
            history: []
          }
        })
      if (/\/images\/\d+\/descriptor$/.test(pathname)) return route.fulfill({ status: 404 })
      if (pathname.endsWith('/pdf/descriptor')) return route.fulfill({ json: preview })
      if (pathname.endsWith('/pdf'))
        return route.fulfill({
          body: originalPdf,
          contentType: 'application/pdf',
          headers: {
            'X-PDF-Preview-Key': preview.key,
            'X-PDF-Expires-At': preview.expiresAt,
            'X-PDF-Start-Page': '1',
            'X-PDF-End-Page': '1',
            'X-PDF-Total-Pages': '1'
          }
        })
      return route.fulfill({ json: { items: [], totalItems: 0 } })
    })
    await page.goto(base + '/tests/fixtures/arbitration-queue.html')
    const entry = page.getByRole('article', { name: '词条', exact: true })
    const meaning = page.getByRole('article', { name: '释义', exact: true })
    const next = page.getByRole('button', { name: '下一处待确认字段', exact: true })
    const focusField = (name) =>
      page.waitForFunction(
        (label) => document.activeElement.getAttribute('aria-label') === label,
        name
      )
    assert.equal(await next.isEnabled(), true)
    const progressTop = (await next.boundingBox()).y
    await page.getByRole('img', { name: 'PDF 页面图像' }).waitFor()
    const zoom = page.getByRole('spinbutton', { name: '原文缩放百分比' })
    await zoom.fill('200')
    await zoom.press('Enter')
    const source = page.getByRole('region', { name: 'PDF 原文', exact: true })
    await page.waitForFunction(() => {
      const el = document.querySelector('.pdf-scroll')
      return el && el.scrollHeight - el.clientHeight > 100
    })
    await source.focus()
    const sourceScroll = await source.evaluate((el) => {
      el.scrollTop = 100
      return el.scrollTop
    })
    assert.ok(sourceScroll > 0)
    await page.keyboard.press('ControlOrMeta+Enter')
    await focusField('释义')
    assert.equal(
      (await next.boundingBox()).y,
      progressTop,
      'Progress stays above the field scroller'
    )
    assert.equal(await page.getByRole('dialog').count(), 0)
    await next.click()
    await focusField('词条')
    assert.equal(await source.evaluate((el) => el.scrollTop), sourceScroll)
    await entry.getByRole('button', { name: '采用导入值', exact: true }).click()
    assert.equal(
      await entry
        .getByRole('button', { name: '采用导入值', exact: true })
        .getAttribute('aria-pressed'),
      'true'
    )
    await entry.getByRole('button', { name: '下一处待确认', exact: true }).click()
    await focusField('释义')
    await page.screenshot({ path: path.join(output, 'next-unresolved.png') })
    await meaning.getByRole('button', { name: '采用导入值', exact: true }).click()
    assert.equal(await next.isDisabled(), true)
    await page.keyboard.press('ControlOrMeta+Enter')
    const confirm = page
      .getByRole('dialog')
      .getByRole('button', { name: '确认完成仲裁', exact: true })
    await confirm.waitFor()
    await page.keyboard.press('ControlOrMeta+Enter')
    assert.equal(await confirm.isVisible(), true)
    assert.equal(submissions, 0, 'shortcut waits for explicit confirmation')
    await confirm.click()
    await page.waitForFunction(
      () => !document.querySelector('[aria-labelledby="arbitration-review-title"]')
    )
    assert.equal(submissions, 1)
    assert.deepEqual(errors, [])
    console.log(
      'PASS: desktop arbitration field navigation, source position and keyboard confirmation'
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
