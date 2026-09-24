# 语料探测脚本（corpus probe）

离线检查一份方言资料 CSV 里**可疑的值**，只报不改。这里是 #177（第 0 层确定性规则）的参考实现，finding 的 `kind` 取自 #176 的枚举；它**不是产品代码**：不参与导入、校对、仲裁，也不写任何库。

## 来源

从 W2 工作区的探测脚本手工移植而来（`anomaly_probe.py` / `anomaly_probe2.py`，原先只存在于某台机器的会话缓存目录里，见 #193）。移植时做了三件事：

1. **删掉硬编码的本机路径**，输入必须显式给出（见下）；
2. 把 print 型脚本改成**纯函数 + 一个 CLI**，从而可被单测与 #179 的打分脚本直接调用；
3. 拆掉原脚本里定义了却没使用的 `LEGAL` 常量——实际判定只依赖 `533` / `453` 两个合法三数字调值，这一点现在写在 `LEGAL_LONG_TONES` 上并有正反用例。

只用 Python 标准库，未新增任何依赖。许可随仓库（`LICENSING.md`，AGPL-3.0-only），不含第三方资产，故不触发 `ASSET_BOUNDARIES.md`。

## 用法

```bash
python3 scripts/corpus_probe/probe_corpus.py --csv /path/to/正本.csv
python3 scripts/corpus_probe/probe_corpus.py --csv /path/to/正本.csv --json
python3 scripts/corpus_probe/probe_corpus.py            # 或 export WANYU_CORPUS_CSV=...
```

输入优先级：`--csv PATH` > `$WANYU_CORPUS_CSV` > 报错。**没有默认值**——默认值曾写死为作者本机的绝对路径，在别人机器上必然不存在。字符集基线同理：`--keyboard PATH` > `$WANYU_KEYBOARD_JSON` > 仓库内的 `backend/keyboards/hinghwa-dialect.json`。

## 输出纪律

默认输出只有**行号、列名、计数与 sha256 前缀**，不含任何字段内容：这类诊断一旦被粘进 issue 或提交，就等于把未公开语料带进仓库（`CONTRIBUTING.md` 禁止）。`--show-samples N` 才会打印字段值，并且会在 stderr 上明确警告「输出已含语料内容，勿粘贴」。这两条都有测试守住。

## 规则清单

| 检测函数 | kind | 默认严重度 | 含义 | 已知的误报面 |
| --- | --- | --- | --- | --- |
| `detect_illegal_tone_runs` | `reading_format_invalid` | strong | 记音列里 ≥3 位连续数字，除 `533`/`453` 外都视为上标声调被压平 | 真需要三位以上调值的方案（目前莆仙三套方案里没有） |
| `detect_tone_count_mismatch` | `reading_format_invalid` | warn | `拼音` 与 `莆田IPA` 的声调 token 数不等，通常意味着漏字或多字 | 「22 压平成 222」不算 token 差（由上一行负责）；`@十六进制` 占位里的数字先被剔除，不参与计数 |
| `detect_missing_glyph_placeholders` | `missing_glyph_placeholder` | strong | `@十六进制` 形式的集外字占位 | —— |
| `detect_column_collapse` | `merged_columns` | strong | 记音/释义列里出现地区标签 `〔莆〕〔仙〕` 或方括号不配对，即多列被并成一格 | 释义里合法使用方括号注码 |
| `detect_phonetic_in_meaning` | `merged_columns` | warn / strong | 释义列里混进一串记音（strong = 整格就是一段记音） | 用 `：`/`‖` 分层的释义不报 |
| `detect_inconsistent_forms` | `encoding_form_anomaly` | warn | 同一列里 NFC 与 NFD 两种编码形式并存，报少数派 | 只提示，**不改写**任何值 |
| `detect_combining_marks` | `encoding_form_anomaly` | info | 该值含组合附加符，列出码位 | 合法 IPA 组合符很多，所以是 info |
| `detect_non_repertoire_chars` | `char_out_of_repertoire` | warn | 出现项目键盘**打不出来**的非 ASCII 码位 | 键盘 JSON 本身就是待维护的清单，缺键会表现为误报 |
| `detect_cjk_extension` | `outside_unicode_set` | warn | 出现 CJK 扩展 B 及以后的非 BMP 汉字 | 由 #123 决定如何无损表示 |

## 一格只报一次

`analyze_row()` 里有一条抑制规则：某个格子已经被 strong 级的 `merged_columns` 或 `missing_glyph_placeholder` 判为结构损坏时，**同一格的 `char_out_of_repertoire` 不再重复报**。合成语料上实测：加这条前 16 条 finding，加后 14 条，去掉的正是两处噪音（`〔莆〕` 的汉字码位、`@4E2D` 里的十六进制数字被当成声调）。理由写在 #175 的红线里——校对员一旦学会忽略标记，整套机制就失效了。

## R-DEDUP：不要在这里长出「自动合并重复词条」

`entry_identity()` 与 `group_by_identity()` 表达的是项目既定的领域规则：**同形词头绝不合并，条目身份 = `(词头, 拼音)`**。同一词头多行是正常语料形态，不是脏数据。任何后续设计（包括 #178）都不得把「同词头」直接当成重复。

## 与平台规则的关系

#176 的 kind 枚举 v1 未包含 `missing_glyph_placeholder` 与 `outside_unicode_set` 两类，本模块先用着，需要在 #176 下补齐定义（含前端措辞）后再对齐；#179 负责给每条规则实测 precision/recall，**未达门槛的规则不得进入校对端界面**（#175 的红线）。

## 测试

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
```

每条规则都有正反用例（必须命中的值 + 相邻的合法值），`fixtures/mini_corpus.csv` 是**人工构造的合成语料**，不含任何词典正文。
