# 万语校坊产品定位与跨产品边界

> 仓库：`e-dialect/wanyu-proofreader`
>
> 旧产品名：方辑 Fangji
>
> 当前产品名：**万语校坊**
>
> 品牌整合前的旧版源码快照：[fangji-v1.0.0](https://github.com/e-dialect/wanyu-proofreader/releases/tag/fangji-v1.0.0)

## 1. 定位

万语校坊是“乡声万语”体系中面向**方言、地方语言与民族语言资料**的协同校勘平台；“智能协同校勘”是产品方向，不表示当前已经具备成熟的 AI 自动校勘模型。

它解决的不是普通用户随手补充一个词条，而是：

- 成批导入 PDF / CSV 等资料；
- 多人独立校对；
- 可配置校对轮次；
- 差异检测；
- 管理员仲裁；
- 批量导出最终结果；当前导出可按 PDF 页码定位，但不包含逐位校对者尝试与仲裁过程的完整审计记录。

它有双重但不冲突的身份：

- 对外是可独立部署、独立使用并具有独立商业价值的资料数字化产品；
- 对内是乡声万语 `Candidate → Trusted / Gold` 的专业工作台。

万语校坊项目内的 `approved` 只表示校勘工作流完成，不自动把数据提升为 Trusted 或 Gold。跨产品质量层级仍须经过 [#97](https://github.com/e-dialect/wanyu-proofreader/issues/97) 定义的 provenance、QA、可信/专家决策和版本化流程。

因此它继续保留独立 PocketBase 后端、数据库、认证、权限和专业工作台，不需要为了“品牌统一”强行与乡声集盒合并，也不能降格为乡声集盒的管理后台。

2027 春节阶段使用 **Data First + Product Polish**：用真实莆仙和蒙古语资料验证导入、独立校对、仲裁、导出与志愿者旅程，同时修复产品摩擦，不重写核心架构。执行总控见 [SF-W · 2027 春节万语校坊 Sprint Tracking](https://github.com/e-dialect/wanyu-proofreader/issues/91)。

## 2. 与乡声集盒的分工

### 留在乡声集盒

- 普通用户录音；
- 对本地说法进行轻量确认/反例反馈；
- 高质量成员的一次性补充；
- 与某条 Entry / Recording 紧密绑定、几步即可完成的整理动作；
- 需要最大限度降低用户跳转成本的任务。

### 进入万语校坊

- 一个项目包含大批材料；
- 需要两人及以上独立结果；
- 需要隐藏其他校对者结果以避免相互影响；
- 需要管理员逐字段仲裁；
- 需要进度、租约、批量账号或项目权限；
- 需要批量导出最终校勘成果；如需全过程审计，还应另行导出或保留校对尝试与仲裁记录。

## 3. 登录

- 当前代码保留 `hinghwa` external identity provider，作为历史兼容路径；
- 外部身份按稳定 provider-local subject 映射万语校坊本地用户，不按邮箱或姓名猜测合并；
- 长期方向是以乡声集盒稳定身份作为“乡声万语”主要外部身份入口，但不声称该 SSO 已经实现；
- 万语校坊本地用户、项目角色和独立登录仍保留。

早期不要把两个后端强行合并。身份映射规则必须显式记录，并继续由万语校坊本地权限模型决定项目访问能力。

## 4. 数据交换

近期实行 Review Bundle v0 的人工可控批次交换，而不是实时双向同步。字段契约见 [`plans/2026-09-29-review-bundle-v0.md`](plans/2026-09-29-review-bundle-v0.md)。

下图中 X = 乡声集盒，W = 万语校坊：

```text
X export Review Bundle
→ human check
→ W import
→ independent proofreading
→ arbitration if needed
→ W export Review Result
→ human check
→ X import
```

原则是：**先打通语义，再打通网络。** 春节阶段不建设 realtime API、webhook、message queue、distributed transaction、shared database 或 full OIDC。

每批至少保留：

- source system；
- export batch id；
- schema version；
- source object ids；
- generated-at；
- operator / reviewer；
- checksums（适用时）；
- import result / conflicts。

不允许两端直接读取彼此内部数据库表作为稳定 API。

## 5. 候选任务是否必须进万语校坊？

不必须。

“有高质量管理员/高质量整理成员”并不意味着他的所有动作都要进专业工作台。产品体验优先按**任务复杂度**分流，而不是按**用户身份**分流：

- 轻量、上下文明确、一次完成 → 原地在乡声集盒；
- 成批、需要独立性、仲裁、项目管理 → 万语校坊。

这可以减少两个平台来回跳转，同时保留专业校勘流程的严谨性。
