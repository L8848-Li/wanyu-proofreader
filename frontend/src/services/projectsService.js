import pb from '@/lib/pocketbase'

export async function getProject(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}`, {
    requestKey: null
  })
}

export async function listProjects(options = {}) {
  const scope = options.scope || 'all'
  return pb.send(`/api/fangji/projects?scope=${encodeURIComponent(scope)}`, {
    requestKey: null,
  })
}

export async function createProject(data) {
  return pb.send('/api/fangji/projects', {
    method: 'POST',
    body: data,
    requestKey: null
  })
}

export async function updateProject(projectId, data) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: data,
    requestKey: null
  })
}

export async function deleteProject(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    requestKey: null
  })
}

export async function transferProjectOwnership(projectId, userId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/owner`, {
    method: 'PUT',
    body: { userId },
    requestKey: null
  })
}

export async function joinProject(projectId, password = '') {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/join`, {
    method: 'POST',
    body: { password },
    requestKey: null
  })
}

export async function listProjectMembers(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/members`, {
    requestKey: null
  })
}

export async function listMemberCandidates(projectId, term = '') {
  const query = term.trim() ? `?term=${encodeURIComponent(term.trim())}` : ''
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/member-candidates${query}`, {
    requestKey: null
  })
}

export async function setProjectMember(projectId, userId, role) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: { role },
    requestKey: null
  })
}

export async function removeProjectMember(projectId, userId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    requestKey: null
  })
}

export async function generateProjectVolunteers(projectId, options) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/volunteers/generate`, {
    method: 'POST',
    body: options,
    requestKey: null
  })
}

export async function getAccessContext() {
  return pb.send('/api/fangji/access-context', { requestKey: null })
}

export async function listCreatorGrants() {
  return pb.send('/api/fangji/platform/creator-grants', { requestKey: null })
}

export async function setCreatorGrant(userId, { enabled, projectLimit }) {
  return pb.send(`/api/fangji/platform/creator-grants/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: { enabled, projectLimit: projectLimit ?? 0 },
    requestKey: null
  })
}
