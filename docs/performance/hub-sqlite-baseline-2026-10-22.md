# HAPI SQLite 性能基线 2026 年 10 月 22 日

本记录保存 PostgreSQL 与索引优化实施前的运行现状，供后续按相同口径比较。完整脱敏样本见 [hub-sqlite-baseline-2026-10-22.json](hub-sqlite-baseline-2026-10-22.json)，改善目标见 [PostgreSQL 与历史 SQLite 自动迁移方案](../guide/postgresql-migration-plan.md)。

首次故障排查与本次补采分开记录，各自保留进程实例、负载口径和样本数量。线上数据持续增长，以下结果均附采样时间。当前运行时代码沿用上游，PostgreSQL 后端与索引修复仍处于改善方案阶段。

## 版本与环境

| 项目 | 本次补采值 |
| --- | --- |
| 采样时间 UTC | `2026-10-22T10:26:18+00:00` 至 `2026-10-22T10:26:34+00:00` |
| HAPI 镜像 | `local/hapi-hub:0.30.7` |
| 镜像 ID | `sha256:5f3500f40485af6b24ad8f99422272ef5651820a0c0fe5d9df55e1c6ba2710ab` |
| HAPI 可执行文件 SHA256 | `a85eaf72ab157f920600c2b64d15623e83bae5c79849f8867b19d3e89ba26eed` |
| 运行时 | Bun 1.4.0，SQLite 3.53.2，schema 26 |
| 架构与内核 | `aarch64`，`6.17.0-1020-oracle` |
| 宿主机 | 16 个逻辑 CPU，内存 62.660 GiB，采样开始可用内存 49.529 GiB，Swap 0 KiB |
| 数据盘 | `/data`，/dev/sdb，ext4；总量 1006.854 GiB，可用 51.713 GiB |
| 容器启动时间 | `2026-10-22T09:27:11.704372377Z` |
| 进程标识与时长 | init PID 2986264，主线程 PID/TID 2986361，补采开始时运行 3546.910 秒 |
| cgroup 配额 | `cpu.max = max 100000`，`memory.max = max`，可用 CPU `0-15` |

CPU、内存、cpuset 等 Docker 原始配置和本次 `cpu.stat`、`docker stats` 记录均保存在 JSON 中。采样结束已确认容器进程与镜像 ID 和开始时一致。

## 数据规模

数据库统计时间为 `2026-10-22T10:26:25.032Z`。使用 HAPI 自带 Bun/SQLite，以只读连接和同一读事务获取记录数量及 SQL 对照数据。

| 业务表 | 记录数量 |
| --- | ---: |
| `sessions` | 177 |
| `machines` | 1 |
| `messages` | 510,420 |
| `message_epochs` | 10 |
| `users` | 0 |
| `push_subscriptions` | 3 |
| `fcm_devices` | 0 |
| `session_scratchlist` | 0 |
| `usage_events` | 124,574 |
| `usage_scan_state` | 177 |
| `events` | 0 |
| `event_links` | 0 |

SQLite 主文件大小为 1,052,946,432 字节；page size 为 4096 字节，page count 为 257072。会话列表查询覆盖 `default` 命名空间的 177 个会话；待发送定时消息为 0 条。主文件大小采自独立文件统计时刻，WAL 中的新页可能使逻辑页数与主文件大小出现差异。

## 被动 CPU 与内存采样

在本次 SQL 对照与主动 HTTP 请求开始前，读取 `/proc` 两次并间隔约 5 秒。宿主机其他服务与既有客户端照常运行。

| 指标 | 补采值 |
| --- | ---: |
| 采样间隔 | 5.0006 秒 |
| 主线程 CPU，单核为 100% | 1.000% |
| 主线程 user CPU | 0.800% |
| 主线程 system CPU | 0.200% |
| 宿主机 CPU 空闲 | 91.681% |
| 宿主机 I/O wait | 0.013% |
| 进程 RSS，开始 / 结束 | 883.320 / 883.352 MiB |
| 进程线程数，开始 / 结束 | 18 / 18 |
| 进程 rchar 增量 | 281,900 字节 |
| 进程实际磁盘读取 read_bytes 增量 | 0 字节 |

`rchar` 包含页缓存命中的读取，`read_bytes` 单独记录存储层读取。上述 CPU 来自该 5 秒窗口的主线程计数差值；`ps %CPU` 的进程生命周期平均值保留在前期观察中。RSS 与 Docker cgroup 内存指标分别记录各自口径。

## 本机接口原始耗时

探测目标为 `http://127.0.0.1:3006`，使用现有凭据获取 JWT 后访问接口，Origin 与既有公网入口一致。每个端点采样 5 次，顺序为一次完整会话列表、一次健康检查，单并发、逐请求新建 HTTP 连接、读取完整响应；单次超时 20 秒。连接直接进入本机端口，后台客户端流量继续运行。

| 端点 | 成功 / 尝试 | 最小 ms | 中位 ms | 最大 ms |
| --- | ---: | ---: | ---: | ---: |
| `/api/sessions` | 5/5 | 1067.846 | 1071.312 | 1078.637 |
| `/health` | 5/5 | 1.430 | 5.720 | 8.371 |

| 轮次 | 端点 | HTTP 状态 | 总耗时 ms | 响应字节 |
| --- | --- | ---: | ---: | ---: |
| 1 | `/api/sessions` | 200 | 1070.150 | 137886 |
| 1 | `/health` | 200 | 1.430 | 93 |
| 2 | `/api/sessions` | 200 | 1071.312 | 137886 |
| 2 | `/health` | 200 | 5.720 | 93 |
| 3 | `/api/sessions` | 200 | 1078.637 | 137886 |
| 3 | `/health` | 200 | 6.807 | 93 |
| 4 | `/api/sessions` | 200 | 1073.573 | 137886 |
| 4 | `/health` | 200 | 4.991 | 93 |
| 5 | `/api/sessions` | 200 | 1067.846 | 137886 |
| 5 | `/health` | 200 | 8.371 | 93 |

JSON 还保存每次请求时间、收到响应头的耗时和返回的会话数量。本组样本用于保留实际观测值；后续 p95 验收使用独立、固定负载的较大样本测试。

## SQL 对照与执行计划

使用运行镜像内的 HAPI 可执行文件，通过 `BUN_BE_BUN=1` 调用其内置 Bun/SQLite。相同会话 ID 集合、相同 `now` 参数、同一只读事务，每条查询分别执行原计划 3 次、指定现有定时消息索引 3 次，记录 prepare、执行和 finalize 的总耗时及 CPU 时间。查询准备在记录执行计划之后进行，数据处于既有缓存环境。

| 查询 | 原计划 wall 中位 ms | 原计划 CPU 中位 ms | 指定索引 wall 中位 ms | 指定索引 CPU 中位 ms | 返回行数 | 结果对比 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `scheduled_count` | 530.186 | 530.193 | 0.124 | 0.122 | 0 | 一致 |
| `scheduled_min` | 526.592 | 526.615 | 0.168 | 0.165 | 0 | 一致 |

```text
scheduled_count original:
SEARCH messages USING INDEX idx_messages_local_id (session_id=? AND local_id>?)
scheduled_count scheduled_index:
SEARCH messages USING INDEX idx_messages_scheduled_pending (scheduled_at>?)
USE TEMP B-TREE FOR GROUP BY
scheduled_min original:
SEARCH messages USING INDEX idx_messages_local_id (session_id=? AND local_id>?)
scheduled_min scheduled_index:
SEARCH messages USING INDEX idx_messages_scheduled_pending (scheduled_at>?)
USE TEMP B-TREE FOR GROUP BY
```

查询分别聚合 `COUNT(*)` 和 `MIN(scheduled_at)`，共同条件如下。会话 ID 参数由 `SELECT id FROM sessions WHERE namespace = ?` 获取，`now` 使用本次读事务内固定的毫秒值；具体参数数量、时间值、查询模板和全部原始样本存入 JSON。

```sql
WHERE session_id IN (<会话 ID 占位符>)
  AND invoked_at IS NULL
  AND local_id IS NOT NULL
  AND scheduled_at IS NOT NULL
  AND scheduled_at > ?
  AND delivery_state = 'queued'
GROUP BY session_id
```

对照方式在 `FROM messages` 后添加 `INDEXED BY idx_messages_scheduled_pending`，使用已有索引。整个试验保持线上表、索引、统计信息和业务数据原样。

## 采样期间的后台请求

最近请求摘要覆盖最多 180 秒、最多 5,000 行日志，包含本次探测。已完成请求时间范围为 `2026-10-22T10:23:44.917054211Z` 至 `2026-10-22T10:26:33.868805336Z`。

| 路由 | 完成次数 | 日志平均耗时 ms | 日志最大耗时 ms |
| --- | ---: | ---: | ---: |
| `GET /api/sessions` | 13 | 1000.000 | 1000 |
| `POST /api/visibility` | 6 | 2.833 | 8 |
| `GET /api/hub-settings` | 10 | 1.600 | 9 |
| `GET /api/sessions/:id/skills` | 1 | 15.000 | 15 |
| `GET /api/sessions/:id/slash-commands` | 1 | 9.000 | 9 |
| `GET /api/sessions/:id/messages` | 2 | 1.500 | 2 |
| `POST /api/auth` | 1 | 1.000 | 1 |
| `GET /health` | 11 | 0.000 | 0 |
| `GET /sw.js` | 2 | 0.000 | 0 |

应用日志把耗时格式化为整数毫秒或整数秒。此表用于描述请求量和排队现象，精细延迟比较使用上面的原始 HTTP 样本。

## 同日首次故障排查记录

这些数据保留自前期已执行的只读排查，各项独立采样；部分测量只有日期、运行实例与请求先后顺序。它们与本次补采共同描述优化前在不同运行时段的表现。

| 指标 | 已观察值与口径 |
| --- | --- |
| Docker CPU 与内存单次样本 | CPU 102.34%，内存 3.74 GiB / 62.66 GiB |
| 主线程 `ps %CPU` | 多次为 99.1% 至 99.8%，生命周期平均；后台线程多为 0% 至 0.7% |
| 宿主机 vmstat | CPU 空闲 84% 至 87%，I/O wait 为 0%；可用内存约 46 GiB |
| 数据库 | 177 个会话、510,326 条消息、主文件 1,052,782,592 字节、待发送定时消息为 0 |
| 两条原始 SQL | wall 552.272 / 551.595 ms，CPU 552.232 / 551.583 ms |
| 同 SQL 指定已有定时消息索引 | wall 均为 0.150 ms，结果均一致 |
| 最近 3 分钟应用日志样本 | 会话列表完成 125 次，格式化平均 1,192 ms，最大 2,000 ms |

前期记录涉及 09:07:26 UTC 启动的进程，以及 09:27:11 UTC 启动的进程；其 PID 与启动时间保存在 JSON。后续复测应同时记录重启和运行时长，内存随运行时间的变化使用同一实例的连续采样观察。 本次补采前的另一次 `ps` 快照中，同一主进程 PID 2986361 的 `%MEM` 为 20.3%；10:26 的精确 RSS 为 883.352 MiB。中间过程保留为独立观察，内存变化原因需后续连续采样确认。

前期已鉴权的本机请求按执行顺序如下：

| 端点 | 总耗时 ms | HTTP 状态 |
| --- | ---: | ---: |
| `/api/sessions?limit=1` | 873.120 | 200 |
| `/api/sessions` | 4,592.460 | 200 |
| `/api/sessions?limit=1` | 2,968.320 | 200 |
| `/health` | 596.630 | 200 |

另外三次独立 curl 探测中，未鉴权的 `/health` 与 `/api/sessions` 均在约 15 秒截止时超时；首页 `/` 返回 200，耗时 2,524.540 ms。请求条件和原始数字均保存在 JSON。

此前的主线程 perf 使用 49 Hz、`cpu-clock:u`、12 秒窗口，捕获 247 个样本、丢失 0 个样本。原始 perf 文件保留在数据盘受限目录，仓库保存大小、SHA256 与采样参数；函数级分析结论来自 SQL 对照与执行计划。

## 后续复测口径

1. 记录测试代码提交、实际运行镜像和二进制摘要、Bun/数据库版本、schema、容器启动时间、资源额度、数据规模和宿主机负载。
2. 在主动探测前采集同样的 5 秒 CPU/RSS 计数差值，再执行完整会话列表与健康检查的 5 轮交替请求，保存每次原始耗时与失败记录。
3. SQLite 优化复测沿用相同驱动、SQL、参数范围和事务；PostgreSQL 复测使用等价数据与业务条件，并记录 `EXPLAIN (ANALYZE, BUFFERS)`、数据库资源和 Hub 事件循环指标。
4. 对零待发送消息、少量待发送消息和较多待发送消息分别测量；给出样本数量、缓存与后台流量条件。p95 与并发吞吐采用额外的固定负载测试并保存原始结果。
5. 在相同数据快照上检查查询和 API 输出一致性，再比较延迟与 CPU；数据持续增长时同时报告数量差异。
6. 新结果使用新日期或明确阶段保存，并从改善方案链接。原始基线与后续实测值、验收目标分别保留。

数据库内容、请求与响应正文、凭据及完整日志保留在受限环境；仓库中的 JSON 只包含脱敏计数、配置摘要、执行计划和耗时。
