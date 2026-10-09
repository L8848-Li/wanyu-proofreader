# 界面契约

本文件是 `frontend/src` 的可核对界面真源。只记录已经落在代码里的决定；还没做的事指向对应 issue，不在这里讨论。

`frontend/src/style.css` 的行号按当前 `:root`（`:6-156`）计算。只改 Vue 模板的引用仍指向组件文件里的那一行。

核对方式：下面每一条都能用文中给出的 `file:line` 或 `grep` 复现。没有「适当美化」这类无法判定的句子。

## 基调

活跃界面的产品名是「万语校坊」。`grep -rn 方辑 frontend/src` 为 0 命中。字体族名仍是拉丁写法 `Fangji Phonetic` / `Fangji Rare Han`（`frontend/src/style.css:56` 的 `--font-rare`，以及 `frontend/src/rare-fonts.css:3`），那是历史资源名，不是界面句子。`grep -c "Fangji Phonetic" frontend/src/style.css` 为 1。

视觉基调是档案校勘工作台：纸色底、墨色字、朱砂点缀。对应令牌是 `--paper`、`--ink`、`--accent`（`frontend/src/style.css:14-17`）。本文件不重新定义配色。

校对员界面不出现「一校」「二校」。`grep -rn "一校\|二校" frontend/src` 为 0 命中。轮次只出现在管理员仲裁台（`frontend/src/views/admin/ArbitrationView.vue:16`）。

## 令牌

定义位置只有 `frontend/src/style.css` 的 `:root`（`:6-156`）。下面两张表按用途归纳调色板、字体、间距、圆角、层级和状态色，不是 `:root` 的逐条清单。其余名字列在表后，行号就是定义处。用途按引用处归纳，不是新设计。

| 名称 | 值 | 用途 | 定义 |
| --- | --- | --- | --- |
| `--primary` | `#315f68` | 主操作、链接、进度 | `:7` |
| `--primary-dark` | `#234850` | 主按钮悬停 | `:8` |
| `--primary-light` | `#e5eff0` | 选中底、浅强调 | `:9` |
| `--secondary` | `#648b7d` | 校对入口顶边 | `:10`，引用见 `.capability-card--proofread` `:283` |
| `--danger` | `#b7433f` | 危险按钮与强疑点边 | `:11` |
| `--warn` | `#b86432` | 警告按钮、草稿点 | `:12` |
| `--success` | `#3f7b5b` | 成功按钮 | `:13` |
| `--paper` | `#f6f3ec` | 页面底 | `:14`；`:root` 背景 `:155`，`body` 渐变 `:162` |
| `--paper-deep` | `#eee8dc` | 印章、头像底 | `:15` |
| `--ink` | `#24343a` | 标题字色 | `:16`，`h1-h4`（`:165`） |
| `--accent` | `#ad4f32` | 朱砂：印章、已改字段 | `:17`，`.field-change-label` `:651` |
| `--gray-50` … `--gray-900` | `#f9fafb` … `#111827` | 中性色阶，一步一档 | `:18-27` |
| `--radius` | `10px` | 卡片、按钮、输入框的默认圆角 | `:28` |
| `--shadow` | 见 `:29` | 卡片阴影 | `:29` |
| `--shadow-lg` | 见 `:30` | 悬停与登录卡片 | `:30` |

`:root` 把 `font-family` 设成 `var(--font-ui)`（`:152`），`font-size: 15px`（`:153`），`color: var(--gray-800)`（`:154`），`background: var(--paper)`（`:155`）。

### 语义、刻度与焦点

这些名字都定义在同一个 `:root` 里。视图里的颜色、圆角、层级和字体栈引用它们，不再写字面值。`python3 scripts/check_ui_debt.py --only hardcoded_colors --only border_radius_literals --only z_index_literals --only font_family_stacks` 这四类的 `now` 为 0。

| 名称 | 值 | 用途 | 定义 |
| --- | --- | --- | --- |
| `--surface` | `#fff` | 卡片、输入、键盘键的实色底。源码注释标明白名单 | `:31` |
| `--on-fill` | `#fff` | 铺色按钮上的反白字。与 `--surface` 同值，注释写明语义分开 | `:32` |
| `--surface-raised` | `#fcfbf8` | 校对字段区 | `:33` |
| `--ink-muted` | `#475569` | 调色板外的石板灰，不并进 `--gray-500` | `:38` |
| `--line` | `var(--gray-200)` | 边线别名 | `:39` |
| `--overlay` | `rgba(20, 31, 34, .58)` | 模态遮罩 | `:43` |
| `--focus-ring` | `var(--primary)` | 键盘焦点环 | `:55` |
| `--font-rare` / `--font-ui` / `--font-display` / `--font-mono` | 见 `:56-59` | 唯一含 `Fangji Phonetic` 的地方是 `--font-rare`。界面用三个别名 | `:56-59` |
| `--space-1` … `--space-6` | `4px` 到 `32px`，每档 ×2 或按 4px 网格 | 间距刻度。现有 `padding`/`margin` 仍是字面值，新代码用这组名字 | `:60-65` |
| `--text-xs` … `--text-2xl` | `.75rem` 到 `2rem` | 字号刻度。现有 `font-size` 仍是字面值，新代码用这组名字 | `:66-71` |
| `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-pill` | `6px` / `var(--radius)` / `14px` / `999px` | 圆角主刻度 | `:75`、`:80`、`:82`、`:84` |
| `--radius-none` `--radius-hairline` `--radius-key` `--radius-nav` `--radius-tight` `--radius-panel` `--radius-mark` `--radius-card` `--radius-auth` `--radius-circle` `--radius-inset` | 见 `:72-86` | 已经出现过的其余圆角，保留原像素，避免把 16px 登录卡收成 14px | `:72-86` |
| `--z-mask` `--z-local` `--z-float` `--z-raised` `--z-sticky-bar` `--z-dropdown` `--z-sticky` `--z-overlay` `--z-modal` | `1` `2` `5` `8` `9` `10` `100` `400` `500` | 层级。遮罩是 `--z-overlay`（`.modal-backdrop` `:683`）。对话框卡片是 `position: relative` 且 `z-index: var(--z-modal)`（`.confirmation-dialog` `:691`），这个 500 只在遮罩自己的层叠上下文里排序，页面上的高度仍是遮罩的 400 | `:87-95` |
| `--danger-bg` `--warn-bg` `--success-bg` `--info-bg` 及同组边框/文字 | 见 `:96-120` | `.alert-*`（`:235-238`） | `:96-120` |
| `--badge-*` | 见 `:121-131` | 条目状态徽章（`:313` 起） | `:121-131` |

上表用省略号和「同组」覆盖中间档，不是漏记：`--gray-100` 到 `--gray-800`、`--space-2` 到 `--space-5`、`--text-sm` 到 `--text-xl`、`:96-120` 里未点名的边框与文字色、以及 `:121-131` 的每一个 `--badge-*`，都在对应行的行号范围内。上表没有逐条展开、也不在那些范围内的，仍在同一个 `:root` 里：半透明表面 `--surface-nav` `--surface-float` `--surface-bar` `--surface-chip`（`:34-37`）；弱边线 `--line-faint` `--line-nav` `--line-card`（`:40-42`）；辉光 `--ink-glow` `--ink-glow-hover` `--ink-glow-tight` `--primary-glow` `--primary-glow-soft` `--primary-line` `--accent-glow`（`:44-50`）；石板阴影 `--slate-shadow` `--slate-shadow-soft`（`:51-52`）；PDF 底 `--pdf-grid` `--pdf-mask`（`:53-54`）；`:96-120` 里的热警告与其余状态边/字色已算在「同组」行；差异与纸色 `--diff-del-bg` `--diff-del-ink` `--source-wash` `--paper-bright` `--paper-quiet`（`:132-136`）；登录 `--auth-shade` `--auth-sand`（`:137-138`）；工作状态 `--work-active-bg` `--work-active-ink` `--work-complete-bg` `--work-complete-ink` `--work-complete-edge`（`:139-143`）；`--selection-border` `--arbitration-border`（`:144-145`）；石板填充与 PDF 工具条 `--slate-fill` `--slate-fill-strong` `--pdf-track` `--pdf-track-strong` `--pdf-toolbar` `--pdf-ink`（`:146-151`）。

`#fff` 在棘轮口径（不计 `--token` 定义，也不把 `#fff7ed` 算成 `#fff`）下为 0 次。源码里剩下的两处 `#fff` 都在 `:31` 和 `:32`，各有一行白名单注释。

焦点环对比度（WCAG 相对亮度，sRGB）：

- 旧环：`--primary-light` `#e5eff0` 对 `.form-control` 的白底。相对亮度比约 **1.17:1**。
- 现环：`--primary` `#315f68`。对 `#fff` 为 **7.08:1**，对 `--paper` `#f6f3ec` 为 **6.39:1**。都高于 3:1。
- 规则：`.form-control:focus`（`:218`）与 `:focus-visible`（`:221-223`）都是 `3px solid var(--focus-ring)`。没有 `outline: none`。

键盘键、校对输入框和仲裁终值输入框原先各有一套缺字的字体栈。三处现在都用 `--font-ui`（`.ipa-key` `:412`，`.proofread-textarea` `:675`，`.final-value textarea` `:919`）。`--font-ui` 把 `-apple-system`、`BlinkMacSystemFont`、`Segoe UI` 排在 `Fangji Rare Han` 之前；同一码位若系统界面字体也覆盖，会先用系统字形。哪一层该赢归 #270。

债务计数的口径写在 `CONTRIBUTING.md` 的「UI 债务棘轮」。

## 共享组件

第二次需要同一块界面时用下表的组件，不在视图里再抄一份。组件本体都在 `frontend/src/components/`。

| 组件 | 做什么 | 调用点 | 允许再内联 |
| --- | --- | --- | --- |
| `AppErrorBoundary` | 渲染异常时整页 `role="alert"`（`components/AppErrorBoundary.vue:3`） | `App.vue:2` | 否 |
| `AppNavbar` | 顶栏、身份、出口 | `AdminLayout.vue:3`、`ProofreaderLayout.vue:3`、`WorkspaceHomeView.vue:3`、`ProjectDiscoveryView.vue:3` | 否 |
| `UserAvatar` | 用户头像 | `AppNavbar.vue:13`、`ProfileView.vue:15` | 否 |
| `AppModal` | 确认层：`role="dialog"`、`aria-modal`、Esc、焦点环绕（`components/AppModal.vue:3-16`，焦点算法 `lib/modalFocus.js`） | `ProofreadEditorView.vue:190`、`ArbitrationView.vue:181`、`ProjectDetailView.vue:596`、`ProofreaderOnboarding.vue:2` | 否。`.vue` 里的 `class="modal-backdrop"` 只允许出现在 `AppModal.vue`。`grep -rn modal-backdrop frontend/src` 还会命中 `style.css` 里的规则本体（`:680`）；判据是 `grep -rn "class=\"modal-backdrop" frontend/src --include="*.vue"` 只命中 `AppModal.vue:5`。棘轮 `custom_modals` 数的也是开始标签，不是 CSS 规则 |
| `ProofreaderOnboarding` | 可跳过的校对引导 | `ProofreaderLayout.vue:13` | 否 |
| `DocumentReviewWorkspace` | PDF 与字段的对照壳。遮罩用已定义的 `var(--surface)`（`DocumentReviewWorkspace.vue:205`） | `ProofreadEditorView.vue:2`、`ArbitrationView.vue:2` | 否 |
| `PdfSinglePageViewer` | 单页 PDF | `DocumentReviewWorkspace.vue:48` | 否 |
| `FieldNavigation` | 字段进度与跳转 | `ProofreadEditorView.vue:184`、`ArbitrationView.vue:175` | 否 |
| `ProjectKeyboard` | 项目字符键盘。旧名 `IpaKeyboard.vue` 已不存在 | `ProofreadEditorView.vue:187`、`ArbitrationView.vue:178` | 否 |
| `RareCharacterNotice` | 缺字提示 | `ProofreadEditorView.vue:94`、`ArbitrationView.vue:51` | 否。字符层的进一步约定归 #270 |

还没有、本文件不预命名的组件：`AppField`、`AppDataTable`、`AppPagination`、`ConfirmDialog`、`AppStatusPanel`、`useAsyncResource`。它们分别归 #268 与 #267。在那些 issue 合入之前，表格仍是原生 `<table>`（棘轮 `bare_tables`），异步状态仍写在各个视图里。

## 四态

四态指一块区域在「还没跑完 / 跑完但没有 / 失败 / 不可逆」时怎么标记。统一组件归 #267。在那之前，沿用下面已经出现的结构，不要另起一套类名。

| 态 | 现有标记 | 文案例子 | 位置 |
| --- | --- | --- | --- |
| pending | 骨架：`skeleton-card` 且 `aria-hidden="true"`，容器 `aria-label="正在加载项目"` | 按钮文案用「正在…」 | `TaskHallView.vue:47-48`；字段区 `panel-loading` + `aria-live="polite"`（`ProofreadEditorView.vue:53`，样式 `style.css:602`） |
| empty | `empty-state` + `empty-state-text`，标记 `aria-hidden="true"` | 「当前没有需要你处理的项目」；来源页「还没有登记来源」 | `TaskHallView.vue:55-58`；`SourcesView.vue:23`；样式 `style.css:435-437` |
| error | `alert alert-error` 且 `role="alert"` | 视图各自的失败句 | 类在 `style.css:235`。`python3 scripts/check_ui_debt.py --only alerts_without_role` 的 `now` 为 0，基线上限 0 |
| danger | `btn-danger`（`style.css:201`）；设置里的 `.danger-zone`（`:309`）；提交确认里的不可逆句用 `role="alert"` | 「提交后将完成条目…」一类永久保留的说明 | `ArbitrationView.vue:163`；校对确认框 `ProofreadEditorView.vue:204` |

成功与进行中的提示用 `alert alert-success` 或无修饰 `alert`，角色是 `role="status"`。一直显示、文案不随操作改写的说明用 `role="note"`（`NewProjectView.vue:8`）。错误是 `role="alert"`。长期收口仍归 #267 的 `AppStatusPanel`，避免以后靠 grep 维持。

状态不单独靠颜色。机器疑点芯片始终带文字，规则写在 `style.css:657-658`，芯片结构在 `:662`。

## 措辞

界面用词就用代码里已经出现的这些，不在文案里换同义词。

| 说法 | 用在 | 不要写成 | 证据 |
| --- | --- | --- | --- |
| 待校对原文 | 校对栏里对照用的原书字段 | 原文、源文、OCR 文本 | `ProofreadEditorView.vue:141` |
| 领取任务 / 重新领取任务 | 校对员拿到一条材料 | 抢单、接单 | `ProofreadEditorView.vue:72` |
| 仲裁 | 管理员处理不一致结果 | 审核、审批（那是条目状态名，不是这个动作） | `ArbitrationView.vue:16`、`DashboardView.vue:37` |
| 万语校坊 | 产品名 | 方辑 | 见上文「基调」的 grep |
| 校对员 | 做独立校对的人 | 一校、二校 | `grep -rn "一校\|二校" frontend/src` 为 0 |

条目状态的中文标签以 `frontend/src/constants/pageStatus.js` 为准，不在本文件复制第二份。

## 断点

宽度查询只有下面六档。语义按该档里实际改动的布局写，不按设备名称。

| 最大宽度 | 语义 | 位置 |
| --- | --- | --- |
| 1100px | 校对对照从左右两栏改成上下单栏；原文工具收进摘要 | `style.css:373`、`:1005`、`:1053` |
| 900px | 管理列表筛选与个人页统计改为单列 | `style.css:724`、`:951`；`ProfileView.vue:331` |
| 768px | `.grid-2`/`.grid-3` 单列；导航变窄；字段导航出现；编辑器控件至少 44px 高 | `style.css:350`、`:1022`、`:1035`、`:1046`、`:1064` |
| 700px | PDF 工具条改为横向滚动，不换页 | `PdfSinglePageViewer.vue:406` |
| 640px | 页边距收紧；确认框改为单列；快捷键提示隐藏 | `style.css:749`、`:972`；`ArbitrationView.vue:458` |
| 560px | 批量生成志愿者账号的表单改为单列 | `style.css:744` |

1100px 以下不是「所有页面都变单栏」。登录卡、来源表单没有自己的 1100px 规则。管理表格包在 `.table-wrapper { overflow-x: auto }`（`style.css:327`）里，窄屏横滑，不截断操作列。

动效：`prefers-reduced-motion: reduce` 时全局 `*` 把滚动、动画、过渡压到近乎零（`style.css:761-762`）。

## 可及性核销清单

这张表只记录「怎么判定通过」。没通过的项不在本文件里标成完成。执行与证据归 #265。

| 项 | 通过条件 | 当前 |
| --- | --- | --- |
| 键盘焦点可见 | 焦点环相对相邻背景对比度 ≥ 3:1。PR 里写出前后色值与计算式 | 通过。`--focus-ring` 对白底 7.08:1、对纸色 6.39:1，见上文「语义、刻度与焦点」。键盘走查仍归 #265 |
| 动态消息有角色 | `grep -rn "class=\"alert" frontend/src` 的每一行都含 `role=` | 通过。错误用 `role="alert"`，成功与进度用 `role="status"`。棘轮 `alerts_without_role` 上限 0 |
| 状态不只靠颜色 | 疑点标记带「疑」或等价文字 | 通过。`style.css:657-658` |
| 动效可关 | `prefers-reduced-motion` 规则仍在 | 通过。`style.css:761-762` |
| 模态不丢焦点 | Tab 留在对话框内，Esc 关闭，关闭后焦点回到触发控件 | 算法在 `lib/modalFocus.js`，测试在 `frontend/tests/modalFocus.test.js`。调用点都走 `AppModal` |
| 记音的 `lang` | 不在本清单里实施 | 归 #270。`grep -rn "lang=" frontend` 目前主要是 `frontend/index.html` 的页面语言 |

## 改动时要引用的小节

改 `frontend/src` 里跨视图的令牌、共享组件、焦点、断点或四态标记时，PR 描述点名本文件的对应小节（「令牌」「共享组件」「四态」「断点」「可及性核销清单」之一）。只改一个领域内部的文案或流程时，用那个领域的 scope，并在 PR 里写「不涉及界面契约」。scope 的取舍写在 `CONTRIBUTING.md` 的 `ui` 条目。
