# 部署文档 —— dsh-session-persistence-mysql

## 1. 数据库与最小权限

使用**专项最小权限用户**，勿用 root。对目标库的三张前缀表授予最小 DML（schema 迁移另见 §4）：

```sql
-- 假设前缀为 dsh_，数据库为 dsh_session
CREATE USER 'dsh'@'%' IDENTIFIED BY '<strong-password>';
GRANT SELECT, INSERT, UPDATE, DELETE
  ON `dsh_session`.`dsh_sessions`, `dsh_session`.`dsh_events`, `dsh_session`.`dsh__meta`
  TO 'dsh'@'%';
FLUSH PRIVILEGES;
```

如需插件启动时自动建表（`MYSQL_SCHEMA_AUTO_MIGRATE=true`，默认），还需 `CREATE` 与 `ALTER` 权限，或改用外部迁移（§4）并设 `false`。

## 2. 凭据与传输

- 凭据只经环境变量 / 密钥管理注入，**绝不硬编码、绝不进日志**（本插件已做日志脱敏与配置不回显）。
- 传输加密（TLS）当前**预留**：`MYSQL_SSL_REQUIRED` 位保留，届时可配合云 RDS 的 SSL/TLS。生产建议启用云厂商的强制 TLS。
- 网络收窄：DB 绑定内网地址，应用侧用安全组/防火墙白名单；勿暴露公网 3306。

## 3. 读写分离

- 写库 `MYSQL_HOST`，读库 `MYSQL_READ_HOST`（独立只读副本，只读账号 `MYSQL_READ_USER`）。
- 未配置读库时读池复用写库（同库模式）。
- 读副本建议开启一致性快照读取；revision 语义允许轻微滞后。

## 4. Schema 迁移策略

- 默认 `MYSQL_SCHEMA_AUTO_MIGRATE=true`：启动自动幂等建表 + 版本校验/迁移。
- 生产严谨做法：设 `false`，由独立迁移工具（如 Flyway/Liquibase）执行本插件提供的 DDL（见 `src/schema.ts`），启动仅校验版本一致；版本不一致则 fail-closed。

## 5. 容量规划

参考公式（详见 `docs/DESIGN.md` §8）：

```
Disk(session) ≈ [ Σ c_t·p_t + R·(n − n_c + c_p) − (n_c − c_p)·(R + p_chunk) ] × A
Capacity      = Disk/day × 保留天数       # A≈1.5–2.0
```

- 开启 `MYSQL_PACK_CHUNKS`（默认）可省约 35% 磁盘。
- 无删除/归档 API：按保留期由外部任务 `DELETE` 旧会话行（注意外键顺序：先 events 后 sessions）。

## 6. 监控与可观测

- 关注连接池使用率、写入延迟、`ER_LOCK_DEADLOCK` 计数（已内置有限重试）。
- 日志为结构化中文描述、脱敏；错误路径不回显连接参数。

## 7. 优雅关停

插件 dispose 时协调器先排空所有 controller、等待在途写操作，再关闭写/读连接池（同库只关一次）。滚动发布前建议先停流量再缩容。
