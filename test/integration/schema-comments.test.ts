import { afterEach, describe, expect, it } from "vitest";

import { setupTestDb, type TestDbHandle } from "../helpers/db.js";

/** 被测试的装配句柄。 */
let handle: TestDbHandle | undefined;

afterEach(async () => {
  await handle?.dispose();
  handle = undefined;
});

describe("DDL：列注释通过 COMMENT 子句落库", () => {
  it("sessions 与 events 表每个业务列都有非空 COMMENT", async () => {
    handle = await setupTestDb();
    const { writePool, prefix } = handle;

    const [sessionCols] = await writePool.query<
      Array<{ COLUMN_NAME: string; COLUMN_COMMENT: string }>
    >(
      "SELECT COLUMN_NAME, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      [`${prefix}sessions`],
    );
    const [eventCols] = await writePool.query<
      Array<{ COLUMN_NAME: string; COLUMN_COMMENT: string }>
    >(
      "SELECT COLUMN_NAME, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      [`${prefix}events`],
    );

    // sessions：10 个业务列（含主键列）全部有注释。
    for (const col of sessionCols) {
      expect(col.COLUMN_COMMENT, `sessions.${col.COLUMN_NAME} 缺注释`).not.toBe("");
    }
    expect(sessionCols).toHaveLength(10);

    // events：4 个业务列全部有注释。
    for (const col of eventCols) {
      expect(col.COLUMN_COMMENT, `events.${col.COLUMN_NAME} 缺注释`).not.toBe("");
    }
    expect(eventCols).toHaveLength(4);

    // 抽查关键列注释内容。
    const sessionId = sessionCols.find((c) => c.COLUMN_NAME === "session_id");
    expect(sessionId?.COLUMN_COMMENT).toContain("品牌化会话 id");
    const seq = eventCols.find((c) => c.COLUMN_NAME === "seq");
    expect(seq?.COLUMN_COMMENT).toContain("事件在日志中的序号");
    const payload = eventCols.find((c) => c.COLUMN_NAME === "payload");
    expect(payload?.COLUMN_COMMENT).toContain("存储记录 JSON");
  });
});
