## 关联 Issue

<!-- 使用 Closes #123 / Fixes #123；仅部分完成时请写 Related to #123 并说明遗留范围。 -->

## 改动内容

<!-- 说明问题、实现方式，以及没有包含在本 PR 中的内容。 -->

## 行为、风险与兼容性

- 用户可见行为：
- 数据迁移或 schema 影响：
- 部署或环境变量影响：
- 安全与权限影响：
- 回滚方式：

## 验证

<!-- 列出实际执行的命令和结果；未运行的检查要说明原因。 -->

- [ ] `make check`（gofmt、`go vet`、ESLint、版本与套件一致性、Compose 不变量、单测、迁移 up/down/up）
- [ ] `cd frontend && npm run build`
- [ ] `docker compose config`
- [ ] 涉及并发或后台任务时：`RACE=1 make test-go`
- [ ] 涉及导入、权限、盲校、仲裁或迁移时：`make test-integration SUITES=<套件前缀>`
- [ ] 未运行的检查已在此说明原因

## UI 证据

<!-- 涉及 UI/交互时提供截图或短视频；否则写“不涉及”。不要上传真实用户或语料数据。 -->

## 提交前自查

- [ ] 本 PR 只处理一个可独立合并的问题
- [ ] 已关联 issue，并记录未完成的后续工作
- [ ] 文档和示例已更新，或不需要更新
- [ ] 没有提交密钥、`.env`、生产数据或构建产物
- [ ] PocketBase 变更通过新增迁移完成，没有改写既有迁移
- [ ] 我理解维护者将手动审核并使用 Squash and merge；未启用 auto-merge

## Contribution

- [ ] I confirm that I have the right to submit this contribution.
- [ ] Any third-party material is clearly identified with its source and license.

For first-time contributors, the CLA check will guide explicit acceptance of
the current e-dialect ICLA. These checkboxes do not constitute a CLA signature.
