/// <reference path="../pb_data/types.d.ts" />

// #177 确定性规则引擎的触发口。
//
// 本文件刻意不在顶层声明任何 const：PocketBase 的 JSVM 把所有 .pb.js 拼进同一个作用域，
// 顶层同名声明会在启动时直接 panic（本轮踩过：Identifier 'FANGJI_API' has already been declared），
// 而顶层 const 在回调实际执行时也读不到（本轮踩过：ReferenceError → 400）。

// POST /api/fangji/projects/{projectId}/findings/recompute
// manager 专属的项目级全量重算：列级(R3 编码形式 / R4 全半角)与页级(R7 离群)规则
// 必须看到整批数据才判得出来，所以只能挂在这个口，不能挂在单条提交上。
// 同步执行并返回耗时——#177 的规模与耗时验收要靠这个数字，不靠估计。
routerAdd("POST", "/api/fangji/projects/{projectId}/findings/recompute", (c) => {
  const { assertId: proofAssertId, requireManager: proofRequireManager } = require(`${__hooks}/lib/project_access.js`)
  const { recomputeProject: assistRecomputeProject } = require(`${__hooks}/lib/assist_writer.js`)

  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const projectId = proofAssertId(c.request.pathValue("projectId"), "项目")
  proofRequireManager($app, projectId, auth)

  const summary = assistRecomputeProject($app, projectId)
  console.log("assist_recompute", JSON.stringify({ project: projectId, ...summary }))
  return c.json(200, summary)
}, $apis.requireAuth("users"))

// POST /api/fangji/pages/{pageId}/findings/recompute
// 单条重算，鉴权与疑点读取同构（manager 或该条在手者）。
// 存在的理由有两个：#124 的预览要能只对一条补算；以及 #177 验收里
// 「单条重算 p95 < 50 ms」必须有一个可以直接计时、不被认领/事务耗时混进去的口子。
routerAdd("POST", "/api/fangji/pages/{pageId}/findings/recompute", (c) => {
  const { assertId: proofAssertId, canManage: proofCanManage, canProofread: proofCanProofread, project: proofProject } =
    require(`${__hooks}/lib/project_access.js`)
  const { recomputePage: assistRecomputePage } = require(`${__hooks}/lib/assist_writer.js`)

  const auth = c.auth
  if (auth.getBool("must_change_password")) throw new ForbiddenError("首次登录请先修改密码")
  const pageId = proofAssertId(c.request.pathValue("pageId"), "条目")
  let page = null
  try {
    page = $app.findRecordById("pages", pageId)
  } catch {
    throw new NotFoundError("条目不存在")
  }
  const projectId = page.getString("project")
  const manager = proofCanManage($app, proofProject($app, projectId), auth)
  if (!manager && !proofCanProofread($app, projectId, auth)) {
    throw new ForbiddenError("你不是该项目的成员")
  }
  if (!manager) {
    const active = page.getString("proofreader") === auth.id
      && ["claimed", "proofreading"].includes(page.getString("status"))
    if (!active) throw new ForbiddenError("该条目当前不在你手上")
  }

  const startedAt = Date.now()
  const summary = assistRecomputePage($app, pageId)
  return c.json(200, { ...summary, duration_ms: Date.now() - startedAt })
}, $apis.requireAuth("users"))
