const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')
const preset = require('../../../backend/keyboards/hinghwa-dialect.json')
const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5173'
const findingsOutput = path.resolve(__dirname, '../../../output/playwright/proofread-findings')
let realPreset = false
async function openTray(page) {
  const toggle = page.getByRole('button', { name: '字符键盘', exact: true })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
}

function waitForFindingPresentation(page, id, presented) {
  return page.waitForRequest(
    (request) => {
      if (!request.url().endsWith('/research-sessions/fixture-research-session/events'))
        return false
      const { type, data } = request.postDataJSON()
      return (
        type === 'render' &&
        data.rendered_ids?.includes(id) &&
        data.presented_ids.includes(id) === presented
      )
    },
    { timeout: 5000 }
  )
}

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  const page = await browser.newPage()
  page.on('dialog', (dialog) => dialog.accept())
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { row, state } = await installReviewRoutes(page, {
    keyboard: () => (realPreset ? preset : null)
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      'fangji:onboarding:v1:fixture-user',
      JSON.stringify({ version: 1, completed: true })
    )
  })
  for (const admin of [false, true]) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(base + '/tests/fixtures/review.html' + (admin ? '?admin' : ''))
    await page.waitForTimeout(1000)
    await page.locator('.ipa-key').first().waitFor({ state: 'attached', timeout: 3000 })
    await openTray(page)
    if (admin) await page.getByRole('button', { name: '全部字段 3', exact: true }).click()
    await page.locator('.panel-loading').waitFor({ state: 'hidden' })
    if ((await page.locator('.pdf-page-label').innerText()) !== '第 5 / 10 页')
      throw Error('Restricted PDF source page mapping')
    const source = await page.locator('.source-panel').boundingBox(),
      key = await page.locator('.keyboard-panel').boundingBox(),
      fields = await page.locator('.fields-panel').boundingBox()
    if (!(source.x < fields.x && key.x >= fields.x - 1 && key.y > fields.y))
      throw Error('Desktop source/editor and character tray placement')
    await page.screenshot({ path: `/tmp/review-${admin ? 'arb' : 'proof'}-desktop.png` })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(150)
    await page.getByRole('button', { name: '系统输入 / 收起', exact: true }).click()
    await page.getByRole('button', { name: '查看原文', exact: true }).click()
    await page.screenshot({ path: `/tmp/review-${admin ? 'arb' : 'proof'}-mobile-pdf.png` })
    await openTray(page)
    await page.getByRole('button', { name: '钉住', exact: true }).click()
    await page.getByRole('combobox', { name: '字符分组', exact: true }).selectOption('tones')
    if (!(await page.getByRole('button', { name: '插入字符 ˥', exact: true }).isVisible()))
      throw Error('Group switch failed')
    await page.getByRole('combobox', { name: '字符分组', exact: true }).selectOption('vowels')
    await page.locator('.ipa-key').first().click()
    if (
      !(await page
        .locator('textarea:visible')
        .first()
        .inputValue()
        .then((v) => v.includes('ɑ')))
    )
      throw Error('Insertion failed')
    await page.screenshot({ path: `/tmp/review-${admin ? 'arb' : 'proof'}-mobile.png` })
    if (!admin) {
      await page.getByRole('button', { name: '下一字段', exact: true }).click()
      if ((await page.locator('.proofread-field:visible').count()) !== 1)
        throw Error('Field navigation')
      await page.getByRole('button', { name: '下一字段', exact: true }).click()
      await page.getByRole('button', { name: '总览/提交', exact: true }).click()
      if ((await page.locator('.proofread-field:visible').count()) !== 3) throw Error('Overview')
      if (await page.locator('.ipa-key').first().isVisible())
        throw Error('Overview keyboard not hidden')
    }
  }
  await fs.mkdir(findingsOutput, { recursive: true })
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  desktop.on('dialog', (dialog) => dialog.accept())
  try {
    await installReviewRoutes(desktop)
    await desktop.route(
      '**/api/fangji/pages/page1/verification',
      (route) =>
        route.fulfill({
          status: 409,
          json: { message: '分析结果或来源已更新，请重新读取。' }
        }),
      { times: 1 }
    )
    const endpoint = '**/api/fangji/pages/page1/findings'
    let failures = 0
    const failFindings = (route) => {
      failures++
      return route.fulfill({ status: 503, json: { message: 'Synthetic timeout' } })
    }
    await desktop.route(endpoint, failFindings)
    await desktop.goto(base + '/tests/fixtures/review.html')
    await desktop
      .getByRole('region', { name: '来源与核验记录' })
      .getByText('来源与约定', { exact: true })
      .waitFor()
    const pane = desktop.getByRole('region', { name: '本条疑点' })
    const retry = pane.getByRole('button', { name: '重试读取疑点' })
    const reading = desktop.getByRole('textbox', { name: '读音 校对结果' })
    await retry.waitFor()
    await reading.fill('tɛ⁵³')
    await retry.click()
    await retry.waitFor()
    assert.equal(failures, 2)
    await desktop.unroute(endpoint, failFindings)
    await retry.click()
    await pane.getByText('待核对 4 · 已核对 0', { exact: true }).waitFor()
    assert.equal(await reading.inputValue(), 'tɛ⁵³')
    const compactHeight = (await pane.boundingBox()).height
    assert.ok(compactHeight < 100, 'The resting list must leave room for the fields')
    await pane.getByRole('button', { name: '查看疑点列表' }).click()
    assert.equal(await pane.getByRole('listitem').count(), 4)
    await pane.locator('[data-locate-finding="finding-reading"]').click()
    const evidence = desktop.getByRole('region', { name: '读音的疑点证据' })
    await evidence.getByRole('button', { name: '已按原文修正' }).click()
    await evidence.getByText('已核对 · 已按原文修正', { exact: true }).waitFor()
    await pane.getByText('待核对 3 · 已核对 1', { exact: true }).waitFor()
    await evidence.getByRole('button', { name: '报告问题' }).click()
    const form = desktop.locator('.verification-report')
    const description = form.getByLabel('问题说明')
    await description.fill('读音原文无连续调值')
    await form.getByRole('checkbox').check()
    const openFinding = async (id) => {
      await pane.getByRole('button', { name: '查看疑点列表' }).click()
      await pane.locator('[data-locate-finding="' + id + '"]').click()
    }
    await openFinding('finding-meaning')
    const meaning = desktop.getByRole('region', { name: '释义的疑点证据' })
    await meaning.getByRole('button', { name: '报告问题' }).click()
    assert.equal(await form.getByLabel('涉及字段').inputValue(), '释义')
    assert.equal(await form.getByLabel('相关提示（可选）').inputValue(), 'finding-meaning')
    assert.equal(await description.inputValue(), '')
    assert.equal(await form.getByRole('checkbox').isChecked(), false)
    const category = form.getByLabel('问题类型')
    await category.selectOption('input_display')
    await meaning.getByRole('button', { name: '核对无误，保留原值' }).click()
    await pane.getByText('待核对 2 · 已核对 2', { exact: true }).waitFor()
    await meaning.getByRole('button', { name: '下一处待核对' }).click()
    await desktop.getByRole('region', { name: '声调的疑点证据' }).waitFor()
    await openFinding('finding-reading')
    await evidence.getByRole('button', { name: '报告问题' }).click()
    assert.equal(await description.inputValue(), '读音原文无连续调值')
    assert.equal(await form.getByRole('checkbox').isChecked(), true)
    assert.equal(await category.inputValue(), 'hint')
    await openFinding('finding-meaning')
    await meaning.getByRole('button', { name: '报告问题' }).click()
    assert.equal(await description.inputValue(), '')
    assert.equal(await category.inputValue(), 'input_display')
    await desktop.waitForFunction(() => {
      const draft = JSON.parse(localStorage.getItem('fangji:task-draft:v1:fixture-user:page1'))
      return (
        draft?.findingReviews?.['finding-reading']?.result === 'corrected' &&
        draft?.findingReviews?.['finding-meaning']?.result === 'kept'
      )
    })
    await desktop.reload()
    await pane.getByText('待核对 2 · 已核对 2', { exact: true }).waitFor()
    await reading.fill('tɛ⁵⁵')
    await pane.getByText('待核对 3 · 已核对 1', { exact: true }).waitFor()
    await openFinding('finding-reading')
    await desktop.getByRole('img', { name: 'PDF 页面图像' }).waitFor()
    await desktop.screenshot({ path: path.join(findingsOutput, 'desktop-review-progress.png') })
    await reading.fill('tɛ')
    await desktop.reload()
    await pane.getByText('待核对 3 · 已核对 1', { exact: true }).waitFor()
    assert.equal(
      await reading.inputValue(),
      'tɛ',
      'a review can persist by itself without a text edit'
    )
  } finally {
    await desktop.close()
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  try {
    await installReviewRoutes(mobile, { research: true })
    await mobile.route('**/api/fangji/pages/page1/problems', async (route) => {
      await route.fulfill({ json: { id: 'synthetic-report', issue: { status: 'new' } } })
    })
    await mobile.goto(base + '/tests/fixtures/review.html')
    const hints = mobile.getByRole('region', { name: '本条疑点' })
    await hints.getByRole('button', { name: '展开其余 1 个疑点', exact: true }).tap()
    const hint = hints
      .locator('li')
      .filter({ has: mobile.locator('[data-locate-finding="finding-meaning"]') })
    const locate = hint.getByRole('button', { name: '定位原文', exact: true })
    const descriptionText = hint.locator('p').first()
    // Leave enough scroll range to move the last finding past the panel's top edge.
    const scrollSpace = await mobile.addStyleTag({
      content: '.editor-panel-body--fields { padding-bottom: 100vh !important; }'
    })
    await Promise.all([
      waitForFindingPresentation(mobile, 'finding-meaning', true),
      descriptionText.evaluate((element) => {
        element.scrollIntoView({ block: 'center', behavior: 'instant' })
      })
    ])

    await Promise.all([
      waitForFindingPresentation(mobile, 'finding-meaning', false),
      locate
        .evaluate((button) => {
          button.scrollIntoView({ block: 'start', behavior: 'instant' })
          const panel = button.closest('.editor-panel-body--fields').getBoundingClientRect()
          const action = button.getBoundingClientRect()
          const description = button.closest('li').querySelector('p').getBoundingClientRect()
          return {
            actionVisible: action.bottom > panel.top && action.top < panel.bottom,
            descriptionClipped: description.bottom <= panel.top
          }
        })
        .then(({ actionVisible, descriptionClipped }) => {
          assert.equal(actionVisible, true, 'Finding action must be visible')
          assert.equal(descriptionClipped, true, 'Finding text must be above the scrollport')
        })
    ])
    await scrollSpace.evaluate((element) => element.remove())
    await locate.tap()
    await mobile
      .locator('.source-finding-note')
      .getByText('原文第 5 页 · 核对「释义」', { exact: true })
      .waitFor()
    assert.equal(await mobile.locator('.proofread-field:visible h2').innerText(), '释义')
    assert.equal(await mobile.locator('.source-value__hit').count(), 0)
    await mobile.locator('.pdf-canvas-stage').waitFor({ state: 'visible' })
    await mobile.screenshot({ path: path.join(findingsOutput, 'mobile-source.png') })
    await hint.getByRole('button', { name: '报告问题', exact: true }).tap()
    const form = mobile.locator('.verification-report')
    assert.equal(await form.getByLabel('涉及字段').inputValue(), '释义')
    assert.equal(await form.getByLabel('相关提示（可选）').inputValue(), 'finding-meaning')
    assert.equal(await form.getByLabel('问题类型').inputValue(), 'hint')
    const description = form.getByLabel('问题说明')
    assert.equal(await description.evaluate((el) => el === document.activeElement), true)
    await description.fill('合成验收：原文没有该标点问题')
    await mobile.screenshot({ path: path.join(findingsOutput, 'mobile-report.png') })
    const submitted = mobile.waitForRequest((request) => request.url().endsWith('/page1/problems'))
    await form.getByRole('button', { name: '保存草稿并提交问题' }).tap()
    const body = (await submitted).postDataJSON()
    assert.equal(body.field, '释义')
    assert.equal(body.finding, 'finding-meaning')
    assert.equal(body.category, 'hint')
    assert.equal(body.blocking, false)
    await mobile.getByText('问题已提交，可继续逐字段核对。', { exact: true }).waitFor()
  } finally {
    await mobile.close()
  }

  // A desktop focus change must follow the field into the single-field layout.
  for (const admin of [false, true]) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => localStorage.clear())
    await page.goto(base + '/tests/fixtures/review.html' + (admin ? '?admin' : ''))
    await page.locator('.ipa-key').first().waitFor({ state: 'attached' })
    await openTray(page)
    if (!admin) {
      const hints = page.getByRole('region', { name: '本条疑点' })
      const more = hints.getByRole('button', { name: '查看疑点列表', exact: true })
      await more.waitFor()
      assert.equal(await hints.locator('li').count(), 0)
      await more.click()
      assert.equal(await hints.locator('li').count(), 4)
      await hints.getByRole('button', { name: '收起列表', exact: true }).click()
      assert.equal(await hints.locator('li').count(), 0)
      await page.getByRole('button', { name: '下一页原文', exact: true }).click()
      assert.equal(await page.getByRole('spinbutton', { name: 'PDF 页码' }).inputValue(), '6')
      await more.click()
      await hints.locator('[data-locate-finding="finding-reading"]').click()
      assert.equal(await page.getByRole('spinbutton', { name: 'PDF 页码' }).inputValue(), '5')
      assert.equal(await page.locator('.source-value__hit').innerText(), 'tɛ')
      assert.equal(await page.locator('.proofread-field:focus h2').innerText(), '读音')
      await page.locator('.pdf-canvas-stage').waitFor({ state: 'visible' })
      await page.screenshot({ path: path.join(findingsOutput, 'desktop-source.png') })
      await openTray(page)
    }
    if (admin) await page.getByRole('button', { name: '全部字段 3', exact: true }).click()
    const fieldCards = page.locator(admin ? '.arbitration-field' : '.proofread-field')
    const inputs = fieldCards.locator('textarea')
    // Save a caret in the first field, then a replacement selection in the third.
    await inputs.nth(0).focus()
    await inputs.nth(0).evaluate((el) => {
      el.setSelectionRange(1, 1)
      el.dispatchEvent(new Event('select'))
    })
    await inputs.nth(2).focus()
    await inputs.nth(2).evaluate((el) => {
      el.setSelectionRange(1, 3)
      el.dispatchEvent(new Event('select'))
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(
      (selector) => {
        const cards = [...document.querySelectorAll(selector)]
        return cards.filter((el) => el.getBoundingClientRect().height > 0).length === 1
      },
      admin ? '.arbitration-field' : '.proofread-field'
    )
    if (!(await fieldCards.nth(2).isVisible()))
      throw Error(`${admin ? 'Arbitration' : 'Proofreading'}: desktop target hidden after resize`)
    await openTray(page)
    await page.getByRole('button', { name: '钉住', exact: true }).click()
    await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
    if ((await inputs.nth(2).inputValue()) !== '演ɑ料')
      throw Error('Resize lost replacement selection')
    if (
      (await inputs.nth(0).inputValue()) !== row.字词 ||
      (await inputs.nth(1).inputValue()) !== row.读音
    )
      throw Error('Resize changed a hidden field')
    // Return to the first field and use its independent remembered caret.
    await page.getByRole('navigation', { name: '字段导航' }).getByRole('combobox').selectOption('0')
    await inputs.nth(2).evaluate((el) => el.dispatchEvent(new Event('select')))
    await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
    if ((await inputs.nth(0).inputValue()) !== '测ɑ试')
      throw Error('Field navigation lost remembered caret')
    // Cross back to desktop, choose another target, and enter mobile again.
    await page.setViewportSize({ width: 1440, height: 900 })
    await inputs.nth(1).focus()
    await inputs.nth(1).evaluate((el) => {
      el.setSelectionRange(0, 0)
      el.dispatchEvent(new Event('select'))
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await openTray(page)
    await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
    if (!(await fieldCards.nth(1).isVisible()) || (await inputs.nth(1).inputValue()) !== 'ɑtɛ')
      throw Error('Repeated resize uses stale target')
  }
  // Exercise the shipped preset with both shortcut and complete categories.
  realPreset = true

  for (const admin of [false, true])
    for (const mobile of [false, true]) {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }
      )
      await page.evaluate(() => localStorage.clear())
      await page.goto(base + '/tests/fixtures/review.html' + (admin ? '?admin' : ''))
      await page.locator('.ipa-key').first().waitFor({ state: 'attached' })
      await page.locator('.panel-loading').waitFor({ state: 'hidden' })
      await openTray(page)
      if (mobile) {
        await openTray(page)
        await page.getByRole('button', { name: '钉住', exact: true }).click()
      }
      const category = page.getByRole('combobox', { name: '字符分组', exact: true })
      if ((await category.inputValue()) !== 'common-proofreading')
        throw Error('Wrong initial character group')
      const group = (id) => page.locator(`.ipa-section[id$="-${id}"]`)
      const choose = async (id) => {
        await category.selectOption(id)
        return group(id)
      }
      const insert = async (id, value) => {
        const section = await choose(id),
          key = preset.sections.find((s) => s.id === id).keys.find((k) => k.value === value)
        await section
          .getByRole('button', { name: key.hint || '插入字符 ' + value, exact: true })
          .click()
      }
      const count = new Set(preset.sections.flatMap((s) => s.keys.map((k) => k.value))).size
      if (
        !(await page
          .locator('.keyboard-footer')
          .innerText()
          .then((t) => t.includes(count + ' 个字符')))
      )
        throw Error('Shortcut duplicates inflated total')
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({
        path: `/tmp/keyboard-default-${admin ? 'arb' : 'proof'}-${mobile ? 'mobile' : 'desktop'}.png`
      })
      const field = page.locator('textarea:visible').first()
      await field.fill('甲乙')
      await field.focus()
      await field.evaluate((el) => {
        el.setSelectionRange(1, 1)
        el.dispatchEvent(new Event('select'))
      })
      await insert('common-proofreading', 'ã')
      await insert('nasalized', 'ã')
      if ((await field.inputValue()) !== '甲ãã乙')
        throw Error('Shortcut/category values or caret differ')
      await field.evaluate((el) => {
        el.focus()
        el.setSelectionRange(1, 3)
        el.dispatchEvent(new Event('select'))
      })
      await insert('common-proofreading', 'ɒ̃')
      if ((await field.inputValue()) !== '甲ɒ̃乙') throw Error('Shortcut lost replacement selection')
      await field.fill('甲a乙')
      await field.focus()
      await field.evaluate((el) => {
        el.setSelectionRange(2, 2)
        el.dispatchEvent(new Event('select'))
      })
      await insert('combining-marks', '̃')
      await insert('dictionary-symbols', '〔')
      await insert('common-proofreading', '〕')
      if ((await field.inputValue()) !== '甲ã〔〕乙')
        throw Error('Mark label leaked or cross-group caret changed')
      for (const section of preset.sections) {
        const visible = await choose(section.id)
        if ((await visible.locator('.ipa-key:visible').count()) !== section.keys.length)
          throw Error('Unreachable category ' + section.id)
        // Long groups scroll within the dock; even the last key must be fully reachable.
        const last = visible.locator('.ipa-key').last()
        await last.scrollIntoViewIfNeeded()
        const keyBox = await last.boundingBox(),
          dockBox = await page.locator('.keyboard-dock-content').boundingBox()
        if (keyBox.y < dockBox.y - 1 || keyBox.y + keyBox.height > dockBox.y + dockBox.height + 1)
          throw Error('Clipped last key ' + section.id)
      }
      await insert('mandarin-tones', 'ǖ')
      if ((await field.inputValue()) !== '甲ã〔〕ǖ乙')
        throw Error(
          `Complete Mandarin group lost caret (${admin ? 'arbitration' : 'proofreading'}, ${mobile ? 'mobile' : 'desktop'}): ${JSON.stringify(await field.inputValue())}`
        )
      const loaded = await page.evaluate(
        async (values) =>
          Promise.all(
            values.map(
              async (value) =>
                (await document.fonts.load('16px "Fangji Phonetic"', value)).length > 0
            )
          ),
        [...new Set(preset.sections.flatMap((s) => s.keys.map((k) => k.value)))]
      )
      if (loaded.some((value) => !value)) throw Error('Keyboard value has no bundled font')
      await choose('common-proofreading')
      await page.screenshot({
        path: `/tmp/keyboard-symbols-${admin ? 'arb' : 'proof'}-${mobile ? 'mobile' : 'desktop'}.png`
      })
    }
  // Exercise the mounted editor's draft and lease service wiring, not only its
  // storage helpers. The lease failure must preserve the draft and lock editing.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.goto(base + '/tests/fixtures/review.html')
  const draftField = page.locator('.proofread-field textarea').first()
  const draftResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/draft') &&
      response.request().method() === 'PUT' &&
      response.request().postDataJSON().row?.字词 === '合成草稿𠮷'
  )
  await draftField.fill('合成草稿𠮷')
  await page.waitForFunction(() =>
    Object.keys(localStorage).some(
      (key) => key.includes('task-draft') && localStorage.getItem(key).includes('合成草稿𠮷')
    )
  )
  await draftResponse
  if (
    !state.drafts.some(
      (draft) =>
        draft.row.字词 === '合成草稿𠮷' &&
        draft.leaseToken === 'synthetic-fixture-lease-token-32-chars'
    )
  )
    throw Error('Mounted server draft did not carry row and lease')
  await page.reload()
  await draftField.waitFor()
  if ((await draftField.inputValue()) !== '合成草稿𠮷')
    throw Error('Mounted editor did not restore local draft')
  state.failLease = true
  const renewal = page.waitForResponse(
    (response) => response.url().endsWith('/lease/renew') && response.status() === 409
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await renewal
  await page.locator('.lease-lost-alert').waitFor()
  if (!(await draftField.getAttribute('readonly').then((value) => value !== null)))
    throw Error('Lease loss left field writable')
  if ((await draftField.inputValue()) !== '合成草稿𠮷')
    throw Error('Lease loss discarded the saved draft')
  if (errors.length) throw Error(errors.join('\n'))
  console.log(
    'Desktop/mobile layout, group switching, protected PDF mapping, cross-breakpoint targets and per-field selections passed for both review views.'
  )
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
