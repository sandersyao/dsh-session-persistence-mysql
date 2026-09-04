import { afterEach, describe, expect, it } from "vitest";
import { setupTestDb, type TestDbHandle } from "../helpers/db.js";
import { balancedTurnEvents } from "../helpers/events.js";

/** 被测试的装配句柄。 */
let handle: TestDbHandle | undefined;

afterEach(async () => {
  await handle?.dispose();
  handle = undefined;
});

describe("安全：SQL 注入与边界（优先）", () => {
  it("恶意会话 id 被当作字面量参数化，不构成注入", async () => {
    handle = await setupTestDb();
    const { coordinator, backend } = handle;
    // 注入负载作为会话 id。
    const maliciousId = "sess'; DROP TABLE t_sessions; --";
    await coordinator.create({
      version: 0,
      id: maliciousId,
      createdAt: 1,
      isSeeded: false,
    });
    await coordinator.append(maliciousId, balancedTurnEvents(0));

    const loaded = await coordinator.load(maliciousId);
    expect(loaded.meta.id).toBe(maliciousId);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);

    // 表应仍然存在（未被注入语句删除）。
    const headers = await backend.list();
    expect(headers.map((h) => h.id)).toContain(maliciousId);
  });

  it("事件负载中的 SQL 片段被原样存储，不执行", async () => {
    handle = await setupTestDb();
    const { coordinator } = handle;
    const id = "sess-payload-sql";
    const events = balancedTurnEvents(0);
    // 把一条事件的 data 换成含 SQL 的对象（JSON 可序列化）。
    const tampered = [
      {
        type: "turn/start" as const,
        seq: 0,
        time: 1,
        data: { turn: 1, note: "'); DROP TABLE dsh_events; --" },
      },
      events[1],
      events[2],
      events[3],
    ];
    await coordinator.create({ version: 0, id, createdAt: 1, isSeeded: false });
    await coordinator.append(id, tampered as never);

    const loaded = await coordinator.load(id);
    const first = loaded.events[0];
    expect(first && "data" in first).toBe(true);
    expect((first as { data: { note: string } }).data.note).toContain("DROP TABLE");
  });

  it("表前缀非法时拒绝创建后端（标识符注入防护）", async () => {
    handle = await setupTestDb();
    const { settings, writePool } = handle;
    // 直接以非法前缀调用 ensureSchema 应抛错。
    const { ensureSchema } = await import("../../src/schema.js");
    await expect(ensureSchema(writePool, "bad; DROP", { autoMigrate: true })).rejects.toThrow(
      /表前缀非法/,
    );
    void settings;
  });

  it("schema 版本回退（已应用高于期望）拒绝启动", async () => {
    handle = await setupTestDb();
    const { writePool, prefix } = handle;
    const { ensureSchema, tableNames } = await import("../../src/schema.js");
    // 先以高版本写入 meta，再以低版本启动 → 拒绝。
    const names = tableNames(prefix);
    await writePool.query(`INSERT INTO \`${names.meta}\` (version) VALUES (99)`);
    await expect(
      ensureSchema(writePool, prefix, { autoMigrate: true, expectedVersion: 1 }),
    ).rejects.toThrow(/降级/);
  });

  it("禁止自动迁移但 schema 缺失时拒绝启动（fail-closed）", async () => {
    handle = await setupTestDb();
    const { writePool, prefix } = handle;
    const { ensureSchema } = await import("../../src/schema.js");
    // 用一个不存在的全新前缀且 autoMigrate=false → 应抛“禁止自动迁移”。
    await expect(ensureSchema(writePool, `${prefix}new_`, { autoMigrate: false })).rejects.toThrow(
      /禁止自动迁移/,
    );
  });

  it("畸形的 payload 在读取时 loud-fail（损坏检测，不静默丢数据）", async () => {
    handle = await setupTestDb();
    const { backend, writePool, prefix } = handle;
    const { tableNames } = await import("../../src/schema.js");
    const names = tableNames(prefix);
    // 直接写入一个非 JSON 的 payload 行，模拟存储损坏。
    await writePool.query(
      `INSERT INTO \`${names.sessions}\` (session_id, version, created_at, delegation_depth) VALUES (?, 0, 1, 0)`,
      ["sess-corrupt"],
    );
    await writePool.query(
      `INSERT INTO \`${names.events}\` (session_id, seq, row_type, payload) VALUES (?, ?, NULL, ?)`,
      ["sess-corrupt", 0, "{not-valid-json"],
    );
    await expect(backend.loadStored("sess-corrupt" as never)).rejects.toThrow();
  });
});
