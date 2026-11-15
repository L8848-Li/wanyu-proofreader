# 启动提示与连接恢复

本目录只使用合成账号和浏览器拦截响应，不含真实用户或资料。浏览器运行实际应用入口；未替换应用启动逻辑。

自动验证覆盖：等待登录刷新时先显示状态、10秒超时及503错误保留登录信息、显式重试、401清除失效凭据并进入登录页、迟到响应不恢复旧会话，以及1440px/390px无横向溢出。补充派发 `persisted` 页面生命周期事件，验证等待/错误状态挂起、恢复、新请求失败后手动重试，旧请求迟到不回填，已挂载页面恢复不重复刷新。此项确定性验证事件接线，没有声称浏览器实际选择将页面放入 BFCache。

- [桌面等待状态](desktop-pending.png)
- [桌面超时与重试](desktop-retry.png)
- [手机连接失败与重试](mobile-retry.png)
- [重试后的登录页](desktop-recovered.png)
- [运行结果](result.json)

复现入口：`NODE_PATH=<playwright 所在 node_modules> BROWSER_CHANNEL=chrome python3 backend/tests/run_frontend_quality_browser.py --only startup`。Playwright版本与CI一致为1.62.1。真实网络、原生手机及读屏体验仍需人工复核。
