# T5 测试体系 —— 任务交接

**状态**：completed
**依赖**：T4
**交接给**：T6（进行中）

## 测试清单
- 单元 20 例：`config`(9) `schema`(7) `codec`(4)。
- 契约一致性 9 例：`test/conformance/coordinator.test.ts`（协调器驱动，连真实 MySQL）。
- 安全 6 例：`test/integration/security.test.ts`。
- 后端集成 2 例：`test/integration/backend.test.ts`（commitRepair、跨进程双写）。
- e2e 1 例：`test/e2e/plugin.test.ts`（真实挂载插件全流程）。
- 基准 2 例：`test/bench/throughput.test.ts`（吞吐 + 并发安全，宽松回归门禁）。

## 覆盖率（门禁：lines/stmts≥90、funcs≥85、branches≥80）
- lines 94.3% / stmts 94.3% / funcs 90.9% / branches 83.4% —— **达标**。

## 基建
- `test/helpers/db.ts`：唯一表前缀隔离装配 + 清理。
- `test/helpers/events.ts`：结构事件/平衡轮次/chunk 事件构造。
- `vitest.config.ts`：覆盖 src/，排除 `invariant.ts`。

## 遗留
- 死锁注入与跨库 close 分支缺定向测试（TD-007）。
