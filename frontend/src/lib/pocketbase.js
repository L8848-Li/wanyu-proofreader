import PocketBase from 'pocketbase'

const runtimeBackendUrl = globalThis.__FANGJI_BACKEND_URL__
const buildTimePbUrl = import.meta.env.VITE_PB_URL

const pbUrl = runtimeBackendUrl || buildTimePbUrl || window.location.origin

const pb = new PocketBase(pbUrl)
// Session-aware authService refreshes own invalidation. A late 401 from an old
// account must not clear the account that signed in while that request ran.
pb.autoClearAuthStore(false)

export default pb
