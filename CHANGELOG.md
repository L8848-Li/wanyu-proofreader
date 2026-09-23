# Changelog

本文件记录项目级别的部署、配置和功能变更。日常开发细节请优先看 Git 历史。

> **2026-09-23 起暂停更新。** `## Unreleased` 用「顶部插入一条」的写法，条目全部堆在同一个
> 未发布段落里，既没有版本边界，又让并行 PR 反复撞在同一行上。定下首个 Release 版本之前，
> 贡献者与合并者都不再往这里加条目：PR 不必附 changelog 文案，改动以合并进 `main` 的提交信息为准。
> Release 落地时另开一支 PR 重新设计本文件的组织形式并回填。

## Unreleased

- 校对员首次进入编辑器时提供可跳过的新手引导（桌面与移动两套说明），完成后可在个人中心重看；偏好存在本机 `fangji:onboarding:v1:<userId>`。引导打开期间屏蔽编辑器快捷键，避免按 ⌘/Ctrl+Enter 误提交。
- 管理员 PDF 分块上传可在刷新、重开页面或服务重启后续传：重新选择同一文件并核对其 SHA-256，跳过已收分片；错误原件、过期和放弃均有界面提示。
- 校对员可只读回看本人已提交条目：新增 `GET /api/fangji/projects/{projectId}/tasks/reviewed` 游标；`GET /api/fangji/pages/{pageId}/task?mode=review` 在本人当前轮有提交时返回只读对照（无查询参数时仍为 403）。只读响应不含 `status`、轮次、人数或其他校对员结果。
- 管理员选择单个 PDF 后立即校验并自动上传；上传中禁止重复选择，失败时提供重试入口。
- 校对员编辑器字段条标题由“导入原文”调整为“待校对原文”，明确该区域展示的是本次需要校对的原始文本。
- 校对员项目大厅和编辑器不再显示一校、二校等轮次线索，只呈现可领取任务、进行中任务和独立校对操作。
- 管理员仲裁复用 PDF 双栏审阅工作区，可对照条目实际关联的 PDF，动态比较全部校对结果并使用字符板编辑最终值。
- 管理员控制台新增异常优先排序与项目管线概览；项目状态可直达筛选结果，仲裁要求显式确认全部差异并提供批量来源选择与离开保护。
- 统一为档案校勘工作台视觉，补充响应式导航、键盘焦点、减少动效和加载/空/错误状态。
- CSV 预检新增有效页码范围，项目创建页新增 PDF/CSV 组合提示和应用内完整说明。
- CSV 预检会快照当时的主 PDF 和页数，正式导入的任务固定关联该文件；相同 CSV 在不同主 PDF 下会创建独立作业。
- 登录身份刷新仅在服务端明确返回 401/403 时清理本地会话，网络故障、限流和服务端临时错误会保留有效 token。
- CSV 导入改为单次上传到后端持久化作业，浏览器不再逐条创建和补偿删除任务。
- 后端支持 UTF-8/GB18030、标准 CSV 引号及跨行字段，错误行会跳过并记录行号、字段、错误代码和原因。
- 新增导入进度、成功/跳过统计、错误明细、内容哈希幂等保护和服务重启后的未完成作业恢复。
- PDF 上传增加 50 MB 请求限制、文件签名校验和 `processing`/`ready`/`error` 状态处理。
- PocketBase 改为自定义 Go 构建，并新增上传逻辑单元测试和端到端集成测试。
- 新增 `proofreading_attempts` 校对历史集合，永久保留每轮一校、二校和管理员仲裁结果。
- 将任务认领、提交、两次结果比较和仲裁改为后端事务接口，校对员不能再直接修改任务状态。
- 二校只能读取原始条目和自己的校对历史，无法通过集合 API 读取一校内容。
- 两次结果不一致时进入 `arbitration`，管理员可逐字段对比并提交最终结果。
- 个人统计改为基于校对尝试计算双校一致率，不一致记录不再因重置任务而消失。
- 新增第一阶段端到端集成测试，覆盖权限、盲校、一致通过、不一致仲裁和统计。
- IPA/BUC 键盘改为在当前光标处插入字符，并支持替换文本选区。
- 校对内容按用户和任务自动保存到浏览器本地草稿，刷新可恢复，提交后自动清除。
- 新增校对快捷键：保存草稿、提交校对和切换前后任务。
- 提交后自动进入下一条任务时保留成功反馈，避免页面切换后提示丢失。
- PDF 预览新增缩放、适宽、旋转、全屏、页码显示和高分屏渲染。
- 校对编辑器新增窄屏上下布局，并补充第二阶段前端单元测试。
- 管理员项目详情页新增条目搜索、状态筛选、分页和每页条数设置，避免大项目一次渲染全部条目。
- 条目列表加载失败支持页面内重试，范围选择和批量操作改为页面内成功/错误反馈。
- 范围选择支持中文逗号、逆序区间和越界过滤，并新增对应单元测试。
- 新增全局 Vue 页面异常边界、键盘焦点样式和管理员操作区窄屏布局。
- 应用启动时刷新本地登录身份，自动清理已失效或指向已删除用户的旧会话，避免管理员关系字段提交失败。
- PocketBase 字段校验错误优先显示具体原因，通用英文错误改用调用处的中文提示。
- 将生产 Docker Compose 默认入口调整为 Traefik，由 Traefik 路由到 `frontend` 容器的 `80` 端口。
- 保留但默认注释 `frontend` 和 `backend` 的宿主机 `ports` 映射，便于无 Traefik 或本机调试时手动启用。
- 将 PocketBase 数据默认持久化到本地目录 `./pb_data`，便于备份和迁移；Windows 宿主机可叠加 `docker-compose.named-volume.yml` 切换为 Docker named volume。
- 拆分环境变量示例：
  - `.env.example` 用于生产 `docker-compose.yml`。
  - `.env.dev.example` 用于开发 `docker-compose.dev.yml`。
- 生产配置统一使用 `BACKEND_URL` 表示浏览器可访问的后端地址，移除生产 compose 中的旧 `PB_URL` 兼容变量。

### 工程质量与开发工具（2026-09-19）

- 新增根目录 `Makefile`：`make check` 一次跑完推送前应执行的全部门禁，`make ci` 追加集成套件、前端构建与镜像构建。
- 新增 `backend/tests/run_all.py` 与 `backend/tests/harness.py`：一次编译共享给全部集成套件，每套仍使用独立临时数据目录；套件清单集中在 `backend/tests/suites.json`，CI 矩阵由它生成。
- 新增静态检查门禁：`gofmt -l`、`go vet ./...`、前端 ESLint（`eslint:recommended` + `vue/essential`，仅正确性规则）、`go test -race` 与竞态下的导入/租约集成套件。
- 新增三个一致性守卫：`check_test_inventory.py`（磁盘套件 vs `suites.json` vs CI vs 文档）、`check_runtime_versions.py`（Node/Go/PocketBase/Dependabot 声明互相印证）、`scripts/check_compose_structure.py`（把 CI 里四段无法本地复用的 jq 断言变成可执行检查）。
- 迁移校验改为通用 `check_migrations.py`：逐条 up/down/up，覆盖此前从未被执行过的 `1788941000_pagination_indexes.js`，并断言初始 schema 拒绝回滚；替换两个各自硬编码单一索引名的 `check_pdf_affinity.py` 与 `check_join_retention.py`。
- 空项目的所有者/管理员可用 `term` 按**完整**用户名或昵称精确查人（刻意不用模糊匹配：任何 2 字符 LIKE 都会让项目管理员逐段扫完全平台名册，正是本次要收掉的边界）；前端查找框文案与空结果提示同步说明需要完整名称。
- 新增 `backend/tests/seed_demo.mjs`：经真实 CSV 导入链路灌入一个可复核的演示项目，含一致结果与一条待仲裁分歧。
- 新增 `ops/audit_storage.py`：只读巡检 `pb_data` 体积、PDF 预览缓存与上传暂存残留、磁盘水位，超限非零退出以便接入调度。
- 后端镜像现在注入 `version`/`commit`/`build_date` 并在启动日志打印，补齐运维备份记录所需的构建版本；三个 Compose 入口与 `backend/.dockerignore` 同步更新。
- 前端补齐权限判定与任务定位单测：`src/lib/access.js` 抽出登录态、落地页与路由守卫判定，`tests/accessControl.test.js`、`tests/taskNeighbors.test.js`、`tests/structuredRow.test.js` 覆盖此前 0 覆盖的角色门禁与 `n/m` 计数器。
- `member-candidates` 路由加入集成断言：字段形状、姓名排序以及非管理者 403、未登录 401。
- 新增 `frontend-image-parity` job：前端镜像以 Node 26 构建，而 CI 此前只在 24 上验证，发布用的构建环境从未被测过；守卫现在要求镜像的大版本必须有对应 job 覆盖。
- 集成测试服务器以 `-race` 构建时设 `GORACE=halt_on_error=1` 并在日志中检出 `DATA RACE` 即失败；独立二进制默认只打警告并退出 0，否则竞态永远测不出来。
- CI 的 `git diff --check` 改为对比 PR base（裸命令比较工作树与索引，检出后必然干净）；镜像构建注入 `COMMIT` 并写入 OCI 标签，备份记录可直接读取。
- **安全收敛**：`GET /api/fangji/projects/{id}/member-candidates` 此前会用无范围读取列出**全平台账号**（含 `email`，同时绕过 `users.listRule` 仅平台管理员可列出、以及 `emailVisibility` 脱敏）。现收敛为：项目管理员只看到与自己管理的项目相关的账号（含本项目所有者与成员），响应不再包含 `email`，并按 name→username 码元序稳定排序、设 200/500 上限；平台管理员保留列出权限（同样只有 200 条硬上限，尚无游标分页）。前端成员与转让选择器随之去掉 `email` 回退。志愿者批量开通与项目密码自助加入不依赖该接口，不受影响。
- 修正文档与配置漂移：README 技术栈版本、Dependabot 更新频率描述、项目结构树、`pocketbase` 二进制来源说明；`frontend` 镜像 Node 26 与 `engines` 约束现已一致。
