# 确定性规则引擎 v1（L0）——规则清单、判定与阈值

> 本文件是 **#177** 的交付物之一（验收项「规则清单与判定写入 `docs/plans/`，与 #176 契约同址」）。
> 数据形状、门控与批次语义见 [`2026-09-25-review-findings.md`](./2026-09-25-review-findings.md)；
> 档位判据（哪条规则能进校对端）见 [`2026-09-25-assist-rule-thresholds.md`](./2026-09-25-assist-rule-thresholds.md)。
> **三份文件分工不重叠**：本文件只写「规则怎么判、判出来是什么 severity、阈值是多少」。

规则清单版本：`l0-v1`（`backend/pb_hooks/lib/assist_rules.js` 的 `RULES_VERSION`）。
**任何判定口径变化都必须升这个版本号**——`producer_version` 就是它，登记表按它置档，
旧批次的数字不会串到新规则上。移植基准是 #201 入仓的 `scripts/corpus_probe/detectors.py`，
不是 W2 工作区的本机缓存脚本。

## 1. 规则表

| # | kind | message_key | severity | 判定 | 作用域 | 入仓参考实现 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | `char_out_of_repertoire` | `non_ipa_range_codepoints` | warn | 值含码位 ∉（项目启用键盘字符并集 ∪ §2 放行区段） | 逐格 | ✅ `detect_non_repertoire_chars` |
| R2 | `confusable_substitution` | `confusable_ascii_in_reading` | warn | **仅 IPA 列**出现「键盘 hint 点明的易混 ASCII」 | 逐格 | ❌ 新建（表编译自 `keyboards/hinghwa-dialect.json` 的 `hint`） |
| R3 | `encoding_form_anomaly` | `combining_marks_present` | info | 该格含 Mn 组合附加符，列出码位 | 逐格 | ✅ `detect_combining_marks` |
| R3 | `encoding_form_anomaly` | `mixed_normalization_forms` | warn | 同一列 NFC 与 NFD 真并存，报少数派 | **整列** | ✅ `detect_inconsistent_forms` |
| R4 | `punctuation_mix` | `punctuation_width_mixed_in_column` | warn | 同一列里某对全/半角标点都出现过 | **整列** | ❌ 新建 |
| R5 | `missing_field` | `required_role_field_empty` | strong | 角色 ∈ {headword, reading, meaning} 的列为空 | 逐格 | ❌ 新建，**依赖 #170** |
| R6 | `reading_format_invalid` | `long_digit_run` | strong | 记音列 ≥3 位连续数字，除 `533`/`453` 外视为上标压平 | 逐格 | ✅ `detect_illegal_tone_runs` |
| R6 | `reading_format_invalid` | `tone_token_count_differs` | warn | `拼音` 与 `莆田IPA` 的数字调号个数不等 | 整行 | ✅ `detect_tone_count_mismatch` |
| R7 | `page_outlier` | `pdf_page_backtrack` | warn | 条目顺序前进时 `pdf_page` 回退超过容差 | 全项目 | ❌ 新建 |
| R7 | `page_outlier` | `page_entry_count_outlier` | warn | 某页条目数 > max(中位数×3, 中位数+8) | 全项目 | ❌ 新建 |

`merged_columns` 不在本表：它由 #125（识别）与 #178（跨行规则）产出。同理
`duplicate_identity` / `cross_source_conflict` 归 #178。

## 2. 阈值与常量（开工前写定，改它要走新 PR）

```
LEGAL_LONG_TONES          = {533, 453}      // 原型 13 值 LEGAL 集合在 #201 移植时被刻意删除
PLACEHOLDER               = /@[0-9a-fA-F]{4,6}/   // 缺字登记序号，不是 Unicode 码位
READING_FIELDS            = {拼音, 莆田IPA, 仙游IPA}
IPA_FIELDS                = {莆田IPA, 仙游IPA}    // R2 只看这两列，见 §3.2
ALLOWED_RANGES            = 见 assist_rules.js 的 ALLOWED_RANGES（ASCII / IPA 扩展 /
                            组合符 / 通用标点 / CJK 符号标点 / 扩展A / 统一表意 /
                            兼容表意 / 非 BMP 汉字）
PAGE_ORDER_BACKTRACK_TOLERANCE = 1 页
PAGE_DENSITY_MEDIAN_MULTIPLIER = 3
PAGE_DENSITY_MIN_EXTRA         = 8 条
PAGE_DENSITY_MIN_PAGES         = 20 页  // 样本不足时密度判据必须沉默
PAGE_SCAN_CAP                  = 5000 条 // 单次全量重算的条目上限，超出则 truncated=true
```

R7 的两个阈值是 #177 正文点名的「必须先定阈值并写定」那一项。定在 3×/中位数+8 是因为
20 页样本下 6 条/页的项目要出现 18 条才报，而真实拆分错误通常是整页几十条量级；
这个数字没有真实数据支撑过，所以它属于「先写定、等 #179 的尺子来推翻」的那类常数，
改它的正确姿势是新 PR + 实测依据，不是实现时顺手改。

## 3. 逐条口径与取舍

### 3.1 R1 放行集合的两处已知缺口（今天不咬人，但必须写下来）

R1 的放行集合是「启用键盘字符 ∪ 固定区段」。实测发现两类字符**都不在其中**：

1. **IPA 调号字母 `˥ ˦ ˧ ˨ ˩`（U+02E5..U+02E9）**：莆仙三套方案用数字标调，所以今天
   报它们是对的；一旦项目改用调号字母记音，R1 会把每一条都报成集外字符。
   届时改的是 `ALLOWED_RANGES`（并升 `RULES_VERSION`），不是关掉规则。
2. **全角标点 U+FF00..U+FFEF 整段**（如 `（）`）：`assist_rules_integration.mjs` 里
   释义写「第一（个）测试」就会被 R1 报出 `U+FF08/U+FF09`。2026-09-25 在 15,022 行正本上
   实测 `char_out_of_repertoire` 命中 0 条，所以今天不咬人；但这说明放行集合的覆盖面
   是按那份语料的写法校准的，不是按 IPA 全集校准的。

`assist_rules_integration.mjs` 把第 1 条**当成断言写死了**（调号字母必须被报出），
这样将来有人放宽区段时会立刻看到这条测试变了。

### 3.2 R2 只查 IPA 列，不查 `拼音`

混淆表编译自键盘 hint，实测编出 3 组：`a→U+0251(ɑ)`、`g→U+0261(ɡ)`、`|→U+2223(∣)`。
`拼音` 列用拉丁字母是方案本身规定的——在里面报「你打的 a 应该是 ɑ」是纯粹的噪声，
所以 R2 的作用域是 `IPA_FIELDS`。hint 的解析要求同时满足「含区别于」与
「hint 里声明的码位等于目标字符」，解析不出来就不收（宁可少一条规则也不猜表）。

### 3.3 R5/R6 与 #170 的关系

`pages` 今天没有列角色信息（#170 未落地）。R5 的做法是：**上下文里没有 roles 就整条规则沉默**，
不拿列名猜角色。集成测试同时断言了「无 roles 返回空数组」与「有 roles 时精确报出空的必填列」，
所以这条规则的启用与否是可见的，不是静默失效。

R6 的两个判据沿用入仓版的硬编码列名（`拼音`/`莆田IPA`/`仙游IPA`）——这正是 #170 要消灭的东西，
`detectors.py` 的 README 也把它列为已知债务。#170 落地后应改成按角色查询，
届时 `RULES_VERSION` 升版。

### 3.4 占位符为什么要在 R6 里先摘掉

`@20000` 带五位数字串。它是源库缺字登记的**序号**，不是 Unicode 码位，也不是压平的声调。
不摘掉就会同一格挂上两条 strong（占位符 + 压平声调），与「一格一条 strong 独占」相冲。
`a@20000` 在测试里被断言为**不报** `long_digit_run`。

### 3.5 因果抑制不在本 PR

门槛文件 P1 推论（同格结构损坏时不再重复报集外字符）需要 `merged_columns` 与
`char_out_of_repertoire` 同时在场。`merged_columns` 的产出方是 #125/#178，
所以抑制逻辑落在 **#178**（那里两个 kind 真的会同格共存）。
本 PR 不写一段没有触发路径的抑制代码。

## 4. 触发与运行

| 路径 | 实现 | 跑哪些规则 |
| --- | --- | --- |
| 提交 | `proofreading.pb.js` 的 submit 成功后调用 `safeRecomputePage`，**传入刚提交的那一行** | R1、R2、R3 格级、R5、R6 |
| 仲裁 | 同上，仲裁落定的最终行 | 同上 |
| 项目全量 | `POST /api/fangji/projects/{id}/findings/recompute`（manager 专属，同步执行，返回 `duration_ms`） | 全部，含整列(R3/R4)与全项目(R7) |
| 单条补算 | `POST /api/fangji/pages/{id}/findings/recompute`（manager 或该条在手者） | R1、R2、R3 格级、R5、R6 |

设计约束与遗留：

- **单条与全量分开**是必须的：整列与全项目判据要看到全部数据才成立，不能挂在提交路径上。
- **规则失败不影响提交**：`safeRecomputePage` 吞掉异常并打日志（`assist_recompute_after_submit`），
  已落库的校对结果不会因为疑点生产挂掉而回滚；管理端可用补算路由重试。
  失败不静默成「没有疑点」——日志里必须有它。
- **重算只下线同 `producer` 的旧批次**：规则重算不得把 OCR(#125) 或 bundle_import(#124)
  的疑点一起标 `superseded`，测试 `assist_rules_integration.mjs` 专门断言了这一点。
- **未接自动触发（本 PR 的已知缺口）**：`import_service.go` 用 `app.Save()`（DAO 层）落
  `import_jobs`/`pages`，而 PocketBase 的 JS 模型钩子只经由 RecordService 触发，
  所以 JS 侧看不到「导入完成」这个事件。本 PR 因此**不改 Go 导入工作器**，
  全量重算目前由 manager 路由显式调用（#124 的导入预览是天然调用方）。
  要自动化，两条路：把工作器里的 `app.Save` 换成 `services.NewRecordService(app).Save`
  （改动面覆盖导入热路径与它的测试），或在 Go 侧起一个作业调用同一套逻辑。
  两者都不适合塞进本 PR，已作为 #177 的遗留项单独说明。

## 5. 实测数字（2026-09-25，`assist_rules_integration.mjs` 输出）

```
ASSIST_FP_RATE {"normal_rows":8,"r1_r2_findings":0,"keys":[]}
ASSIST_P95     {"samples":30,"p50":2,"p95":3,"max":3}   // 单位 ms，预算 < 50 ms
                                                    // 两次运行实测 p95 = 4ms 与 3ms
```

- **反向用例**：8 条含 `ɒ̃ Ǿ ʔ`、数字调号与合法占位符的正常莆仙条目，R1/R2 命中 **0** 条。
- **单条重算 p95 = 3–4 ms**（30 次采样，走 HTTP 计时，含读页、读项目键盘配置、下线旧批次、
  插入新批次的全部开销），满足 #177 的提交路径预算 50 ms。
- 未测：10k 行项目的**全量**耗时。那需要 #178 的分组判据一起测才有意义
  （#178 的验收项「10k 行项目全量跑通并记录耗时」），本 PR 只保证 `PAGE_SCAN_CAP`
  与 `truncated` 标志存在，不会在无上限的表上静默跑。

## 6. 每条规则的验证矩阵

`assist_rules_integration.mjs` 的纯函数部分逐规则覆盖「命中 / 不命中 / 边界」：

| 规则 | 命中 | 不命中 | 边界 |
| --- | --- | --- | --- |
| R1 | `→`(U+2192) 在释义里 | IPA 里的 `ã ɒ̃ ʔ Ǿ` | 键盘内的 `∣`(U+2223) 虽在放行区段外但**不报**；调号字母**报**（§3.1） |
| R2 | IPA 列的 `a` | 拼音列的 `a`；IPA 列真正的 `ɑ` | 一格两个 `a` 只报 1 条但列 2 个位置 |
| R3 格级 | NFD 的 `a+U+0303` | 预合成 `ã`(U+00E3)；纯 `ka` | 非记音列不查 |
| R3 列级 | NFC 与 NFD 并存 | 全列同形 | 形式中性值(`ka`)不得被当成一种形式 |
| R4 | 同列 `（` 与 `(` 并存 | 全列只用全角 | — |
| R5 | roles 下必填列为空 | 无 roles（#170 未落地）；region 空 | roles 为空对象也算无角色 |
| R6 | `ua5333` | `ua533`、`oa453`、`a2` | `a@20000` 不报；两列调号数不等才报第二条；缺列不猜 |
| R7 顺序 | 40→12 页 | 单调序列 | 回退 1 页在容差内不报 |
| R7 密度 | 30 条 vs 中位数 6 | 均匀 6 条/页 | 样本 < 20 页时沉默 |

## 7. 与 #179 门槛的关系

本文件定的是**规则会报什么**，不是**该不该给校对员看**。后者由 `assist_rule_gates` 决定，
新规则入库时一律没有登记行 ⇒ 按 `off` 处理 ⇒ 校对端一条都看不到。
#179 的弱标注集跑出每条规则的 `n` 与 `p̂` 之后，按门槛文件 §2 的判据置档。
本 PR 的集成测试特意在「一条 gate 行都没有」时断言在手校对员拿到 `hints: []`，
并在只给一条规则置 `strong` 后断言只有那一条可见——这条联动是 #176/#177 之间
最容易各自实现一套过滤而后失配的地方。
