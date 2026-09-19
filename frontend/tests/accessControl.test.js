import test from 'node:test'
import assert from 'node:assert/strict'

import { authState, homePath, isPlatformAdmin, projectRoles, resolveNavigation } from '../src/lib/access.js'

const loggedIn = authState({ isValid: true, model: { id: 'u1' } })
const anonymous = authState({})
const forcedPasswordChange = authState({ isValid: true, model: { must_change_password: true } })

test('only the platform_admin role unlocks platform administration', () => {
  assert.equal(isPlatformAdmin('platform_admin'), true)
  for (const role of ['user', '', null, undefined, 'PLATFORM_ADMIN', 'platform_admin ']) {
    assert.equal(isPlatformAdmin(role), false, `${JSON.stringify(role)} must not be an admin`)
  }
})

test('project capabilities require a non-empty membership list', () => {
  assert.deepEqual(projectRoles(null), {
    canCreateProjects: false, hasManagedProjects: false, hasProofreadingProjects: false
  })
  assert.deepEqual(projectRoles({ managedProjectIds: [], proofreadingProjectIds: [] }), {
    canCreateProjects: false, hasManagedProjects: false, hasProofreadingProjects: false
  })
  assert.deepEqual(projectRoles({ canCreateProjects: true, managedProjectIds: ['p1'], proofreadingProjectIds: ['p2'] }), {
    canCreateProjects: true, hasManagedProjects: true, hasProofreadingProjects: true
  })
})

test('sign-in state is derived from the token and the initial-password flag', () => {
  assert.deepEqual(anonymous, { isLoggedIn: false, mustChangePassword: false })
  assert.deepEqual(loggedIn, { isLoggedIn: true, mustChangePassword: false })
  assert.equal(forcedPasswordChange.mustChangePassword, true)
})

test('the landing page depends on sign-in and password state', () => {
  assert.equal(homePath(anonymous), '/login')
  assert.equal(homePath(forcedPasswordChange), '/change-password')
  assert.equal(homePath(loggedIn), '/workspace')
})

test('a signed-in visitor is bounced off guest-only pages', () => {
  assert.equal(resolveNavigation({ path: '/login', meta: { guest: true } }, loggedIn), '/workspace')
  assert.equal(resolveNavigation({ path: '/login', meta: { guest: true } }, anonymous), null)
})

test('protected pages carry the intended destination through the login redirect', () => {
  const target = { path: '/projects/p1', fullPath: '/projects/p1?tab=pending#row-7', meta: { requiresAuth: true } }
  const redirect = resolveNavigation(target, anonymous)
  assert.equal(redirect, '/login?redirect=%2Fprojects%2Fp1%3Ftab%3Dpending%23row-7')
  assert.equal(decodeURIComponent(redirect.split('redirect=')[1]), target.fullPath,
    'the round trip through encodeURIComponent must be lossless')
  assert.equal(resolveNavigation(target, loggedIn), null)
})

test('a missing fullPath cannot escape the redirect as undefined', () => {
  assert.equal(resolveNavigation({ path: '/workspace', meta: { requiresAuth: true } }, anonymous),
    '/login?redirect=%2Fworkspace')
  assert.equal(resolveNavigation({ meta: { requiresAuth: true } }, anonymous), '/login?redirect=%2F')
})

test('an initial password blocks every page except the change-password flow', () => {
  assert.equal(resolveNavigation({ path: '/workspace', meta: { requiresAuth: true } }, forcedPasswordChange),
    '/change-password')
  assert.equal(resolveNavigation({ path: '/change-password', meta: { allowInitialPassword: true } }, forcedPasswordChange), null)
  assert.equal(resolveNavigation({ path: '/', meta: {} }, forcedPasswordChange), '/change-password')
})

test('unauthenticated users are not trapped by the password rule', () => {
  assert.equal(resolveNavigation({ path: '/', meta: {} }, anonymous), null)
  assert.equal(resolveNavigation({ path: '/', meta: {} }, loggedIn), null)
})
