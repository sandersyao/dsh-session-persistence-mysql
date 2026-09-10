# Changelog

本项目为 Pre-1.0，遵循 [语义化版本](https://semver.org/)。插件版本对齐当前运行的 dsh：`0.1.x` 对齐 `^0.1.5-rc.x`。

## 0.1.5-rc.1 (2026-09-10) —— 适配 dsh 0.1.5-rc.1 契约

### 同上（rc.1 与 alpha.2 public surface 完全一致）
- peer/dev 升至 `@deepseek-ai/dsh-session` / `dsh-session-persistence` `^0.1.5-rc.1`；其他 `@deepseek-ai/dsh-*` 也对齐到 `0.1.5-rc.1`。
- 源码无需改动：`SESSION_FORMAT_VERSION=3`、`SessionPersistence` 抽象方法签名、`SessionHandle` 接口、storage contract 与 alpha.2 完全一致。
- 门禁全绿：typecheck 0 错误、build、test **48/48** 通过、smoke PASS。
- 移除无实际检查的 `invariants` 伴生入口（`src/invariant.ts`、`./invariant` 导出、`tsup` entry）与 `@deepseek-ai/dsh-invariants` 依赖，对齐官方 `dsh-session-persistence-jsonl`（不发布该伴生入口）。

## 0.1.5-alpha.1 (2026-09-10) —— 适配 dsh 0.1.5-alpha.x 契约

### Breaking（对齐 dsh 0.1.5 API）
- **去掉 `PersistenceCoordinator` 中介**：子类直接实现 `SessionPersistence` 抽象方法 `create` / `open` / `flush` / `stat` / `list`，不再复用 `loadStored`/`readStoredRevision`/`commitRepair` 等 hooks。
- **SessionHandle 重构**：写 handle 由子类构造并返回；`read`/`append`/`flush`/`close` 直接走 handle API；`read(0)` 默认从 seq 0 读、传 offset 可 seek；live event 路由由 `MysqlBackendTracker` 监听 `session/event` / `session/flush` / `session/disposed` 三个事件实现。
- **会话头格式升级到 v3**：跟随 `SESSION_FORMAT_VERSION`，session 头去 `seedLength`，继承前缀迁移到 `SessionStorageMetadata.inheritedEventCount`；schema 版本从 1 升到 2 并新增迁移（把旧 v0 行的 `sessions.version` 一次性刷到 3，避免 `assertVersion` 拒读）。
- **Chunk 折叠不再在插件层**：0.1.5 起由上游 `sessionFormatCatalog.encodeCurrentEvent` 在 format catalog 内部处理；本插件只透传事件，每行 `row_type=NULL`。`PersistenceSettings.writeBatchMaxDelayMs` / `preparedSessionCacheSize` 下沉为 handle 层内部常量 `LIVE_WRITE_BATCH_MAX_DELAY_MS`，不再从 env 读取。
- **encode 简化**：`encodeStorageRows` 走 `materializeAppendBatch`（上游已校验）；`decodeStoredRows` 走 `validateStoredEvents`（loud-fail 损坏检测）。

### 新增
- `MysqlBackendTracker`：进程内单写者约束 + open handle 跟踪 + live event 路由；`install(ctx)` 把 session 事件桥接到当前写 handle 的 buffered 队列，200ms 批量 drain；dispose effect 收尾 sweep 剩余 handle。
- `MysqlSessionHandle`：monotonic view（`observedLength`）+ per-handle mutation chain（Promise 串行化）+ lazy materialization（首次 append/flush 触发 header 落盘）。
- 集成测试用 `assistant/message` 事件（带 `surfaceOp="append"` 与完整 message shape）替代旧的 `assistant/chunk`，对齐 0.1.5 catalog。

### 配置 / 环境
- 沿用 `SESSION_*` > `MYSQL_*` 解析；`writeBatchMaxDelayMs` / `preparedSessionCacheSize` env 已被忽略（保留解析仅为历史兼容）。
- `packChunks` 配置位保留但实际不再使用（折叠由上游承担）。

### 测试
- 48 例全部绿：unit 22 + conformance 9 + integration 7 + e2e 1 + bench 2 + 跨进程双写 + SQL 注入防护 + schema 版本回退。
- `setupTestDb` 现在把测试 tablePrefix 一并传给 persistence（之前漏传 → 插件读 `MYSQL_TABLE_PREFIX` 而非测试前缀 → 误报已存在）。
- smoke `scripts/smoke.mjs` 用 `ctx.fiber.dispose()` 收尾（Cordis 4 Context 不再有 `dispose` 方法）。

## Unreleased

### 配置：独享 `SESSION_*` 环境变量
- 环境变量加载改为本插件独享 `SESSION_*` 优先、缺省回退共享 `MYSQL_*`（`fromEnv` 模式，与 `dsh-storage-mysql` 的 `STORAGE_*`、`dsh-credentials-mysql` 的 `CREDENTIALS_*` 一致）：多 MySQL 插件共用一套 `MYSQL_*` 又可各自独立配置。
- 覆盖项含连接、读库、池、持久化语义与 schema；加密 key 走 `SESSION_ENCRYPTION_KEY` > `MYSQL_ENCRYPTION_KEY` > 旧版裸 `ENCRYPTION_KEY`。
- 测试隔离改由独享 `SESSION_TEST_DATABASE` 驱动；`.env.example` 与 README 环境表同步。

## 0.1.2-rc.1 (2026-09-04) —— 迁移至 dsh v0.1.2-rc.1 契约

### 兼容对齐（T6）
- peer/dev 升至 `@deepseek-ai/dsh-session`/`dsh-session-persistence`/`dsh-invariants` `^0.1.2-rc.1`、`@deepseek-ai/cordis` `^4.0.2`；新增 `dsh-brand`/`dsh-timeout`/`dsh-scope` dev 依赖以对齐 persistence 0.1.2 peer。
- 后端 hooks 适配 `SessionStorageMetadata{meta,inheritedEventCount}`：`appendBatch`/`commitRepair` 改收存储元数据；新增 `materializeHeader`（空会话 header 持久化）。
- `SessionHeader` 移除 `seedLength`、新增必填 `isSeeded`：`seed_length` 列保留为继承前缀编码（`isSeeded` 由列非空推导，镜像 JSONL 参考实现，零 DDL 迁移、存量向后兼容）。
- 子类实现 0.1.2 新增抽象 `borrowSession` 与 `ensureMaterialized`；`create` 增加 `inheritedEventCount?`、`readFrom` 返回 `SessionEventSuffix` 并按 `SessionLogOffset` 寻址。
- 事件编码不变（format v0）；新增 seed 往返 / `materializeHeader` / e2e `borrowSession` 用例。
- 门禁全绿：typecheck 0 错误、biome、build、test 47 例、覆盖率 lines 95.3% / funcs 89.6%。

## 0.1.1 (2026-09-01)

### 新增
- MySQL `SessionPersistence` 后端插件（`@sandersyao/dsh-session-persistence-mysql`）：
  - 复用 `PersistenceCoordinator`，实现 `PersistenceBackend` hooks（`loadStored`/`readStoredRevision`/`loadStoredFrom`/`appendBatch`/`commitRepair`/`list`/`close`）。
  - 两表（sessions + events）+ `_meta` 版本表，幂等建表 + 版本校验/迁移，fail-closed。
  - lazy materialization（header 与首批事件同事务原子提交）。
  - 无撕裂尾部：写路径单事务，`tornMarker` 恒 `undefined`。
  - 读写分离（写池/读池；读库缺省复用写库）。
  - chunk run 折叠（`MYSQL_PACK_CHUNKS`，默认开）。
  - 死锁（`ER_LOCK_DEADLOCK`）有限退避重试。
  - `readFrom` seek（`loadStoredFrom`，`WHERE seq >= ?`）。

### 安全
- 全部参数化占位符；会话 id 不作 SQL 标识符拼接；表前缀字符集校验。
- 凭据仅来自环境变量/.env，日志脱敏，配置不回显。
- 明文默认 + `ENCRYPTION_KEY` 预留扩展位（字段加密暂缓）。

### 测试
- 单元 20 例 + 契约一致性 9 例 + 安全 6 例 + 后端集成 2 例 + e2e 1 例 + 基准 2 例。
- 覆盖率门禁：lines≥90（当前约 94%）。

### 已知限制 / 待办
- 无删除/归档 API；`list()` 不分页；TLS 暂缓；`v0.1.2-alpha.3` 兼容为后续（详见 `docs/TECH_DEBT.md`）。
