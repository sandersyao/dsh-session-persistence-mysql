# T7 跨进程租约模式（cluster/lease）实现

**状态**：planned（未开始；设计先行）
**依赖**：T6（文档收尾与发布前对齐）
**设计来源**：`docs/LEASE_MODE_DESIGN.md`（唯一权威；实现时逐节核对）

## 目标
在不改 dsh 核心的前提下，为多实例共享同一 MySQL 的部署补一层 **opt-in 分布式租约 + 围栏令牌**：
`open('write')`/`create` 原子认领单写者所有权；`append`/`flush` 在写事务内校验围栏；
崩溃以 `expires_at` 惰性释放；过期由新 owner 以更高 fence 接管。默认 `cluster.lease.enabled=false`，关闭时与当前单实例行为逐字节一致。

## 兼容性前置核查（2026-09-10，已完成）
- 目标版本 **dsh 0.1.5-rc.2**（`dsh@next`；`dsh@latest` 仍为 rc.1）。
- 对比 `dsh-session` / `dsh-session-persistence` 的 **rc.1 vs rc.2**：`lib/types` 与 `lib/*.js` **字节一致**，仅 `package.json`（版本 + peer 范围 → `^0.1.5-rc.2`）不同。
- 本插件 peer `^0.1.5-rc.1` **语义上接受 0.1.5-rc.2**（同 `0.1.5` 元组的 prerelease）。
- 设计依赖的 `SessionOwnershipLostError` 在 rc.1/rc.2 均存在并导出；核心 README 明确「durable cross-process lease 是 planned next layer on the same handle shape」。
- **结论：兼容，无需改代码**。已将 devDeps（dsh-session/persistence/brand/scope/timeout）由 `0.1.5-rc.1` 升到 `0.1.5-rc.2` 并对齐 `next` 复测：typecheck/lint/build 全绿、**75 测试通过**、coverage lines **97.95%**。插件 peer 仍为 `^0.1.5-rc.1`（同时覆盖 rc.1/rc.2）。

## 评审问题处理（2026-09-10，已在 `LEASE_MODE_DESIGN.md` 收敛）
| # | 问题 | 处理 |
|---|---|---|
| 1 | 引用不准确 | **撤回（评审误判）**：核对源仓库 `deepseek-ai/deepseek-harness` 的 `packages/session/session-persistence/README.md`（master），确有原文 *cross-process exclusion is provider-specific*；此前查的是 npm 发布包 README（措辞不同）。引用保留。 |
| 2 | 错误语义混淆 | 已改：`SessionOwnershipLostError` 仅用于 fence 失效；“同 seq 不同内容”的真冲突继续用普通 `Error`（§2/§4.3）。 |
| 3 | 与 append 幂等顺序 | 已定：fence 校验在写事务内、**幂等 no-op 判定之前**（§4.3：开事务→行锁→fence→幂等→写）。 |
| 4 | fence 生成口径 | 智能体已改为原子 `UPDATE … +1`（§4.1/§5/§12 #3）。**复核发现新问题**：per-row `+1` 若 `close()` 删除行会**复位** fence；已改为 `close()` **标记释放、保留 fence**（§4.4/§5），全局单调序列为可选更强方案。 |
| 5 | 空行认领竞态 | 已改：算法改为「先尝试接管→判定→INSERT」，规定 INSERT 撞 1062 时**回退重新判定**（§4.1）。 |
| 6 | 本地 claim 回滚 | 已补：认领失败必须 `releaseClaim`（§4.1 第 3 步 / §11）。 |
| 7 | lazy 物化与 FK | 已补：显式声明不建 FK（§3）。 |
| 8 | 表接线缺失 | 已补：`tableNames()` / cleanup / db / smoke / 迁移接线（§8 / §11）。 |
| 9 | 时间单位混用 | 已改：一律应用层 epoch 毫秒、以 `?` 绑定（§4.1/§4.2/§4.4/§6.2）。 |
| 10 | 心跳生命周期 | 已补：close / abort / asyncDispose / tracker sweep / 失锁 均清理（§11）。 |
| 11 | leaseConnection 生命周期 | 已补：纳入 `dispose()`；fence 读固定同写事务（§4.3 / §11）。 |
| 12 | 悬空附图 | 已补：§5.3 增加 mermaid 时序图。 |
| 13 | enabled=false 建表 | 已定：统一建表、仅不写（§8）。 |
| 14 | sweeper `INTERVAL ?` | 已改：应用层算 cutoff 后 `WHERE expires_at < ?`（§6.2）。 |
| 15 | 行号核实 | 已更新引用（§1.1 / §4.3 / §11）。 |
| 16 | 测试补充 | 已补：幂等×fence 顺序 + fence 不复位 + 兼容（§10）。 |

## 实现 TODO（设计与源码核对后拆分）
- [ ] `src/schema.ts`：`${prefix}leases` DDL、`tableNames()` 扩展、`SCHEMA_VERSION 2→3` + 迁移。
- [ ] `src/mysql-handle.ts`：`claimLease`/`renewLease`/`releaseLease`；tracker 关联 lease 状态与心跳生命周期。
- [ ] `src/index.ts`：`open('write')`/`create` 认领（失败回滚本地 claim）；handle 携带 owner_id/fence/heartbeat。
- [ ] `src/mysql-backend.ts`：`persistBatchOnce` 写事务内 fence 校验（在幂等/重复键分支前）；fence 不符抛 `SessionOwnershipLostError`。
- [ ] `src/config.ts`：`cluster.lease.*` schemastery 配置（默认 enabled=false）。
- [ ] 心跳：`setInterval(ttl/3)` + 机会式续租；连续 N 次失败判失锁。
- [ ] 测试清理接线（cleanup/db/smoke）+ 契约测试。

## 验收门禁
- enabled=false：既有 75 测试全绿，行为与单实例一致。
- enabled=true：争抢 / 围栏 / 崩溃接管 / 续租抖动 / 幂等×fence 顺序 全绿。
- `typecheck` 0、`biome`、`build`、`test:coverage` lines≥90。
