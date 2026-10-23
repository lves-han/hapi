# PostgreSQL 部署、自动迁移与回退

本 fork 支持 SQLite 和 PostgreSQL。`DATABASE_URL` 仅从环境读取；配置后 Hub 在启动时完成迁移与验证，再开放 HTTP、Socket.IO、SSE 和后台任务。省略该变量时沿用 SQLite。

已验证 legacy/schema 1 至 26、实际 v0.29.0（schema 25）和 v0.30.7（schema 26）数据库结构。[验证记录](../performance/postgresql-validation-2026-10-22.md)列出客户端覆盖范围与性能样本。

## 准备原目录与连接

保留原有绝对路径 `HAPI_HOME`，其中的 `settings.json`、JWT/推送密钥、数据库与附件保持原布局。原 token、机器 ID 和会话 ID 会继续使用。沿用自定义 `DB_PATH`；显式设置的路径缺失时启动报错。全新安装应省略 `DB_PATH`，由选定后端初始化。

为 PostgreSQL 使用独立数据库及应用账号：账号需要连接数据库、使用及创建 public schema 对象、管理自身表/索引/identity。随附 Compose 使用独立管理员口令初始化普通 `hapi` 账号，并将数据库所有权授予该账号。应用连接使用 `hapi`。PG 数据目录与 HAPI 数据目录分别持久化。

迁移预检要求快照目录的可用空间至少为 SQLite 主库逻辑页大小的三倍；还需为 PostgreSQL 表、索引和 WAL 留足空间。旧 Hub 在整个迁移期间保持停写，同一数据目录和目标库只运行一个业务 Hub。

## Docker Compose 升级

从仓库根目录执行：

```sh
cp deployment/example.env deployment/.env
chmod 600 deployment/.env
```

编辑 `deployment/.env`：

- `HAPI_HOME` 填原有数据目录的绝对路径，Compose 将其挂载到容器内相同路径。
- `HAPI_UID`、`HAPI_GID` 填该目录现有所有者的 UID/GID（可用 `stat -c '%u:%g' /原目录` 查询）。
- 两个口令分别用 `openssl rand -hex 32` 生成；`DATABASE_URL` 中的口令与 `HAPI_DATABASE_PASSWORD` 保持一致。hex 可直接放入 URL。
- `HAPI_POSTGRES_DATA_DIR` 填独立数据目录；`HAPI_PUBLIC_URL` 沿用原地址及反向代理设置。
- 默认仅在 `127.0.0.1:3006` 发布 Hub；按原有部署调整绑定地址和端口。PostgreSQL 仅连接容器内部网络。

PostgreSQL 初始化脚本仅在空数据目录执行。已有卷需要使用现有有效凭据；修改 env 文件中的口令后，应同步修改数据库账号口令。

若旧 Hub 是容器：

```sh
HAPI_OLD_HUB_CONTAINER=原Hub容器名 sh deployment/upgrade.sh
```

脚本先验证 Compose 配置、构建镜像并等待 PostgreSQL 认证查询成功，再停止指定旧 Hub，启动新版并等待健康。脚本清除当前 HAPI 会话继承的数据库/目录变量，统一采用 `deployment/.env`。构建和健康检查日志可用于排查失败；失败后的重新执行会识别已提交迁移。

自定义 `DB_PATH` 在 `HAPI_HOME` 外时，为 `deployment/compose.yml` 增加同路径目录挂载，覆盖数据库及其 `-wal`、`-shm` 文件，再按下面的手动顺序执行。保留原部署使用的其他环境变量、挂载和代理配置。

旧 Hub 由 systemd 等管理时，在配置校验、镜像构建与 PostgreSQL 就绪后停止旧服务，再启动 Hub：

```sh
docker compose --env-file deployment/.env -f deployment/compose.yml config --quiet
docker compose --env-file deployment/.env -f deployment/compose.yml build hub
docker compose --env-file deployment/.env -f deployment/compose.yml up -d --wait postgres
# 在此停止旧 Hub 服务，确认其数据库写入进程已退出。
docker compose --env-file deployment/.env -f deployment/compose.yml up -d --no-build --wait --wait-timeout 900 hub
```

手动命令执行前，清除 shell 中覆盖 `.env` 的同名变量。增加挂载的 override 文件应通过每条命令的 `-f` 一并传入。

全新部署可直接执行 Compose 构建及启动命令，省略旧服务停止步骤。

## Runner 升级与上线验证

主机 Runner 使用与 Hub 同一源码修订构建的 CLI，按 [CLI 构建步骤](https://github.com/lves-han/hapi/blob/main/cli/README.md#build-from-source)更新，并保留旧二进制。构建可能沿用相同的版本号，部署时记录源码修订及产物摘要。

新建会话通过 `reservedSessionId` 采用 Hub 预分配的记录。旧 Runner 将该 ID 传成 `--existing-session-id` 时，Codex 会进入恢复路径并报 `Existing HAPI session has no Codex thread binding`。更新 Runner 后重启服务；systemd 的 `KillMode=process` 可保留已运行的会话子进程，重启前后核对这些进程及机器 ID。

上线验证覆盖登录、历史消息、排队消息取消及一次真实的新建 Codex 会话。确认新会话为 active，且 `metadata.codexSessionId` 已生成，再归档并删除验证用会话。

## 启动行为与迁移报告

| 情况 | 结果 |
| --- | --- |
| 空目标、存在旧 SQLite | 快照 → 工作副本历史升级 → 事务导入 12 表 → 摘要/外键/编码校验 → 提交 → ANALYZE → 开放服务 |
| 空目标、默认 SQLite 路径缺失 | 初始化全新 PostgreSQL 库 |
| 目标已有完成记录 | 校验版本、必要表及仍保留的源库指纹，继续使用已提交的 PostgreSQL 数据 |
| 目标有表且缺少完成记录 | 停止启动，报告目标冲突 |
| 连接失败、权限不足、坏 JSON/压缩内容、附件缺失、超前 schema | 停止启动并保留诊断报告 |
| 旧 SQLite 在迁移期间或切换后继续写入 | 停止迁移或后续启动，保留双方数据供核对 |

一致性快照使用 SQLite `VACUUM INTO`，包含已提交 WAL 数据；历史升级只作用于独立工作副本。原 SQLite 保留为切换前恢复点。迁移完成元数据和业务数据同一事务提交；失败重启会重新导入，已提交目标继续保留新写入。

`HAPI_HOME/migrations/` 权限为 0700，快照、工作副本和 JSON 报告为 0600。报告包含 `importerVersion`、源/目标 schema、阶段、源逻辑指纹、源表数量、工作副本路径与各表 `count/sha256`；失败包含阶段、错误及适用的表/记录定位。诊断报告可能包含记录 ID，应按备份权限管理。

迁移期间 HTTP 端口保持关闭，健康检查未就绪；完成后 `/health` 返回成功。Compose 健康检查给予迁移 10 分钟启动宽限，升级入口等待 15 分钟；按实际库大小调整等待时间。超过等待时先检查容器日志与迁移报告。

部署锁覆盖同目录启动及目标库迁移，进程退出会释放。修复失败原因后可重跑同一升级命令。目标已有冲突数据、源库切换后变化时，先核对报告和双方最新数据，确定应保留的数据后再处理冲突。

## 回退

### PostgreSQL 开放业务写入前

停止新版 Hub，用原镜像、原 `HAPI_HOME`、原 SQLite 路径恢复旧服务，并移除 `DATABASE_URL`。v0.29.0 原库保留 schema 25，可直接由该版本启动。

### PostgreSQL 已产生业务写入后

先停止所有 Hub 写入进程并备份 PostgreSQL。将最新数据反向导出到一个全新的文件：

```sh
docker compose --env-file deployment/.env -f deployment/compose.yml stop hub
docker compose --env-file deployment/.env -f deployment/compose.yml run --rm --no-deps hub \
  bun run hub/dist/export-postgres-to-sqlite.js /原HAPI_HOME/rollback.sqlite
```

将示例输出路径替换为挂载目录内真实路径。导出通过 PostgreSQL 一致性只读事务和写入互斥锁读取全部 12 表，校验摘要、外键、内容和整数范围，恢复消息/事件顺序。输出文件已存在时明确失败，成功附带 `rollback.sqlite.report.json`。

导出结果为 schema 26。使用本 fork SQLite 模式或经过验证的 v0.30.7 启动，设置 `DB_PATH=/原HAPI_HOME/rollback.sqlite` 并移除 `DATABASE_URL`。继续沿用原配置、密钥和附件。先核对历史、新增消息、定时消息和权限状态，再恢复业务流量。使用新路径可同时保留切换前源库和对应 WAL/SHM。

本地源码也可执行：

```sh
DATABASE_URL=postgresql://hapi:...@localhost/hapi \
  bun run hub/scripts/export-postgres-to-sqlite.ts /备份目录/rollback.sqlite
```

导出时保留 PostgreSQL 数据卷与备份，待业务核对完成后按现有保留策略处理。

## 开发与验证

```sh
bun typecheck
bun run test
HAPI_TEST_DATABASE_URL=postgresql://测试账号:口令@localhost/测试入口库 \
  bun test hub/src/store/postgres.integration.test.ts
HAPI_TEST_DATABASE_URL=postgresql://测试账号:口令@localhost/测试入口库 \
  bun run hub/scripts/benchmark-postgres.ts
```

集成测试和性能脚本为每次运行创建独立随机数据库并清理；使用专用测试实例。测试账号需要 `CREATEDB`，权限拒绝测试还需要 `CREATEROLE`。CI 在 PostgreSQL 16 服务上执行该矩阵。原有 `compact-db.ts`、`cleanup-sessions.ts` 维护脚本直接操作 SQLite 文件；对 PostgreSQL 的离线整理可先导出并核对最新 SQLite 副本。
