# 单机运维与恢复

使用单实例 PocketBase/SQLite。正式启用前按以下步骤演练，记录版本、耗时和结果。

## 备份与恢复

目标 RPO 为 24 小时，目标 RTO 为 60 分钟；这是初始目标，实际应按数据量测量。
每日低流量窗口停写备份，升级前额外备份；保留 7 份日备份、4 份周备份和 6 份月备份。
备份目录包含全部数据库、WAL/SHM（若存在）、上传文件及其他 pb_data 元数据。
不要只复制 data.db，也不要在线逐个复制数据库和文件。

```sh
docker compose stop frontend backend
python3 backend/ops/backup.py backup ./pb_data /secure-backups/fangji-20260909 \
  --version "$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' fangji-backend:latest)" --application-stopped
docker compose start backend frontend
```

后端镜像在构建时注入 `VERSION`/`COMMIT`/`BUILD_DATE`，同时写入 OCI 标签
`org.opencontainers.image.revision`，因此备份记录可以直接从镜像读取，不必手工誊抄；
容器启动日志第一行 `fangji backend <version> (commit <sha>, built <date>)` 可作为交叉核对。
由 Compose 直接构建时使用 `FANGJI_VERSION`/`FANGJI_COMMIT`/`FANGJI_BUILD_DATE` 传入，
CI 的镜像构建与 `make docker-build` 已自动传入。未传入时记为 `dev`/`unknown`，
`scripts/check_compose_structure.py` 会在巡检输出里提示这一点——它就是需要纠正的配置信号。
每日巡检可运行 `python3 ops/audit_storage.py --data-dir ./pb_data`，它只读不删，
超过预算或非零退出时可挂到调度器上。

工具拒绝已存在的备份目录、软链接及放在源目录内的备份，复制前后检查文件哈希，
验证 SQLite 完整性并记录版本。`--application-stopped` 是操作者对已停写的确认，
工具不能独立判断容器是否停止，文件变化检测也不能替代停写。
named volume 部署需先停止服务，再将卷内容完整复制到离线目录后运行同一命令。
备份成功后传到加密的异地存储，上传完成后验证 manifest；生产数据不得放入 Git。
每日调度应在任何命令非零退出、24 小时无新备份或异地校验失败时通知维护者。
异地存储目标和通知渠道由部署者配置，仓库不预置凭据或发送通知。

恢复到全新路径，保留当前目录供排查：

```sh
docker compose stop frontend backend
python3 backend/ops/backup.py restore /secure-backups/fangji-20260909 ./pb_data-restored
# 验证输出版本与将要运行的镜像匹配；将 Compose 数据挂载切换到恢复目录。
# 确认容器用户能读写该目录后，启动 backend 和 frontend。
```

工具检查完整清单、SHA-256 和 SQLite integrity_check，不覆盖现有目标目录。
启动后检查 `/healthz` 和 `/api/health`，管理员登录、项目/条目数、PDF 打开、
领取/提交、仲裁、CSV 导出，并对比备份前文件哈希。每季度和重要版本升级前重复演练。

## TLS、网络与管理入口

公网 TLS 在 Traefik 终止；只将 frontend 接入代理网络，backend 不发布公网端口。
按实际代理网段配置 TRUSTED_PROXY_CIDRS；外部伪造转发头不得成为限速身份。
仅 HTTPS 的 Traefik router 应设置 HSTS，不能在本机 HTTP 模式强制 HSTS。
当前本机 Compose 默认关闭 Admin UI；Traefik 入口为维护便利默认开启，
正式运营须显式 `ENABLE_POCKETBASE_ADMIN_UI=false`，需要维护时结合 VPN/IP 白名单临时开放。
健康检查和启动依赖已在 Compose 配置。PDF 最大 100 MiB，Nginx 请求上限 101 MiB，
异步校验可能持续数分钟；realtime 连接读取超时为 3600 秒。

## 日志与升级

应用和 Nginx 写 stdout/stderr，使用 `docker compose logs` 查看；生产 Compose
配置 Docker 日志轮转，每个容器最多 5 个 10 MB 文件。按需将脱敏日志集中保存 30 天。
不得记录密码、认证头、token、口令、完整 CSV/PDF 正文；审计记录保留操作者 ID、
资源 ID、时间、操作结果和 request_id。备份/恢复工具仅输出版本和文件数。

升级前确认 CI、阻断评审、镜像 digest、配置差异及迁移说明；停写备份，
先用备份副本演练新版本，再切换正式服务并完成上述烟雾检查。
失败时停止新服务，恢复旧镜像及升级前整目录备份；不能用旧程序直接打开新版本已迁移的数据。

## 本次演练边界

自动测试创建包含扩展汉字/音标的 SQLite 记录及 PDF/CSV 文件，完整备份后恢复到新目录，
验证数据库记录和全部文件 SHA-256 一致；损坏备份、软链接及覆盖现有数据均被拒绝。
这是可重复的离线工具演练，不等同于实际服务器的容量、异地传输及通知链路验收。
部署者仍须测量实际 RPO/RTO，验证容器非 root/最小权限和异地恢复。

## PDF 分块上传

用户仍选择一份不超过 100 MiB 的完整 PDF。浏览器按 1 MiB 顺序传输，显示整体
进度并可取消；网络错误、408/429/5xx 最多重试三次（1、2、4 秒退避）。已完成
分片不会因后续失败而重传。浏览器用 Blob.slice 截取字节，无需解析或手动拆分 PDF。

接口位于 `/api/fangji/projects/{projectId}/pdf-uploads`：POST 创建会话，
PUT `/{id}/chunks/{index}` 提交分片，POST `/{id}/complete` 完成，DELETE `/{id}`
取消。每次核对登录用户和项目管理权限。创建请求用客户端随机 requestId 保证
响应丢失可重试；相同分片返回成功，内容冲突返回 409。完成时校验分片哈希、
总长度及 PDF 头，按顺序拼接后进入既有深度校验队列；重复完成返回同一文件记录。

每用户一个进行中会话，全局最多四个。按每文件两倍大小预留临时预算（全局
1 GiB），私有目录为 `pb_data/pdf-upload-staging-v1`，目录 0700、文件 0600。
取消立即删除分片，闲置一小时后由每分钟清理任务回收，重启时清空全部遗留
分片。完成结果在进程内保留到会话过期，支持网络响应丢失后的幂等重试。
刷新页面、退出页面后重传或服务重启后的续传由 [#88](https://github.com/e-dialect/wanyu-proofreader/issues/88) 单独跟踪。

正常上传无需调整共享 Traefik：60 秒限制作用于每个分片请求，而非整本书的
累计传输时间。极慢到单个 1 MiB 分片也超过入口超时的网络仍可能失败；此时
可使用下述可选部署排障设置。旧整文件 API 保留供现有客户端兼容使用。

验证（临时数据库，不连接生产）：

```sh
go test -C backend ./...
FANGJI_SLOW_UPLOAD=1 python3 backend/tests/run_integration.py pdf_chunks_integration.mjs
npm --prefix frontend test
npm --prefix frontend run build
# 已安装 Playwright Chromium 后运行；macOS 可设置 BROWSER_CHANNEL=chrome。
PDF_UPLOAD_BROWSER_SCRIPT="$PWD/backend/tests/pdf_upload_browser.cjs" \
PDF_BROWSER_FIXTURE=/tmp/fangji-upload-browser-fixture.json \
python3 backend/tests/run_integration.py pdf_chunks_integration.mjs
```

慢网测试使完整 HTTP 流程超过 60 秒并校验原件字节完全一致，未模拟生产 Traefik。
浏览器回归模拟分片 503 和完成响应丢失，确认自动重试只创建一条 ready 文件记录。
Go/前端测试另覆盖重复与冲突分片、取消、超限、权限撤销、重启和闲置清理。
浏览器 fixture 只包含一次性测试凭据，不得提交生产凭据。

## 可选排障：旧整文件上传在 60 秒附近失败

100 MiB 的容量上限不代表允许传输足够久。Traefik 的入口
`transport.respondingTimeouts.readTimeout` 默认 60 秒，计时包含整个请求体。
慢速上传会在到达 PocketBase 前断开；Nginx 常记录空响应的 400，后端没有对应
`upload_received`。同一文件重试若恰好在 60 秒以内传完就会成功。

确需放宽入口超时时，可在 **Traefik 自身的静态配置**中保留其他设置并合入：

```yaml
entryPoints:
  websecure:
    transport:
      respondingTimeouts:
        readTimeout: 600s
```

JSON 部署可生成待审查文件（不要将输出重定向到输入文件）：

```sh
python3 ops/prepare_upload_timeout.py /path/to/traefik.json > /tmp/traefik-upload.json
diff -u /path/to/traefik.json /tmp/traefik-upload.json
```

备份原配置后替换为生成文件，并按基础设施的启动方式重建/重启 Traefik。
如果基础设施有配置生成器，同时修改生成源，避免下次部署覆盖。
这个入口可能由多个站点共享，变更会允许它们的上传连接占用至多 10 分钟；
不使用无限超时。回滚为备份文件并重启 Traefik 即可，无数据库迁移。
仅重建万语校坊容器或设置 router 的 `serversTransport` **不能**改变入口读取超时。

验证：在测试项目以约 1 MiB/s 上传一份 80 MiB PDF，确认耗时超过 60 秒仍返回
202，随后文件状态为 ready；并验证超限文件仍返回 413、无权限用户仍被拒绝。
部署后的日志应同时出现 Nginx 202 和后端 upload_accepted/pdf_ready。
生产故障证据：首次约 60 秒中断且后端无记录，第二次约 55 秒传输成功；
校验本身不到一秒。无需重复上传来“预热”PDF 校验器。

参考：[Traefik 入口 respondingTimeouts](https://doc.traefik.io/traefik/v3.3/routing/entrypoints/#respondingtimeouts)。
