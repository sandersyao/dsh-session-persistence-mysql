# T2 数据模型与 DDL —— 任务交接

**状态**：completed
**依赖**：T1
**交接给**：T3（已完成）

## 产出
- `src/schema.ts`：`SCHEMA_VERSION=1`、`assertTablePrefix`（字符集校验防注入）、`tableNames`、`sessionsDdl`/`eventsDdl`/`metaDdl`（含字段中文注释）、`ensureSchema`（幂等建表 + `_meta` 版本校验/迁移，降级 fail-closed）。
- 单元测试 `test/unit/schema.test.ts`（7 例）。

## 关键决策
- 两表（sessions + events）+ `_meta` 版本表；header 与首批事件同事务（lazy materialization 原子）。
- 外键不命名（MySQL 约束名库内唯一，命名会在多前缀测试下冲突）。
- 事件 payload 用 `LONGTEXT`（保字节序，避免 JSON 列规范化）。

## 验收
- 单测通过；真实 MySQL 上 `ensureSchema` 幂等可重复。
- 遗留：`eventsDdl` 外键自动命名（无显式名）。
