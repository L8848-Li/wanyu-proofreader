# 同身份跨行与跨来源冲突检出（#178）

> 实现：`backend/pb_hooks/lib/assist_identity.js`（纯函数）、
> `backend/pb_hooks/lib/assist_writer.js` 的 `recomputeIdentity`、
> 迁移 `1789113800_entry_identity.js`、验证 `backend/tests/identity_integration.mjs`。
> 疑点数据形状与门控见 [`2026-09-25-review-findings.md`](./2026-09-25-review-findings.md)；
> 规则引擎（#177）见 [`2026-09-25-assist-rules.md`](./2026-09-25-assist-rules.md)。

## 1. 前置约束：R-DEDUP（从 #171 移植，不可违背）

条目身份 = `(headword, pinyin)`，**同形词头绝不合并**。所以本 issue 不报「重复」，
只报「身份冲突」与「疑似结构损坏」。这不是措辞游戏：分组键就是 `(词头, 记音)`，
同词头不同拼音的两条**落进不同的桶**，因此"绝不误合"是结构性质，不是靠代码里
"记得判断一下"。测试 `R-DEDUP 反向用例` 断言的就是这一点（两条都保留、零 finding）。

## 2. 身份键

```
entry_identity_key = 归一化(词头) + " " + 归一化(记音)
归一化 = NFC → 全/半角折叠 → 删除所有空白
```

- **分隔符必须可打印**。第一版用 `\u0000`，结果是 `finding_dismissals.group_key`
  写入被 PocketBase 拒成 400，而且管理端根本没法肉眼读一个含 NUL 的分组键。
  归一化已经把两段里的空白全去掉了，所以空格分隔是无损、可反解的。
- 词头取 `词条`，记音取 `拼音`/`莆田IPA`/`仙游IPA` 里第一个非空的。
  **#170 落地后改成按列角色取**（与 #177 的 R5/R6 同一处债务），届时升 `IDENTITY_VERSION`。
- 两段任一缺失 ⇒ **不产生键**（`null`）。宁可少算，也不要拿不完整的键把别的条目误合进来。
  这类条目计入 `unkeyed`，在汇总里可见，不是静默丢弃。

## 3. 三条规则的现状

| kind | message_key | severity | 状态 |
| --- | --- | --- | --- |
| `duplicate_identity` | `same_identity_different_content` | strong | ✅ 已实现 |
| `merged_columns`（规则生产者） | `multiple_headwords_in_cell` / `reading_inside_meaning_row` | strong / warn | ✅ 已实现 |
| `cross_source_conflict` | — | — | ❌ **不实现，缺 #169** |

`cross_source_conflict` 必须经 #169 的 `sources` 登记来源才能判，而 #169 至今 OPEN、
`sources` 集合不存在。#178 正文自己要求「来源缺失时只报 `duplicate_identity` /
`merged_columns`，不报跨来源冲突，避免虚假结论」，所以这里缺的是**依赖**，不是遗漏。
实现里没有半成品的跨来源代码路径，测试则**显式断言这个 kind 一条都不出现**——
这样将来 #169 落地时必须是一次有意的改动，而不是某次"顺手就报了"。

`merged_columns` 与 #125 的**同名同语义、不同生产者**（`producer = rule` vs `ocr`）。
判据只有两条形状检查：一格内出现 ≥2 个词头片段、释义列含数字调号串或 IPA 记音符。
参考 `w4_blocked_queue.py` 的「列合并修复」分诊桶。

## 4. `producer = "rule"` 的批次必须按 kind 收口（本轮修掉的一个真实隐患）

#177 与 #178 都用 `producer = "rule"` 写 `review_findings`。如果两边的"重算 = 下线旧批次"
只按 `producer` 过滤，那么**跑一次 #177 的全量重算会把 #178 的跨行疑点全部标 superseded，
反之亦然**，而两边各自看自己的表都"正常"。

现在 `supersede(...)` 必须带一个 kind 集合：

```
RULE_KINDS     = char_out_of_repertoire, confusable_substitution, encoding_form_anomaly,
                 missing_field, reading_format_invalid, punctuation_mix, page_outlier
IDENTITY_KINDS = duplicate_identity, cross_source_conflict, merged_columns
```

`identity_integration.mjs` 有双向断言：跑完 #177 的重算后 #178 的批次数量不变，
反之亦然；并且先断言两边**都有**批次，否则这两条比较是空真。

## 5. 人工结论 `not_conflict`

新集合 `finding_dismissals`（`project` + `group_key` + `kind` 唯一索引，五个 API 规则全 null）：

| 路由 | 权限 | 语义 |
| --- | --- | --- |
| `POST /api/fangji/projects/{id}/dismissals` `{group_key, kind, note}` | manager | 把一组判成"不是冲突"，幂等（已存在返回原行 + `existed: true`） |
| `DELETE /api/fangji/projects/{id}/dismissals/{id}` | manager | 显式撤回（而不是悄悄覆盖，这是本 issue 唯一的人类写入） |

它在独立集合而不是给 finding 打标记，理由：机器批次会被下一次重算下线，
**人工结论不该跟着下线**。#178 正文说这是"本 issue 唯一允许人写的状态"，
`kind` 参数也被限制在三类冲突之内（写别的 kind 直接 400）。

已测：标 `not_conflict` → 重算后该组零 finding，而**其他 kind 照常出现**
（只跳过被标的那一组，不整批沉默）；撤回 → 重新报出。

## 6. 运行方式与规模

- **只在批处理路径跑**：跨行比较是 O(n) 起，绝不挂到提交路径（#178 正文明确要求）。
  入口是 `POST /api/fangji/projects/{id}/identity/recompute`（manager 专属，同步，返回
  `pages / findings / superseded / backfilled_keys / dismissed_groups / duration_ms / truncated`）。
- 同一次调用顺手回填 `pages.entry_identity_key`。第二次跑 `backfilled_keys = 0` 且键值不变
  （幂等、可重跑，这是 #178 的验收项）。
- **10k 行端到端实测**（2026-09-25，`python3 backend/tests/measure_identity_scale.py 10000`，
  该脚本不进 CI——它测容量不测正确性，且在矩阵里会是最慢的一环）：

  | 指标 | 实测 |
  | --- | --- |
  | 行数 | 10,000（其中 1/4 共享身份，制造真实分组压力） |
  | 全量重算耗时 | **6123 ms**（含身份键回填与 17,840 条 finding 写库） |
  | 每行均摊 | 0.61 ms |
  | 产出 finding | 17,840 条 |
  | 第二次重算 | 6396 ms、finding 数完全一致（可复算） |
  | 300 行的同口径数字 | 164 ms / 0.55 ms 每行 |

  规模上限因此**不是一个代码里的常数**：扫描已改成固定游标分批翻页直到取完
  （`PAGE_SCAN_CHUNK = 1000`），所以 10k 不会被动截断。可接受的运营上限按实测写定为
  **单项目 2 万行以内一次重算控制在 ~15s 量级**；再往上应当拆分项目或改成分批作业，
  而不是把常数调大。`backend/tests/identity_integration.mjs` 里还有一条纯函数级的
  10k 分组断言（15ms、并断言 < 4s），用来在退化成两两全比时立刻报警。
- 与之相对，**#177 的项目级重算仍然保留 `PAGE_SCAN_CAP = 5000` 与 `truncated` 标志**，
  两处不对称是有意的：#177 的路径会为每一页刷新难度标签（每页一次疑点查询），
  10k 页就是 10k 次查询；跨行检出只需要一次全量分组。将来若统一，要先把
  难度刷新改成批量读，而不是简单把上限调大。
- 分组结果按 key 排序后再产出，所以同一份数据的 finding 顺序稳定，diff 可复现。

## 7. 门槛与精度

新批次入库时**没有登记行 ⇒ 按 `off` ⇒ 校对端一条都看不到**（#176 的门控语义）。
本 issue 的验收项「精度数字来自 #179 的尺子并回填」目前的状态：
#179 的打分粒度是 `(提交, 字段)`，而跨行疑点的对错要两条一起看才算，
因此 `duplicate_identity` / `cross_source_conflict` **今天无法度量精度**，
需要把标注提到 `(提交, 条目)` 或 `(提交, 列)` 粒度。已作为结论回填在 #178 的
#179 comment 里。在此之前保持 `off` 是正确的：那是"还没测"，不是"测出来不好"。

## 8. 不做（#178 非目标，逐条落到了断言上）

不合并、不删除（测试断言检出后 4 个条目都还在）、不做模糊匹配/编辑距离/向量相似度
（纯字符归一化，无相似度代码）、不跨项目（分组带 `project`）、不裁决谁对
（finding 只列出差在哪几列，不含建议值）、不写回任何值。
