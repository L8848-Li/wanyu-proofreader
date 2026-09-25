# 任务难度分层（A/B/C）——信号表、判定与 #162 契约

> 本文件是 **#180** 的交付物：`信号 → 层级` 是一张可评审的表（不是散在代码里的 if），
> 并且**改表必改测试**。实现：`backend/pb_hooks/lib/assist_difficulty.js`（纯函数），
> 落库：`backend/pb_migrations/1789113700_page_difficulty.js`，
> 验证：`backend/tests/difficulty_integration.mjs`。
> 疑点本身来自 #177/#176，其契约见 [`2026-09-25-review-findings.md`](./2026-09-25-review-findings.md)。

版本：`DIFFICULTY_VERSION = "tier-v1"`，写进每个条目的 `difficulty_version`。
**改这张表必须同时升这个版本号**，否则库里会混着两种口径的 tier 而分不出来。

## 1. 为什么落在 `pages` 而不是走 finding

#180 正文两个选项都给过（走 #176 的 finding 机制 / `pages` 追加字段），并倾向后者。
理由在 #162 一侧：大厅按 tier 筛选是一个 SQL 谓词。如果 tier 只能从 findings 现算，
大厅每翻一页都要重算一遍且无法建索引——所以建列并加索引
（`idx_pages_project_tier`，其 `EXPLAIN QUERY PLAN` 由 `check_migrations.py` 断言）。

## 2. 判定表

求值方式：**命中多条时取最严的一条（上确界）**，不做平均、不做多数表决。
理由：分层的目的是别把 C 派给只打算秒判 A 的人，向下取会直接坏事。

| 信号 id | 触发条件 | tier | 为什么是这个档 |
| --- | --- | --- | --- |
| `cross_source_conflict` | 该条目带 `cross_source_conflict` 疑点 | C | 多个登记来源给出不同值，要判断不是照抄 |
| `rights_gate_blocked` | `blocked_reason = rights_gate` | C | 授权未决的条目不该由志愿者开工，该走 #188 升级 |
| `scanned_read_blocked` | `blocked_reason = scanned_read` | C | 扫描页识读要肉眼辨认 + 领域知识 |
| `strong_findings_ge_2` | strong 级疑点 ≥ 2 | C | 多处结构级问题叠加 |
| `reading_and_meaning_change` | 列角色同时含 `reading` 与 `meaning` | B | 要理解词义才能定读法 |
| `column_merge_blocked` | `blocked_reason = column_merge` | B | 先修结构再谈内容 |
| `strong_findings_eq_1` | 恰好 1 条 strong 级疑点 | B | 单点结构问题，看一眼就够 |
| `missing_pdf_page` | 缺 `pdf_page` | B | 看不到原文页，只能靠已有文本推断 |
| `row_shape_outlier` | 字段数或最长值对项目分布离群 | B | 形状异常通常是拆分/合并问题 |
| `warn_findings_ge_3` | warn 级疑点 ≥ 3 | B | 单条 warn 是噪声，成堆说明这行不干净 |
| `frequent_arbitration` | 涉及列的历史仲裁进入率 ≥ 0.25 | B | 「这个位置常出事」是比单条内容更强的先验 |
| `glyph_table_blocked` | `blocked_reason = glyph_table` | A | 查表填字是机械操作，量大但不难 |
| `pure_transcription` | 列角色只有 headword/reading 且零疑点 | A | 照抄型任务 |

阈值常量（改它要走新 PR）：`ARBITRATION_RATE_TRIGGER = 0.25`、`FIELD_COUNT_OUTLIER = 2`、
`VALUE_LENGTH_OUTLIER_MADS = 6`。

## 3. 两个维度不互相推导（#196 并入本 issue 的那条）

| 字段 | 回答什么 | 谁消费 |
| --- | --- | --- |
| `difficulty_tier` | 这活要多长时间 / 多高专业度 | #162（大厅筛选） |
| `blocked_reason` | 现在为什么做不下去 | #188（升级判定） |

`blocked_reason` 的桶移植自 `w4_blocked_queue.py` 的分诊语义（按「什么输入才能真正解开它」分类）：
`glyph_table`（缺字表可解）、`scanned_read`（扫描页需人工识读）、
`column_merge`（列合并要修）、`rights_gate`（授权未决）、`unknown`。
今天能从数据里**自动认出**的只有 `column_merge`（有 `merged_columns` 疑点）与
`glyph_table`（有 `missing_glyph_placeholder` 疑点）；认不出就留 `unknown`，不猜。
其余桶要等 #123/#124 给出信号。

## 4. 空值的三种状态（#162 必须区分）

| 库里状态 | 含义 | #162 应有的行为 |
| --- | --- | --- |
| `difficulty_tier` 为空字符串/未设置 | **从没算过**（该条目尚未进入任何一次重算） | 当作 unknown 处理，但不要用 `tier IS NULL` 去筛"难活" |
| `difficulty_tier = "unknown"` | 算过了，**没有任何信号命中** | 原样退回「下一条」，不显示难度标签 |
| `A` / `B` / `C` | 有信号命中 | 可筛选、可展示（展示措辞见 §6） |

"没测过"与"测了没问题"必须可区分——这是本项目反复出现的一类错误（#179 报告纪律、
门槛文件 §3 的 `n/a` vs 精度不足，都是同一条）。

## 5. 今天真实的可达状态（不粉饰）

- `frequent_arbitration` **今天永远不会触发**：#179 的仲裁分布还没有真实样本
  （部署库内零分歧/仲裁记录）。把它当 0 用会让所有条目系统性偏 A——
  那是把"没测过"当成"测出来没问题"。因此输入为 `null` 时本层不产生任何信号。
- `reading_and_meaning_change` 与 `pure_transcription` 依赖列角色（#170），今天为 `null`
  ⇒ 两条都不参与。也就是说 v1 实际能落地的信号只有：疑点数量、`pdf_page` 缺失、
  行形状离群、以及自动认出的两类阻塞原因。
- strong/warn 疑点数量这一项，在 #177 的规则都还是 `off` 时**照样计入**：
  本层读的是库里全部当前批次疑点，不按 gate 过滤。信号要的是"机器认为这行有多少问题"，
  不是"校对员被打了几个标"——两者是不同的量，混用会让难度分层跟着门控档位漂移。

## 6. 给 #162 的接口契约

**字段名**（`pages` 集合）：

| 字段 | 类型 | 允许值 | 空值语义 |
| --- | --- | --- | --- |
| `difficulty_tier` | select(1) | `A` \| `B` \| `C` \| `unknown` | 空 = 从没算过（见 §4） |
| `difficulty_basis_json` | text(JSON 数组) | 命中的信号 id 列表 | `[]` = 算过且无命中（此时 tier 必为 `unknown`） |
| `difficulty_version` | text | 当前为 `tier-v1` | 空 = 从没算过 |
| `blocked_reason` | select(1) | §3 的五个桶 | 空 = 从没算过 |

**筛选**：`filter="project=\"<id>\" && difficulty_tier=\"A\""`，走 `idx_pages_project_tier`。
**排序**：本层不提供排序键；如果 #162 要"先派 A"，请显式按 `difficulty_tier` 排并自行处理
`unknown`（建议放最后，不要当 0）。
**措辞**：`A/B/C` 对志愿者怎么说法由 #162 定（本层不管 UI）。
**红线**：tier **不得**出现在校对端任何响应里作为轮次线索。
`difficulty_integration.mjs` 断言了 `GET /task` 与 findings 两个响应的序列化结果里
不含 `difficulty_tier` / `difficulty_basis_json` / `difficulty_version` / `blocked_reason`
（也不含 `round`/`pass_no`）——将来谁把 payload 从显式字段列表改成展开写法，这条会红。

## 7. 复算与触发

不新造触发器：tier 在 #177 的两条路径里顺手刷新（单条重算 / 项目全量重算），
所以不会出现"疑点是新的、难度是旧的"。
`row_shape_outlier` 需要项目级统计（中位数字段数、中位值长与 MAD），
只有全量重算拿得到；单条路径传入 `projectStats = null`，该信号因此不产生——
**这是有意的降级，不是漏算**，也解释了为什么同一行在两条路径下 tier 可能不同。
要稳定结果，用项目级重算。

幂等性：同一份数据连续重算，`difficulty_tier` 与 `difficulty_basis_json` 逐字节不变（已测）。
写库前先比对四个字段，全等则不写，避免每次重算都刷一遍 `updated`。

## 8. 明确不做

- 不改大厅 UI、不改领取逻辑（#162）；
- 不做志愿者能力模型/绩效（#162 亦列为非目标）；
- 不做 #191 专家升级判定（#188），本层只提供 `blocked_reason` 这个正交字段；
- **绝不**从他人提交结果推导 tier：本层输入里没有任何 attempt 内容（#175 红线 1）。
