import { Context } from "@deepseek-ai/cordis";
import SessionStore from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";

import { MysqlSessionPersistence } from "../../src/index.js";
import { balancedTurnEvents } from "../helpers/events.js";

/** 当前 e2e 用到的上下文与唯一前缀。 */
let ctx: Context | undefined;
let prefix: string | undefined;

afterEach(async () => {
  if (ctx && prefix) {
    const { writePool, tableNames } = await import("../../src/pool.js").then(
      (m) => ({ writePool: undefined, tableNames: undefined }),
    );
    void writePool;
    void tableNames;
    await ctx.fiber.dispose().catch(() => {});
    ctx = undefined;
    prefix = undefined;
  }
});

describe("e2e：插件加载与全流程", () => {
  it("挂载插件注册 ctx.sessionPersistence，schema 就绪，create/append/load/list 全流程", async () => {
    const c = new Context();
    ctx = c;
    prefix = `e_${Date.now().toString(36)}_`;
    await c.plugin(SessionStore);
    await c.plugin(MysqlSessionPersistence, {
      connection: { tablePrefix: prefix },
    });

    const persistence = c.sessionPersistence as MysqlSessionPersistence;
    expect(persistence).toBeInstanceOf(MysqlSessionPersistence);

    // 初始为空。
    expect(await persistence.list()).toEqual([]);

    const id = "e2e-sess-1";
    const writeHandle = await persistence.create({
      version: 3,
      id,
      createdAt: 1_700_000_000_000,
      isSeeded: false,
      cwd: "/tmp/e2e",
    });

    // 未 append 前 lazy，list 不可见（pending 只在本进程）。
    await writeHandle.append(balancedTurnEvents(0));
    await writeHandle.append(balancedTurnEvents(4, 2));
    await writeHandle.flush();

    // 已 materialize，list 可见。
    const headers = await persistence.list();
    expect(headers.map((s) => s.header.id)).toContain(id);

    // 重新打开 read handle 取回所有事件。
    const readHandle = await persistence.open(id, "read");
    const reread = await readHandle.read();
    expect(reread.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // read offset seek。
    const suffix = await readHandle.read(4);
    expect(suffix.events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);

    await readHandle.close();
    await writeHandle.close();
  });
});
