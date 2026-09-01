# MySQL 会话持久化后端 —— 设计决策笔记

> 决策依据记录（供后续 Agent 与人工阅读）。详细设计见 `docs/DESIGN.md`。

## 为什么选 `SessionPersistence` 接缝
dsh 把「会话持久化」定义为持久化 event-sourced 的 `SessionEvent` 日志（log 是唯一事实源），非回放元数据走 `SessionHeader`。参考实现 `dsh-session-persistence-jsonl` 提供了「类继承 `SessionPersistence` + 组合 `PersistenceCoordinator` + 实现 `PersistenceBackend` hooks」的接线。本插件即该接缝的 MySQL Provider。

## 为什么复用 `PersistenceCoordinator`
崩溃恢复、lazy materialization、batching、写路径监听、生命周期、per-id 串行化都是后端无关的复杂编排。复用协调器可保证与 JSONL 行为契约等价，我只实现 `PersistenceBackend` hooks 与存储层。

## 为什么写路径单事务 → 无撕裂尾部
InnoDB 事务原子性使「半写的末尾记录」不可能出现，`tornMarker` 恒 `undefined`，`commitRepair` 只追加 closers。这是相对文件后端的结构性优点，写进 README。

## 为什么 header 与首批事件同事务
满足 lazy materialization 的原子性：绝不出现「有 header 无事件」的半态，也未 append 的会话不进 `list`。

## 为什么预留明文默认 + encryptionKey
与 JSONL 一致，默认明文；事件含敏感内容的风险已在 README/Known Limitations 声明，`ENCRYPTION_KEY` 为字段级加密扩展位（本轮不实现）。安全优先的落地是：参数化防注入、凭据不入日志、最小权限、前缀校验。

## 为什么读写分离 + 测试同库
写 hook 走写池、读 hook 走读池；读库缺省复用写库，测试即同库模式，保证读写分离逻辑在单库下与单池结果一致，避免测试依赖多副本。

## 为什么 peer 对齐 ^0.1.1-rc.2 且高覆盖率打底
当前运行 dsh 为 v0.1.1-rc.2（dist-tag next）；官方已发 v0.1.2-alpha.3，兼容留待后续。高覆盖率（lines≥90）作为未来兼容的安全网。

## 已知取舍
- 无删除/归档 API（接缝无）。
- `list()` 不分页（接缝约束）。
- 死锁重试分支与跨库 close 分支缺定向测试（TD-007）。
