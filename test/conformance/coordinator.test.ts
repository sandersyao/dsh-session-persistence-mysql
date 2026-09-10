import type { SessionHeader } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";
import { setupTestDb, type TestDbHandle } from "../helpers/db.js";
import { balancedTurnEvents, chunkEvent, structuralEvent } from "../helpers/events.js";

/** 被测试的装配句柄。 */
let handle: TestDbHandle | undefined;

afterEach(async () => {
  await handle?.dispose();
  handle = undefined;
});

/** 构造一个测试会话头（0.1.5 格式：version=3）。 */
function header(id: string): SessionHeader {
  return {
    version: 3,
    id,
    createdAt: 1_700_000_000_000,
    isSeeded: false,
    cwd: "/tmp/proj",
    agentPreset: "test",
  };
}

describe("MySQL 后端契约（0.1.5 SessionPersistence API）", () => {
  it("create → append → read 往返无损（header + 事件）", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "sess-1";
    const meta = header(id);
    const writeHandle = await persistence.create(meta);
    await writeHandle.append(balancedTurnEvents(0));

    const readHandle = await persistence.open(id, "read");
    const loaded = await readHandle.read();
    expect(loaded.events).toEqual(balancedTurnEvents(0));
    const stat = await persistence.stat(id);
    expect(stat?.header.id).toBe(id);
    expect(stat?.header.cwd).toBe("/tmp/proj");
    expect(stat?.header.agentPreset).toBe("test");
    await readHandle.close();
    await writeHandle.close();
  });

  it("lazy materialization：未 append 前 list 为空、append 后可见", async () => {
    handle = await setupTestDb();
    const { persistence, backend } = handle;
    const id = "sess-lazy";
    const writeHandle = await persistence.create(header(id));

    expect(await backend.listSnapshots()).toEqual([]);

    await writeHandle.append(balancedTurnEvents(0));
    const headers = await backend.listSnapshots();
    expect(headers.map((h) => h.header.id)).toEqual([id]);
    await writeHandle.close();
  });

  it("连续 append 保持 seq 连续且全部可读", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "sess-seq";
    const writeHandle = await persistence.create(header(id));
    await writeHandle.append(balancedTurnEvents(0));
    await writeHandle.append(balancedTurnEvents(4, 2));

    const readHandle = await persistence.open(id, "read");
    const loaded = await readHandle.read();
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await readHandle.close();
    await writeHandle.close();
  });

  it("read offset 从指定 seq 读后缀（seek）", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "sess-readfrom";
    const writeHandle = await persistence.create(header(id));
    await writeHandle.append(balancedTurnEvents(0));
    await writeHandle.append(balancedTurnEvents(4, 2));
    await writeHandle.flush();

    const readHandle = await persistence.open(id, "read");
    const suffix = await readHandle.read(4);
    expect(suffix.events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    await readHandle.close();
    await writeHandle.close();
  });

  it("read offset 超过末尾返回空事件", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "sess-empty-tail";
    const writeHandle = await persistence.create(header(id));
    await writeHandle.append(balancedTurnEvents(0));
    await writeHandle.flush();

    const readHandle = await persistence.open(id, "read");
    const suffix = await readHandle.read(10);
    expect(suffix.events).toEqual([]);
    await readHandle.close();
    await writeHandle.close();
  });

  it("append 非连续 seq 被拒（contiguous-seq 契约）", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "sess-gap";
    const writeHandle = await persistence.create(header(id));
    await writeHandle.append(balancedTurnEvents(0));
    // 下一个 append 应从 seq 4 开始；从 5 开始会造成缺口，handle 应拒绝。
    await expect(writeHandle.append(balancedTurnEvents(5, 2))).rejects.toThrow(/seq mismatch/);
    await writeHandle.close();
  });

  it("混合事件（含 assistant/message）写入后 read 仍无损还原", async () => {
    handle = await setupTestDb();
    const { persistence, backend } = handle;
    const id = "sess-chunk";
    const writeHandle = await persistence.create(header(id));
    const events = [
      structuralEvent("turn/start", 0, { turn: 1 }),
      chunkEvent(1, "a"),
      chunkEvent(2, "b"),
      chunkEvent(3, "c"),
      structuralEvent("turn/end", 4, { turn: 1, reason: { kind: "completed" } }),
    ];
    await writeHandle.append(events);
    await writeHandle.flush();

    const readHandle = await persistence.open(id, "read");
    const loaded = await readHandle.read();
    expect(loaded.events).toEqual(events);
    expect(backend.name).toBe("session-persistence-mysql");
    await readHandle.close();
    await writeHandle.close();
  });

  it("stat revision 在 append 后变化，未变时稳定", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "sess-rev";
    const writeHandle = await persistence.create(header(id));
    await writeHandle.append(balancedTurnEvents(0));
    await writeHandle.flush();

    const rev1 = (await persistence.stat(id))?.revision;
    expect(typeof rev1).toBe("string");
    const rev1b = (await persistence.stat(id))?.revision;
    expect(rev1b).toEqual(rev1);

    await writeHandle.append(balancedTurnEvents(4, 2));
    await writeHandle.flush();
    const rev2 = (await persistence.stat(id))?.revision;
    expect(rev2).not.toEqual(rev1);
    await writeHandle.close();
  });

  it("list 返回 header + revision", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "sess-snap";
    const writeHandle = await persistence.create(header(id));
    await writeHandle.append(balancedTurnEvents(0));
    await writeHandle.flush();
    const snaps = await persistence.list();
    expect(snaps.length).toBeGreaterThan(0);
    const snap = snaps.find((s) => s.header.id === id);
    expect(snap).toBeDefined();
    expect(typeof snap?.revision).toBe("string");
    await writeHandle.close();
  });
});
