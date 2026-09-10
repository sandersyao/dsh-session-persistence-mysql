import { describe, expect, it } from "vitest";

import { encodeStorageRows } from "../../src/mysql-codec.js";
import { balancedTurnEvents, chunkEvent, structuralEvent } from "../helpers/events.js";

/**
 * 0.1.5 codec：encodeStorageRows 透传事件（materializeAppendBatch 不折叠）；
 * chunk 折叠由 dsh-session 的 sessionFormatCatalog.encodeCurrentEvent 承担。
 * decodeStoredRows 由 handle 层内部的 validateStoredEvents 兜底，因此本单元
 * 测试仅覆盖 encodeStorageRows 的形状契约：每条事件 → 一行 rowType=null。
 */
describe("encodeStorageRows（0.1.5 透传语义）", () => {
  it("结构事件 → 每条一行 rowType=null", () => {
    const events = balancedTurnEvents(0);
    const rows = encodeStorageRows(events);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.rowType === null)).toBe(true);
  });

  it("chunk 事件同样每条一行 rowType=null（折叠由 catalog 承担）", () => {
    const chunks = [0, 1, 2, 3, 4].map((i) => chunkEvent(i, `t${i}`));
    const rows = encodeStorageRows(chunks);
    expect(rows).toHaveLength(chunks.length);
    expect(rows.every((r) => r.rowType === null)).toBe(true);
  });

  it("混合事件（chunk + 结构）每条独立一行", () => {
    const events = [
      structuralEvent("turn/start", 0, { turn: 1 }),
      chunkEvent(1, "a"),
      chunkEvent(2, "b"),
      chunkEvent(3, "c"),
      structuralEvent("turn/end", 4, { turn: 1, reason: { kind: "completed" } }),
    ];
    const rows = encodeStorageRows(events);
    expect(rows).toHaveLength(5);
  });
});
