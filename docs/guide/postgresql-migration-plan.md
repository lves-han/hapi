# PostgreSQL 与历史 SQLite 自动迁移改善方案

状态：第 1 至 4 阶段实现已完成。SQLite/PostgreSQL 回归、legacy/schema 1 至 26 自动迁移、实际 v0.29.0/v0.30.7 结构、故障重试、旧 JWT/Runner、隔离容器升级与写入后回迁已完成本地验证。详见[部署与回退步骤](./postgresql-deployment.md)、[PostgreSQL 验证记录](../performance/postgresql-validation-2026-10-22.md)和 [SQLite 测量记录](../performance/hub-sqlite-scheduled-2026-10-22.md)。2026-10-23 已完成生产迁移与固定口径负载采样，见[生产性能对照](../performance/hub-postgresql-comparison-2026-10-23.md)；历史原生客户端真机验收仍待执行。

基线：上游 `main` 提交 `5d8deb201189dc1f183c4f5bf38c87ec4d34dd70`，SQLite schema 26。现有部署的兼容起点为 HAPI v0.30.7；历史版本覆盖以数据库 schema 和发布版本测试矩阵共同确认。

## 目标与已有证据

本 fork 增加 PostgreSQL 存储后端，保留 SQLite 部署方式，并让使用历史 HAPI 的用户在部署新版时自动完成 SQLite 到 PostgreSQL 的迁移。会话、历史消息、定时消息、权限状态和既有客户端连接约定应完整保留。

2026 年 10 月 22 日的只读诊断定位到 `/api/sessions` 的两条同步聚合查询：`countFutureScheduledBySessionIds` 和 `minFutureScheduledAtBySessionIds`。样本共有 177 个会话、510,326 条消息，SQLite 文件约 1.05 GB。HAPI 自带 Bun 1.4.0 和 SQLite 3.53.2 的复现结果如下。

| 查询 | 原计划使用 `idx_messages_local_id` | 使用 `idx_messages_scheduled_pending` |
| --- | ---: | ---: |
| 定时消息数量 | 552.272 ms | 0.150 ms |
| 最早发送时间 | 551.595 ms | 0.150 ms |

两种计划返回相同结果；此样本中待发送定时消息数量为零。以上为单条 SQL 的对照耗时，端到端收益应通过接口负载测试单独确认。 完整运行现状、原始耗时与复测口径见 [2026 年 10 月 22 日性能基线](../performance/hub-sqlite-baseline-2026-10-22.md)。

## 后端与兼容约定

- 保留 `HAPI_HOME`、`DB_PATH`、`CLI_API_TOKEN` 和现有启动命令。未配置 `DATABASE_URL` 时继续使用 SQLite；配置 PostgreSQL 连接后使用 PostgreSQL，连接或迁移失败时明确报错并保持服务未就绪。
- PostgreSQL 客户端优先复用 Bun 的原生 SQL 能力，使用异步查询和有界连接池。存储模块及上层调用链显式处理异步结果。
- 保留 REST、SSE、Socket.IO 的字段、命名空间、消息分页游标、版本冲突规则和鉴权语义。复用原有 token、JWT 与推送密钥、机器 ID、会话 ID、消息 ID 和附件路径。
- 发布时列出经过兼容测试的旧 CLI、Runner、Web 与原生客户端版本。首批覆盖既有 v0.30.7 部署及发布说明中列出的历史版本，并记录每个客户端所需能力。
- 数据库事务提交成功后再更新缓存和发送事件；数据库失败应传递到请求或后台任务的错误处理。通过事务内原子操作保证消息 `seq`、幂等键、版本检查和并发写入顺序。

### 历史 SQLite 支持目标

| 输入数据库 | 处理方式与发布门槛 |
| --- | --- |
| 空数据目录 | 在选定后端初始化新库；显式指定而缺失的 `DB_PATH` 应报错 |
| `user_version = 0` 的历史库 | 检查表、列和历史结构，在工作副本上执行现有 legacy 升级链 |
| schema 1 至 25 | 在工作副本上逐版本升级到基线 schema 26，再导入 PostgreSQL |
| schema 26 | 校验结构后直接导入 PostgreSQL |
| 高于基线或结构存在歧义的库 | 保留原始数据，报告检测到的版本、冲突字段和所需兼容版本 |

复用 [Store 的历史迁移链](../../hub/src/store/index.ts)，保留包括 `daemon_state` 到 `runner_state` 在内的历史字段转换。首版发布需要覆盖上表中的 legacy 分支及每个目标 schema；后续上游 schema 变化时同步更新基线与矩阵。

版本号映射以实际发布产物和数据库结构为准。v0.29.0、v0.30.7 及本 fork 基线版本应有对应的脱敏迁移样本或可复现 fixture，验收结果随发行版本提供。

## 首次部署自动迁移

用户提供原有 `HAPI_HOME` 数据目录和 PostgreSQL 连接，沿用自定义 `DB_PATH` 时一并保留该配置。完整旧目录包含数据库、配置、密钥和附件，部署流程保持原有目录布局。

配置示意：

```sh
HAPI_HOME=/var/lib/hapi
DB_PATH=/var/lib/hapi/hapi.db
DATABASE_URL=postgresql://hapi:<secret>@postgres:5432/hapi
```

自动迁移在 Hub 开放业务 HTTP 路由、Socket.IO、SSE、定时发送任务和写入服务之前执行。当前实现在迁移期间保持 HTTP 端口关闭，容器健康检查返回未就绪；成功后开放 `/health`。标准部署流程负责依次停止旧 Hub 的数据库写入、等待 PostgreSQL 就绪、运行新版启动迁移并开放服务；Runner 和客户端在切换期间等待重连。

### 启动与导入顺序

1. **检查入口。** 读取后端配置、源库路径和版本；检查源目录、备份空间及目标库权限。部署脚本确认旧 Hub 已退出，固定迁移期间的源数据。迁移持有独占部署锁和 PostgreSQL advisory lock，覆盖整个导入与切换阶段。
2. **判断是否需要导入。** PostgreSQL 专用库为空且存在历史 SQLite 时自动迁移；已有完成记录时使用该 PostgreSQL 库并跳过旧库导入；存在业务数据却缺少匹配迁移记录时停止并报告冲突。
3. **生成一致性备份。** 使用 SQLite `VACUUM INTO` 生成包含已提交 WAL 数据的一致性逻辑快照，再生成独立工作副本。Bun 1.4.0 的 SQLite 接口缺少文件 backup API，复用现有 compact 工具采用的 SQLite 原生快照方式；快照允许物理页和隐式 rowid 重排，消息与事件的相对插入顺序及业务值通过导入摘要校验。后续历史 schema 升级只作用于工作副本，原库保留为切换前恢复点。备份与迁移报告放在 `HAPI_HOME/migrations/` 的受限目录。
4. **规范化历史结构。** 在工作副本运行对应历史升级链，校验表、列、外键和编码。识别缺失必需表、冲突字段、损坏内容与越界整数，并明确失败位置。
5. **事务化导入。** 在专用 PostgreSQL 数据库的一个事务中建立应用表、按依赖顺序流式导入、恢复 identity/sequence、创建索引并校验数据。按批次读取以控制内存；约束和编码错误应使整个导入事务回滚。
6. **提交并记录。** 在同一事务最后写入迁移完成记录，包含源快照指纹、源 schema、导入器版本、目标 schema、各表数量与校验摘要，然后提交。事务失败后的下次启动从原始快照重新执行。
7. **验证后开放服务。** 运行统计信息更新与必要查询检查，成功后加载缓存、启用后台任务并进入就绪状态。迁移或检查期间端口关闭，容器 readiness 为未就绪，避免客户端读到部分导入的数据。

迁移完成记录与业务数据原子提交。进程在提交之后、对外开放之前退出时，重启应识别已完成导入并继续检查。迁移完成记录与 PostgreSQL schema 版本共用一个元数据表，记录源快照、版本、校验摘要与完成时间。该表独立于 12 张业务表，负责数据库升级与重复部署时的导入判断。

源快照指纹及明细摘要保存在受限迁移报告中，日志仅输出进度、数量和脱敏错误。重复部署优先使用 PostgreSQL 中已提交的数据；发现旧 SQLite 在切换后继续变化时报告源端仍有写入，保留双方数据以供核对。

## 数据与文件迁移规则

基线包含 12 张业务表：`sessions`、`machines`、`messages`、`message_epochs`、`users`、`push_subscriptions`、`fcm_devices`、`session_scratchlist`、`usage_events`、`usage_scan_state`、`events`、`event_links`。

| 数据 | 保留规则 |
| --- | --- |
| ID、命名空间、外键 | 原值导入，校验关联关系及唯一约束 |
| 时间戳、`seq`、计数和版本字段 | 按值域映射到 PostgreSQL 整数类型；毫秒时间戳采用 `bigint`，驱动返回值保持现有 API 类型与精度 |
| 布尔值、NULL、自增 ID | 显式转换并区分空值、零和假；导入后使 identity/sequence 与已导入 ID 一致 |
| 消息正文 | 保留现有明文 JSON 与 zstd 压缩内容的编码信息和原始字节，逐条验证解码结果 |
| metadata、agent state、todos、team state | 保留历史字段与未知字段，维持原有版本检查语义 |
| 定时与排队消息 | 保留 `scheduled_at`、`invoked_at`、`local_id`、`delivery_state`，验证到期时间、消费确认和幂等行为 |
| 配置、密钥和附件 | 沿用原 `HAPI_HOME` 文件布局与权限，校验配置引用和附件存在性 |

[现有内容编码](../../hub/src/store/contentCodec.ts)使用 SQLite 的 TEXT/BLOB 类型区分明文 JSON 与 zstd 数据。PostgreSQL 方案统一使用 `bytea` 保存原始字节，并增加明确的编码字段区分 UTF-8 JSON 与 zstd；数据库适配层恢复旧解码入口所需的字符串或二进制值。迁移过程按原样保留内容，已有 ingest 截断规则仅作用于后续新消息。

校验以规范化工作副本为基准：检查各表记录数、按主键确定顺序的内容摘要、逐会话消息数量及序号、外键关系和待发送状态。原始快照与工作副本的变化单独记录，便于解释历史 schema 升级造成的预期字段变化。

## 定时消息索引与性能方案

SQLite 阶段先在副本上核对统计信息和执行计划，修复两条聚合查询对已有定时消息索引的使用，并覆盖空集合、存在定时消息和历史消息很多的场景。

已落地的 SQLite 修复在 `countFutureScheduledBySessionIds` 与 `minFutureScheduledAtBySessionIds` 中使用 `INDEXED BY idx_messages_scheduled_pending`，保留全部筛选条件。复用 schema 9 起已有的索引，schema 版本保持 26。生成数据对照覆盖 177 个会话、510,420 条历史消息及 0、1、1,000 条未来待发送消息，结果一致，两条查询本地 p95 均小于 1 ms；真实数据副本和线上接口的复测按基线口径继续验收。

PostgreSQL 保留同名部分索引，初始定义与现有筛选语义一致：

```sql
CREATE INDEX idx_messages_scheduled_pending
ON messages (scheduled_at)
WHERE scheduled_at IS NOT NULL
  AND invoked_at IS NULL;
```

两条聚合查询保留完整的会话范围、排队状态、未消费标记和未来时间条件。导入后更新统计信息，通过 `EXPLAIN (ANALYZE, BUFFERS)` 验证部分索引是否有效减少历史数据访问。SQLite 试验中的 `INDEXED BY` 留在 SQLite 专属查询中。

性能验收目标使用固定硬件、相同数据与请求负载，分别记录待发送定时消息为 0、1 和 1,000 条时的行为。在约 51 万条历史消息的基准下，初始目标为两条聚合查询各 p95 ≤ 10 ms、本机会话列表 p95 ≤ 200 ms；同时记录 Hub 主线程 CPU、事件循环延迟和 PostgreSQL CPU/I/O。这些值作为实现验收目标，结果随测试环境一起报告。

## 故障恢复与回退

- 导入事务失败时回滚目标导入，保留原始 SQLite、备份与错误报告；服务维持未就绪。修复失败原因后允许相同部署命令重新执行。
- 首次开放 PostgreSQL 业务写入之前，可以恢复原镜像并使用保留的 SQLite 源库回退。
- PostgreSQL 已产生新业务写入后，先停写、备份并校验 PostgreSQL 中的最新数据；回到 SQLite 需要完整回迁和核对新增内容，再恢复旧服务。切换前 SQLite 快照的恢复点应在操作界面与报告中明确显示。
- PostgreSQL 服务使用独立应用凭据和数据卷，数据库文件、备份及构建产物按部署环境要求持久化；本机开发与部署的数据文件放在 `/data` 卷。

## 实施顺序与交付物

| 阶段 | 最小交付物 | 验收条件 |
| --- | --- | --- |
| 1 修复现有热点 | SQLite 查询优化与行为回归测试 | 结果一致，原慢查询复现与新计划对比通过 |
| 2 PostgreSQL 后端 | 后端选择、异步存储、表结构和事务改造 | 两种后端通过相同存储行为测试，协议与幂等语义保持兼容 |
| 3 自动迁移 | 启动迁移、历史升级复用、完整性校验及故障重试 | legacy、schema 1 至 26、发布版本矩阵及重复启动测试通过 |
| 4 部署交付 | Docker Compose、升级入口、健康检查与备份回退文档 | 用同一份旧数据目录完成部署演练，达到性能与兼容性目标 |

发布版本应提供明确的历史版本支持清单、源与目标 schema、校验报告格式和部署步骤。备份与 schema 升级工具优先复用已有能力，迁移保持单次事务与失败后重跑的直接实现。

## 发布验收清单

- [x] legacy `user_version = 0` 和 schema 1 至 26 的各条升级路径通过；v0.29.0、v0.30.7 与基线版本样本通过。
- [x] 明文、压缩正文、Unicode、空值、未知 metadata 字段和历史大消息迁移后内容一致；迁移错误明确到表与记录定位信息。
- [x] 12 张业务表的数量、摘要、外键、序号和版本字段匹配规范化工作副本；附件文件及大小、保留目录的 JWT/配置复用已验证。
- [x] 在复制、建索引、校验、提交前后和服务就绪前注入故障，重启后保持数据完整与导入幂等。
- [x] PostgreSQL 为空、已有成功迁移、已有冲突业务数据、连接失败及凭据无权限的行为均已验证。
- [x] 已迁移目标收到新消息后再次部署，历史消息数量和内容保持一致，新消息仍保留。
- [ ] 历史 Web/原生客户端真机及真实 agent 完整流程验收。存储/Hub 回归已覆盖定时投递、消费确认、权限、分页与幂等；实际 v0.29.0/v0.30.7 Runner 已验证注册和心跳。
- [x] 迁移期间客户端得到未就绪结果；恢复服务后使用原 token、机器与会话标识正常访问。
- [x] PostgreSQL 与 SQLite 路径均通过相关回归；修改上层协议或共享行为时执行仓库要求的跨包检查。
- [x] 索引计划、p95 延迟达到已记录生成数据环境下的目标，Hub CPU、内存、事件循环及 PostgreSQL 统计已记录。
- [x] 开放写入前的回退、开放写入后的数据保护与回迁演练完成。

CI 使用生成或脱敏数据，真实部署数据库、消息正文、token、连接串、备份和性能采样中的内存内容保留在受限环境。

## 实现参考

- [数据库与历史 schema 升级](../../hub/src/store/index.ts)
- [消息查询](../../hub/src/store/messages.ts)与[消息内容编码](../../hub/src/store/contentCodec.ts)
- [会话列表接口](../../hub/src/web/routes/sessions.ts)与[Hub 启动入口](../../hub/src/startHub.ts)
- [现有配置](../../hub/src/configuration.ts)与[客户端协议](../api/client-contract/index.md)
- [Bun SQL](https://bun.sh/docs/runtime/sql)
- [PostgreSQL 部分索引](https://www.postgresql.org/docs/current/indexes-partial.html)
- [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause)
