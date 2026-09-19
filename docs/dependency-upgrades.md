# PocketBase 重建升级决策

2026-09-09，跟踪 #14。维护者确认没有正式运营数据，允许重新整理数据。
最终目标为 PocketBase 0.40.3、Go 1.27、Node 24 LTS 和 PocketBase JS SDK 0.28.1。
版本依据：[PocketBase 发布记录](https://github.com/pocketbase/pocketbase/releases/tag/v0.40.3)、
[Go 支持版本](https://go.dev/doc/devel/release)、[Node LTS](https://nodejs.org/en/about/previous-releases)。

## 实现决策

使用全新数据目录。临时旧 schema 先经官方 0.22.46 再经 0.40.3 转换，
导出应用集合（不包含系统集合或数据）作为新的初始化快照。
旧的 28 份迁移保留于 `backend/legacy_migrations`，仅供历史参考，启动时不执行。
初始化快照不提供破坏性的 down；回滚使用旧镜像和旧目录。

按照官方 [Go](https://pocketbase.io/v023upgrade/go/) 和
[JSVM](https://pocketbase.io/v023upgrade/jsvm/) 指南迁移 DAO/Record、请求参数、
路由中间件、事务和事件 Next 链。超级管理员现在属于 `_superusers` auth 集合。
新版零值不能满足 required number，因此失败计数和排序序号明确允许零。
内置原始文件拒绝响应为 404；自定义任务 PDF 的租约与角色限制保持一致。

修改邮箱时 PocketBase 会轮换认证密钥。`PATCH /api/fangji/profile` 现在返回
`{ record, token }`，前端同步保存新令牌；浏览器刷新后仍可再次保存资料。
启动管理员 bootstrap 只在密码实际变化时重设密码，避免重启使会话失效。

## 部署和回滚

1. 合并运行时基线 PR #79，再合并本升级 PR；构建新镜像并记录 digest。
2. 停止前后端。保留原 pb_data 和旧镜像；不要让新程序直接打开旧目录。
3. 创建新的空数据目录，例如 `pb_data-040`，把 Compose 数据挂载指向它。
   named volume 部署则创建新的卷并修改挂载来源，不删除原卷。
4. 设置 APP_ADMIN_EMAIL/PASSWORD 与 PB_ADMIN_EMAIL/PASSWORD，启动新后端、前端。
   新版自动初始化 schema 和键盘；旧账号、项目和材料不自动复制。
5. 检查健康端点、登录、创建项目、CSV/PDF 上传、领取/提交/仲裁、导出和管理入口。
6. 失败时停止新服务，恢复旧镜像并重新挂载原目录；不要把新版数据目录交给旧二进制。
   正式运营开始后不再采用重建策略，应以完整备份副本演练后续增量迁移。

## 验证证据

- Go 1.27：全部 Go 测试通过。旧 PocketBase 0.21.3 曾在该运行时的 JSON 路径栈溢出，
  更新 PocketBase 后已通过；这说明仅更新旧镜像是不够的。
- 全新临时数据库：核心逻辑、CSV/PDF 上传、可配置多人仲裁、租约、项目权限、
  统计、任务 PDF、键盘、列顺序、志愿者和 Unicode 集成均通过。
- Unicode API 全链路及关闭/重启后的数据持久化通过。
- Chrome：修改邮箱、刷新页面、再次保存昵称、验证新令牌通过，无页面异常。
- Node 24：前端测试和构建通过。容器构建由 CI 验证。

## 依赖监控

Dependabot 按前端、Go、Actions 独立每日更新，Go 仅分组 patch。
每周审计保存 npm audit、govulncheck 和过期版本结果；漏洞或扫描失败会使任务失败。
严重/高危可达漏洞 24 小时内分诊，72 小时内修复或给出经评审的缓解措施。
超时须记录负责人、影响和下次复查日期，不得无期限忽略。
