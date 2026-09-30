/// <reference path="../pb_data/types.d.ts" />

// 来源登记的读写口。集合规则全是 null，不能从集合 API 绕过。
// 本文件不在顶层声明 const：PocketBase 会把所有 .pb.js 拼进同一个作用域。

routerAdd("GET", "/api/fangji/sources", (c) => {
  const { requireReader, listSources } = require(`${__hooks}/lib/source_registry.js`)
  requireReader($app, c.auth)
  return c.json(200, listSources($app))
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/fangji/sources", (c) => {
  const { requireWriter, createSource } = require(`${__hooks}/lib/source_registry.js`)
  requireWriter($app, c.auth)
  const body = c.requestInfo().body || {}
  return c.json(201, createSource($app, c.auth, body))
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/sources/{sourceId}", (c) => {
  const { requireReader, findSource, sourceJson } = require(`${__hooks}/lib/source_registry.js`)
  requireReader($app, c.auth)
  const source = findSource($app, c.request.pathValue("sourceId"))
  return c.json(200, sourceJson($app, source))
}, $apis.requireAuth("users"))

routerAdd("PATCH", "/api/fangji/sources/{sourceId}", (c) => {
  const { requireWriter, findSource, updateSource } = require(`${__hooks}/lib/source_registry.js`)
  requireWriter($app, c.auth)
  const source = findSource($app, c.request.pathValue("sourceId"))
  return c.json(200, updateSource($app, source, c.requestInfo().body || {}))
}, $apis.requireAuth("users"))

routerAdd("DELETE", "/api/fangji/sources/{sourceId}", (c) => {
  const { requireWriter, findSource } = require(`${__hooks}/lib/source_registry.js`)
  requireWriter($app, c.auth)
  const source = findSource($app, c.request.pathValue("sourceId"))
  const referenced = ["projects", "import_jobs"].some(
    (collection) => $app.findRecordsByFilter(collection, `source = "${source.id}"`, "", 1, 0).length
  )
  if (referenced) throw new BadRequestError("来源仍被项目或导入作业引用，请先解除关联")
  $app.delete(source)
  return c.json(200, { id: source.id, deleted: true })
}, $apis.requireAuth("users"))

routerAdd("PUT", "/api/fangji/sources/{sourceId}/usages/{purpose}", (c) => {
  const { requireWriter, findSource, upsertUsage } = require(`${__hooks}/lib/source_registry.js`)
  requireWriter($app, c.auth)
  const source = findSource($app, c.request.pathValue("sourceId"))
  const usage = upsertUsage($app, c.auth, source, c.request.pathValue("purpose"), c.requestInfo().body || {})
  return c.json(200, usage)
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/fangji/sources/{sourceId}/usages/{purpose}/gate", (c) => {
  const { requireReader, findSource, gateFor } = require(`${__hooks}/lib/source_registry.js`)
  requireReader($app, c.auth)
  const source = findSource($app, c.request.pathValue("sourceId"))
  return c.json(200, gateFor($app, source.id, c.request.pathValue("purpose")))
}, $apis.requireAuth("users"))
