import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { refreshStoredAuth } from '@/services/authService'
import { documentTitleFor } from '@/lib/pageTitle'
import { shouldFocusMainLandmark } from '@/lib/routeFocus'
import { focusMainLandmark } from '@/lib/mainLandmark'
import { startTelemetry } from '@/services/telemetryService'
import { createApplicationStartup, renderStartupState } from '@/lib/applicationStartup'
import './style.css'
import './workbench.css'
import './styles/ui-components.css'

router.afterEach(async (to, from, failure) => {
  if (failure) return
  document.title = documentTitleFor(to.name)
  if (!shouldFocusMainLandmark(to, from)) return
  await nextTick()
  focusMainLandmark()
})

async function mountApplication() {
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.mount('#app')
  await router.isReady()
  startTelemetry(router)
  await nextTick()
  focusMainLandmark()
}

const startup = createApplicationStartup({
  refresh: (options) => refreshStoredAuth({ ...options, throwOnError: true }),
  mount: mountApplication,
  onState: (state) => renderStartupState(document, state)
})
document.getElementById('startup-retry')?.addEventListener('click', () => void startup.start())
window.addEventListener('pagehide', (event) => {
  if (event.persisted) startup.suspend()
  else startup.dispose()
})
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void startup.resume()
})
void startup.start()
