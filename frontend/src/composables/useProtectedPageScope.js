import { onBeforeUnmount } from 'vue'
import pb from '@/lib/pocketbase'
import { createIdentityPageScope } from '@/lib/identityPageScope'

export function useProtectedPageScope(clear) {
  return createIdentityPageScope(pb, clear, onBeforeUnmount)
}
