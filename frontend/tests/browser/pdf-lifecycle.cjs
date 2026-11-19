const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { chromium } = require('playwright')
const { installReviewRoutes } = require('./reviewFixture.cjs')

const base = process.env.REVIEW_BASE_URL || 'http://127.0.0.1:5291'
const output =
  process.env.PDF_LIFECYCLE_OUTPUT ||
  path.resolve(__dirname, '../../../output/playwright/pdf-lifecycle')

// Hold the first blob read, without replacing PDF.js or changing its bytes.
// Both the previous XHR transport and the component's fetch use this same
// request barrier. Subsequent reads remain native, so account replacement must
// actually render the new account's authorized source.
async function holdFirstPdfRead(page) {
  let held
  let seen
  const requested = new Promise((resolve) => {
    seen = resolve
  })
  await page.route('**/__pdf_lifecycle_pending', (route) => {
    held = route
    seen()
  })
  await page.addInitScript(() => {
    const state = { transport: '', aborted: 0, headersRequested: false, workerTerminated: 0 }
    window.__PDF_LIFECYCLE__ = state
    function hold(url, transport) {
      if (state.transport || !String(url).startsWith('blob:')) return url
      state.transport = transport
      return `${location.origin}/__pdf_lifecycle_pending`
    }
    const nativeFetch = window.fetch
    window.fetch = function (url, options) {
      const source = hold(url, 'fetch')
      if (source !== url)
        options?.signal?.addEventListener(
          'abort',
          () => {
            state.aborted++
          },
          { once: true }
        )
      return nativeFetch.call(this, source, options)
    }
    const open = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      const source = hold(url, 'xhr')
      if (source !== url)
        this.addEventListener(
          'abort',
          () => {
            state.aborted++
          },
          { once: true }
        )
      return open.call(this, method, source, ...args)
    }
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args)
        this.addEventListener('message', (event) => {
          if (event.data?.action === 'ReaderHeadersReady') state.headersRequested = true
        })
      }
      terminate() {
        state.workerTerminated++
        return super.terminate()
      }
    }
  })
  return {
    async wait() {
      let deadline
      try {
        await Promise.race([
          requested,
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('PDF read barrier not reached')), 10000)
          })
        ])
      } finally {
        clearTimeout(deadline)
      }
      await page.waitForFunction(() => {
        const state = window.__PDF_LIFECYCLE__
        return state.transport === 'fetch' || state.headersRequested
      })
    },
    async release(response) {
      if (!held) return
      if (response) await held.fulfill(response)
      else await held.abort().catch(() => {})
    }
  }
}

async function configurePreviewExpiry(page, outcome) {
  const now = new Date('2026-11-11T00:00:00Z')
  const body = Buffer.from(
    (await fs.readFile(path.resolve(__dirname, '../fixtures/review-pdf.base64'), 'utf8')).trim(),
    'base64'
  )
  const first = {
    key: 'fixture-pdf',
    expiresAt: new Date(+now + 60_000).toISOString(),
    start: 5,
    end: 5,
    total: 10
  }
  const next = {
    ...first,
    key: outcome === 'replace' ? 'replacement-pdf' : first.key,
    expiresAt: new Date(+now + 300_000).toISOString()
  }
  let active = first
  let descriptorRequests = 0
  let release
  const canRenew = new Promise((resolve) => {
    release = resolve
  })
  await page.clock.install({ time: now })
  await page.addInitScript(() => {
    const created = []
    const revoked = []
    const create = URL.createObjectURL
    const revoke = URL.revokeObjectURL
    window.__PDF_PREVIEW_URLS__ = { created, revoked }
    URL.createObjectURL = (blob) => {
      const url = create.call(URL, blob)
      if (blob.type === 'application/pdf') created.push(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      revoked.push(url)
      revoke.call(URL, url)
    }
  })
  await page.route('**/api/fangji/pages/*/pdf/descriptor', async (route) => {
    if (++descriptorRequests === 1) return route.fulfill({ json: first })
    await canRenew
    if (outcome === 'deny') {
      return route.fulfill({ status: 403, json: { message: '合成测试：原文授权已撤回' } })
    }
    active = next
    return route.fulfill({ json: active })
  })
  await page.route('**/api/fangji/pages/*/pdf', (route) =>
    route.fulfill({
      contentType: 'application/pdf',
      headers: {
        'X-PDF-Preview-Key': active.key,
        'X-PDF-Expires-At': active.expiresAt,
        'X-PDF-Start-Page': String(active.start),
        'X-PDF-End-Page': String(active.end),
        'X-PDF-Total-Pages': String(active.total)
      },
      body
    })
  )
  return { release }
}

async function configurePageImages(page) {
  const expiresAt = '2099-01-01T00:00:00Z'
  const region = {
    entryId: 'page1',
    physicalPage: 5,
    rect: { x: 0.1, y: 0.12, width: 0.8, height: 0.12 }
  }
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 480
    canvas.height = 640
    const context = canvas.getContext('2d')
    context.fillStyle = '#faf5e8'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#222'
    context.font = '20px sans-serif'
    context.fillText('Synthetic source entry', 60, 118)
    return canvas.toDataURL('image/webp').split(',')[1]
  })
  let held
  let release
  await page.route('**/api/fangji/pages/*/pdf/descriptor', (route) =>
    route.fulfill({
      json: {
        key: 'fixture-pdf',
        expiresAt,
        start: 5,
        end: 6,
        total: 10,
        sourceRegion: { ...region, assetKey: 'fixture-pdf' }
      }
    })
  )
  await page.route('**/api/fangji/pages/*/images/*/descriptor', async (route) => {
    const url = new URL(route.request().url())
    const isEntryPage = url.pathname.endsWith('/5/descriptor')
    if (!isEntryPage && held) await held
    const assetId = isEntryPage ? 'fixture-image-5' : 'fixture-image-6'
    return route.fulfill({
      json: {
        url: url.pathname.replace(/descriptor$/, 'asset'),
        assetId,
        expiresAt,
        width: 480,
        height: 640,
        sourceRegion: isEntryPage ? { ...region, assetKey: assetId } : null
      }
    })
  })
  await page.route('**/api/fangji/pages/*/images/*/asset', (route) =>
    route.fulfill({ contentType: 'image/webp', body: Buffer.from(image, 'base64') })
  )
  return {
    holdNextPage() {
      held = new Promise((resolve) => {
        release = resolve
      })
    },
    release() {
      release?.()
      held = null
    }
  }
}

async function waitForRenderedPdf(page) {
  await page.waitForFunction(
    () =>
      document.querySelector('.pdf-canvas')?.width > 1 &&
      !document.querySelector('.pdf-loading-mask, .pdf-transition-mask')
  )
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  const viewer = await fs.readFile(
    path.resolve(__dirname, '../../src/components/editor/PdfSinglePageViewer.vue')
  )
  const report = {
    synthetic: true,
    viewer_sha256: createHash('sha256').update(viewer).digest('hex'),
    scenarios: []
  }
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'msedge' : undefined)
  })
  report.browser_version = browser.version()
  report.playwright_version = require('playwright/package.json').version
  async function scenario(name, run, hold = false, prepare) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    const item = { name, pass: false, errors }
    report.scenarios.push(item)
    page.on('pageerror', (error) => errors.push({ message: error.message, stack: error.stack }))
    let barrier
    let setup
    try {
      await installReviewRoutes(page)
      await page.route('**/api/fangji/access-context', (route) =>
        route.fulfill({ json: { managedProjectIds: [], proofreadingProjectIds: ['project1'] } })
      )
      if (hold) barrier = await holdFirstPdfRead(page)
      setup = await prepare?.(page)
      await page.goto(
        base +
          '/tests/fixtures/repository-review.html?start=' +
          encodeURIComponent('/tasks/page1/edit')
      )
      await page.waitForFunction(() => {
        const input = document.querySelector('.proofread-textarea')
        return input && !input.readOnly
      })
      if (barrier) await barrier.wait()
      await run(page, barrier, setup)
      item.probe = await page.evaluate(() => window.__PDF_LIFECYCLE__ || null)
      assert.deepEqual(errors, [], `${name}: no browser exceptions`)
      item.pass = true
    } catch (error) {
      item.failure = error.message
    } finally {
      await page
        .screenshot({ path: path.join(output, `${name}.png`), fullPage: true })
        .catch(() => {})
      await barrier?.release()
      setup?.release()
      await page.close()
    }
  }
  try {
    for (const action of ['logout', 'route', 'account']) {
      await scenario(
        `pending-${action}`,
        async (page) => {
          if (action === 'logout') {
            await page.getByLabel('账户与帮助', { exact: true }).click()
            await page.getByRole('button', { name: '退出登录', exact: true }).click()
            await page.locator('#login-account').waitFor()
          } else if (action === 'route') {
            await page.evaluate(() => window.__REPOSITORY_REVIEW__.router.push('/workspace'))
            await page.getByText('合成工作台', { exact: true }).waitFor()
          } else {
            await page.evaluate(() => {
              const { pb, token } = window.__REPOSITORY_REVIEW__
              pb.authStore.save(token, { id: 'account-b', name: '合成账号 B', role: 'user' })
            })
            await page.waitForFunction(() => {
              const canvas = document.querySelector('.pdf-canvas')
              return (
                window.__REPOSITORY_REVIEW__.auth.user?.id === 'account-b' &&
                canvas?.width > 1 &&
                !document.querySelector('.pdf-loading-mask')
              )
            })
          }
          await page.waitForFunction(() => {
            const state = window.__PDF_LIFECYCLE__
            return state.transport === 'fetch' ? state.aborted === 1 : state.workerTerminated > 0
          })
          // Cross a rendering boundary after the observed cancellation/worker
          // termination, not an arbitrary sleep or a filter for unwanted errors.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          )
        },
        true
      )
    }
    await scenario('ordinary-reading', async (page) => {
      await page.waitForFunction(
        () =>
          document.querySelector('.pdf-canvas')?.width > 1 &&
          !document.querySelector('.pdf-loading-mask')
      )
      assert.equal(await page.locator('.pdf-error').count(), 0)
      await page.getByRole('button', { name: '放大', exact: true }).click()
      assert.equal(
        await page.getByRole('spinbutton', { name: '原文缩放百分比' }).inputValue(),
        '125'
      )
      await page.waitForFunction(() => !document.querySelector('.pdf-loading-mask'))
    })
    for (const outcome of ['preserve', 'deny', 'replace']) {
      await scenario(
        `expired-preview-${outcome}`,
        async (page, _barrier, { release }) => {
          await waitForRenderedPdf(page)
          await page.getByRole('button', { name: '旋转 90°', exact: true }).click()
          for (let step = 0; step < 5; step++) {
            await page.getByRole('button', { name: '放大', exact: true }).click()
          }
          await waitForRenderedPdf(page)
          const before = await page.evaluate(() => {
            const scroll = document.querySelector('.pdf-scroll')
            const canvas = document.querySelector('.pdf-canvas')
            const stage = canvas.closest('.pdf-canvas-stage')
            scroll.scrollTo(160, 95)
            window.__originalPdfCanvas__ = canvas
            return {
              left: scroll.scrollLeft,
              top: scroll.scrollTop,
              width: stage.offsetWidth,
              height: stage.offsetHeight,
              url: window.__PDF_PREVIEW_URLS__.created.at(-1)
            }
          })
          assert.ok(before.left > 0 && before.top > 0, 'zoomed fixture must scroll on both axes')
          assert.ok(before.url?.startsWith('blob:'))
          await Promise.all([
            page.waitForRequest('**/api/fangji/pages/*/pdf/descriptor'),
            page.clock.fastForward(61_000)
          ])
          await page.locator('.pdf-transition-mask').waitFor()
          assert.deepEqual(
            await page.evaluate((url) => {
              const viewer = document.querySelector('.pdf-viewer')
              return {
                protected: getComputedStyle(viewer).opacity === '0' && viewer.inert,
                sameCanvas: document.querySelector('.pdf-canvas') === window.__originalPdfCanvas__,
                revoked: window.__PDF_PREVIEW_URLS__.revoked.includes(url)
              }
            }, before.url),
            { protected: true, sameCanvas: true, revoked: true }
          )
          release()
          if (outcome === 'deny') {
            await page.getByText('合成测试：原文授权已撤回', { exact: true }).waitFor()
            assert.equal(await page.locator('.pdf-viewer').count(), 0)
            return
          }
          await waitForRenderedPdf(page)
          if (outcome === 'replace') {
            assert.equal(await page.locator('.pdf-zoom-input').inputValue(), '100')
            assert.equal(
              await page.evaluate(
                () => document.querySelector('.pdf-canvas') === window.__originalPdfCanvas__
              ),
              false
            )
            return
          }
          assert.equal(await page.locator('.pdf-zoom-input').inputValue(), '225')
          const after = await page.evaluate(() => {
            const scroll = document.querySelector('.pdf-scroll')
            const canvas = document.querySelector('.pdf-canvas')
            const stage = canvas.closest('.pdf-canvas-stage')
            return {
              left: scroll.scrollLeft,
              top: scroll.scrollTop,
              width: stage.offsetWidth,
              height: stage.offsetHeight,
              sameCanvas: canvas === window.__originalPdfCanvas__
            }
          })
          assert.deepEqual(
            [after.left, after.top, after.sameCanvas],
            [before.left, before.top, true]
          )
          assert.ok(
            Math.abs(after.width - before.width) <= 1 &&
              Math.abs(after.height - before.height) <= 1,
            'renewal preserves the rotated stage within layout rounding'
          )
        },
        false,
        (page) => configurePreviewExpiry(page, outcome)
      )
    }
    await scenario('local-zoom', async (page) => {
      await page.waitForFunction(() => document.querySelector('.pdf-canvas')?.width > 1)
      const input = page.getByRole('spinbutton', { name: '原文缩放百分比' })
      const slider = page.getByRole('slider', { name: '原文缩放滑块' })
      await input.fill('173')
      await input.press('Enter')
      assert.equal(await slider.inputValue(), '173')
      await slider.press('ArrowRight')
      assert.equal(await input.inputValue(), '174')
      const priorBitmap = await page.evaluate(() => {
        const slider = document.querySelector('.pdf-zoom-range')
        const input = document.querySelector('.pdf-zoom-input')
        const event = () => new Event('input', { bubbles: true })
        slider.value = '175'
        slider.dispatchEvent(event())
        input.focus()
        input.value = '400'
        input.dispatchEvent(event())
        return document.querySelector('.pdf-canvas').width
      })
      await page.waitForFunction(
        (prior) => document.querySelector('.pdf-canvas')?.width !== prior,
        priorBitmap
      )
      assert.equal(await input.inputValue(), '400', 'Rendering preserves a pending zoom input')
      await input.blur()
      assert.equal(await input.inputValue(), '300')
      assert.equal(await page.getByRole('button', { name: '放大', exact: true }).isDisabled(), true)
      await input.fill('120')
      await input.press('Enter')
      await page.waitForFunction(() => {
        const stage = document.querySelector('.pdf-canvas-stage')
        const canvas = document.querySelector('.pdf-canvas')
        return Math.abs(stage.clientWidth * devicePixelRatio - canvas.width) < 3
      })

      const wheel = await page.evaluate(async () => {
        const wrap = document.querySelector('.pdf-scroll')
        const stage = document.querySelector('.pdf-canvas-stage')
        const canvas = document.querySelector('.pdf-canvas')
        const bounds = wrap.getBoundingClientRect()
        const clientX = bounds.left + wrap.clientWidth / 2
        const clientY = bounds.top + wrap.clientHeight / 2
        wrap.scrollTo(50, 90)
        const point = () => {
          const box = stage.getBoundingClientRect()
          return [(clientX - box.left) / box.width, (clientY - box.top) / box.height]
        }
        const before = point()
        const pixels = canvas.width
        const send = (target, ctrlKey) =>
          !target.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: -20,
              ctrlKey,
              clientX,
              clientY
            })
          )
        const outside = send(document.querySelector('.proofread-textarea'), true)
        const ordinary = send(wrap, false)
        const locallyHandled = [send(wrap, true), send(wrap, true)]
        await Promise.resolve()
        await Promise.resolve()
        const after = point()
        return {
          outside,
          ordinary,
          locallyHandled,
          drift: Math.max(...before.map((value, index) => Math.abs(value - after[index]))),
          keptBitmap: canvas.width === pixels && getComputedStyle(stage).visibility === 'visible'
        }
      })
      assert.equal(wheel.outside, false)
      assert.equal(wheel.ordinary, false)
      assert.deepEqual(wheel.locallyHandled, [true, true])
      assert(wheel.drift < 0.01, `wheel anchor drifted by ${wheel.drift}`)
      assert.equal(wheel.keptBitmap, true)
      assert(Number(await input.inputValue()) > 120)
      await page.waitForFunction(() => {
        const stage = document.querySelector('.pdf-canvas-stage')
        const canvas = document.querySelector('.pdf-canvas')
        return Math.abs(stage.clientWidth * devicePixelRatio - canvas.width) < 3
      })

      await page.getByRole('button', { name: '适合宽度' }).click()
      assert.equal(await input.inputValue(), '100')
      assert.equal(await slider.inputValue(), '100')
      const webkitGesture = await page.evaluate(() => {
        const wrap = document.querySelector('.pdf-scroll')
        const { left, top } = wrap.getBoundingClientRect()
        const send = (name, scale) =>
          !wrap.dispatchEvent(
            Object.assign(new Event(name, { bubbles: true, cancelable: true }), {
              clientX: left + 100,
              clientY: top + 100,
              scale
            })
          )
        return [send('gesturestart', 1), send('gesturechange', 1.25), send('gestureend', 1.25)]
      })
      assert.deepEqual(webkitGesture, [true, true, true])
      assert.equal(await input.inputValue(), '125')
      const touchPinch = await page.evaluate(() => {
        const target = document.querySelector('.pdf-scroll')
        const { left, top } = target.getBoundingClientRect()
        const touch = (identifier, x) =>
          new Touch({
            identifier,
            target,
            clientX: left + x,
            clientY: top + 110
          })
        const send = (name, touches) =>
          !target.dispatchEvent(
            new TouchEvent(name, {
              bubbles: true,
              cancelable: true,
              touches
            })
          )
        return [
          send('touchstart', [touch(1, 70)]),
          send('touchstart', [touch(1, 70), touch(2, 130)]),
          send('touchmove', [touch(1, 55), touch(2, 145)]),
          send('touchend', [])
        ]
      })
      assert.deepEqual(touchPinch, [false, true, true, false])
      assert.equal(await input.inputValue(), '188')
      assert.equal(await slider.inputValue(), '188')

      const toolbarFits = () =>
        page.locator('.pdf-toolbar').evaluate((toolbar) => {
          const box = toolbar.getBoundingClientRect()
          const controls = [...toolbar.querySelectorAll('button, input')]
          return (
            box.width > 0 &&
            controls.every((control) => {
              const bounds = control.getBoundingClientRect()
              return bounds.width > 0 && bounds.left >= box.left && bounds.right <= box.right + 1
            })
          )
        })
      await page.setViewportSize({ width: 1111, height: 900 })
      await page.getByRole('separator', { name: '调整原文与编辑区宽度' }).press('Home')
      assert((await page.locator('.pdf-toolbar').boundingBox()).width < 340)
      assert.equal(await toolbarFits(), true, 'Zoom controls fit the narrow desktop pane')
      await page.setViewportSize({ width: 320, height: 640 })
      await page.getByRole('button', { name: '查看原文', exact: true }).click()
      assert.equal(await toolbarFits(), true, 'Zoom controls fit the 320 px mobile layout')
      assert((await page.locator('.pdf-scroll').boundingBox()).height >= 64, 'Room to read the PDF')
      assert(
        (await page.locator('.fields-panel').boundingBox()).height >= 200,
        'Room to edit fields'
      )
      await slider.press('ArrowRight')
      assert.equal(await input.inputValue(), '189')
    })
    await scenario(
      'page-image-navigation-focus',
      async (page, _barrier, images) => {
        const local = page.getByRole('button', { name: '本条局部' })
        const next = page.getByRole('button', { name: '下一页原文' })
        const pageNumber = page.getByRole('spinbutton', { name: 'PDF 页码' })
        const source = page.getByRole('region', { name: '来源原文' })
        const field = page.locator('.proofread-textarea').first()
        await page.getByRole('img', { name: '本条原文局部' }).waitFor()

        await page.getByRole('button', { name: '整页', exact: true }).press('Enter')
        await page.getByRole('img', { name: '原文页面', exact: true }).waitFor()
        await local.press('Enter')
        await page.getByRole('img', { name: '本条原文局部' }).waitFor()
        assert.equal(await pageNumber.inputValue(), '5')
        assert.equal(await local.evaluate((el) => el === document.activeElement), true)

        await next.press('Enter')
        await page.getByRole('img', { name: '原文页面', exact: true }).waitFor()
        assert.equal(await pageNumber.inputValue(), '6')
        assert.equal(await pageNumber.evaluate((el) => el === document.activeElement), true)

        await page.keyboard.press('Tab')
        assert.equal(await local.evaluate((el) => el === document.activeElement), true)
        await page.keyboard.press('Enter')
        await page.getByRole('img', { name: '本条原文局部' }).waitFor()
        assert.equal(await pageNumber.inputValue(), '5')
        assert.equal(await local.evaluate((el) => el === document.activeElement), true)

        images.holdNextPage()
        await pageNumber.fill('6')
        await pageNumber.press('Enter')
        await page.getByText('正在加载原文…', { exact: true }).waitFor()
        assert.equal(await source.evaluate((el) => el === document.activeElement), true)
        assert.equal(await page.locator('.pdf-page-image').count(), 0)
        await field.focus()
        images.release()
        await page.getByRole('img', { name: '原文页面', exact: true }).waitFor()
        assert.equal(await field.evaluate((el) => el === document.activeElement), true)

        await local.press('Enter')
        await page.getByRole('img', { name: '本条原文局部' }).waitFor()
        assert.equal(await local.evaluate((el) => el === document.activeElement), true)

        await pageNumber.press('ArrowUp')
        await page.getByRole('img', { name: '原文页面', exact: true }).waitFor()
        assert.equal(await pageNumber.inputValue(), '6')
        assert.equal(await pageNumber.evaluate((el) => el === document.activeElement), true)

        await local.press('Enter')
        await page.getByRole('img', { name: '本条原文局部' }).waitFor()
      },
      false,
      configurePageImages
    )
    await scenario(
      'source-read-failure',
      async (page, barrier) => {
        await barrier.release({ status: 503, body: 'Synthetic unavailable source' })
        await page.locator('.pdf-error').filter({ hasText: '503' }).waitFor()
        assert.equal(await page.locator('.proofread-textarea').first().inputValue(), '测试')
      },
      true
    )
    await scenario(
      'invalid-pdf',
      async (page, barrier) => {
        await barrier.release({
          status: 200,
          contentType: 'application/pdf',
          body: 'Synthetic invalid PDF bytes'
        })
        const error = page.locator('.pdf-error').filter({
          hasText:
            'PDF 文件结构无效，无法预览。可重新读取；若仍失败，请联系项目管理员检查来源文件。'
        })
        await error.waitFor()
        assert.equal(await error.getByRole('button', { name: '重新读取原文' }).isEnabled(), true)
        assert.equal(await page.locator('.proofread-textarea').first().inputValue(), '测试')
      },
      true
    )
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
    assert.ok(
      report.scenarios.every((item) => item.pass),
      'Every PDF lifecycle scenario must pass'
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
