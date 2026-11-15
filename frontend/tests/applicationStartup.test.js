import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplicationStartup } from '../src/lib/applicationStartup.js'

function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

test('startup shows pending before refresh, deduplicates retries and mounts once', async () => {
  const refresh = deferred()
  const states = []
  let mounts = 0
  const startup = createApplicationStartup({
    refresh: () => {
      assert.deepEqual(states, ['pending'])
      return refresh.promise
    },
    mount: () => mounts++,
    onState: ({ state }) => states.push(state)
  })
  const first = startup.start()
  assert.equal(startup.start(), first)
  await Promise.resolve()
  assert.equal(mounts, 0)
  refresh.resolve()
  assert.equal(await first, true)
  assert.equal(await startup.start(), true)
  assert.equal(mounts, 1)
  assert.deepEqual(states, ['pending', 'ready'])
})

test('startup failures retain a retry and do not mount protected views', async () => {
  const states = []
  let requests = 0
  let mounts = 0
  const startup = createApplicationStartup({
    refresh: () => {
      if (++requests === 1) throw new TypeError('synthetic connection failure')
    },
    mount: () => mounts++,
    onState: ({ state }) => states.push(state)
  })
  assert.equal(await startup.start(), false)
  assert.equal(mounts, 0)
  assert.equal(await startup.start(), true)
  assert.equal(mounts, 1)
  assert.deepEqual(states, ['pending', 'error', 'pending', 'ready'])
})

test('timeout aborts a stalled refresh and its late result cannot mount over a retry', async () => {
  const stalled = deferred()
  const states = []
  let requests = 0
  let mounts = 0
  let firstSignal
  const startup = createApplicationStartup({
    timeoutMs: 5,
    refresh: ({ signal }) => {
      if (++requests === 1) {
        firstSignal = signal
        return stalled.promise
      }
    },
    mount: () => mounts++,
    onState: ({ state, error }) => states.push([state, error?.name])
  })
  assert.equal(await startup.start(), false)
  assert.equal(firstSignal.aborted, true)
  assert.equal(firstSignal.reason.name, 'TimeoutError')
  assert.equal(mounts, 0)
  assert.equal(await startup.start(), true)
  stalled.resolve()
  await Promise.resolve()
  assert.equal(mounts, 1)
  assert.deepEqual(
    states.map(([state]) => state),
    ['pending', 'error', 'pending', 'ready']
  )
})

test('leaving during refresh cancels it without publishing an error or a late view', async () => {
  const stalled = deferred()
  const states = []
  let mounts = 0
  const startup = createApplicationStartup({
    refresh: () => stalled.promise,
    mount: () => mounts++,
    onState: ({ state }) => states.push(state)
  })
  const running = startup.start()
  await Promise.resolve()
  startup.dispose()
  assert.equal(await running, false)
  stalled.resolve()
  assert.equal(await startup.start(), false)
  assert.equal(mounts, 0)
  assert.deepEqual(states, ['pending'])
})

test('disposed startup never starts a request', async () => {
  const startup = createApplicationStartup({
    refresh: () => assert.fail('disposed refresh ran'),
    mount: () => assert.fail('disposed mount ran')
  })
  startup.dispose()
  assert.equal(await startup.start(), false)
})

test('cached pending startup cancels the old refresh and resumes with a new generation', async () => {
  const old = deferred()
  const states = []
  let requests = 0,
    mounts = 0,
    oldSignal
  const startup = createApplicationStartup({
    refresh: ({ signal }) => {
      if (++requests === 1) {
        oldSignal = signal
        return old.promise
      }
    },
    mount: () => mounts++,
    onState: ({ state }) => states.push(state)
  })
  const running = startup.start()
  await Promise.resolve()
  startup.suspend()
  assert.equal(oldSignal.aborted, true)
  assert.equal(await startup.start(), false)
  const resumed = startup.resume()
  assert.equal(await running, false)
  assert.equal(await resumed, true)
  old.resolve()
  await Promise.resolve()
  assert.equal(requests, 2)
  assert.equal(mounts, 1)
  assert.deepEqual(states, ['pending', 'pending', 'ready'])
})

test('cached error startup can fail again on restoration and still accept a manual retry', async () => {
  let requests = 0,
    mounts = 0
  const startup = createApplicationStartup({
    refresh: () => {
      if (++requests < 3) throw new Error('unavailable')
    },
    mount: () => mounts++
  })
  assert.equal(await startup.start(), false)
  startup.suspend()
  assert.equal(await startup.resume(), false)
  assert.equal(await startup.start(), true)
  startup.suspend()
  assert.equal(await startup.resume(), true)
  assert.equal(requests, 3)
  assert.equal(mounts, 1)
})

test('caching before the first microtask never sends the cancelled refresh', async () => {
  let requests = 0,
    mounts = 0
  const startup = createApplicationStartup({ refresh: () => requests++, mount: () => mounts++ })
  const running = startup.start()
  startup.suspend()
  assert.equal(await startup.resume(), true)
  assert.equal(await running, false)
  assert.equal(requests, 1)
  assert.equal(mounts, 1)
})

test('restoration during mounting waits for the existing app instead of mounting it twice', async () => {
  const mounting = deferred()
  let requests = 0,
    mounts = 0
  const startup = createApplicationStartup({
    refresh: () => requests++,
    mount: () => {
      mounts++
      return mounting.promise
    }
  })
  const running = startup.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(mounts, 1)
  startup.suspend()
  const resumed = startup.resume()
  mounting.resolve()
  assert.equal(await running, true)
  assert.equal(await resumed, true)
  assert.equal(requests, 1)
  assert.equal(mounts, 1)
})

test('a restored suspended refresh has its own timeout and can be retried', async () => {
  const old = deferred()
  let requests = 0
  const startup = createApplicationStartup({
    timeoutMs: 5,
    refresh: () => (++requests < 3 ? old.promise : undefined),
    mount: () => {}
  })
  const running = startup.start()
  await Promise.resolve()
  startup.suspend()
  assert.equal(await startup.resume(), false)
  assert.equal(await running, false)
  assert.equal(await startup.start(), true)
  old.resolve()
})

test('a truly disposed page cannot be revived by a persisted pageshow', async () => {
  const startup = createApplicationStartup({
    refresh: () => assert.fail('disposed refresh ran'),
    mount: () => assert.fail('disposed mount ran')
  })
  startup.dispose()
  assert.equal(await startup.resume(), false)
})
