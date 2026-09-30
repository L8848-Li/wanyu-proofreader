# 来源登记与用途权利

本文件说明 #169 的字段、门闩和回滚。权利结论由人填写，系统不托管授权文件，也不在用途之间做自动放行。

## 集合

`sources` 一条对应一份可以单独谈权利的材料。`logical_id` 在库内唯一。未提供时按标题和格式生成 `src-` 加 8 位十六进制。

| 字段 | 含义 |
| --- | --- |
| `logical_id` | 稳定逻辑 ID |
| `title` | 标题 |
| `holder` | 权利主体 |
| `scope` | 方言或地区范围 |
| `format` | 载体格式 |
| `original_vs_derived` | `original` 原始 / `derived` 派生 |
| `status` | `unregistered` 未入册 / `pending_rights` 待权利确认 / `confirmed` 已确认可用 / `restricted` 受限 |
| `record_count` | 材料条数，只是登记数字 |

`source_usages` 按用途各记一条。用途是 `public_display`、`internal_research`、`model_training`、`commercial_use`、`redistribution`、`raw_third_party_transfer`。结论是 `allow` 允许、`deny` 禁止、`unknown` 未知。`evidence_ref` 只写授权文件在仓库外的位置，不写文件正文。

`projects.source` 和 `import_jobs.source` 可以指向一条来源。导入表单的 `source_id` 留空时，作业仍会成功，`source_link` 写成 `unknown`。填了但找不到来源时，这一次导入会被拒绝，不会静默标成未知。

## 门闩

`GET /api/fangji/sources/{id}/usages/{purpose}/gate` 只读。`decision` 不是 `allow` 时 `blocked` 为真，包括没有登记过的用途。下游不得把缺记录读成默认允许。

集合规则全部是 `null`。清单和写入只走 `/api/fangji/sources`。平台管理员可写，平台管理员和项目管理员可看。

## 回滚与备份

迁移文件是 `backend/pb_migrations/1789200000_source_registry.js`。

它的 down 会删除 `source_usages`、`sources`，以及项目和导入作业上的来源字段。登记过的权利结论会一起丢掉。

`1788940000_initial_schema.js` 的 down 会直接抛错，不会拆掉已有库。错误文本要求先恢复完整备份，或换一个新的数据目录。因此上线本迁移之前要先备份 `pb_data`。不能指望把初始快照回滚来撤销这次变更。

已经写进来源表的内容，回滚后无法从迁移本身找回，只能从备份恢复。
