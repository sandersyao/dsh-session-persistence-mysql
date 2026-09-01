import { Context } from "@deepseek-ai/cordis";
import SessionStore from "@deepseek-ai/dsh-session";
import type { Pool } from "mysql2/promise";
import { createPool } from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import { MysqlSessionPersistence } from "../../src/index.js";
import { tableNames } from "../../src/schema.js";
import { balancedTurnEvents } from "../helpers/events.js";

/** 当前 e2e 用到的连接池与唯一前缀。 */
let pool: Pool | undefined;
let prefix: string | undefined;

afterEach(async () => {
  if (pool && prefix) {
    const names = tableNames(prefix);
    await pool.query(
      `DROP TABLE IF EXISTS \`${names.events}\`, \`${names.sessions}\`, \`${names.meta}\``,
    );
    await pool.end();
  }
  pool = undefined;
  prefix = undefined;
});

describe("e2e：插件加载与全流程", () => {
  it("挂载插件注册 ctx.sessionPersistence，schema 就绪，create/append/load/list 全流程", async () => {
    const c = new Context();
    prefix = `e_${Date.now().toString(36)}_`;
    await c.plugin(SessionStore);
    await c.plugin(MysqlSessionPersistence, {
      connection: { tablePrefix: prefix },
    });

    const persistence = c.sessionPersistence;
    expect(persistence).toBeInstanceOf(MysqlSessionPersistence);

    // 初始为空。
    expect(await persistence.list()).toEqual([]);

    const id = "e2e-sess-1";
    await persistence.create({
      version: 0,
      id,
      createdAt: 1_700_000_000_000,
      cwd: "/tmp/e2e",
      delegationDepth: 0,
    });

    // 未 append 前 lazy，list 为空。
    expect(await persistence.list()).toEqual([]);

    await persistence.append(id, balancedTurnEvents(0));
    await persistence.append(id, balancedTurnEvents(4, 2));

    // 已 materialize，list 可见。
    const headers = await persistence.list();
    expect(headers.map((h) => h.id)).toEqual([id]);

    // load 还原全部事件。
    const loaded = await persistence.load(id);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // readFrom seek。
    const suffix = await persistence.readFrom(id, 4);
    expect(suffix.events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);

    // locate 无工件、readRaw 拒绝。
    expect(persistence.locate(loaded.meta)).toBeUndefined();
    expect(persistence.supportsRawArtifacts).toBe(false);
    await expect(persistence.readRaw(id, new AbortController().signal)).rejects.toThrow();

    // 记录连接池以便清理（连接测试库，与插件一致）。
    pool = createPool({
      host: process.env.MYSQL_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? "dsh",
      password: process.env.MYSQL_PASSWORD ?? "dsh_dev_password",
      database: process.env.MYSQL_DATABASE ?? "test",
    });
  });
});
