import type { SessionHeader } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";

import { MysqlBackend } from "../../src/mysql-backend.js";
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

/** 构造测试会话头（0.1.5 格式：version=3）。 */
function header(id: string): SessionHeader {
  return { version: 3, id, createdAt: 1_700_000_000_000, isSeeded: false };
}

describe("后端级：跨进程双写与 fork 边界", () => {
  it("跨进程双写：重叠 seq 且内容不同 → 被拒（真冲突）", async () => {
    handle = await setupTestDb();
    const { settings, prefix, persistence } = handle;
    await persistence.dispose();
    // 第二个后端共用同一套表（同一前缀），模拟另一进程写者。
    const writePool2 = createWritePool(settings.connection, settings.pool);
    const readPool2 = createReadPool(settings.connection, settings.readConnection, settings.pool);
    await ensureSchema(writePool2, prefix, { autoMigrate: true });
    const backend2 = await import("../../src/mysql-backend.js").then(
      (m) => new m.MysqlBackend(writePool2, readPool2, readPool2 === writePool2, settings),
    );

    const id = "sess-dual-writer";
    const meta = header(id);
    const first = balancedTurnEvents(0);
    // 写者 1：materialize 并写 seq 0-3。
    await handle.backend.persistBatch(meta, first, false, 0);
    // 写者 2：同 seq 但内容不同 → 真冲突，必须被拒（幂等只放行内容一致的重放）。
    const conflicting = first.map((e, i) => (i === 0 ? { ...e, time: 999 } : e));
    await expect(backend2.persistBatch(meta, conflicting as never, false, 0)).rejects.toThrow();

    // 清理第二后端（表格由 afterEach 统一 drop，这里只关池）。
    if (readPool2 === writePool2) await writePool2.end();
    else await Promise.all([writePool2.end(), readPool2.end()]);
  });

  it("同批重放（提交成功但 ack 丢失）→ 幂等 no-op，不重复写、revision 不变", async () => {
    handle = await setupTestDb();
    const { backend } = handle;
    const id = "sess-replay";
    const meta = header(id);
    const batch = balancedTurnEvents(0);
    await backend.persistBatch(meta, batch, false, 0);
    const before = (await backend.readStoredLog(id as never)).revision;
    // 首批重放：sessions 主键重复 → 幂等 no-op。
    await backend.persistBatch(meta, batch, false, 0);
    // 已 materialize 的重放：events 主键重复 → 幂等 no-op。
    await backend.persistBatch(meta, batch, true, 0);
    const after = await backend.readStoredLog(id as never);
    expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(after.revision).toBe(before);
  });

  it("seeded 会话：seed_length 列编码 inheritedEventCount，读回 isSeeded=true", async () => {
    handle = await setupTestDb();
    const { backend } = handle;
    const id = "sess-seed";
    const meta = {
      version: 3,
      id: id as never,
      createdAt: 1_700_000_000_000,
      isSeeded: true,
      parentSession: "parent" as never,
    };
    // 首个 materialize 批次 + 后续事件（seq 从 0 续）。
    await backend.persistBatch(meta, balancedTurnEvents(0), false, 4);
    await backend.persistBatch(meta, balancedTurnEvents(4, 2), true, 4);

    const stored = await backend.readStoredLog(id as never);
    expect(stored.meta.isSeeded).toBe(true);
    expect(Number(stored.inheritedEventCount)).toBe(4);
    expect(stored.meta.parentSession).toBe("parent");
    expect(stored.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 未 seed 的对照：seed_length 为 NULL → isSeeded=false、inheritedEventCount=0。
    await backend.persistBatch(
      { version: 3, id: "sess-plain" as never, createdAt: 1, isSeeded: false },
      balancedTurnEvents(0),
      false,
      0,
    );
    const plain = await backend.readStoredLog("sess-plain" as never);
    expect(plain.meta.isSeeded).toBe(false);
    expect(Number(plain.inheritedEventCount)).toBe(0);
  });

  it("persistHeader 持久化空会话 header（无事件）", async () => {
    handle = await setupTestDb();
    const { backend } = handle;
    const meta = { version: 3, id: "sess-empty" as never, createdAt: 1, isSeeded: false };
    await backend.persistHeader(meta, 0);

    const stored = await backend.readStoredLog("sess-empty" as never);
    expect(stored.meta.id).toBe("sess-empty");
    expect(stored.events).toEqual([]);
    expect(Number(stored.inheritedEventCount)).toBe(0);
    const snaps = await backend.listSnapshots();
    expect(snaps.map((s) => s.header.id)).toContain("sess-empty");
  });
});

// avoid unused-import warning for the local import; keep type-check coverage.
void MysqlBackend;
