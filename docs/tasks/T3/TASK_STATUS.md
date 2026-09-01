# T3 PersistenceBackend hooks + 协调器 + 读写分离 —— 任务交接

**状态**：completed
**依赖**：T2
**交接给**：T4（已完成）

## 产出
- `src/mysql-backend.ts`：`MysqlBackend implements PersistenceBackend<undefined>`。hooks：`loadStored`/`readStoredRevision`/`loadStoredFrom`/`appendBatch`/`commitRepair`/`list`/`listSnapshots`/`close`。
- `src/mysql-codec.ts`：`encodeStorageRows`/`decodeStoredRows`（裸 + chunk 折叠，layout-blind）。
- `src/pool.ts`：写/读池工厂，同库模式复用写池。
- `src/index.ts`：`MysqlSessionPersistence extends SessionPersistence`，`[Service.init]` 里 ensureSchema + 建 coordinator。
- 契约一致性测试 `test/conformance/coordinator.test.ts`（9 例，连真实 MySQL）。

## 关键决策
- 读 hook 走读池、写 hook 走写池；读库缺省复用写库。
- append 单事务 + `FOR UPDATE` 锁会话行 + 复合主键兜底同 id 双写；死锁(1213)有限退避重试。
- `tornMarker` 恒 `undefined`（事务原子，无撕裂尾）。
- revision = `<database>/<prefix>:v<SCHEMA_VERSION>#<log_rev>`。

## 验收
- 契约测试 9 例全过；跨进程双写第二写者被拒。
