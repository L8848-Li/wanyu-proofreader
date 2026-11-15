export function createApplicationStartup({
  refresh,
  mount,
  onState = () => {},
  timeoutMs = 10000
}) {
  let flight = null
  let controller = null
  let completed = false
  let disposed = false
  let suspended = false
  const suspensionReason = new DOMException('Startup suspended', 'AbortError')

  function start() {
    if (disposed || suspended) return Promise.resolve(false)
    if (completed) return Promise.resolve(true)
    if (flight) return flight

    controller = new AbortController()
    const current = controller
    flight = Promise.resolve().then(async () => {
      if (disposed || suspended || current.signal.aborted) {
        if (controller === current) controller = null
        flight = null
        return false
      }
      onState({ state: 'pending' })
      let rejectAbort
      const aborted = new Promise((_, reject) => {
        rejectAbort = () => reject(current.signal.reason)
        current.signal.addEventListener('abort', rejectAbort, { once: true })
      })
      const timer = setTimeout(
        () => current.abort(new DOMException('Startup refresh timed out', 'TimeoutError')),
        timeoutMs
      )
      try {
        await Promise.race([refresh({ signal: current.signal }), aborted])
        current.signal.throwIfAborted()
        clearTimeout(timer)
        if (disposed || suspended) return false
        // Refresh is finished. Suspending an already mounting app must not
        // cancel its completion and trigger a second mount on restoration.
        if (controller === current) controller = null
        await mount()
        if (disposed) return false
        completed = true
        if (!suspended) onState({ state: 'ready' })
        return true
      } catch (error) {
        if (!disposed && !suspended && error !== suspensionReason)
          onState({ state: 'error', error })
        return false
      } finally {
        clearTimeout(timer)
        current.signal.removeEventListener('abort', rejectAbort)
        if (controller === current) controller = null
        flight = null
      }
    })
    return flight
  }

  return {
    start,
    suspend() {
      suspended = true
      controller?.abort(suspensionReason)
    },
    async resume() {
      if (disposed) return false
      suspended = false
      // Let the aborted generation release its flight before starting another.
      await flight
      return start()
    },
    dispose() {
      disposed = true
      controller?.abort(new DOMException('Startup disposed', 'AbortError'))
    }
  }
}

export function renderStartupState(document, { state }) {
  const screen = document.getElementById('startup-screen')
  const title = document.getElementById('startup-title')
  const message = document.getElementById('startup-message')
  const retry = document.getElementById('startup-retry')
  if (!screen || !title || !message || !retry) return
  const retryHadFocus = document.activeElement === retry
  screen.setAttribute('aria-busy', String(state === 'pending'))
  message.setAttribute('role', state === 'error' ? 'alert' : 'status')
  title.textContent = state === 'error' ? '暂时无法打开万语校坊' : '正在打开万语校坊'
  message.textContent =
    state === 'error' ? '连接暂未完成，请检查网络后重试。当前登录信息会保留。' : '正在更新登录状态…'
  retry.hidden = state !== 'error'
  if (retryHadFocus && retry.hidden) message.focus()
}
