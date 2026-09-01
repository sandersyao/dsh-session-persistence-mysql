import { Context } from "@deepseek-ai/cordis";
import { PersistenceCoordinator } from "@deepseek-ai/dsh-session-persistence";
import SessionStore from "@deepseek-ai/dsh-session";
import type { Pool } from "mysql2/promise";

import {
  loadSettingsFromEnv,
  mergeSettings,
  type MysqlSettings,
} from "../../src/config.js";
import { MysqlBackend } from "../../src/mysql-backend.js";
import { createReadPool, createWritePool } from "../../src/pool.js";
import { ensureSchema, tableNames } from "../../src/schema.js";

/** 每次测试装配递增的后缀，保证表前缀唯一。 */
let runCounter = 0;

/**
 * 一次测试装配的句柄：后端、协调器、上下文与清理入口。
 */
export interface TestDbHandle {
  /** 合并后的设置（表前缀唯一）。 */
  readonly settings: MysqlSettings;
  /** 后端实例。 */
  readonly backend: MysqlBackend;
  /** 协调器实例。 */
  readonly coordinator: PersistenceCoordinator<undefined>;
  /** Cordis 上下文。 */
  readonly ctx: Context;
  /** 写连接池。 */
  readonly writePool: Pool;
  /** 唯一表前缀。 */
  readonly prefix: string;
  /** 释放资源：回滚上下文、删表、关池。 */
  readonly dispose: () => Promise<void>;
}

/**
 * 装配一套隔离的 MySQL 测试环境（唯一表前缀 + schema + 后端 + 协调器）。
 * @returns 测试句柄。
 */
export async function setupTestDb(): Promise<TestDbHandle> {
  const base = loadSettingsFromEnv();
  const prefix = `t_${Date.now().toString(36)}_${runCounter++}_`;
  const settings = mergeSettings(base, { connection: { tablePrefix: prefix } });
  const writePool = createWritePool(settings.connection, settings.pool);
  const readPool = createReadPool(settings.connection, settings.readConnection, settings.pool);
  const shared = readPool === writePool;
  await ensureSchema(writePool, prefix, { autoMigrate: true });
  const backend = new MysqlBackend(writePool, readPool, shared, settings);
  const ctx = new Context();
  // 协调器写路径依赖 ctx.sessions（SessionStore）；先挂载内存 store。
  await ctx.plugin(SessionStore);
  const coordinator = new PersistenceCoordinator(ctx, backend, {
    preparedSessionCacheSize: 5,
    writeBatchMaxDelayMs: 50,
  });

  const dispose = async () => {
    await coordinator.dispose?.();
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

  return { settings, backend, coordinator, ctx, writePool, prefix, dispose };
}
