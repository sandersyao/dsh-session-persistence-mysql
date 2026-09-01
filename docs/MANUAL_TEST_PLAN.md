# 手动功能测试方案 —— dsh-session-persistence-mysql

> 面向人工 QA 的验收步骤。自动化已覆盖契约/安全/集成（`pnpm test`），本方案验证**真实环境下的端到端行为**。逐项执行并记录结果。

## 0. 前置准备

1. 启动 MySQL：`docker compose up -d`，等待 `healthy`（本机镜像 `mysql:8.4`）。
2. 确认 `.env` 已配置 `MYSQL_*`（模板见 `.env.example`；凭据只来自这里）。
3. 安装并构建：`pnpm install && pnpm build`。
4. 冒烟脚本：`node scripts/manual-smoke.mjs`，期望 `7/7 通过`。

## 1. 冒烟（基础链路）

| # | 步骤 | 预期 |
|---|---|---|
| 1.1 | `node scripts/manual-smoke.mjs` | 打印 7 项全部 PASS，退出码 0 |
| 1.2 | 检查库中无残留 `smoke_*` 表 | `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'smoke_%'` 为空 |

## 2. Schema 与注释

| # | 步骤 | 预期 |
|---|---|---|
| 2.1 | 用冒烟脚本或临时插件建表后，查询列注释 | 每列 `COLUMN_COMMENT` 非空（如 `session_id` 含「品牌化会话 id」） |
| 2.2 | 重复挂载插件（重启） | 幂等，不报「表已存在」 |
| 2.3 | 版本回退：手动把 `_meta` 写入高于期望的版本再启动 | fail-closed，拒绝启动，提示不支持降级 |

## 3. 持久化语义

| # | 步骤 | 预期 |
|---|---|---|
| 3.1 | create 后不 append，`list()` | 为空（lazy materialization） |
| 3.2 | create + append 两批，`load()` | 事件 `seq` 连续 0..7，header 字段（cwd/agentPreset 等）还原 |
| 3.3 | `readFrom(id, 4)` | 仅返回 `seq>=4` 的后缀 |
| 3.4 | 连续两次 append 相同起始 seq（如都从 0） | 第二次被拒（seq 不连续 / 主键冲突） |

## 4. 崩溃恢复（人工模拟）

| # | 步骤 | 预期 |
|---|---|---|
| 4.1 | append 一批「开着 turn 未关」的事件后，**直接 kill 进程**（`kill -9`），再正常 `load()` | 被保留，且合成 closers（`tool/result`/`step/end`/`turn/end {interrupted}`）补齐为平衡日志 |
| 4.2 | 校验：写路径单事务，`events` 表无「半行」 | 事务提交前崩溃则整批不存在；提交后则完整 |

## 5. 安全

| # | 步骤 | 预期 |
|---|---|---|
| 5.1 | 用含 SQL 片段的会话 id（如 `a'; DROP TABLE x;--`）create+append+load | 按字面量存储/读取，库不被破坏（表仍存在） |
| 5.2 | `MYSQL_TABLE_PREFIX` 设成非法字符（如 `a-b`）启动 | 拒绝启动，提示前缀非法 |
| 5.3 | 缺 `MYSQL_HOST`/`MYSQL_PASSWORD` 启动 | fail-closed，提示缺失 |
| 5.4 | 用一个只有最小权限的 DB 用户连接 | 正常读写自身前缀表；越权访问其他表被 MySQL 拒绝 |
| 5.5 | 观察日志 | 不含密码/连接串明文 |

## 6. 读写分离

| # | 步骤 | 预期 |
|---|---|---|
| 6.1 | 不配 `MYSQL_READ_HOST` | 读池复用写库，行为与单库一致（同库模式） |
| 6.2 | （可选）配独立只读副本 | 写走主、读走从；副本有轻微滞后不影响 revision 语义 |

## 7. 性能冒烟

| # | 步骤 | 预期 |
|---|---|---|
| 7.1 | `pnpm bench`（或 `pnpm vitest run test/bench`） | 吞吐下限断言通过；并发写多会话无死锁 |

## 8. 结果记录

| 用例 | 结果（PASS/FAIL） | 备注 |
|---|---|---|
| 1.1 | | |
| 1.2 | | |
| 2.1 | | |
| 2.2 | | |
| 2.3 | | |
| 3.1 | | |
| 3.2 | | |
| 3.3 | | |
| 3.4 | | |
| 4.1 | | |
| 4.2 | | |
| 5.1 | | |
| 5.2 | | |
| 5.3 | | |
| 5.4 | | |
| 5.5 | | |
| 6.1 | | |
| 6.2 | | |
| 7.1 | | |

**通过标准**：核心链路（1/2/3/6/7）全 PASS；安全（5）无高危项失败；崩溃恢复（4）符合预期。发现 FAIL 时记录到 `docs/TECH_DEBT.md` 并在此表标注。
