import pb from '@/lib/pocketbase'
import { createAuthService } from './createAuthService.js'

export const {
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
} = createAuthService(pb)
