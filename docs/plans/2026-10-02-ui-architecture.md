# 界面架构基线

本计划把界面约定收成一层可以核对的契约，并标明后面几支 issue 各改哪一层。它不改 `.vue`、不改 `style.css`、不引入依赖。契约正文在 [docs/DESIGN.md](../DESIGN.md)。本文件只写分层、不变量和边界。

实测基线是 `main@937eb3d`（2026-10-05）。#263 正文里的数字是 2026-10-02 的盘点，和这天的树有出入的地方以 DESIGN.md 的 grep 为准，不回写过期数字。

## 六层

层与层之间只向下依赖：视图可以引用组件和令牌，组件可以引用令牌，谁也不许在视图里重写下一层的定义。

| 层 | 名字 | 现在落在哪 | 这一层不做什么 |
| --- | --- | --- | --- |
| L0 | 契约 | `docs/DESIGN.md` | 不写未决方案，不复制 `pageStatus.js` 的文案表 |
| L1 | 令牌 | `frontend/src/style.css` `:root`（`:6-156`） | 不在视图的 `<style>` 里新写一份色值。语义色、字体别名、间距/字号/圆角/层级和 `--focus-ring` 已在同一处 |
| L2 | 组件 | `frontend/src/components/` 下 DESIGN.md「共享组件」表 | 不把第二个对话框写回视图。抽出 `AppField` 等归 #268 |
| L3 | 状态 | 各视图里的 `alert` / `empty-state` / `panel-loading` / `skeleton-card` | 不在本计划里发明 `useAsyncResource`。统一归 #267 |
| L4 | 字符保真 | `rare-fonts.css`、`phonetic-fonts.css`、`RareCharacterNotice.vue`、`ProjectKeyboard.vue` | 不在本计划里加 `lang` 或改字号基准。归 #270 |
| L5 | 验证 | `scripts/check_ui_debt.py` + `scripts/ui_debt_baseline.json`（#264 已合入） | 不引入 axe、Stylelint、组件挂载测试。那些归 #271。浏览器套件的缺口归 #131 |

## 五条不变量

每条都能用一条命令或一个文件位置判定。打破它的 PR 应该先改契约或先改基线，而不是先改界面。

1. **疑点不靠颜色单独表意。** 标记样式只挂在 `.field-hint-*` 上，并且芯片带文字。位置：`frontend/src/style.css:657-662`。
2. **动态 `alert` 必须有角色。** `python3 scripts/check_ui_debt.py --only alerts_without_role` 的 `now` 不得超过基线。这一支把上限收到 0。
3. **键盘焦点必须看得见。** 表单控件不得用 `outline: none` 盖掉焦点环；环与相邻背景的对比度 ≥ 3:1。现环是 `var(--focus-ring)`，计算见 DESIGN.md「语义、刻度与焦点」。键盘走查归 #265。
4. **对话框只有一个实现。** `grep -rn "class=\"modal-backdrop" frontend/src --include="*.vue"` 只允许命中 `components/AppModal.vue`。不带 `class=` 的全目录 `grep` 还会命中 `style.css` 里的规则本体，那一次不算第二个对话框。焦点算法的测试是 `frontend/tests/modalFocus.test.js`。
5. **字面界面值不得高于棘轮。** `python3 scripts/check_ui_debt.py` 对九类债务与 `scripts/ui_debt_baseline.json` 比较。减少债务时在同一支 PR 下调对应 `limit`（`CONTRIBUTING.md`「UI 债务棘轮」）。把某一类从 `warn` 改成 `fail` 要先在 #264 的后续记录里确认，不在本计划里改 `mode`。在 `937eb3d` 上这条还不是全绿：`hardcoded_colors` 是 146/145，`inline_styles` 是 28/27，两类都是 `warn`，脚本退出 0。令牌合入后颜色、圆角、层级和字体栈降到 0；`inline_styles` 仍是 28/27 的 warn，这支没有上调它的上限。红线禁止的是再往上加；warn 退出 0 不能读成通过。

## 边界

| Issue | 状态（2026-10-05） | 属于哪一层 | 不包含 |
| --- | --- | --- | --- |
| #263 | 本计划与 DESIGN.md | L0 | 任何 `.vue` / `style.css` 改动 |
| #264 | 已合入 | L5 棘轮 | 不清理存量，只禁止涨过当前上限 |
| #266 | 令牌已放进 `:root` | L1：语义色、字体别名、间距/字号/圆角/层级刻度、`--focus-ring` | 不重做配色，不做暗色，不拆视图。间距和字号刻度已定义，旧的 `padding`/`font-size` 字面值留到触及那一行时再换 |
| #265 | 焦点环与 `alert` 角色已补 | L5 的核销 + 焦点环与缺 `role` 的 `alert` | 不引入扫描依赖；`lang` 只登记、不实现。全路径键盘走查受本地是否有可登录实例限制，结论写在该 PR |
| #129 | 未做 | 按 DESIGN.md 替换存量字面值 | 在 #266 的令牌还不存在时，不把「全部回到令牌」当作可验收 |
| #267 | 未做 | L3：`useAsyncResource` + `AppStatusPanel` | 不在各视图里再手写一套空态文案体系 |
| #268 | 未做 | L2：字段、表格、分页、确认框 | 不在第一次出现时就抽组件 |
| #269 | 未做 | 拆 `ProjectDetailView` 与 `ProofreadEditorView` | 不改这两页的协议与文案 |
| #270 | 未做 | L4：缺字、字段渲染、`lang` | 不改焦点环 |
| #271 | 未做 | L5 的工具选型 | 本计划的验收不依赖它 |
| #131 | 未做 | 浏览器套件与前端覆盖率 | 在它合入前，界面验收停在 grep、棘轮和人工走查 |
| #262 | 已合入 | 仲裁确认框走 `AppModal` | 不把焦点环对比度算进那支 PR |

## 顺序

1. L0：本文件与 DESIGN.md（#263）。后面的界面 PR 引用 DESIGN.md 的小节。
2. L1：令牌（#266）。#129 的存量替换依赖这一层。
3. 焦点环与 `alert` 角色（#265），与 #266 的 `--focus-ring` 共用验收。
4. L3 四态组件（#267），把 #265 用 grep 守住的角色收进一个组件。
5. L2 共享字段/表格（#268）与大视图拆分（#269）互不阻塞，都在令牌之后。
6. L4 字符保真（#270）独立。
7. L5 工具链（#271、#131）不挡住 1–3。

## 明确不做

- 不改视觉方向，不引入暗色主题（仓库里没有 `prefers-color-scheme` 规则；`grep -rn prefers-color-scheme frontend/src` 为 0）。
- 不在本计划里改任何 `.vue` 或 `style.css`。
- 不承诺图标库、组件库或新的 CSS 框架。
