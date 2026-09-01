# AGENTS.md

本文件为开发本仓库的 Agent（或人工协作者）提供**必须遵守的约定**。读取后按此执行。

## 项目是什么

`@sandersyao/dsh-session-persistence-mysql` —— DeepSeek Harness（dsh）的 **MySQL 会话持久化后端**。它是 `dsh-session-persistence` 能力接缝的一个 Provider：以 Cordis 插件形式加载，注册为 `ctx.sessionPersistence`，持久化 event-sourced 的 `SessionEvent` 日志。

## 关键架构事实（先读文档，勿扫源码）

- 参考契约：`dsh-session-persistence` 的 README（Service API + `PersistenceBackend` hooks 表 + invariants）。
- 参考实现模式：`dsh-session-persistence-jsonl` —— 类继承 `SessionPersistence` + `static Config`(schemastery) + `static inject` + 组合 `PersistenceCoordinator` + 委托抽象方法 + 实现 hooks。
- **必须复用 `PersistenceCoordinator`**，只实现 `PersistenceBackend` hooks：`loadStored` / `readStoredRevision` / `loadStoredFrom?` / `appendBatch` / `commitRepair` / `list` / `close?`。
- 事件模型：`SessionEvent`（dsh-session），格式版本 `SESSION_FORMAT_VERSION`(v0)。chunk 折叠用 `packChunkRuns`/`decodeStorageRecord`。
- 读写分离：写 hook 走写池，读 hook 走读池；读库缺省复用写库连接（测试同库）。

## 常用命令

```bash
pnpm install            # 安装依赖（本地 store 在 .pnpm-store）
pnpm typecheck          # 类型检查（strict）
pnpm lint / pnpm fmt    # Biome 格式+lint
pnpm build              # tsup 构建 → lib/
pnpm test               # vitest run
pnpm test:coverage      # 带覆盖率门禁（lines≥90）
pnpm bench              # 性能基准
docker compose up -d    # 启动本地 MySQL（env 取自 .env）
```

## 代码风格约束（强制，违反即被打回）

1. **类型声明**（`interface` / `type` / `class`）上方必须有**多行 JSDoc** `/** ... */`。
2. **具名函数与方法**上方必须有**多行 JSDoc**。
3. 所有**注释描述使用中文**（标识符、代码、日志保持英文）。
4. **数据表与字段必须有注释**（DDL 内每列用 `COMMENT '...'` 子句注明用途；表级 `COMMENT=` 只写表的一句话描述，不堆叠列注释）。
5. 复杂/非显然逻辑：在实现上方补中文说明，解释「为什么」。
6. 格式与 lint 由 Biome 统一（`biome check` 必须通过）。

## 安全基线（本项目红线）

- 连接凭据只来自环境变量/.env，**绝不硬编码、绝不打印、绝不进日志**。
- 全部 SQL 用参数化占位符 `?`；会话 id **绝不**作为 SQL 标识符拼接。
- 表前缀来自配置且校验 `^[A-Za-z0-9_]+$`。
- 事件负载默认明文；不实现删除/归档。

## 测试要求

- 安全用例优先级最高；其次功能完整；再性能。
- 契约一致性套件必须覆盖 `dsh-session-persistence` 的全部 invariants。
- 覆盖率门禁：`lines ≥ 90`（为 v0.1.2-alpha.3 兼容打底）。

## 交接与文档

- 每个任务在 `docs/tasks/T<id>/` 产出 `TASK_STATUS.md`（markdown）+ `TASK.json`（机器可读）。
- 技术债登记到 `docs/TECH_DEBT.md` + `docs/TECH_DEBT.json`。
- 任务队列总表：`docs/TASKS.json`。
