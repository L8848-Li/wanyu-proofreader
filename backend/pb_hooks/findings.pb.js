/// <reference path="../pb_data/types.d.ts" />

// #176 — 机器疑点的只读接口。集合 API 不给 list/view/create/update/delete 规则，
// 校对端与管理端都只能走这两个路由，门控与盲校过滤才有唯一的落点。

// Even a native superuser request cannot turn a staged payload into legacy data
// or delete its publication marker. Internal Save/Delete paths retain control of
// bounded abandoned-stage cleanup; normal project/page cascades remain legal.
// Judgment projections intentionally index only human judgments. Keep the
// publication relation exclusive to machine events even for internal Save.
onRecordCreate((e) => {
  if (e.record.getString("assist_publication") && e.record.getString("kind") !== "machine_analysis") throw new BadRequestError("只有机器分析事件可以暂存发布")
  return e.next()
}, "verification_events")
onRecordUpdate((e) => {
  if (e.record.getString("assist_publication") && e.record.getString("kind") !== "machine_analysis") throw new BadRequestError("只有机器分析事件可以暂存发布")
  return e.next()
}, "verification_events")
onRecordCreateRequest(() => { throw new ForbiddenError("分析发布标记只能由发布流程创建") }, "assist_publications")
onRecordUpdateRequest(() => { throw new ForbiddenError("分析发布标记不可通过记录 API 修改") }, "assist_publications")
onRecordDeleteRequest(() => { throw new ForbiddenError("分析发布标记必须保留") }, "assist_publications")
onRecordCreateRequest((e) => {
  if (e.record.getString("assist_publication")) throw new ForbiddenError("分析发布载荷只能由发布流程创建")
  return e.next()
}, "review_findings", "verification_events")
onRecordUpdateRequest((e) => {
  const original = e.app.findRecordById(e.collection.name, e.record.id)
  if (original.getString("assist_publication") !== e.record.getString("assist_publication")) throw new ForbiddenError("分析发布关系不可通过记录 API 修改")
  return e.next()
}, "verification_events")
onRecordDeleteRequest((e) => {
  if (e.record.getString("assist_publication")) throw new ForbiddenError("分析发布载荷不可通过记录 API 删除")
  return e.next()
}, "review_findings", "verification_events")

onRecordUpdateRequest((e) => {
  const { IMMUTABLE_FINDING_FIELDS: FINDING_IMMUTABLE_FIELDS } = require(`${__hooks}/lib/findings.js`)
  // 只允许把旧批次标成 superseded_at，其余字段一律不可改。
  // 这里用 Request 版钩子并回读库里的当前行——与 main.pb.js 的 users/pages 守卫同一套写法；
  // 模型级 onRecordUpdate 里回读会在同一次保存的事务中失败（表现为 400 Failed to update record）。
  // 覆盖范围：所有走 API 的写入（含 superuser）。特权代码路径必须自己遵守只追加约定。
  let original = null
  try {
    original = $app.findRecordById("review_findings", e.record.id)
  } catch {
    throw new BadRequestError("疑点记录不存在或已被删除")
  }
  const publicationId = original.getString("assist_publication")
  if (publicationId) {
    // A staged row still counts toward publication even if the native API
    // retires it. Keep private payloads immutable until they are published.
    const publication = e.app.findRecordById("assist_publications", publicationId)
    if (publication.getString("state") !== "published") {
      throw new ForbiddenError("未发布的分析载荷不可通过记录 API 修改")
    }
  }
  for (const name of FINDING_IMMUTABLE_FIELDS) {
    if (e.record.getString(name) !== original.getString(name)) {
      throw new ForbiddenError("疑点记录不可覆写，只能标 superseded_at 后写新批次")
    }
  }
  return e.next()
}, "review_findings")

// GET /api/fangji/pages/{pageId}/findings
// 校对端形状：{ hints: [{field, kind, severity, message:{key,params}, highlight, evidence}] }
// 已按 gate 与 severity 过滤：off 档一条不给，info 永不给。响应里不含 round / 轮次线索。
routerAdd("GET", "/api/fangji/pages/{pageId}/findings", (c) => {
  const result = require(`${__hooks}/lib/assist_read_consistency.js`).pageResponse($app, c.request.pathValue("pageId"), c.auth, ({ page, actor }) => {
    const result = require(`${__hooks}/lib/findings.js`).hintsForPage($app, page.id)
    const research = require(`${__hooks}/lib/source_research.js`).presentationFor($app, page, actor.id)
    if (research) {
      result.hints = research.presentation.hints
      result.suppressed_by_gate = research.presentation.display.hint_policy === "explicit_research_release" ? 0 : research.presentation.production_suppressed
      result.research = research
    }
    return { page: page.id, ...result }
  }, ({ page, manager, actor }) => {
    // Preserve this endpoint's narrower access: a draft/report alone does not
    // grant findings access. Apply the same check again before returning.
    if (!manager) {
      const active = page.getString("proofreader") === actor.id && ["claimed", "proofreading"].includes(page.getString("status"))
      if (!active && !require(`${__hooks}/lib/proofreading_workflow.js`).ownProofreadAttempt($app, page, actor.id)) throw new ForbiddenError("该条目当前不在你手上")
    }
  })
  return c.json(200, result)
}, $apis.requireAuth("users"))

// GET /api/fangji/projects/{projectId}/findings
// 管理端统计口：不做门控过滤，info 与 off 档照样可见（门槛文件 §2 的
// 「仍计算、仍写库、只在管理端统计」靠这个读取口才成立）。manager 专属。
routerAdd("GET", "/api/fangji/projects/{projectId}/findings", (c) => {
  const projectId = require(`${__hooks}/lib/project_access.js`).assertId(c.request.pathValue("projectId"), "项目")
  const query = c.request.url.query()
  const result = require(`${__hooks}/lib/assist_read_consistency.js`).projectResponse($app, projectId, c.auth, () =>
    require(`${__hooks}/lib/findings.js`).listForProject($app, projectId, {
      page: query.get("page"), per: query.get("per"), kind: query.get("kind"), producer: query.get("producer"), batch: query.get("batch")
    }))
  return c.json(200, result)
}, $apis.requireAuth("users"))
