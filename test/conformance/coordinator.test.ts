import { afterEach, describe, expect, it } from "vitest";

import type { SessionHeader } from "@deepseek-ai/dsh-session";

import { balancedTurnEvents, chunkEvent, structuralEvent } from "../helpers/events.js";
import { setupTestDb, type TestDbHandle } from "../helpers/db.js";

/** 被测试的装配句柄。 */
let handle: TestDbHandle | undefined;

afterEach(async () => {
  await handle?.dispose();
  handle = undefined;
});

/** 构造一个测试会话头。 */
function header(id: string): SessionHeader {
  return {
    version: 0,
    id,
    createdAt: 1_700_000_000_000,
    cwd: "/tmp/proj",
    delegationDepth: 0,
    agentPreset: "test",
  };
}

describe("MySQL 后端契约（协调器驱动）", () => {
  it("create → append → load 往返无损（header + 事件）", async () => {
    handle = await setupTestDb();
    const { coordinator } = handle;
    const id = "sess-1";
    const meta = header(id);
    await coordinator.create(meta);
    await coordinator.append(id, balancedTurnEvents(0));

    const loaded = await coordinator.load(id);
    expect(loaded.meta.id).toBe(id);
    expect(loaded.meta.cwd).toBe("/tmp/proj");
    expect(loaded.meta.agentPreset).toBe("test");
    expect(loaded.events).toEqual(balancedTurnEvents(0));
  });

  it("lazy materialization：未 append 前 list 为空、append 后可见", async () => {
    handle = await setupTestDb();
    const { coordinator, backend } = handle;
    const id = "sess-lazy";
    await coordinator.create(header(id));

    expect(await backend.list()).toEqual([]);

    await coordinator.append(id, balancedTurnEvents(0));
    const headers = await backend.list();
    expect(headers.map((h) => h.id)).toEqual([id]);
  });

  it("连续 append 保持 seq 连续且全部可读", async () => {
    handle = await setupTestDb();
    const { coordinator } = handle;
    const id = "sess-seq";
    await coordinator.create(header(id));
    await coordinator.append(id, balancedTurnEvents(0));
    await coordinator.append(id, balancedTurnEvents(4, 2));

    const loaded = await coordinator.load(id);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("readFrom 从指定 seq 读后缀（seek）", async () => {
    handle = await setupTestDb();
    const { coordinator } = handle;
    const id = "sess-readfrom";
    await coordinator.create(header(id));
    await coordinator.append(id, balancedTurnEvents(0));
    await coordinator.append(id, balancedTurnEvents(4, 2));

    const suffix = await coordinator.readFrom(id, 4);
    expect(suffix.events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    expect(suffix.meta.id).toBe(id);
  });

  it("readFrom 超过末尾返回空事件", async () => {
    handle = await setupTestDb();
    const { coordinator } = handle;
    const id = "sess-empty-tail";
    await coordinator.create(header(id));
    await coordinator.append(id, balancedTurnEvents(0));
    const suffix = await coordinator.readFrom(id, 10);
    expect(suffix.events).toEqual([]);
  });

  it("append 非连续 seq 被拒（contiguous-seq 契约）", async () => {
    handle = await setupTestDb();
    const { coordinator } = handle;
    const id = "sess-gap";
    await coordinator.create(header(id));
    await coordinator.append(id, balancedTurnEvents(0));
    // 下一个 append 应从 seq 4 开始；从 5 开始会造成缺口，协调器应拒绝。
    await expect(coordinator.append(id, balancedTurnEvents(5, 2))).rejects.toThrow();
  });

  it("chunk 折叠写入后 load 仍无损还原", async () => {
    handle = await setupTestDb();
    const { coordinator, backend } = handle;
    const id = "sess-chunk";
    await coordinator.create(header(id));
    const events = [
      structuralEvent("turn/start", 0, { turn: 1 }),
      chunkEvent(1, "a"),
      chunkEvent(2, "b"),
      chunkEvent(3, "c"),
      structuralEvent("turn/end", 4, { turn: 1, reason: { kind: "completed" } }),
    ];
    await coordinator.append(id, events);

    const loaded = await coordinator.load(id);
    expect(loaded.events).toEqual(events);
    expect(backend.name).toBe("session-persistence-mysql");
  });

  it("readStoredRevision 在 append 后变化，未变时稳定", async () => {
    handle = await setupTestDb();
    const { coordinator, backend } = handle;
    const id = "sess-rev";
    await coordinator.create(header(id));
    await coordinator.append(id, balancedTurnEvents(0));

    const rev1 = await backend.readStoredRevision(id);
    expect(typeof rev1).toBe("string");
    expect(rev1).toMatch(/v1#1$/);
    const rev1b = await backend.readStoredRevision(id);
    expect(rev1b).toEqual(rev1);

    await coordinator.append(id, balancedTurnEvents(4, 2));
    const rev2 = await backend.readStoredRevision(id);
    expect(rev2).not.toEqual(rev1);
  });

  it("listSnapshots 返回 header + revision", async () => {
    handle = await setupTestDb();
    const { coordinator, backend } = handle;
    const id = "sess-snap";
    await coordinator.create(header(id));
    await coordinator.append(id, balancedTurnEvents(0));
    const snaps = await backend.listSnapshots();
    expect(snaps.length).toBeGreaterThan(0);
    const snap = snaps.find((s) => s.header.id === id);
    expect(snap).toBeDefined();
    expect(typeof snap?.revision).toBe("string");
  });
});
