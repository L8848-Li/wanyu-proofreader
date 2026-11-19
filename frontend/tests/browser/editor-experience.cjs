const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'
const output =
  process.env.EDITOR_EXPERIENCE_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/editor-experience')

;(async () => {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await installReviewRoutes(page)
    await page.goto(base + '/tests/fixtures/review.html')
    const toggle = page.getByRole('button', { name: '字符键盘', exact: true })
    await toggle.waitFor()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    await page.locator('.pdf-page-label').waitFor()
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.pdf-canvas')
      return canvas?.width > 100 && !document.querySelector('.pdf-loading-mask')
    })
    await page.screenshot({ path: path.join(output, 'desktop-default.png') })
    assert.equal(await page.getByRole('toolbar', { name: '原文工具' }).count(), 1)
    const displayOptions = page.locator('.pdf-display-options > summary')
    const rotate = page.getByRole('button', { name: '旋转 90°', exact: true })
    assert.equal(await rotate.isVisible(), false)
    await displayOptions.press('Enter')
    await page.getByText('已经下载的副本无法收回。', { exact: true }).waitFor()
    await rotate.focus()
    await page.keyboard.press('Escape')
    assert.equal(await rotate.isVisible(), false)
    assert.equal(
      await displayOptions.evaluate((element) => element === document.activeElement),
      true
    )
    const desktopSource = await page.locator('.source-panel').boundingBox()
    assert.ok(desktopSource.height > 800)
    const divider = page.getByRole('separator', { name: '调整原文与编辑区宽度' })
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await divider.getAttribute('aria-valuenow'), '47')
    await page.keyboard.press('End')
    assert.equal(await divider.getAttribute('aria-valuenow'), '65')
    await page.keyboard.press('Home')
    assert.equal(await divider.getAttribute('aria-valuenow'), '30')
    await page.keyboard.press('ArrowRight')
    const box = await divider.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(640, box.y + box.height / 2)
    await page.mouse.up()
    const width = Number(await divider.getAttribute('aria-valuenow'))
    assert.ok(width > 40 && width < 50)
    const input = page.locator('.proofread-textarea').first()
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    await input.evaluate((element) => {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
      window.__inputHeightReads = 0
      Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        get() {
          window.__inputHeightReads++
          return descriptor.get.call(this)
        }
      })
    })
    await input.fill('甲乙丙')
    assert.equal(
      await input.inputValue(),
      '甲乙丙',
      'model/input updates without waiting for resize'
    )
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert.equal(
      await page.evaluate(() => window.__inputHeightReads),
      1,
      'a stable-width input fits once after render'
    )
    await input.evaluate((element) => {
      delete element.scrollHeight
    })
    const shortHeight = (await input.boundingBox()).height
    assert.ok(shortHeight <= 80, 'short fields do not reserve a paragraph-sized editor')
    const preedit = '𠮷 a̤̍\n'.repeat(8)
    await input.evaluate((element, text) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      element.value = text
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          isComposing: true,
          inputType: 'insertCompositionText'
        })
      )
    }, preedit)
    assert.ok(
      (await input.boundingBox()).height > shortHeight,
      'IME preedit grows even before v-model commits'
    )
    await input.evaluate((element) =>
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    )
    assert.equal(
      await input.inputValue(),
      preedit,
      'composition preserves exact Unicode and newlines'
    )
    await input.fill('甲乙丙')
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    await input.evaluate((element, text) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      element.value = text
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          isComposing: true,
          inputType: 'insertCompositionText'
        })
      )
    }, preedit)
    assert.ok((await input.boundingBox()).height > shortHeight)
    await input.evaluate((element) => {
      element.value = '甲乙丙'
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert.equal(await input.inputValue(), '甲乙丙')
    assert.equal(
      (await input.boundingBox()).height,
      shortHeight,
      'cancelled composition restores the short height even when model value did not change'
    )
    const exactMultiline = '  ia̤̍h\n' + '𠮷  '.repeat(80) + '\n  '
    await input.fill(exactMultiline)
    assert.equal(
      await input.inputValue(),
      exactMultiline,
      'autoheight preserves leading/trailing whitespace, newlines and combining characters'
    )
    const longHeight = (await input.boundingBox()).height
    assert.ok(
      longHeight > shortHeight && longHeight <= 177,
      'long fields grow to a bounded editing area'
    )
    await input.fill('甲乙')
    await input.evaluate((element) => {
      element.setSelectionRange(1, 1)
      element.dispatchEvent(new Event('select'))
    })
    await toggle.click()
    await page.getByRole('searchbox', { name: '搜索字符、名称或码位' }).fill('U+0251')
    await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
    assert.equal(await input.inputValue(), '甲ɑ乙')
    assert.equal(await input.evaluate((element) => element === document.activeElement), true)
    await page.getByRole('button', { name: '清除搜索', exact: true }).click()
    await page.getByRole('combobox', { name: '字符分组', exact: true }).selectOption('__recent')
    await page
      .getByRole('region', { name: '最近使用字符' })
      .getByRole('button', { name: '再次插入字符 ɑ' })
      .click()
    assert.equal(await input.inputValue(), '甲ɑɑ乙')
    await page.screenshot({ path: path.join(output, 'desktop-tray.png') })
    await page.reload()
    await toggle.waitFor()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(Number(await divider.getAttribute('aria-valuenow')), width)
    await page.getByRole('button', { name: '系统输入 / 收起', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    const fieldNavigation = await page.getByRole('navigation', { name: '字段导航' }).boundingBox()
    const collapsedKeyboard = await toggle.boundingBox()
    assert.ok(
      Math.abs(fieldNavigation.y - collapsedKeyboard.y) <= 5,
      'closed character entry shares the field navigation row'
    )
    assert.ok(
      Math.max(
        fieldNavigation.y + fieldNavigation.height,
        collapsedKeyboard.y + collapsedKeyboard.height
      ) -
        Math.min(fieldNavigation.y, collapsedKeyboard.y) <=
        60,
      'closed mobile controls use one compact bottom bar'
    )
    await page.screenshot({ path: path.join(output, 'mobile-compact-controls.png') })
    await page.getByRole('button', { name: '查看原文', exact: true }).click()
    const source = await page.locator('.source-panel').boundingBox()
    const fieldPanel = await page.locator('.fields-panel').boundingBox()
    assert.ok(
      source.height > 100 && fieldPanel.height > 150 && source.y + source.height <= fieldPanel.y + 2
    )
    await input.focus()
    await input.scrollIntoViewIfNeeded()
    const field = await input.boundingBox()
    assert.ok(field.y >= fieldPanel.y && field.y + field.height <= fieldPanel.y + fieldPanel.height)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    await page.screenshot({ path: path.join(output, 'mobile-source-and-input.png') })
    await page.getByRole('navigation', { name: '字段导航' }).getByRole('combobox').selectOption('2')
    await page.waitForFunction(() => {
      const input = [...document.querySelectorAll('.proofread-textarea')].find(
        (element) => element.getClientRects().length
      )
      const field = input?.getBoundingClientRect()
      const panel = document.querySelector('.fields-panel')?.getBoundingClientRect()
      return field && panel && field.y >= panel.y && field.bottom <= panel.bottom
    })
    await page.screenshot({ path: path.join(output, 'mobile-next-field.png') })
    const blockedUrl = '**/api/fangji/pages/page1/verification'
    await page.route(blockedUrl, (route) =>
      route.fulfill({
        json: {
          context: {
            basis: 'blocked-source-v2',
            input: { 字词: '测试', 读音: 'tɛ', 释义: '演示材料' },
            source: { name: 'synthetic.pdf' },
            pdf_page: 5,
            policy: { instructions: '合成来源约定' },
            source_approved: false,
            policy_compatible: true
          },
          announcements: [],
          reports: [],
          draft: null,
          draft_history: [],
          judgments: []
        }
      })
    )
    await page.goto(base + '/tests/fixtures/review.html')
    await page.getByText('当前来源尚未纳入此版约定', { exact: false }).waitFor()
    assert.equal(
      await page.locator('.verification-details').evaluate((element) => element.open),
      true
    )
    await page.screenshot({ path: path.join(output, 'mobile-blocked-source.png') })
    await page.unroute(blockedUrl)
    await page.goto(base + '/tests/fixtures/review.html?admin')
    await page.locator('.arbitration-field').first().waitFor()
    assert.equal(await page.locator('.arbitration-field').count(), 1)
    assert.match(await page.locator('.arbitration-field h3').innerText(), /读音/)
    assert.equal(await page.locator('.source-judgment select').first().inputValue(), '')
    assert.deepEqual(errors, [])
    // 640×400 is layout-equivalent to a 1280×800 viewport at 200%. This is
    // reflow evidence, not a claim about native zoom or a phone's OS keyboard.
    const short = await browser.newPage({ viewport: { width: 640, height: 400 } })
    const preset = require('../../../backend/keyboards/hinghwa-dialect.json')
    await installReviewRoutes(short, { keyboard: () => preset })
    let shortSubmissions = 0
    short.on('request', (request) => {
      if (request.url().endsWith('/submit')) shortSubmissions++
    })
    await short.goto(base + '/tests/fixtures/review.html')
    const navigation = short.getByRole('navigation', { name: '字段导航' })
    await navigation.getByRole('combobox').selectOption('2')
    const currentInput = short.locator('.proofread-textarea:visible')
    await currentInput.focus()
    await currentInput.evaluate((element) => {
      element.setSelectionRange(1, 1)
      element.dispatchEvent(new Event('select'))
    })
    await short.getByRole('button', { name: '字符键盘', exact: true }).click()
    await short.getByRole('button', { name: '钉住', exact: true }).click()
    await short.getByRole('searchbox', { name: '搜索字符、名称或码位' }).fill('U+0251')
    await short.locator('.keyboard-search-results .ipa-key').click()
    assert.equal(await currentInput.inputValue(), '演ɑ示材料')
    const centerUncovered = (element) => {
      const bounds = element.getBoundingClientRect()
      const hit = document.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2
      )
      return element === hit || element.contains(hit)
    }
    assert.equal(await currentInput.evaluate(centerUncovered), true)
    await short.screenshot({ path: path.join(output, 'reflow-640x400-character-tray.png') })
    await navigation.getByRole('combobox').selectOption('0')
    assert.equal(await short.locator('.proofread-textarea:visible').evaluate(centerUncovered), true)
    await navigation.getByRole('combobox').selectOption('2')
    await navigation.getByRole('button', { name: '总览/提交', exact: true }).click()
    await navigation.getByRole('button', { name: '检查并提交', exact: true }).click()
    const confirmation = short.getByRole('dialog')
    await confirmation.getByRole('checkbox').check()
    await short.keyboard.press('Tab')
    await short.keyboard.press('Tab')
    const confirm = confirmation.getByRole('button', { name: '确认提交', exact: true })
    assert.equal(await confirm.evaluate((element) => element === document.activeElement), true)
    assert.equal(await confirm.evaluate(centerUncovered), true)
    await confirm.click({ trial: true })
    await short.screenshot({ path: path.join(output, 'reflow-640x400-confirmation.png') })
    await short.keyboard.press('Escape')
    assert.equal(shortSubmissions, 0)
    await fs.writeFile(
      path.join(output, 'reflow-640x400.json'),
      JSON.stringify(
        {
          cssViewport: [640, 400],
          layoutEquivalentTo: '1280×800 at 200%',
          nativeBrowserZoomVerified: false,
          nativeKeyboardVerified: false,
          exactCharacterAtRememberedCaret: true,
          fieldSwitchUncovered: true,
          confirmationKeyboardAndPointerReachable: true,
          submissions: 0
        },
        null,
        2
      )
    )
    await short.close()
    console.log(
      'PASS editor experience: defaults, pointer/keyboard split, persisted tray, exact search/caret/recent insertion, mobile source/input and unverified arbitration'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
