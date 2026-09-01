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

## 8. 在 dsh 中集成（npm 安装 + `cordis.patch.yml`）

正常使用请用 npm 包安装（开发期 `file:` 试用见 `docs/DSH_PROFILE_TRIAL.md`）。

### 8.1 安装到目标 profile

```bash
dsh plugin --profile <name> add @sandersyao/dsh-session-persistence-mysql
```

### 8.2 用 MySQL 替换默认 jsonl 后端

dsh 的 profile 是补丁组合；默认 jsonl 后端在 `dsh-base` bundle 里以 id `session-persistence-jsonl` 声明。在目标 profile 的 `cordis.patch.yml` 中**停用 jsonl、插入 MySQL**：

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-mysql
      name: '@sandersyao/dsh-session-persistence-mysql'
      config:
        connection:
          tablePrefix: dsh_
```

> 说明：
> - patch 按插件 `id` 定位、后者覆盖前者；`disabled: true` 停用，`insert:` 追加新行。
> - `name` 必须是包名；插件默认导出即插件类，loader 直接构造。
> - `config` 可选；主机/库/凭据由环境变量 `MYSQL_*` 提供（见 §2/§3），`connection.tablePrefix` 可在此覆盖 env 的 `MYSQL_TABLE_PREFIX`。

### 8.3 会话迁移注意

`ctx.sessionPersistence` 每 profile 仅一个后端。切到 MySQL 后，**该 profile 内已有的 JSONL 会话（`~/.dsh/sessions/...`）不会出现在 MySQL**——若需保留旧会话，请在**新 profile** 上启用（旧 profile 不动），或先迁移数据。

### 8.4 校验

```bash
dsh --dump-config --profile <name>   # 查看组合后是否已含 session-persistence-mysql、jsonl 是否 disabled
dsh --profile <name>
```

