# @sandersyao/dsh-session-persistence-mysql

[English](README.md) | 中文

DeepSeek Harness 的 **MySQL 会话持久化后端**——`dsh-session-persistence` 能力接缝的一个具体 Provider。以插件加载后注册 `ctx.sessionPersistence`，把 event-sourced 的 `SessionEvent` 日志持久化到 MySQL，与 JSONL 后端行为契约等价，并支持**读写分离**。

## 安装与使用

```ts
import { MysqlSessionPersistence } from '@sandersyao/dsh-session-persistence-mysql'

await ctx.plugin(MysqlSessionPersistence, {
  connection: { tablePrefix: process.env.MYSQL_TABLE_PREFIX },
})
// ctx.sessionPersistence 现在由 MySQL 支撑。
```

## 配置

凭据、表前缀与连接池参数来自环境变量 / `.env`（见 `.env.example`）。插件 `Config` 全部可选——**凭据只来自环境变量**（绝不硬编码密码）。

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | 写库（主库）地址。 |
| `MYSQL_USER` / `MYSQL_PASSWORD` | —（必需） | 最小权限 DB 用户。 |
| `MYSQL_DATABASE` | —（必需） | 目标数据库。 |
| `MYSQL_TABLE_PREFIX` | —（必需） | 表前缀，校验 `^[A-Za-z0-9_]+$`。 |
| `MYSQL_READ_HOST` / `MYSQL_READ_USER` / `MYSQL_READ_PASSWORD` | （空） | 读写分离读库；留空复用写库连接（同库模式）。 |
| `MYSQL_SSL_REQUIRED` | `false` | 预留 TLS 强制位（暂缓，届时可能由云服务商提供）。 |
| `MYSQL_POOL_SIZE` / `MYSQL_POOL_QUEUE_LIMIT` | `10` / `0` | 连接池大小。 |
| `MYSQL_WRITE_BATCH_DELAY_MS` | `200` | 传给协调器的 batching 窗口。 |
| `MYSQL_PREPARED_CACHE_SIZE` | `5` | 未发布会话 LRU 容量。 |
| `MYSQL_PACK_CHUNKS` | `true` | 折叠 `assistant/chunk` run 为 packed 行。 |
| `MYSQL_SCHEMA_AUTO_MIGRATE` | `true` | 启动自动迁移 schema；`false` 仅校验。 |
| `ENCRYPTION_KEY` | （空） | 预留应用层字段加密 key（暂缓；空 = 明文）。 |

## 存储布局

三张表，均带 `MYSQL_TABLE_PREFIX` 前缀：

- `${prefix}sessions` —— 每会话一行（`SessionHeader`）。
- `${prefix}events` —— append-only 事件日志；`PRIMARY KEY (session_id, seq)`。
- `${prefix}_meta` —— 已应用的 schema 版本。

**header 行只在「首次 append 的同一事务」写入**（lazy materialization，原子），因此「创建但从未 append」的会话不留任何行、不进 `list`。

## 读写分离

写 hook（`appendBatch`、`commitRepair`）走写池；读 hook（`loadStored`、`readStoredRevision`、`loadStoredFrom`、`list`、`listSnapshots`）走读池。未配置 `MYSQL_READ_HOST` 时读池复用写连接（同库模式——测试即此模式）。读副本轻微滞后不破坏接缝契约：revision 只需在未变化时保持稳定。

## 持久化与崩溃语义

- **事务追加**：每批事件在单个 InnoDB 事务内提交；日志 append-only、seq 连续。复合主键是同 id 双写的跨进程兜底（第二写者在主键冲突时被拒）。
- **无撕裂尾部**：因写入事务化，InnoDB 原子性使「半写的末尾记录」不可能出现，故后端 `tornMarker` 恒为 `undefined`，`commitRepair` 只追加合成 closers。这是相对文件后端的结构性优点。
- **崩溃恢复**：被打断的末轮被保留，并由共享协调器以合成 `tool/result`/`step/end`/`turn/end {interrupted}` 关闭；已提交记录绝不被重写。
- **Lazy materialization**：header 与首批事件原子提交。
- **死锁重试**：`ER_LOCK_DEADLOCK`(1213) 有限退避重试。

## Schema 与迁移

启动执行连接测试 + 幂等 `CREATE TABLE IF NOT EXISTS`，再读 `${prefix}_meta`；已应用版本高于期望则 fail-closed（不支持降级）。`MYSQL_SCHEMA_AUTO_MIGRATE=false` 时版本不匹配即失败（生产可由外部工具管 DDL）。

## 模型体验

后端不新增提示词或 schema。恢复把已存 surface 事件还原为消息历史；崩溃修复把无落库调用的 assistant 请求标记为 `TOOL_NOT_STARTED`、有调用无结果标记为 `TOOL_OUTCOME_UNKNOWN`。普通持久化期间零实时 token；`readFrom` 按 seq seek，服务 checkpoint 消费者。

## 已知限制与待办

- **无删除/归档 API**——接缝本无；清理是库外 `DELETE` 运维职责。
- **`list()` 不分页不过滤**（接缝约束）。
- **默认明文**——事件可能含敏感内容（对话/工具结果/请求头）。`ENCRYPTION_KEY` 为预留扩展位，应用层字段加密暂缓；部署方可考虑 MySQL 原生 TDE / 静态加密。
- **TLS/传输暂缓**——`MYSQL_SSL_REQUIRED` 为预留位，届时可能由云服务商提供。
- **peer 对齐 `^0.1.1-rc.2`**——官方 `v0.1.2-alpha.3` 兼容为后续工作；以高覆盖率作安全网。
