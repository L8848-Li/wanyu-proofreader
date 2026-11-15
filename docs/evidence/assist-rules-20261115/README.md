# 机器疑点规则桌面回归

截图来自 1440×960 的 Edge、本机临时 PocketBase 与合成 CSV。

- [列与分页疑点尚未生成](batch-before-recompute.png)
- [从质量检查重算后返回本批疑点](batch-findings.png)
- [保存参照列与待核对列，刷新后保留设置](tone-count-fields.png)

浏览器脚本为 [batch-report.cjs](../../../frontend/tests/browser/batch-report.cjs)，
包含在 `run_frontend_quality_browser.py --only workbench` 中。真实批次的准确率与漏报率仍待人工复核。
