import { ref } from 'vue'
import { createProtectedPageScope } from './protectedPageScope.js'

export function createIdentityPageScope(pb, clear, onDispose) {
  const accessLost = ref(false)
  const scope = createProtectedPageScope((status) => {
    accessLost.value = true
    clear(status)
  })
  const identity = () =>
    pb.authStore.isValid ? `${pb.authStore.model?.id || ''}:${pb.authStore.model?.role || ''}` : ''
  let previous = identity()
  const unsubscribe = pb.authStore.onChange(() => {
    const next = identity()
    if (previous === next) return // A normal token refresh is not a new identity.
    previous = next
    scope.invalidate({ status: 401 })
  })
  onDispose(() => {
    unsubscribe()
    scope.dispose()
  })
  return { ...scope, accessLost }
}
