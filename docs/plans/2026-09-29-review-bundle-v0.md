# Review Bundle v0

人工可控的批次交换契约。乡声集盒导出 `ReviewBundle/v0`，人工检查后由万语校坊校验；校对结束后万语校坊导出 `ReviewResultBundle/v0`，再经人工检查回到乡声集盒。

本文件只定义语义和校验。导入执行是后续工作，本校验器不写库。不建设 realtime API、webhook、message queue、distributed transaction 或 shared database。校验通过也不等于自动回流，也不把 Candidate 升级为 Gold。

## 1. 承载

一个目录，或一个 zip。根上有 `manifest.json`，清单里的 JSONL 可以放在子目录。目录和 zip 按同一套相对路径读取。zip 如果只有一个顶层目录，校验器会先去掉这一层。清单没有列出的文件会被忽略，也不会被导入。

JSONL 使用 LF。`lines` 按物理行计数：末尾换行不另算空行。`bytes` 是文件字节数。`sha256` 是这些字节的 SHA-256，小写十六进制；大写也可通过比对。

样例（合成数据，不是语料）：

- `backend/reviewbundle/testdata/review-bundle-v0/inbound/`
- `backend/reviewbundle/testdata/review-bundle-v0/result/`

## 2. 进入包 `ReviewBundle/v0`

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `bundle.bundle_id` | 是 | 这一批的稳定编号。不是 `pages.id` |
| `bundle.schema_version` | 是 | 必须是 `ReviewBundle/v0` |
| `bundle.created_at` | 是 | RFC3339 |
| `source_system` | 是 | 来源系统。乡声集盒用 `xiangsheng-jihe` |
| `source_id` | 是 | 来源系统里的对象或数据集编号 |
| `source_version` | 是 | 该对象的版本 |
| `requested_fields` | 是 | 希望校对的字段名。可为空数组 |
| `rights_ref` | 是 | 来源登记的 `sources.logical_id` |
| `operator` | 是 | 导出这批的人 |
| `files[]` | 是 | `path`、`sha256`、`lines`、`bytes` |
| `payload` 行 | 是 | JSONL 里每行一条，见下 |

每行：

```json
{"entry_id":"entry-001","fields":{"headword":"样例甲","reading":"sia3-li6"}}
```

`entry_id` 是来源系统自己的编号。它和万语校坊的 `pages.id` 不是同一个空间，不能因为字符串碰巧相同就当成同一条。`fields` 里必须包含每一个 `requested_fields`。

进入包不能带 `result_of`。

## 3. 结果包 `ReviewResultBundle/v0`

在进入包的公共字段之外，必须有 `result_of.bundle_id`，指回被校对的那一批。`source_system` 在万语校坊导出时为 `wanyu-proofreader`。`requested_fields` 可以原样带回，也可以不带。

每行：

```json
{"entry_id":"entry-001","reviewed_fields":[{"field":"reading","value":"sia3-li6","decision":"confirmed","provenance":"proofread_round:1"}]}
```

| 字段 | 含义 |
| --- | --- |
| `entry_id` | 与进入包同一套来源编号，仍然不是 `pages.id` |
| `field` | 被审的字段名 |
| `value` | 最终值。JSON 类型不限，但键必须在 |
| `decision` | 非空字符串。建议用 `confirmed`、`corrected`、`rejected`。签字前不收成枚举 |
| `provenance` | 这个值从哪一次决定来。不是 `pages.id` |

`provenance` 建议写成 `proofread_round:<轮次>`、`arbitration:<决定编号>` 或 `field_decision:<决定编号>`。校验器只要求它非空、不换行、不超过 200 个字符。

## 4. 和来源登记、出处的关系

- `rights_ref` 指向来源登记（#169）的 `sources.logical_id`。格式是字母或数字开头，后面可含字母、数字、`.`、`_`、`:`、`-`，最长 80。校验器只检查这个字符串，不查询 `sources`，因此来源登记是否已经合并都不影响校验，未知用途也不会在这里被改判。
- `provenance` 指向校对轮次、仲裁或字段级决定。议题里的 A4、C3 若分别指来源登记和结果出处，对齐点就是这两个字段。请双方在下方签字表确认，这里不代签。

## 5. 版本策略

`schema_version` 不是 `ReviewBundle/v0` 或 `ReviewResultBundle/v0` 时，整包拒绝，报告里只有这一条错误，不继续验收条目。不允许部分导入。多出来的 JSON 键在这两个版本里忽略；要改必填字段，升版本。

## 6. 校验器

只验不写。两条入口做同一件事，都接受清单里的子目录路径：

- 离线：`go test ./reviewbundle`，覆盖仓库里的样例目录。
- 在线：`POST /api/fangji/bundles/validate`，`multipart` 字段名 `bundle`，内容是 zip。登录用户可用。响应是校验报告；报告里 `ok: false` 时 HTTP 仍是 200。上传本身不是 zip 时返回 400。两种结果都不写数据库。

`ok: false` 时调用方不得导入。重复校验同一包不新增、不修改任何记录。

失败时 `errors[].code` 与中文 `message` 一起返回，消息里写明「已拒绝整包，未写入任何数据」。验收的五类是：

| code | 何时 |
| --- | --- |
| `manifest_missing` | 没有 `manifest.json` |
| `checksum_mismatch` | SHA-256 不符 |
| `line_count_mismatch` | 行数不符 |
| `schema_version_unsupported` | 版本不认识 |
| `duplicate_entry_id` | 同一个 `entry_id` 出现多次 |

字节数不符时 code 为 `byte_count_mismatch`，同样整包拒绝。

## 7. 语义对齐签字

代理不能代签。请 @aB0T-bupt 与 @L8848-Li 在评审里确认下表。未确认前，导入执行不应开始。

| 字段 | 万语校坊理解 | 乡声集盒 | 万语校坊 |
| --- | --- | --- | --- |
| `bundle.bundle_id` | 批次编号，不是 `pages.id` | 待 @aB0T-bupt 确认 | 待 @L8848-Li 确认 |
| `bundle.schema_version` | 只接受本文两个版本，否则整包拒绝 | 待确认 | 待确认 |
| `source_system` / `source_id` / `source_version` | 来源系统、对象、版本 | 待确认 | 待确认 |
| `requested_fields` | 请求校对的字段名 | 待确认 | 待确认 |
| `entry_id` | 来源系统编号，不与 `pages.id` 合并 | 待确认 | 待确认 |
| `rights_ref` | `sources.logical_id` | 待确认 | 待确认 |
| `manifest.files` | 路径、SHA-256、行数、字节数 | 待确认 | 待确认 |
| `operator` | 导出或交包的人 | 待确认 | 待确认 |
| `result_of.bundle_id` | 结果包指回进入包 | 待确认 | 待确认 |
| `reviewed_fields.value` / `decision` / `provenance` | 最终值、决定、出处；出处不是 `pages.id` | 待确认 | 待确认 |
