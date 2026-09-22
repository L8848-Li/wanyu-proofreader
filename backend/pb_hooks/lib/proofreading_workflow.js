function currentRound(page) {
  return page.getInt("proofread_round") || 1
}

function proofreadAttempts(dao, page) {
  const round = currentRound(page)
  return dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${page.id}" && round = ${round} && kind = "proofread"`,
    "pass_no,created",
    1000,
    0
  )
}

function ownProofreadAttempt(dao, page, userId) {
  const round = currentRound(page)
  const attempts = dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${page.id}" && round = ${round} && proofreader = "${userId}" && kind = "proofread"`,
    "",
    1,
    0
  )
  return attempts.length ? attempts[0] : null
}

function reviewedProofreads(dao, projectId, userId) {
  const pages = dao.findRecordsByFilter(
    "pages",
    `project = "${projectId}"`,
    "page_number",
    100000,
    0
  )
  const attempts = dao.findRecordsByFilter(
    "proofreading_attempts",
    `project = "${projectId}" && proofreader = "${userId}" && kind = "proofread"`,
    "",
    100000,
    0
  )
  const attemptsByPage = Object.create(null)
  for (const attempt of attempts) {
    const pageId = attempt.getString("page")
    if (!attemptsByPage[pageId]) attemptsByPage[pageId] = []
    attemptsByPage[pageId].push(attempt)
  }
  const items = []
  for (const page of pages) {
    if (page.getString("project") !== projectId) continue
    const round = currentRound(page)
    const attempt = (attemptsByPage[page.id] || []).find((row) => row.getInt("round") === round)
    if (!attempt) continue
    items.push({ page, attempt })
  }
  items.sort((a, b) => {
    const byNumber = a.page.getInt("page_number") - b.page.getInt("page_number")
    if (byNumber !== 0) return byNumber
    return String(a.page.id).localeCompare(String(b.page.id))
  })
  return items
}

function arbitrationAttempt(dao, page) {
  const round = currentRound(page)
  const attempts = dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${page.id}" && round = ${round} && kind = "arbitration"`,
    "created",
    1,
    0
  )
  return attempts.length ? attempts[0] : null
}

function requiredProofreads(dao, projectId) {
  const project = dao.findRecordById("projects", projectId)
  return Math.max(2, project.getInt("required_proofreads") || 2)
}

function canonicalRow(raw) {
  let parsed = null
  try { parsed = JSON.parse(String(raw || "")) } catch { return String(raw || "") }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return String(raw || "")
  const result = {}
  Object.keys(parsed).sort().forEach((key) => { result[key] = String(parsed[key] ?? "").trim() })
  return JSON.stringify(result)
}

function setAttemptOutcomes(dao, attempts, outcome) {
  for (const attempt of attempts) {
    if (attempt.getString("outcome") === outcome) continue
    attempt.set("outcome", outcome)
    dao.save(attempt)
  }
}

function resetPageForMoreProofreads(dao, page, attempts) {
  const { clearLease } = require(`${__hooks}/lib/task_leases.js`)
  page.set("proofread_count", attempts.length)
  page.set("proofread_row_json", "")
  page.set("proofread_text", "")
  page.set("proofreader", null)
  page.set("status", attempts.length ? "proofread" : "pending")
  clearLease(dao, page)
  setAttemptOutcomes(dao, attempts, "waiting")
  dao.save(page)
  return { status: page.getString("status"), count: attempts.length, outcome: "waiting" }
}

function evaluatePage(dao, page) {
  const { clearLease } = require(`${__hooks}/lib/task_leases.js`)
  const attempts = proofreadAttempts(dao, page)
  const required = requiredProofreads(dao, page.getString("project"))
  page.set("proofread_count", attempts.length)
  if (attempts.length < required) return resetPageForMoreProofreads(dao, page, attempts)

  const values = attempts.map((attempt) => canonicalRow(attempt.getString("row_json")))
  const matched = values.every((value) => value === values[0])
  page.set("proofreader", null)
  clearLease(dao, page)
  if (matched) {
    const source = attempts[0]
    page.set("proofread_row_json", source.getString("row_json"))
    page.set("proofread_text", source.getString("text"))
    page.set("proofread_at", String(source.get("submitted_at") || new Date().toISOString()))
    page.set("status", "approved")
    setAttemptOutcomes(dao, attempts, "matched")
    dao.save(page)
    return { status: "approved", count: attempts.length, outcome: "matched" }
  }

  const alreadyMismatched = attempts.some((attempt) => attempt.getString("outcome") === "mismatched")
  page.set("proofread_row_json", "")
  page.set("proofread_text", "")
  page.set("status", "arbitration")
  if (!alreadyMismatched) {
    page.set("mismatch_count", page.getInt("mismatch_count") + 1)
    page.set("last_mismatch_at", new Date().toISOString())
  }
  setAttemptOutcomes(dao, attempts, "mismatched")
  dao.save(page)
  return { status: "arbitration", count: attempts.length, outcome: "mismatched" }
}

function reconcileProjectQuorum(dao, projectId) {
  const { leaseForPage, leaseExpired, clearLease } = require(`${__hooks}/lib/task_leases.js`)
  const pages = dao.findRecordsByFilter("pages", `project = "${projectId}"`, "page_number", 100000, 0)
  const required = requiredProofreads(dao, projectId)
  for (const page of pages) {
    if (arbitrationAttempt(dao, page)) continue
    if (page.getString("status") === "arbitration") continue
    const attempts = proofreadAttempts(dao, page)
    page.set("proofread_count", attempts.length)
    const active = ["claimed", "proofreading"].includes(page.getString("status"))
    if (active) {
      const lease = leaseForPage(dao, page.id)
      if (lease && !leaseExpired(lease)) {
        dao.save(page)
        continue
      }
      clearLease(dao, page)
    }
    if (attempts.length >= required) evaluatePage(dao, page)
    else if (page.getString("status") === "approved" || active) resetPageForMoreProofreads(dao, page, attempts)
    else dao.save(page)
  }
}

module.exports = {
  proofreadAttempts,
  ownProofreadAttempt,
  reviewedProofreads,
  arbitrationAttempt,
  requiredProofreads,
  canonicalRow,
  evaluatePage,
  reconcileProjectQuorum
}
