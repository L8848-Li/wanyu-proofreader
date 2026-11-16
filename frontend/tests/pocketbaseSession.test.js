import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

test('production PocketBase client preserves a new session after a late SDK 401', async () => {
  // Load the actual browser module through Vite, including import.meta.env.
  // Only the transport is controlled; send() and authStore use the installed SDK.
  const previousUrl = globalThis.__FANGJI_BACKEND_URL__
  globalThis.__FANGJI_BACKEND_URL__ = 'http://session.example.test'
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }
  })
  try {
    const { default: pb } = await server.ssrLoadModule('/src/lib/pocketbase.js')
    for (const nextAccount of [{ id: 'account-b' }, null]) {
      let finish
      pb.authStore.save('token-a', { id: 'account-a' })
      const pending = pb.send('/api/protected', {
        requestKey: null,
        fetch: () =>
          new Promise((resolve) => {
            finish = resolve
          })
      })
      await Promise.resolve()
      if (nextAccount) pb.authStore.save('token-b', nextAccount)
      else pb.authStore.clear()
      finish(
        new Response(JSON.stringify({ message: 'old credentials rejected' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      await assert.rejects(pending, (error) => error.status === 401)
      assert.equal(pb.authStore.token, nextAccount ? 'token-b' : '')
      assert.deepEqual(pb.authStore.record, nextAccount)
    }
  } finally {
    await server.close()
    if (previousUrl === undefined) delete globalThis.__FANGJI_BACKEND_URL__
    else globalThis.__FANGJI_BACKEND_URL__ = previousUrl
  }
})
