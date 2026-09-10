import { Context } from "@deepseek-ai/cordis";
import SessionStore from "@deepseek-ai/dsh-session";
import type { Pool } from "mysql2/promise";

import { loadSettingsFromEnv, type MysqlSettings, mergeSettings } from "../../src/config.js";
import { MysqlBackend } from "../../src/mysql-backend.js";
import { MysqlSessionPersistence } from "../../src/index.js";
import { createReadPool, createWritePool } from "../../src/pool.js";
import { ensureSchema, tableNames } from "../../src/schema.js";

/** 每次测试装配递增的后缀，保证表前缀唯一。 */
let runCounter = 0;

/**
 * 一次测试装配的句柄：插件、后端、上下文与清理入口。
 */
export interface TestDbHandle {
  /** 合并后的设置（表前缀唯一）。 */
  readonly settings: MysqlSettings;
  /** 后端实例。 */
  readonly backend: MysqlBackend;
  /** 服务实例（`ctx.sessionPersistence`）。 */
  readonly persistence: MysqlSessionPersistence;
  /** Cordis 上下文。 */
  readonly ctx: Context;
  /** 写连接池。 */
  readonly writePool: Pool;
  /** 唯一表前缀。 */
  readonly prefix: string;
  /** 释放资源：tear down ctx → 删表 → 关池。 */
  readonly dispose: () => Promise<void>;
}

/**
 * 装配一套隔离的 MySQL 测试环境（唯一表前缀 + schema + 后端 + 服务）。
 * @returns 测试句柄。
 */
export async function setupTestDb(): Promise<TestDbHandle> {
  const base = loadSettingsFromEnv();
  const prefix = `t_${Date.now().toString(36)}_${runCounter++}_${Math.random().toString(36).slice(2, 10)}_`;
  const settings = mergeSettings(base, { connection: { tablePrefix: prefix } });
  const writePool = createWritePool(settings.connection, settings.pool);
  const readPool = createReadPool(settings.connection, settings.readConnection, settings.pool);
  const shared = readPool === writePool;
  await ensureSchema(writePool, prefix, { autoMigrate: true });
  const backend = new MysqlBackend(writePool, readPool, shared, settings);
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  // 关键：把本次测试的 tablePrefix 一并传给 persistence，使插件使用与 setup 同套表。
  const persistence = new MysqlSessionPersistence(ctx, { connection: { tablePrefix: prefix } });
  await persistence[Symbol.for("cordis.init")]?.();

  const dispose = async () => {
    // teardown 顺序：ctx fiber（关闭所有 handle 与 effect）→ 关池 → 删表。
    try {
      await ctx.fiber.dispose();
    } catch {
      // ignore
    }
    const names = tableNames(prefix);
    await writePool.query(
      `DROP TABLE IF EXISTS \`${names.events}\`, \`${names.sessions}\`, \`${names.meta}\``,
    );
    if (shared) {
      await writePool.end();
    } else {
      await Promise.all([writePool.end(), readPool.end()]);
    }
  };

  return { settings, backend, persistence, ctx, writePool, prefix, dispose };
}
