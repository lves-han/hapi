# PostgreSQL 本地验证记录（2026-10-22）

本记录验证[迁移计划](../guide/postgresql-migration-plan.md)第 2 至 4 阶段。实现包含 PostgreSQL 异步存储、启动自动迁移、离线回迁与 Compose 升级。操作步骤见[部署指南](../guide/postgresql-deployment.md)。

## 运行环境与测量方法

Bun 1.4.0，PostgreSQL 16.15，arm64，16 个逻辑 CPU。数据库与快照位于 `/data`，使用隔离测试数据库。生成 177 个会话、510,420 条历史消息，分别加入 0、1、1,000 条未来待发送消息；每种查询预热 3 次、采样 50 次，单并发，p95 使用 nearest-rank。原始结果、每次请求和 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 见[完整 JSON](./postgresql-validation-2026-10-22.json)。

通过实际 Hub 启动和鉴权后测量 `/api/sessions`，与 `/health` 交替请求，fetch 复用连接且读取完整响应。每次聚合和接口结果均与独立构造的预期值核对。进程内采样事件循环、CPU 与 RSS；宿主机其他服务保持运行，背景负载未控制。

| 未来待发送数量 | COUNT p95 ms | MIN p95 ms | /api/sessions p95 ms | /health p95 ms |
| --- | ---: | ---: | ---: | ---: |
| 0 | 0.624 | 0.604 | 4.498 | 0.492 |
| 1 | 0.800 | 0.683 | 5.416 | 0.625 |
| 1000 | 3.299 | 3.380 | 9.939 | 0.828 |

所有场景的两条查询均使用 `idx_messages_scheduled_pending`，索引实际扫描分别为 0、1、1,000 行；聚合分别返回 0、1、177 个会话。查询 p95 均满足计划中的 10 ms 目标，本机会话列表满足 200 ms 目标。

该生成数据集导入耗时 35.891 秒。事件循环延迟 p95 为 0.478 ms，最大 6.380 ms。空闲观察 5.000 秒，进程累计 CPU 82.692 ms，RSS 从 149,835,776 降为 142,868,480 字节。JSON 同时记录数据库事务、缓存命中、读取和插入计数；这些统计包含导入/预热/验证阶段。补充复测在完整生成、导入、空闲与接口查询期间采集 64 个 Docker stats 样本，PostgreSQL 容器 CPU 范围 0.00%–201.94%（100% 为一个逻辑 CPU）；块 I/O 累计值由 `40.8MB / 2.8GB` 变为 `57.1MB / 3.27GB`。容器累计值包含此前测试，增量与原始采样一并记录在 JSON 的 `postgresContainerRepeat`。该轮宿主机存在明显 I/O 争用（期间 I/O pressure full avg10 为 76.47%），导入耗时 73.968 秒；该轮延迟单独保留，生产固定负载对照仍待执行。

生成样本用于验证计划选择、结果与局部延迟。生产约 1.05 GB 原库、真实 agent 消息体和并发负载仍需按[原始基线](./hub-sqlite-baseline-2026-10-22.md)复测。SQLite 修复的原始对照见[SQLite 记录](./hub-sqlite-scheduled-2026-10-22.md)；异步改造后也重新运行其性能脚本并核对了全部返回值。

## 自动迁移与故障覆盖

`hub/src/store/postgres.integration.test.ts` 的 47 项测试全部通过，覆盖：

- legacy/schema 0–26 的升级路径；生成旧结构后走原有历史升级链，断言源文件未改动。
- 实际 v0.29.0/schema 25、v0.30.7/schema 26 发布产物生成的数据库结构。DDL fixture 保存发布版本、二进制 SHA-256 与采集时间，内容为生成数据。
- 12 表数量和摘要、明文及 zstd、大历史消息、Unicode、未知 metadata、外键、整数精度和 identity 恢复。
- 两种后端上的并发 seq、幂等、版本冲突、事务回滚、定时/排队状态、scratchlist、usage、work graph 和推送注册行为。
- 快照、规范化、建表、数据导入、索引、校验、提交前后及就绪前故障；重启后回滚或识别已完成事务。
- WAL 中已提交数据、迁移期间旧写入、切换后源变化、目标冲突、错误 URL、缺权限、缺失附件、超前版本及损坏正文。
- PostgreSQL 新写入在重启后保留，反向导出后 SQLite 历史与新增内容一致。

## 真实容器与历史客户端演练

使用独立目录、数据库、Docker Compose 项目和本地端口完成演练。[脱敏结果](./postgresql-deployment-validation-2026-10-22.json)记录以下断言：

1. 实际 v0.29.0 创建 schema-25 源库，包含生成的历史会话及消息；保留该 Hub 签发的 JWT。
2. 停旧 Hub，Compose 使用普通 `hapi` 应用账号自动迁移；PostgreSQL 与 Hub 通过健康检查。原 JWT 继续读取旧历史。
3. 实际 v0.29.0、v0.30.7 Runner 分别注册并保持有效心跳。
4. 重启新版 Hub 后历史保留。客户端在 Socket.IO 连接完成立即发送首个心跳，再通过 REST 创建未来定时消息并读回。
5. 停写后用镜像内打包工具导出 schema-26 SQLite，实际 v0.30.7 Hub 启动导出库，原 JWT 能读到旧历史与切换后的新消息。
6. 原 schema-25 SQLite 仍可由实际 v0.29.0 启动，原 JWT 可读到切换前历史。

演练发现并修复了初始化脚本执行权限与应用账号健康检查问题。异步调用复查增加了缓存旧快照覆盖、删除后 ID 重建、首批 Socket.IO 事件等待初始化及包处理顺序回归；持久化失败通过关闭 transport 触发已有客户端的自动重连。Socket.IO 的重连语义依据[官方说明](https://socket.io/docs/v4/client-socket-instance/#disconnect)。

## 仓库检查

- `bun typecheck`：CLI、Web、Hub、Relay 全部通过；Hub 最后局部修改后再次通过类型检查。
- `bun run test`：CLI 2,987、Hub 1,399、Web 3,368、Shared 327、Relay 118 项通过。CLI 11 项及 Hub 3 项既有环境依赖用例跳过；该次运行的 47 项 PostgreSQL 用例另以专用连接执行，全部通过。
- 两个性能脚本及离线导出脚本通过额外 TypeScript 检查，SQLite/PG 性能脚本均实际运行。
- Web/Hub、VitePress 文档构建和 Docker 镜像构建通过；隔离 Compose 部署、重启、原 JWT、旧 Runner 与两条回退路径实测通过。

历史 Web/iOS/Android 客户端真机与真实 agent 端到端流程、生产数据库及流量验收仍待执行。当前结果不涉及生产切换或发布。

## 复现

使用 Bun 1.4.0 和独立 PostgreSQL 16 测试实例：

```sh
bun typecheck
bun run test
HAPI_TEST_DATABASE_URL=postgresql://测试账号:口令@localhost/测试入口库 \
  bun test hub/src/store/postgres.integration.test.ts
HAPI_TEST_DATABASE_URL=postgresql://测试账号:口令@localhost/测试入口库 \
  bun run hub/scripts/benchmark-postgres.ts > postgresql-measurements.json
bun run hub/scripts/benchmark-scheduled-queries.ts > sqlite-measurements.json
```

测试数据库采用随机名称并在结束后删除，测试账号所需权限见[部署指南](../guide/postgresql-deployment.md#开发与验证)。迁移快照、完整日志和含配置的演练目录保留在受限环境，仓库仅保存生成数据的统计与脱敏断言。
