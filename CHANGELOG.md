# Changelog

本项目为 Pre-1.0，格式版本 `SESSION_FORMAT_VERSION`(v0)，遵循 [语义化版本](https://semver.org/)。版本对齐当前运行的 dsh `^0.1.1-rc.2`。

## 0.1.1-rc.2 (unreleased)

### 新增
- MySQL `SessionPersistence` 后端插件（`@deepseek-ai/dsh-session-persistence-mysql`）：
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
