import { FIELD_ROLES } from '../constants/fieldRoles.js'

const SUGGESTIONS = [
  { role: 'headword', pattern: /词头|字头|词条|headword/i },
  { role: 'reading', pattern: /拼音|读音|音标|ipa|reading/i },
  { role: 'meaning', pattern: /释义|意思|词义|meaning/i },
  { role: 'region', pattern: /地区|地点|区域|region/i },
  { role: 'example', pattern: /例句|示例|例子|example/i },
  { role: 'note', pattern: /备注|注释|note/i }
]

export function suggestColumnRole(header) {
  const name = String(header || '').trim()
  if (!name || /页码|pdf_page|^page$/i.test(name)) return 'unspecified'
  for (const rule of SUGGESTIONS) {
    if (FIELD_ROLES.includes(rule.role) && rule.pattern.test(name)) return rule.role
  }
  return 'unspecified'
}

export function suggestColumnRoles(headers) {
  const roles = {}
  for (const header of headers || []) roles[header] = suggestColumnRole(header)
  return roles
}
