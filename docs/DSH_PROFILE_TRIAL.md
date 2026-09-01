# DSH Profile 试用 MySQL 后端（开发期流程）

> 开发期把本地 MySQL 插件装进一个**独立 dsh profile** 试用，**不影响现有 profile 与现有 JSONL 会话**。正常使用请走 npm 包安装（见 `docs/DEPLOYMENT.md` §dsh 集成）。

## 原理

- dsh 每个 profile 是独立的插件组合，会话持久化后端是每个 profile 一个 `ctx.sessionPersistence`。
- 现有 profile 的会话是 JSONL 文件（`~/.dsh/sessions/<cwd>/<id>/session.jsonl.zstd`）。若在**当前** profile 换 MySQL 后端，MySQL 读的是空表，现有会话会立刻不可见。
- 因此试用一律用**新 profile** + **独立 MySQL 库/前缀**，老 profile 随时切回。

## 前置

- 本仓库已构建：`cd <repo> && pnpm build`（产出 `lib/`）。
- MySQL 已起、有独立试用库（如 `dsh_session_trial`）、`dsh` 用户有权限。

## 步骤

**1. 建试用 profile（以 web 为模板）**
```bash
cp -R ~/.dsh/profiles/web ~/.dsh/profiles/web-mysql
```

**2. 把本地插件装进 profile**（`dsh plugin` 转发给 pnpm，支持 `file:`）
```bash
dsh plugin --profile web-mysql add "file:/<仓库绝对路径>"
```
> 插件运行时依赖（`dotenv`/`mysql2`/`schemastery`）会随 `dependencies` 装进 profile。
> 若改了仓库的 `dependencies`/`lib/`，需在 profile 重装：`cd ~/.dsh/profiles/web-mysql && pnpm install --force`。

**3. 写 `~/.dsh/profiles/web-mysql/cordis.patch.yml`**——替换默认 jsonl 后端：
```yaml
# 用 MySQL 后端替换默认 jsonl 后端（仅本 profile 生效）
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-mysql
      name: '@sandersyao/dsh-session-persistence-mysql'
      config:
        connection:
          tablePrefix: trial_
```

**4. 注入 `MYSQL_*` 环境变量**（写到 `~/.dsh/.env`，或 shell export）：
```bash
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=dsh
MYSQL_PASSWORD=<试用库密码>
MYSQL_DATABASE=dsh_session_trial
MYSQL_TABLE_PREFIX=trial_
# MYSQL_READ_HOST 留空 = 同库模式
```

**5. 启动**
```bash
dsh --profile web-mysql
```

## 验证与切回

- 新会话写入 MySQL 试用库；`web` profile 及其 JSONL 会话不受影响。
- 随时 `dsh --profile web` 切回现有会话。

## 注意事项

- 依赖未发布 npm 时用 `file:`；发布后改用 `dsh plugin --profile web-mysql add @sandersyao/dsh-session-persistence-mysql`。
- 若报 `Cannot find package 'dotenv'`：说明 profile 里链接的是旧依赖（dotenv 曾为 devDependency），执行 `cd ~/.dsh/profiles/web-mysql && pnpm install --force` 重装即可。
