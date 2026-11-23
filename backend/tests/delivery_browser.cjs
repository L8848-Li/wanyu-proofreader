// Optional browser evidence against the same disposable, real backend as the
// delivery integration suite. No API interception or mocked product responses.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')

async function main() {
  const fixture = JSON.parse(fs.readFileSync(0, 'utf8'))
  const dist = path.resolve(process.env.FRONTEND_DIST || path.join(__dirname, '../../frontend/dist'))
  const out = path.resolve(process.env.DELIVERY_SCREENSHOTS || 'docs/evidence/issue-316')
  fs.mkdirSync(out, { recursive: true })
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const target = new URL(req.url, fixture.base)
      const proxy = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (upstream) => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res) })
      proxy.on('error', (error) => { res.writeHead(502); res.end(error.message) })
      req.pipe(proxy)
      return
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const asset = path.resolve(dist, `.${pathname}`)
    if (!asset.startsWith(dist + path.sep) && asset !== dist) { res.writeHead(403); res.end(); return }
    const file = fs.existsSync(asset) && fs.statSync(asset).isFile() ? asset : path.join(dist, 'index.html')
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(({ token, record }) => { globalThis.__FANGJI_BACKEND_URL__ = window.location.origin; localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record })) }, fixture.admin)
    const origin = `http://127.0.0.1:${server.address().port}`
    const open = async (id) => { await page.goto(`${origin}/admin/projects/${id}/deliveries`); await page.getByRole('heading', { name: '交付包与回执', exact: true }).waitFor(); await page.getByRole('button', { name: '刷新记录', exact: true }).waitFor({ state: 'visible' }) }
    const shot = (name) => page.screenshot({ path: path.join(out, name), fullPage: true })
    await open(fixture.emptyProject.id)
    await page.getByText('还没有交付包', { exact: true }).waitFor()
    await shot('01-empty.png')
    await open(fixture.project.id)
    await page.getByText('整体失败并回滚', { exact: false }).first().waitFor()
    await shot('02-receipt-states.png')
    await page.getByRole('button', { name: '准备新交付', exact: true }).click()
    const upload = async (body) => page.locator('input[type="file"]').setInputFiles({ name: 'synthetic-D-handoff.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(body)) })
    const handoff = fixture.handoff
    await upload({ ...handoff, expected: { ...handoff.expected, adopted: handoff.expected.adopted + 1 } })
    await page.getByLabel('本次人工核查者').fill('synthetic-browser-reviewer')
    await page.getByRole('button', { name: '检查本批交付范围' }).click()
    await page.getByRole('heading', { name: '检查不通过，已阻止出包' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '生成交付包', exact: true }).count(), 0)
    await shot('03-reconciliation-error.png')
    await page.getByRole('button', { name: '返回更换清单或核查者', exact: true }).click()
    await upload(handoff)
    await page.getByRole('button', { name: '检查本批交付范围' }).click()
    await page.getByRole('heading', { name: '数量一致，等待人工决定' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '生成交付包', exact: true }).isDisabled(), true)
    await shot('04-preflight.png')
    // Changing the attested human invalidates a previously checked snapshot.
    await page.getByLabel('本次人工核查者').fill('synthetic-browser-reviewer-2')
    assert.equal(await page.getByRole('button', { name: '生成交付包', exact: true }).count(), 0)
    await page.getByRole('button', { name: '检查本批交付范围' }).click()
    await page.getByRole('heading', { name: '数量一致，等待人工决定' }).waitFor()
    await page.getByLabel('我已核查范围并决定生成本次交付包').check()
    await page.getByRole('button', { name: '生成交付包', exact: true }).click()
    const article = page.locator('article').filter({ has: page.getByRole('heading', { name: 'synthetic-browser · 第 1 版', exact: true }) })
    await article.getByText('等待回执', { exact: false }).waitFor()
    await article.getByRole('button', { name: '登记回执或处置' }).click()
    await page.getByLabel('消费方导入结果').selectOption('failed_rolled_back')
    await page.getByLabel('原因／处置说明').fill('合成消费方整体失败并已回滚；此截图不是 X 侧实测')
    await page.getByLabel('人工核查者', { exact: true }).fill('synthetic-receipt-reviewer')
    await page.getByLabel('修复／通知责任人').fill('synthetic-A-owner')
    await page.getByLabel('退回环节').selectOption('A')
    await page.getByLabel('处置凭据（停用时填升级记录；失败时填回滚凭据）').fill('synthetic-rollback-evidence')
    await page.getByRole('button', { name: '保存凭据', exact: true }).click()
    await article.getByText('整体失败并回滚', { exact: false }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile horizontal overflow')
    await article.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(out, '05-mobile-failed.png'), fullPage: false })
    assert.deepEqual(errors, [], 'browser errors')
    console.log('PASS browser: real server empty/error/preflight/receipt/mobile states; human confirmation and preview invalidation')
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
