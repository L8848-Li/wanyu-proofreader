import pb from '@/lib/pocketbase'
import { createMemberCandidatesClient } from '../lib/memberCandidatesClient.js'
import { serializeProjectInsightsQuery } from '@/lib/adminProjectInsights'

export async function listProjectInsights(query = {}, { signal } = {}) {
  return pb.send(`/api/fangji/project-insights?${serializeProjectInsightsQuery(query)}`, {
    requestKey: null,
    signal
  })
}

export async function getProject(projectId, { signal } = {}) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}`, {
    requestKey: null,
    signal
  })
}

export async function getProjectWorkflow(projectId, { signal } = {}) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/workflow`, {
    requestKey: null,
    signal
  })
}

export async function getPracticeProgress(projectId, { signal } = {}) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/practice-progress`, {
    requestKey: null,
    signal
  })
}

export async function listProjects(options = {}) {
  const scope = options.scope || 'all'
  return pb.send(`/api/fangji/projects?scope=${encodeURIComponent(scope)}`, {
    signal: options.signal,
    requestKey: null
  })
}

export async function createProject(data) {
  return pb.send('/api/fangji/projects', {
    method: 'POST',
    body: data,
    requestKey: null
  })
}

export async function getColumnRoles(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/column-roles`, {
    requestKey: null
  })
}

export async function saveColumnRoles(projectId, roles, toneCountFields) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/column-roles`, {
    method: 'PUT',
    body: { roles, tone_count_fields: toneCountFields },
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

export const { listMemberCandidates, listMemberCandidatePage, setProjectMember } =
  createMemberCandidatesClient(pb)

export async function removeProjectMember(projectId, userId) {
  return pb.send(
    `/api/fangji/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
      requestKey: null
    }
  )
}

export async function generateProjectVolunteers(projectId, options) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/volunteers/generate`, {
    method: 'POST',
    body: options,
    requestKey: null
  })
}

export async function getAccessContext({ signal } = {}) {
  return pb.send('/api/fangji/access-context', { requestKey: null, signal })
}

export async function listCreatorGrants({ signal } = {}) {
  return pb.send('/api/fangji/platform/creator-grants', { requestKey: null, signal })
}

export async function setCreatorGrant(userId, { enabled, projectLimit }) {
  return pb.send(`/api/fangji/platform/creator-grants/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: { enabled, projectLimit: projectLimit ?? 0 },
    requestKey: null
  })
}
