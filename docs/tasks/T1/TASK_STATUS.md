# T1 基础设施 —— 任务交接

**状态**：进行中
**负责人**：本仓库开发 Agent
**依赖**：无（空工作区起步）

## 目标
初始化代码仓库与工程脚手架，使后续任务（DDL、hooks、测试）可在此基础上落地。

## 已完成
- [x] `git init -b main`（Git 已配置 user.name=皮卡丘 / email=pikaqiu@ifmuse.com）
- [x] `package.json`：ESM、peer 依赖对齐 `^0.1.1-rc.2`、dev 依赖钉死 `0.1.1-rc.2`
- [x] `tsconfig.json`（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）
- [x] `tsup.config.ts`（ESM + dts → lib/）
- [x] `biome.json`（格式 + lint，空格缩进 2，双引号，行宽 100）
- [x] `.env.example` / `.env`（env 加载；凭据不入库）
- [x] `compose.yml`（mysql:8.0，env 取自 .env，healthcheck）
- [x] `.github/workflows/ci.yml`（GHA services: mysql + typecheck/lint/build/test/coverage）
- [x] `vitest.config.ts`（覆盖率门禁 lines≥90）
- [x] `AGENTS.md`（代码风格/安全基线/测试要求/交接规范）
- [x] `.agents/`（notes 目录约定）
- [ ] `pnpm install` 成功（后台进行中）
- [ ] 依赖安装后验证 `typecheck`/`lint`/`build` 空跑通过（需 src 骨架）

## 待办/交接给 T2
- 依赖装好后创建 `src/` 骨架（`index.ts`、`invariant.ts`、`schema.ts` 等），使 build/typecheck 可跑。
- 确认 biome 校验通过、格式一致。

## 技术债
- npm 全局缓存 `/Users/yaoxiaowei/.npm` 有 root 属主文件导致 EPERM → 用项目内 `.pnpm-store`（`.npmrc`）绕开；CI 环境无此问题。

## 验收
- `pnpm install` 无错误；`pnpm typecheck`、`pnpm lint` 通过（空骨架）。

**交接给**：T2（数据模型与 DDL）
