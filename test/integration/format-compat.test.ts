import {
  SESSION_FORMAT_VERSION,
  type SessionHeader,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type { RowDataPacket } from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";

import { setupTestDb, type TestDbHandle } from "../helpers/db.js";
import { balancedTurnEvents, chunkEvent } from "../helpers/events.js";

/** 被测试的装配句柄。 */
let handle: TestDbHandle | undefined;

afterEach(async () => {
  await handle?.dispose();
  handle = undefined;
});

/**
 * 格式版本兼容：dsh 0.2.0-rc.1 的 `SESSION_FORMAT_VERSION=4`，而磁盘上仍可能存在
 * 0.1.5 时代写入的 `sessions.version=3` 行。本套件用一个显式的遗留头（version=3）
 * 加 0.1.5 兼容事件（turn/step 边界 + assistant/message）落盘，再从两条读路径读回，
 * 验证升级到 0.2.0 后存量会话不会被误拒：
 * 1. `headerFromRow` 把内存头盖章为**运行时** SESSION_FORMAT_VERSION，使
 *    `assertVersion` 不会因存量 v3 行拒读；
 * 2. 事件词汇表向后包含（0.1.5 的事件类型是 0.2.0 的子集），旧事件在 v4 校验下仍被接受。
 */
describe("格式兼容：0.1.5（v3）存量日志在 0.2.0（v4）运行时下可读", () => {
  it("遗留 version=3 的 header 与事件可经后端与 open('read') 读出", async () => {
    handle = await setupTestDb();
    const { backend, persistence, writePool, prefix } = handle;
    const id = "sess-legacy-v3" as SessionId;

    // 显式模拟 0.1.5 写下的 header（version=3）；事件形状在 v3/v4 间兼容。
    const legacyMeta: SessionHeader = {
      version: 3,
      id,
      createdAt: 1_700_000_000_000,
      isSeeded: false,
    };
    const log = [...balancedTurnEvents(0), chunkEvent(4, "legacy hello")];
    await backend.persistBatch(legacyMeta, log, false, 0);

    // 磁盘上的版本列确实是遗留的 3（未被凭空改写）。
    const [rows] = await writePool.query<RowDataPacket[]>(
      `SELECT version FROM \`${prefix}sessions\` WHERE session_id = ?`,
      [id],
    );
    expect(Number(rows[0]?.version)).toBe(3);

    // 路径一：后端直读——事件全量解码，头被盖章为运行时版本（0.2.0 下为 4）。
    const stored = await backend.readStoredLog(id);
    expect(stored.meta.version).toBe(SESSION_FORMAT_VERSION);
    expect(stored.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);

    // 路径二：接缝 open('read')——经由 coordinator 的完整读路径同样通过。
    const readHandle = await persistence.open(id, "read");
    const loaded = await readHandle.read();
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    await readHandle.close();
  });
});
