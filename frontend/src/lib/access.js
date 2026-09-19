// Role gating and post-login destinations, kept pure so the security-relevant
// branches can be asserted without a browser or a PocketBase instance.

export function authState({ isValid = false, model = null } = {}) {
  return {
    isLoggedIn: Boolean(isValid),
    mustChangePassword: Boolean(model?.must_change_password)
  }
}

export function homePath(state) {
  if (!state.isLoggedIn) return '/login'
  if (state.mustChangePassword) return '/change-password'
  return '/workspace'
}

// Returns the path to redirect to, or null to let the navigation continue.
export function resolveNavigation(to, state) {
  const meta = to.meta || {}
  if (meta.guest && state.isLoggedIn) return homePath(state)
  if (meta.requiresAuth && !state.isLoggedIn) {
    return `/login?redirect=${encodeURIComponent(to.fullPath || to.path || '/')}`
  }
  if (state.isLoggedIn && state.mustChangePassword && !meta.allowInitialPassword) return '/change-password'
  return null
}

export function isPlatformAdmin(role) {
  return role === 'platform_admin'
}

export function projectRoles(context) {
  return {
    canCreateProjects: Boolean(context?.canCreateProjects),
    hasManagedProjects: Boolean(context?.managedProjectIds?.length),
    hasProofreadingProjects: Boolean(context?.proofreadingProjectIds?.length)
  }
}
