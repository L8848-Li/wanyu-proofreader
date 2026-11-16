管理端领域面板拆分验证，2026-11-15。

全部页面使用 delivery 集成测试即时生成的虚构项目、来源、编选与交付数据。没有真实消费者签收或业务发布。

运行：`NODE_PATH=<playwright installation>/node_modules BROWSER_CHANNEL=chrome python3 backend/tests/run_frontend_quality_browser.py --only delivery`。

- `adoption-created.png`、`adoption-created-mobile.png`：编选创建成功后详情，桌面与 390px。
- `receipt-390.png`：保留未保存内容的回执编辑面板，390px。
- `result.json`：覆盖的交互摘要。
