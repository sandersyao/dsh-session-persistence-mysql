# T7 跨进程租约模式（cluster/lease）实现

**状态**：completed（2026-09-10）
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
| 11 | leaseConnection 生命周期 | 已补；**本轮实现决定暂缓 leaseConnection**（见下方“实现范围”与 TD-008）。 |
| 12 | 悬空附图 | 已补：§5.3 增加 mermaid 时序图。 |
| 13 | enabled=false 建表 | 已定：统一建表、仅不写（§8）。 |
| 14 | sweeper `INTERVAL ?` | 已改：应用层算 cutoff 后 `WHERE expires_at < ?`（§6.2）。 |
| 15 | 行号核实 | 已更新引用（§1.1 / §4.3 / §11）。 |
| 16 | 测试补充 | 已补：幂等×fence 顺序 + fence 不复位 + 兼容（§10）。 |

## 实现结果（2026-09-10）
- [x] `src/schema.ts`：`${prefix}leases` DDL（无 FK）、`tableNames()` 扩展、`SCHEMA_VERSION 2→3` + 迁移。
- [x] `src/mysql-backend.ts`：`claimLease`/`renewLease`/`releaseLease`（非删除式释放）+ `assertLeaseFence`；`persistBatch`/`persistBatchOnce`/`persistHeader` 写事务内 fence 校验先于幂等分支；同事务机会式续租。
- [x] `src/mysql-handle.ts`：handle 持有 lease/fence + 心跳定时器；`close` 先 heartbeat 后非删除式 release。
- [x] `src/index.ts`：`open('write')`/`create` 认领租约（失败释放）；`ownerId = hostname:pid:uuid`。
- [x] `src/config.ts`：`cluster.lease.*`（默认 `enabled=false`；`SESSION_LEASE_*` / `MYSQL_LEASE_*` 优先）。
- [x] 心跳 + 连续失败阈值判失锁。
- [x] 测试接线（`test/helpers/db.ts` DROP 列表）+ 契约测试（`test/integration/lease.test.ts` 6 例、`test/unit/handle-unit.test.ts` +3、schema/backend 单测修订）。
- [x] 文档回填：`docs/LEASE_MODE_DESIGN.md` §8.5/§9/§11/§12；`docs/TECH_DEBT.{md,json}` TD-008；CHANGELOG Unreleased。

### 验收门禁（全绿）
- `pnpm lint`：0 error；`pnpm typecheck`：0 error；`pnpm build`：成功。
- `pnpm test:coverage`：**85 测试通过**，All files lines **97.14%** / funcs 98.85% / branches 85.84%（阈值 lines≥90 满足）。
- `enabled=false`：行为与单实例逐字节一致（既有套件全绿）。

### 实现范围收窄（相对设计文档）
- 租约 DML 与 fence 校验**一律在 `writePool` 写事务内**（隐含 `usePrimaryOnly=true`），读写分离仅用于 events/sessions 回放读。
- **独立 `cluster.lease.leaseConnection`（多主 lease-primary）与租约行 sweeper 暂缓** → TD-008（需全局单调 fence 序列）。单主库下语义完整且行数有界。
