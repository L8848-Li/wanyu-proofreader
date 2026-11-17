import { createIdentityPageScope } from '../../src/lib/identityPageScope.js'

// Use the same identity scope as the Vue composable; replace only disposal
// registration and the auth-store change source.
export function protectedPageScopeFixture(registerDispose = () => {}) {
  const listeners = new Set()
  const authStore = {
    model: { id: 'account-a', role: 'user' },
    token: 'token-a',
    get isValid() {
      return Boolean(this.model?.id && this.token)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const useProtectedPageScope = (clear) =>
    createIdentityPageScope({ authStore }, clear, registerDispose)
  return {
    useProtectedPageScope,
    authStore,
    changeIdentity(model, token = model ? 'next-token' : '') {
      authStore.model = model
      authStore.token = token
      for (const listener of listeners) listener(token, model)
    },
    listenerCount: () => listeners.size
  }
}
