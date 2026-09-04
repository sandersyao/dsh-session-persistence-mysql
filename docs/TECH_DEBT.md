# 技术债登记（markdown 镜像，机器可读见 `TECH_DEBT.json`）

## TD-001 — npm 全局缓存 root 属主 EPERM
- **状态**：open
- **缓解**：项目内 `.pnpm-store`（`.npmrc store-dir`）绕开；CI 环境无此问题。

## TD-002 — 无删除/保留 API
- **状态**：accepted（写入 README Known Limitations）
- **决策**：接缝 `dsh-session-persistence` 本身无删除/归档 API；pruning 是外部运维职责。本插件不实现删除/归档。

## TD-003 — 事件负载默认明文
- **状态**：accepted（写入 README Known Limitations）
- **决策**：默认明文（与 JSONL 一致）；预留 `ENCRYPTION_KEY` 字段级加密扩展位，暂不实现。部署方可考虑 MySQL TDE / 静态加密。

## TD-004 — TLS/传输暂缓
- **状态**：deferred
- **决策**：`MYSQL_SSL_REQUIRED` 保留配置位；安全测试暂缓 TLS 强制项。

## TD-005 — dsh v0.1.2-rc.1 兼容对齐
- **状态**：resolved（2026-09-04，T6 迁移）
- **说明**：dsh 家族锁步发布 `0.1.2-rc.1`（latest）：持久化契约存写首参 `SessionHeader` → `SessionStorageMetadata{meta,inheritedEventCount}`；`SessionHeader` 移除 `seedLength`、新增必填 `isSeeded`；新增抽象 `borrowSession`、`ensureMaterialized` 与后端可选 hook `materializeHeader`；`readFrom` 返回 `SessionEventSuffix`。
- **处理**：peer/dev 升 `^0.1.2-rc.1`（cordis `^4.0.2`）；后端 hooks 适配存储元数据并实现 `materializeHeader`；`seed_length` 列保留为继承前缀编码（`isSeeded` 由列非空推导，镜像 JSONL，零 DDL 迁移、向后兼容存量）；子类实现 `borrowSession`/`ensureMaterialized`、`create`/`readFrom` 按新签名转传。typecheck(0 错误)/biome/build/test(47 绿)/覆盖率(lines 95.3) 全绿。

## TD-006 — list() 不分页不过滤
- **状态**：deferred
- **决策**：按接缝契约实现，不做扩展。

## TD-007 — 死锁重试分支与 close 分支的测试覆盖缺口
- **状态**：resolved（2026-09-01）
- **说明**：`mysql-backend.ts` 的死锁重试（`ER_LOCK_DEADLOCK`）与跨库 `close()` 分支此前缺定向测试。
- **处理**：新增 `test/unit/mysql-backend.test.ts`（4 例）——mock 池注入瞬时/持续死锁验证重试与放弃语义；同库/异库 `close()` 验证只关一次/各关一次。
