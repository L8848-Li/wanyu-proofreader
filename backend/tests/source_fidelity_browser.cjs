// Real app + disposable backend. All identities, PDF text and judgments are
// synthetic; DOM rendering is measured without asserting anyone read a hint.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const exportFeedback = require('./source_fidelity_export_browser.cjs')
const fixture = JSON.parse(fs.readFileSync(process.env.FIDELITY_BROWSER_FIXTURE, 'utf8'))
const dist = path.resolve(__dirname, '../../frontend/dist')
const output = process.env.FIDELITY_BROWSER_OUTPUT || path.resolve(__dirname, '../../output/playwright/source-fidelity')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
async function api(url, auth, method = 'GET', body) {
  const response = await fetch(fixture.base + url, { method, headers: { Authorization: auth.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await response.text()
  assert.ok(response.ok, `${response.status} ${url}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}
async function session(browser, auth, verificationPage) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.__errors = []
  page.__expectedHttpErrors = new Set()
  page.__expectedNetworkErrors = new Set()
  const verificationUrl = verificationPage && `http://localhost/api/fangji/pages/${verificationPage}/verification`
  const verificationStatuses = []
  page.expectVerificationLoaded = async () => {
    await page.getByRole('region', { name: '来源与核验记录' })
      .getByText('来源与约定', { exact: true }).waitFor()
    assert.deepEqual(verificationStatuses, verificationStatuses[0] === 409 ? [409, 200] : [200])
  }
  page.on('pageerror', error => page.__errors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    if (page.__expectedHttpErrors.has(message.location().url) && message.text().includes('status of 400')) return
    if (page.__expectedNetworkErrors.has(message.location().url) && message.text().includes('net::ERR_FAILED')) return
    // The editor may retry one live verification-read conflict. The scenario
    // must still verify the successful retry and the rendered source context.
    if (message.location().url === verificationUrl && verificationStatuses.includes(409) &&
      message.text().includes('status of 409')) return
    page.__errors.push(message.text().slice(0, 1500))
  })
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    assert.equal(url.origin, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      const headers = { ...request.headers(), Authorization: auth.token }
      delete headers.host; delete headers['content-length']; delete headers.authorization
      const response = await fetch(fixture.base + url.pathname + url.search, { method: request.method(), headers, body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataBuffer() })
      if (request.method() === 'GET' && request.url() === verificationUrl)
        verificationStatuses.push(response.status)
      const responseHeaders = Object.fromEntries(response.headers)
      delete responseHeaders['content-length']; delete responseHeaders['content-encoding']
      return route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) })
    }
    const file = path.resolve(dist, '.' + url.pathname)
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file })
    if (/\.(js|css|png|jpg|svg|woff2?|map|ico)$/i.test(url.pathname)) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ path: path.join(dist, 'index.html'), headers: { 'Content-Security-Policy': csp } })
  })
  await page.addInitScript(auth => {
    globalThis.__FANGJI_BACKEND_URL__ = window.location.origin
    localStorage.setItem('pocketbase_auth', JSON.stringify({ token: auth.token, record: auth.record, model: auth.record }))
    localStorage.setItem(`fangji:onboarding:v1:${auth.record.id}`, JSON.stringify({ version: 1, completed: true }))
  }, auth)
  return page
}
async function shot(page, name) { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: page.viewportSize().width > 500 }) }
async function waitFor(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Timed out waiting for backend browser evidence')
}
;(async () => {
  fs.mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) })
  try {
    const manager = await session(browser, fixture.admin)
    const root = `/admin/projects/${fixture.project.id}`
    await manager.goto(`http://localhost${root}/verification`)
    await manager.getByRole('heading', { name: '问题处理' }).waitFor({ timeout: 10000 })
    await waitFor(async () => (await manager.locator('.project-issue-list > li').count()) === 2)
    assert.equal(await manager.locator('.project-issue-list > li').count(), 2)
    await shot(manager, 'manager-problems-desktop')
    await exportFeedback(manager, fixture.project.id, output)
    await manager.goto(`http://localhost${root}/arbitration/${fixture.pages[1].id}?mode=verification`)
    await manager.getByText('管理员来源核验', { exact: false }).waitFor()
    const reading = manager.locator('.arbitration-field').filter({ has: manager.getByRole('heading', { name: '记音', exact: true }) })
    await reading.waitFor()
    const finalReading = reading.getByRole('textbox', { name: '记音的最终仲裁结果', exact: true })
    const note = manager.locator('#arbitration-note')
    const reviewUrl = `http://localhost${root}/arbitration/${fixture.pages[1].id}?mode=verification`
    for (const [value, button] of [['ga⁵³³', '保存判断与进度'], ['ga533', '暂缓本条完成']]) {
      await finalReading.fill(value)
      await note.fill(`合成浏览器验收：${button}后离开并重开`)
      await manager.getByRole('button', { name: button, exact: true }).click()
      await manager.getByText(button === '保存判断与进度' ? '已保存实际判断及进度' : '进度已保存，本条暂缓完成', { exact: false }).waitFor()
      const actual = await api(`/api/collections/pages/records/${fixture.pages[1].id}`, fixture.admin)
      assert.equal(JSON.parse(actual.proofread_row_json).记音, 'ga533', 'saved review progress must not adopt a final value')
      await manager.goto(`http://localhost${root}/verification`)
      await manager.goto(reviewUrl)
      await finalReading.waitFor()
      assert.equal(await finalReading.inputValue(), value)
      assert.equal(await note.inputValue(), `合成浏览器验收：${button}后离开并重开`)
    }
    await finalReading.fill('ga⁵³³')
    const judgments = reading.locator('.source-judgment')
    assert.equal(await judgments.count(), 3)
    for (let i = 0; i < 3; i++) {
      await judgments.nth(i).getByLabel('正误', { exact: true }).selectOption(i === 2 ? 'correct' : 'incorrect')
      await judgments.nth(i).getByLabel('依据／待处理原因').fill('合成浏览器验收：重新对照当前约定，非真人研究判断')
    }
    await manager.getByRole('button', { name: '保存判断与进度', exact: true }).click()
    await manager.getByText('已保存实际判断及进度', { exact: false }).waitFor()
    await reading.scrollIntoViewIfNeeded()
    await shot(manager, 'source-judgments-desktop')
    await manager.getByRole('button', { name: '检查并完成核验', exact: true }).first().click()
    const dialog = manager.getByRole('dialog')
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: '确认完成核验', exact: true }).click()
    await manager.waitForURL(`**/arbitration/${fixture.pages[0].id}?mode=verification`)
    await manager.getByRole('button', { name: '检查并完成核验', exact: true }).first().click()
    const lastSourceDialog = manager.getByRole('dialog')
    await lastSourceDialog.getByRole('checkbox').check()
    await lastSourceDialog.getByRole('button', { name: '确认完成核验', exact: true }).click()
    await manager.waitForURL(`**${root}/verification?view=review`)
    await manager.getByRole('heading', { name: '来源复核', exact: true }).waitFor()
    const completedReview = await api(`/api/fangji/pages/${fixture.pages[1].id}/verification`, fixture.admin)
    assert.equal(completedReview.progress, null)
    // A completed, non-adopting history row must not replace the actual final.
    await api(`/api/fangji/pages/${fixture.pages[1].id}/source-judgments`, fixture.admin, 'POST', { basis: completedReview.context.basis, row: { ...completedReview.context.input, 记音: 'ga533' }, judgments: [], note: '合成验收：已结束的历史进度，未另行采用', complete: true })
    await manager.goto(reviewUrl)
    await finalReading.waitFor()
    assert.equal(await finalReading.inputValue(), 'ga⁵³³')
    assert.equal(await note.inputValue(), '', 'completed history must not reopen as current work')
    await manager.goto(`http://localhost${root}/verification?view=review&reviewScope=all`)
    const emptyRow = manager.locator('.project-review-list li').filter({ hasText: '第 4 条' })
    await emptyRow.getByRole('button', { name: '撤回空记录确认', exact: true }).click()
    const emptyDialog = manager.getByRole('dialog')
    await emptyDialog.getByLabel('来源 PDF 位置及确认依据', { exact: true }).fill('合成浏览器验收：撤回后复核来源，不是真人判读')
    await emptyDialog.getByRole('button', { name: '保存空记录处理', exact: true }).click()
    await emptyRow.getByRole('button', { name: '整条为空／不适用', exact: true }).click()
    await emptyDialog.getByLabel('来源 PDF 位置及确认依据', { exact: true }).fill('合成浏览器验收：物理第1页空记录教学场景')
    await shot(manager, 'empty-source-confirmation-desktop')
    await emptyDialog.getByRole('button', { name: '保存空记录处理', exact: true }).click()
    await emptyRow.getByRole('button', { name: '撤回空记录确认', exact: true }).waitFor()

    const member = await session(browser, fixture.users[0])
    await api(`/api/fangji/pages/${fixture.pages[2].id}/resume`, fixture.users[0], 'POST', {})
    await member.goto(`http://localhost/tasks/${fixture.pages[2].id}/edit`)
    await member.getByText('草稿的来源、导入文本或约定已变化', { exact: false }).waitFor()
    await member.getByRole('button', { name: '提交问题', exact: true }).click()
    await member.getByLabel('涉及字段').selectOption('记音')
    await member.getByLabel('问题说明').fill('合成浏览器验收：显示工具需要帮助')
    await member.getByRole('button', { name: '保存草稿并提交问题', exact: true }).click()
    await member.getByText('问题已提交，可继续逐字段核对', { exact: false }).waitFor()
    await member.setViewportSize({ width: 390, height: 844 })
    await shot(member, 'proofreader-mobile-report')
    await member.goto('http://localhost/tasks/problems')
    await member.getByRole('heading', { name: '我的问题', exact: true }).waitFor()
    await waitFor(async () => (await member.locator('.problem-item').count()) >= 2)
    assert.ok((await member.locator('.problem-item').count()) >= 2)
    await shot(member, 'my-problems-mobile')
    const savedMemberWork = (await api(`/api/fangji/pages/${fixture.pages[2].id}/verification`, fixture.users[0])).draft.row
    const exclusionView = await api(`/api/fangji/pages/${fixture.pages[2].id}/verification`, fixture.admin)
    await api(`/api/fangji/pages/${fixture.pages[2].id}/empty-source`, fixture.admin, 'POST', { basis: exclusionView.context.basis, empty: true, reason: '合成浏览器验收：保留旧草稿并排除条目' })
    const rejectedResumeUrl = `http://localhost/api/fangji/pages/${fixture.pages[2].id}/resume`
    member.__expectedHttpErrors.add(rejectedResumeUrl)
    const rejectedResume = member.waitForResponse(response => response.url() === rejectedResumeUrl && response.request().method() === 'POST')
    await member.getByRole('button', { name: '恢复任务', exact: true }).first().click()
    assert.equal((await rejectedResume).status(), 400)
    await member.getByText('本条已被管理员排除', { exact: false }).waitFor()
    assert.equal(new URL(member.url()).pathname, '/tasks/problems')
    const excluded = await api(`/api/collections/pages/records/${fixture.pages[2].id}`, fixture.admin)
    assert.equal(excluded.status, 'rejected')
    assert.equal(excluded.source_empty, true)
    await shot(member, 'empty-source-resume-blocked-mobile')
    await api(`/api/fangji/pages/${fixture.pages[2].id}/empty-source`, fixture.admin, 'POST', { basis: exclusionView.context.basis, empty: false, reason: '合成浏览器验收：管理员明确撤回排除确认' })
    await member.getByRole('button', { name: '恢复任务', exact: true }).first().click()
    await member.waitForURL(`**/tasks/${fixture.pages[2].id}/edit`)
    await member.getByLabel('词条 校对结果', { exact: true }).waitFor()
    assert.equal(await member.getByLabel('词条 校对结果', { exact: true }).inputValue(), savedMemberWork.词条)

    if (fixture.research) {
      const research = fixture.research
      const worker = await session(browser, fixture.users[0], research.pages[0].id)
      await worker.goto(`http://localhost/tasks/${research.pages[0].id}/edit`)
      await worker.bringToFront()
      await worker.getByText('研究过程记录已启用', { exact: false }).waitFor()
      await worker.expectVerificationLoaded()
      await worker.getByRole('button', { name: '展开其余 1 个疑点', exact: true }).waitFor()
      const hintField = worker.locator('.proofread-field').filter({ has: worker.getByRole('heading', { name: '释义', exact: true }) })
      await hintField.scrollIntoViewIfNeeded()
      await waitFor(async () => {
        const process = await api(`/api/fangji/projects/${research.project.id}/verification-export`, fixture.admin, 'POST', { mode: 'all' })
        return process.events.some(event => event.kind === 'research_event' && event.ref === research.session.id && event.payload.type === 'render' && event.payload.data.rendered_ids?.length === 3 && event.payload.data.collapsed_ids?.length === 1)
      })
      await shot(worker, 'research-rendered-hints')
      await worker.getByLabel('记音 校对结果', { exact: true }).fill('ka⁵³³')
      await worker.getByRole('button', { name: '检查并提交', exact: true }).first().click()
      const submit = worker.getByRole('dialog')
      assert.equal(await submit.getByRole('button', { name: '确认提交', exact: true }).isEnabled(), false)
      await submit.getByRole('checkbox', { name: '我已逐字段对照本条来源 PDF', exact: true }).check()
      await submit.getByRole('button', { name: '确认提交', exact: true }).click()
      // The current task status is the visible submission outcome; the same
      // wording is also retained inside the collapsed operation-history note.
      const submittedStatus = worker.locator('section.editor-completion-note[role="status"]')
      await submittedStatus.getByText('当前暂时没有下一条可由你处理；这不表示项目全部完成。', { exact: false }).waitFor()
      const process = await api(`/api/fangji/projects/${research.project.id}/verification-export`, fixture.admin, 'POST', { mode: 'all' })
      assert.ok(process.events.some(event => event.kind === 'research_submission' && event.ref === research.session.id && event.payload.row.记音 === 'ka⁵³³'))
      assert.deepEqual(worker.__errors, [])
      await api(`/api/fangji/projects/${research.project.id}/claim`, fixture.users[2], 'POST', {})
      const baseline = await session(browser, fixture.users[2], research.pages[1].id)
      await baseline.goto(`http://localhost/tasks/${research.pages[1].id}/edit`)
      await baseline.bringToFront()
      await baseline.getByText('研究过程记录已启用', { exact: false }).waitFor()
      await baseline.expectVerificationLoaded()
      assert.equal(await baseline.locator('[data-finding-id]').count(), 0)
      assert.equal(await baseline.getByText('字段处理记录（保留／修改／暂未完成）', { exact: true }).count(), 0, 'the frozen current-method routing strategy is actually applied')
      await baseline.locator('.verification-panel > details > summary').click()
      await baseline.getByRole('button', { name: '保存未完成工作', exact: true }).click()
      await waitFor(async () => {
        const bundle = await api(`/api/fangji/projects/${research.project.id}/verification-export`, fixture.admin, 'POST', { mode: 'all' })
        return bundle.drafts.some(draft => draft.page === research.pages[1].id && draft.status === 'unfinished_draft') && bundle.events.some(event => event.kind === 'research_event' && event.page === research.pages[1].id && event.payload.type === 'render' && event.payload.data.rendered_ids?.length === 0)
      })
      await shot(baseline, 'research-current-no-hints')
      assert.deepEqual(baseline.__errors, [])
    }
    assert.deepEqual(manager.__errors, [])
    assert.deepEqual(member.__errors, [])
    console.log('PASS: desktop/mobile issue loop, stale draft warning, explicit source judgments/declaration, actual DOM hint density and rendered-event export under shipped CSP.')
  } catch (error) {
    for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
      console.error('BROWSER DIAGNOSTIC', page.url(), page.__errors, (await page.locator('body').innerText()).slice(0, 2000))
      await shot(page, `failure-${index}`)
    }
    throw error
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
