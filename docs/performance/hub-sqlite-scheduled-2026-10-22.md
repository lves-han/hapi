# SQLite 定时消息查询优化：第 1 阶段本地验证

2026 年 10 月 22 日，按 [迁移方案](../guide/postgresql-migration-plan.md)第 1 阶段修复两条会话列表聚合查询。线上实测的原始情况保存在 [性能基线](hub-sqlite-baseline-2026-10-22.md)。本次使用独立生成数据测量 SQL，线上部署、真实数据副本及 HTTP 负载复测待执行。

## 改动与原因

`countFutureScheduledBySessionIds` 和 `minFutureScheduledAtBySessionIds` 在 `FROM messages` 后指定已有的 `INDEXED BY idx_messages_scheduled_pending`。SQLite 默认选择 `idx_messages_local_id` 时会遍历所选会话的历史消息；定时消息部分索引直接按 `scheduled_at > ?` 查找待发送候选记录。

会话范围、`local_id IS NOT NULL`、`invoked_at IS NULL`、`delivery_state = 'queued'` 和未来时间条件保持原样。复用既有索引，schema 版本保持 26。

## 测量条件

- Bun 1.4.0、SQLite 3.53.2、Linux arm64，16 个逻辑 CPU、约 62.66 GiB 内存。
- 全新内存数据库，使用当前 Store 初始化完整 schema；未执行 `ANALYZE`。
- 177 个会话、510,420 条生成历史消息。历史消息均有 `local_id`，`invoked_at = 0`、`scheduled_at = NULL`，均匀分布于各会话。
- 分别添加 0、1、1,000 条未来待发送消息，均匀分布于各会话；每个场景总消息数为历史数量加待发送数量。
- 单并发，每条查询预热 3 次，再采样 20 次。p50/p95 使用排序后的第 10/19 个值；原始 wall 与进程 CPU 时间随样本保存。
- 每组对照在同一读事务内先运行原 SQL，再调用修改后的实际 Store 方法。每次结果均与按生成规则独立计算的预期 Map 比较，全部一致。
- 测试数据库无后台流量，宿主机其他服务继续运行；缓存和生成数据条件与线上基线分别记录。

## 结果

| 未来待发送消息 | 查询 | 原 SQL p50 ms | 原 SQL p95 ms | 优化后 p50 ms | 优化后 p95 ms |
| ---: | --- | ---: | ---: | ---: | ---: |
| 0 | 数量 | 384.449 | 409.567 | 0.046 | 0.061 |
| 0 | 最早时间 | 411.820 | 457.659 | 0.046 | 0.071 |
| 1 | 数量 | 380.924 | 420.332 | 0.093 | 0.131 |
| 1 | 最早时间 | 374.815 | 403.394 | 0.093 | 0.113 |
| 1,000 | 数量 | 388.687 | 424.249 | 0.747 | 0.775 |
| 1,000 | 最早时间 | 372.886 | 384.873 | 0.816 | 0.851 |

两条查询在三个场景中的计划均由：

```text
SEARCH messages USING INDEX idx_messages_local_id (session_id=? AND local_id>?)
```

变为：

```text
SEARCH messages USING INDEX idx_messages_scheduled_pending (scheduled_at>?)
USE TEMP B-TREE FOR GROUP BY
```

原始样本与完整计划见 [JSON](hub-sqlite-scheduled-2026-10-22.json)。本地 SQL 数据达到方案中的单查询 p95 ≤ 10 ms 目标；会话列表 p95 ≤ 200 ms、Hub CPU 和事件循环延迟仍需部署后的固定负载测试确认。

## 复现与回归

从仓库根目录运行：

```sh
bun install --frozen-lockfile
bun run hub/scripts/benchmark-scheduled-queries.ts > /tmp/hapi-scheduled-queries.json
bun run test:hub
bun run typecheck:hub
```

[脚本](../../hub/scripts/benchmark-scheduled-queries.ts)仅在内存中创建生成数据，输出测量 JSON。SQL 对照使用原查询作为参考，优化后耗时包含 Store 方法创建 Map 的开销。JSON 中的优化计划由等价 SQL 输出，回归测试另行捕获实际 Store 查询，检查其执行计划使用定时消息索引。

已执行验证：

- 新增索引计划回归在修复前失败、修复后通过。
- 空会话集合、重复及缺失 ID、命名空间范围、到期边界、已消费消息、缺少 local ID，以及 queued/dispatching/indeterminate 状态筛选通过。
- legacy schema 0（V8 结构）及 schema 8 的现有升级链运行后，两条聚合查询通过。
- Hub 全量测试：1,393 通过、3 跳过、0 失败；跳过项为需外部 Cursor ACP 环境的集成测试。
- Hub TypeScript 检查通过；`git diff --check` 通过。

运行环境使用现有 HAPI 可执行文件内置的 Bun（`BUN_BE_BUN=1`）执行安装、测试与测量，TypeScript 检查使用已安装的同一工作区编译器。
