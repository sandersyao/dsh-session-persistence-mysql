# dsh-session-persistence-mysql —— 设计文档

> 面向实现者的完整设计。先于实现；任何偏离本文件的行为都应先修订本文件。

## 1. 定位

`@sandersyao/dsh-session-persistence-mysql` 是 `dsh-session-persistence` 能力接缝的 **MySQL Provider**。以 Cordis 插件加载后注册为 `ctx.sessionPersistence`，持久化 event-sourced 的 `SessionEvent` 日志（log 是唯一事实源），非回放元数据随 `SessionHeader` 存放。与 `dsh-session-persistence-jsonl` 行为契约等价。

## 2. 架构

- **复用 `PersistenceCoordinator`**：写入/读取编排、lazy materialization、崩溃恢复、batching、生命周期全部交给协调器。
- **只实现 `PersistenceBackend<TornMarker>` hooks**：`name` / `loadStored` / `readStoredRevision` / `loadStoredFrom?` / `appendBatch` / `commitRepair` / `list` / `close?`。
- **读写分离**：写 hook 走 `writePool`，读 hook 走 `readPool`；`readPool` 缺省复用写库连接（测试同库）。
- **事件编解码**：裸事件一行一条（`payload`=事件 JSON）；`packChunks` 开启时用 `packChunkRuns` 折叠 chunk run 为 packed 行，读取用 `decodeStorageRecord` layout-blind。

## 3. 数据模型

两表 + 版本表，前缀 `${prefix}`（来自 `MYSQL_TABLE_PREFIX`，启动校验 `^[A-Za-z0-9_]+$`）。

- `${prefix}sessions`：每会话一行（=已 materialize 的 header）。
- `${prefix}events`：事件日志，复合主键 `(session_id, seq)`。
- `${prefix}_meta`：schema 版本表，`version INT PRIMARY KEY`。

DDL 见 §5（含字段中文注释）。

**关键语义**：
- **lazy materialization 原子性**：header 行只在「首次 append 的同一事务」写入 → 未 append 会话不进 `list`，且不会出现「有 header 无事件」的半态。
- **撕裂尾部不存在**：append/repair 单事务，InnoDB 原子 → `tornMarker` 恒 `undefined`；`commitRepair` 仅追加 closers。
- **并发**：复合主键唯一约束兜底同 id 双写；append 内 `UPDATE … SET log_rev=log_rev+1` 校验受影响行数；`ER_LOCK_DEADLOCK` 有限退避重试。
- **revision**：`SessionPersistenceRevision` 由后端构造，来源限定 = `<database>+<prefix>+schema_gen`，日志版本 = `sessions.log_rev`。

## 4. hooks → 池路由

| Hook | 池 | 行为 |
|---|---|---|
| `name` | — | `'session-persistence-mysql'` |
| `loadStored(id, signal)` | 读 | 查 header + 全部事件（读事务，校验 id/连续 seq）；无 header → `undefined` |
| `readStoredRevision(id, signal)` | 读 | 只查 `sessions.log_rev`（+schema_gen），不载事件 |
| `loadStoredFrom(id, fromSeq, signal)` | 读 | `WHERE session_id=? AND seq>=?`（seek-capable） |
| `appendBatch(meta, events, isMaterialized)` | 写 | 单事务：`!isMaterialized` 先插 header 再插事件；更新 `log_rev` |
| `commitRepair(meta, tornMarker, closers)` | 写 | 事务内追加 closers（tornMarker 恒 undefined） |
| `list(signal)` | 读 | 只查 sessions 表，不载事件 |
| `close()` | 写+读 | 关池（同连接只关一次） |

## 5. DDL（含字段注释）

```sql
-- sessions：每会话一行（=已 materialize 的会话头）
CREATE TABLE IF NOT EXISTS `${prefix}sessions` (
  session_id       VARCHAR(255) NOT NULL COMMENT '品牌化会话 id；唯一标识。仅参数化绑定，绝不作 SQL 标识符拼接',
  version          INT NOT NULL COMMENT '会话头格式版本（SESSION_FORMAT_VERSION，当前 v0）',
  created_at       BIGINT NOT NULL COMMENT '会话创建时间（epoch 毫秒）；重建还原原始 createdAt',
  cwd              TEXT NULL COMMENT '会话工作目录（可选）',
  parent_session   VARCHAR(255) NULL COMMENT '父会话 id（lineage，可选）',
  seed_length      INT NULL COMMENT 'seed 前缀事件数（fork 时 seed boundary，可选）',
  origin           VARCHAR(64) NULL COMMENT '会话来源标记（可选）',
  delegation_depth INT NOT NULL COMMENT '委托深度；磁盘上必需，顶层为 0',
  agent_preset     VARCHAR(255) NULL COMMENT '决定恢复后工具与提示词的 agent preset（可选但建议持久化）',
  log_rev          BIGINT NOT NULL DEFAULT 0 COMMENT '日志修订号：每次 append/repair 同事务自增；构成 revision 日志版本',
  PRIMARY KEY (session_id)
) ENGINE=InnoDB COMMENT='会话头表：每会话一行（=已 materialize 的会话头）';

-- events：会话事件日志（append-only，事实源）
CREATE TABLE IF NOT EXISTS `${prefix}events` (
  session_id VARCHAR(255) NOT NULL COMMENT '所属会话 id，引用 sessions；与 seq 构成复合主键',
  seq        BIGINT NOT NULL COMMENT '事件在日志中的序号，从 0 连续递增；复合主键唯一约束兜底同 id 双写',
  row_type   VARCHAR(32) NULL COMMENT '存储行类型：NULL=裸事件；text-chunks/reasoning-chunks/tool-call-chunks=packed chunk 行',
  payload    LONGTEXT NOT NULL COMMENT '存储记录 JSON；参数化写入；非 JSON 可序列化在写入前被拒绝',
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id)
    REFERENCES `${prefix}sessions`(session_id)
) ENGINE=InnoDB COMMENT='事件日志表：会话事件日志（append-only，事实源）';
```

**幂等 + 版本校验**：
- 两表 `CREATE TABLE IF NOT EXISTS`（PK/FK 内联，天然幂等）。
- `${prefix}_meta(version)`：启动读 version；`<expected` 逐级迁移（每迁移一事务，成功后插 version 行）；`>expected` fail-closed。
- `schemaAutoMigrate`：true=自动迁移；false=只校验。

## 6. 配置（schemastery `z.object`）

- `connection`：`host` `port` `user` `password`(敏感) `database` `tablePrefix` `charset` `connectTimeout` `ssl` `sslRequired`。
- `readConnection`（可选）：读库；缺省复用 connection。
- `pool`：`poolSize` `minIdle` `idleTimeout` `acquireTimeout` `queueLimit`。
- `persistence`：`writeBatchMaxDelayMs` `preparedSessionCacheSize` `packChunks`(默认 true) `packMinRun`(默认 3)。
- `security`：`encryptionKey?`（预留，默认空=明文）`schemaAutoMigrate`(默认 true)。

## 7. 安全基线

- 凭据仅来自 env/.env；Config 不回显；日志脱敏（mask password/连接串）。
- 全参数化占位符；id 不作 SQL 标识符拼接；前缀字符集校验。
- 最小权限：专项用户 `GRANT SELECT,INSERT,UPDATE,DELETE ON \`db\`.\`prefix\`* TO 'dsh'@...`，不用 root。
- 明文默认 + Known Limitation 声明；`encryptionKey` 预留字段级加密扩展位（暂不实现）。
- TLS 暂缓（`sslRequired` 位保留；安全测试暂缓 TLS 强制）。

## 8. 性能

- 连接池（`poolSize`/`queueLimit`）；写批量（单事务多行）；复合主键范围读；`readFrom` 走 `loadStoredFrom`；`list` 只查 header；预编译语句复用；chunk packing 减行数；读写分离；`bench` 基线。

**增长预算公式**：
```
Bytes(session) = Σ_t c_t·p_t + R·(n − n_c + c_p) − (n_c − c_p)·(R + p_chunk)
Disk(session)  = Bytes(session) × A        // A≈1.5–2.0（16KB 页/填充率/索引/碎片）
Capacity       = Disk/day × 保留天数
```
- `n`=事件总数，`n_c`=chunk 事件数，`c_p`=packed 后行数，`c_t/p_t`=类型 t 条数与平均 payload 字节，`R`≈50B 行开销。
- 数量级算例（20k 事件、packing 开）≈ 3.76MB/会话逻辑、5.6MB 磁盘，较不开省约 35%。

## 9. 错误处理与可观测性

- MySQL 错误映射：`ER_LOCK_DEADLOCK`/断连/唯一冲突/超时 → 有限重试+退避；不可恢复错误 fail-closed。
- 优雅关闭：dispose 时 `close()` 关写池+读池（等待在途）。
- 启动校验：连接测试(`SELECT 1`) + schema 存在 + 版本；失败 fail-closed。
- 结构化日志（脱敏、含 context）；指标（写延迟/失败率/pool 使用）预留接口。

## 10. 测试策略

- 安全（最高优先级）：SQL 注入、凭据不回显、错误路径不泄连接参数、最小权限验证、超长/畸形负载；（TLS 强制暂缓）。
- 契约一致性（功能完整）：后端无关套件覆盖 `dsh-session-persistence` 全部 invariants；纯逻辑用内存假后端，集成用真实 MySQL。
- 功能/e2e：create→append→flush→load 全流程；lazy materialization 缺席 list；跨进程同 id 双写；DDL 幂等；读写分离同库一致；优雅关闭。
- 性能：`bench`（写吞吐、读放大、大 batch、并发死锁探测）。
- 覆盖率门禁 lines≥90（为 v0.1.2-alpha.3 兼容打底）。

## 11. 明确不做（技术债/边界）

- 不实现删除/归档（接缝无 API）。
- 不做 TLS 强制、不做字段加密（暂缓/预留）。
- 不做 v0.1.2-alpha.3 兼容（本轮靠覆盖率打底）。
- `list()` 不分页（按契约）。
