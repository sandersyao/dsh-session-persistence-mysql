# T6 迁移 —— dsh v0.1.2-rc.1 兼容对齐

**任务阶段**：已实施完成（代码 + 测试 + 门禁全绿）；剩余对外 dsh 0.1.2 harness 挂载 e2e 与发布在里程碑层跟进。
**依赖**：T5（completed）
**关联债务**：TD-005 → resolved

---

## 结论（核查）
dsh 家族锁步发布 `0.1.2-rc.1`（=latest/next）。仓库原对齐 `0.1.1-rc.2`，经实测（官方 tsconfig+strict 对 `0.1.2-rc.1`）原 `src/` 有 **12 处类型错误**且运行时断裂。本任务已完成迁移。

## 改动
- **package.json**：peer/dev 三件套 → `^0.1.2-rc.1`；cordis `^4.0.2`；新增 dev `dsh-brand`/`dsh-timeout`/`dsh-scope`（persistence 0.1.2 peer 需可解析）；schemastery `^3.18.2`。
- **src/mysql-backend.ts**：`appendBatch`/`commitRepair` 收 `SessionStorageMetadata`；新增 `materializeHeader`；`headerFromRow` 产 `isSeeded`（列非空推导）+ 新 `storageFromRow` 产 `inheritedEventCount`；`loadStored`/`loadStoredFrom` 返回补齐 `inheritedEventCount`。
- **src/index.ts**：新增 `borrowSession`/`ensureMaterialized` 委托；`create` 增 `inheritedEventCount?`；`readFrom` 返回 `SessionEventSuffix` 并按 `SessionLogOffset` 寻址。
- **src/schema.ts**：`seed_length` 列注释改为继承前缀语义；`SCHEMA_VERSION` 保持 1，**零 DDL 迁移、存量向后兼容**。
- **测试**：修正契约性调用点为存储元数据；新增 seed 往返 / `materializeHeader`（integration/backend）+ e2e `borrowSession` 冒烟。

## 验证（门禁全绿）
- typecheck 0 错误；biome check 通过；`pnpm build` 通过。
- `pnpm test`：**10 文件 / 47 例全绿**（含 conformance 9、security 6、e2e 1、bench 2）。
- 覆盖率：lines **95.3%** / funcs 89.6% / branches 86.2%（门禁 lines≥90 ✅）。

## 关键设计决策（采纳推荐值）
- **A**：`seed_length` 列名保留、语义改为继承前缀（镜像 JSONL：仅 `isSeeded` 时非空）；`isSeeded` 由列非空推导 → 零迁移。
- **B**：peer 范围 `^0.1.2-rc.1`。
- **C**：保留本地 `isChunkRow`（未换库内导出）。

## 遗留 / 后续（里程碑 release 跟进）
- 用 `@deepseek-ai/dsh@0.1.2-rc.1` 真实 harness 做一次挂载 e2e（本任务未跑对外 harness）。
- `ensureMaterialized` 委托为薄转发，index.ts funcs 覆盖率受其未单独调用影响；由 harness 生命周期驱动覆盖。
