# Changelog

本项目为 Pre-1.0，格式版本 `SESSION_FORMAT_VERSION`(v0)，遵循 [语义化版本](https://semver.org/)。版本对齐当前运行的 dsh `^0.1.2-rc.1`。

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
