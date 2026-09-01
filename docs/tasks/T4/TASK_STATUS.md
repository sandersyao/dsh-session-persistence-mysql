# T4 配置/连接池/安全 —— 任务交接

**状态**：completed
**依赖**：T3
**交接给**：T5（已完成）

## 产出
- `src/config.ts`：`loadSettingsFromEnv`（env/.env 解析，缺凭据 fail-closed）、`mergeSettings`（env 基址 + 用户覆盖）、连接/池/持久化/安全设置类型。
- `src/pool.ts`：`buildPoolOptions`（参数化，无 ssl 时不带该键）。
- 安全集成测试 `test/integration/security.test.ts`（6 例）。

## 安全基线落地
- 凭据只来自 env/.env；配置不回显；日志脱敏。
- 全参数化占位符；会话 id 不作 SQL 标识符拼接；表前缀校验 `^[A-Za-z0-9_]+$`。
- 最小权限授权语句见 `docs/DEPLOYMENT.md`。
- 明文默认 + `encryptionKey` 预留；TLS 暂缓（`sslRequired` 位保留）。

## 验收
- 安全测试 6 例全过（注入/前缀/版本回退/fail-closed/损坏检测）。
- 遗留：真实死锁重试分支未定向覆盖（TD-007）。
