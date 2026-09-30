import pb from '@/lib/pocketbase'

export function listSources() {
  return pb.send('/api/fangji/sources', { method: 'GET', requestKey: null })
}

export function createSource(body) {
  return pb.send('/api/fangji/sources', { method: 'POST', body, requestKey: null })
}

export function saveSourceUsage(sourceId, purpose, body) {
  return pb.send(`/api/fangji/sources/${encodeURIComponent(sourceId)}/usages/${encodeURIComponent(purpose)}`, {
    method: 'PUT',
    body,
    requestKey: null
  })
}
