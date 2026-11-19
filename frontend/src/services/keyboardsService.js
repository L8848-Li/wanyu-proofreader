import pb from '@/lib/pocketbase'

export async function listKeyboardLibrary() {
  return pb.send('/api/fangji/keyboards', { requestKey: null })
}

export async function getProjectKeyboards(projectId, { signal } = {}) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/keyboards`, {
    requestKey: null,
    signal
  })
}

export async function configureProjectKeyboards(projectId, keyboardIds, defaultKeyboardId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/keyboards`, {
    method: 'PUT',
    body: { keyboardIds, defaultKeyboardId: defaultKeyboardId || '' },
    requestKey: null
  })
}
