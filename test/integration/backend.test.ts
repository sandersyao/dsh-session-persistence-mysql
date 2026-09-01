import type { SessionHeader } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";

import { createReadPool, createWritePool } from "../../src/pool.js";
import { ensureSchema } from "../../src/schema.js";
import { setupTestDb, type TestDbHandle } from "../helpers/db.js";
import { balancedTurnEvents } from "../helpers/events.js";

/** 被测试的装配句柄。 */
let handle: TestDbHandle | undefined;

afterEach(async () => {
  await handle?.dispose();
  handle = undefined;
});

/** 构造测试会话头。 */
function header(id: string): SessionHeader {
  return { version: 0, id, createdAt: 1_700_000_000_000 };
}

describe("后端级：commitRepair 与跨进程双写", () => {
  it("commitRepair 追加 closers（tornMarker 恒为 undefined）", async () => {
    handle = await setupTestDb();
    const { backend } = handle;
    const meta = header("sess-repair");
    const closers = balancedTurnEvents(4, 9);
    // 先 materialize，再 repair 追加（closers 从 seq 4 续写）。
    await backend.appendBatch(meta, balancedTurnEvents(0), false);
    await backend.commitRepair(meta, undefined, closers);

    const stored = await backend.loadStored("sess-repair" as never);
    expect(stored?.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("跨进程双写：两个后端写同一会话的重叠 seq，其中一个被拒", async () => {
    handle = await setupTestDb();
    const { settings, prefix } = handle;
    // 第二个后端共用同一套表（同一前缀），模拟另一进程写者。
    const writePool2 = createWritePool(settings.connection, settings.pool);
    const readPool2 = createReadPool(settings.connection, settings.readConnection, settings.pool);
    await ensureSchema(writePool2, prefix, { autoMigrate: true });
    const backend2 = await import("../../src/mysql-backend.js").then(
      (m) => new m.MysqlBackend(writePool2, readPool2, readPool2 === writePool2, settings),
    );

    const id = "sess-dual-writer";
    const meta = header(id);
    // 写者 1：materialize 并写 seq 0-3。
    await handle.backend.appendBatch(meta, balancedTurnEvents(0), false);
    // 写者 2：以同一 id 再次 materialize 写 seq 0-3 → 主键冲突，必须被拒。
    await expect(backend2.appendBatch(meta, balancedTurnEvents(0), false)).rejects.toThrow();

    // 清理第二后端（表格由 afterEach 统一 drop，这里只关池）。
    if (readPool2 === writePool2) await writePool2.end();
    else await Promise.all([writePool2.end(), readPool2.end()]);
  });
});
