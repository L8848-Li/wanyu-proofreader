import { shouldClearAuthAfterRefreshError } from '../lib/authRefresh.js'

// Bind the transport once; production and regression tests execute the same session lifecycle.
export function createAuthService(pb) {
  function currentUserId(fallbackUser = null) {
    return pb.authStore.model?.id || fallbackUser?.id || null
  }

  function currentUserRole(fallbackUser = null) {
    return pb.authStore.model?.role || fallbackUser?.role || null
  }

  // Auth SDK helpers save tokens before resolving. Use the same REST endpoints
  // with a scoped publication step, so a late response cannot restore a session
  // after logout or replace a different account selected in another tab.
  async function withCurrentSession(operation, accept, signal) {
    const store = pb.authStore
    let unchanged = true
    const unsubscribe = store.onChange(() => {
      unchanged = false
    })
    try {
      const result = await operation()
      signal?.throwIfAborted()
      if (!unchanged || store !== pb.authStore)
        throw new DOMException('登录会话已变化，请重试。', 'AbortError')
      accept(result, store)
      return result
    } finally {
      unsubscribe()
    }
  }

  async function loginWithPassword(identity, password) {
    return withCurrentSession(
      () =>
        pb.send('/api/collections/users/auth-with-password', {
          method: 'POST',
          body: { identity, password },
          requestKey: null
        }),
      (result, store) => store.save(result.token, result.record)
    )
  }

  async function listExternalProviders() {
    const response = await pb.send('/api/fangji/auth/providers', {
      method: 'GET',
      requestKey: null
    })
    return Array.isArray(response?.providers) ? response.providers : []
  }

  async function loginWithExternalProvider(provider, identity, password) {
    return withCurrentSession(
      () =>
        pb.send(`/api/fangji/auth/external/${encodeURIComponent(provider)}/login`, {
          method: 'POST',
          body: { identity, password },
          requestKey: null
        }),
      (result, store) => store.save(result.token, result.record)
    )
  }

  async function bindExternalIdentity(provider, identity, password) {
    return withCurrentSession(
      () =>
        pb.send(`/api/fangji/auth/external/${encodeURIComponent(provider)}/bind`, {
          method: 'POST',
          body: { identity, password },
          requestKey: null
        }),
      (result, store) => {
        if (result.token && result.record) store.save(result.token, result.record)
      }
    )
  }

  async function refreshStoredAuth({ signal, throwOnError = false } = {}) {
    if (!pb.authStore.isValid) return null
    try {
      return await withCurrentSession(
        async () => {
          try {
            return await pb.send('/api/collections/users/auth-refresh', {
              method: 'POST',
              signal,
              requestKey: null
            })
          } catch (error) {
            return { refreshError: error }
          }
        },
        (result, store) => {
          if (result.refreshError) {
            if (shouldClearAuthAfterRefreshError(result.refreshError)) store.clear()
            else if (throwOnError) throw result.refreshError
          } else store.save(result.token, result.record)
        },
        signal
      ).then((result) => (result.refreshError ? null : result))
    } catch (error) {
      if (throwOnError) throw error
      return null
    }
  }

  async function registerProofreader({ email, password, passwordConfirm, name }) {
    return pb.collection('users').create(
      {
        email,
        password,
        passwordConfirm,
        name: name.trim(),
        role: 'user'
      },
      { requestKey: null }
    )
  }

  async function checkNicknameAvailable(name) {
    return pb.send('/api/fangji/auth/nickname-available', {
      method: 'GET',
      query: { name: name.trim() },
      requestKey: null
    })
  }

  async function changeInitialPassword({ currentPassword, newPassword, newPasswordConfirm }) {
    return pb.send('/api/fangji/auth/change-initial-password', {
      method: 'POST',
      body: { currentPassword, newPassword, newPasswordConfirm },
      requestKey: null
    })
  }

  function clearAuth() {
    pb.authStore.clear()
  }

  async function updateProfile({ name }) {
    const result = await withCurrentSession(
      () =>
        pb.send('/api/fangji/profile', {
          method: 'PATCH',
          body: { name },
          requestKey: null
        }),
      ({ token, record }, store) => {
        if (store.isValid && store.model?.id === record.id) store.save(token, record)
      }
    )
    return result.record
  }

  function accountCapabilities({ signal } = {}) {
    return pb.send('/api/fangji/auth/capabilities', { method: 'GET', requestKey: null, signal })
  }

  function requestPasswordReset(email) {
    return pb.collection('users').requestPasswordReset(email, { requestKey: null })
  }

  function requestEmailChange(newEmail) {
    return withCurrentSession(
      () => pb.collection('users').requestEmailChange(newEmail, { requestKey: null }),
      () => {}
    )
  }

  function requestEmailVerification(email) {
    return withCurrentSession(
      () => pb.collection('users').requestVerification(email, { requestKey: null }),
      () => {}
    )
  }

  function confirmAccountAction(action, token, password, passwordConfirm) {
    const paths = {
      'reset-password': 'confirm-password-reset',
      'confirm-email': 'confirm-email-change',
      'verify-email': 'confirm-verification'
    }
    if (!paths[action]) throw new Error('不支持的账户操作')
    return pb.send(`/api/collections/users/${paths[action]}`, {
      method: 'POST',
      body: { token, password, passwordConfirm },
      requestKey: null
    })
  }

  async function changeAccountPassword(oldPassword, password, passwordConfirm) {
    return withCurrentSession(
      () =>
        pb.send(`/api/collections/users/records/${encodeURIComponent(currentUserId())}`, {
          method: 'PATCH',
          body: { oldPassword, password, passwordConfirm },
          requestKey: null
        }),
      (_, store) => store.clear()
    )
  }

  async function logoutAllDevices() {
    return withCurrentSession(
      async () => {
        try {
          await pb.send('/api/fangji/auth/logout-all', {
            method: 'POST',
            body: {},
            requestKey: null
          })
          return {}
        } catch (error) {
          return { error }
        }
      },
      (result, store) => {
        // A timeout cannot prove server-side revocation. End this local session,
        // but never a session selected while the request was pending (even A→B→A).
        store.clear()
        if (result.error) throw result.error
      }
    )
  }

  function listSecurityEvents(query = {}, { signal } = {}) {
    return pb.send('/api/fangji/security-events', {
      method: 'GET',
      query,
      requestKey: null,
      signal
    })
  }
  return {
    currentUserId,
    currentUserRole,
    loginWithPassword,
    listExternalProviders,
    loginWithExternalProvider,
    bindExternalIdentity,
    refreshStoredAuth,
    registerProofreader,
    checkNicknameAvailable,
    changeInitialPassword,
    clearAuth,
    updateProfile,
    accountCapabilities,
    requestPasswordReset,
    requestEmailChange,
    requestEmailVerification,
    confirmAccountAction,
    changeAccountPassword,
    logoutAllDevices,
    listSecurityEvents
  }
}
