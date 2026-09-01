import { describe, expect, it } from "vitest";

import { decodeStoredRows, encodeStorageRows } from "../../src/mysql-codec.js";
import { balancedTurnEvents, chunkEvent, structuralEvent } from "../helpers/events.js";

describe("encodeStorageRows / decodeStoredRows", () => {
  it("裸事件（关闭折叠）往返无损", () => {
    const events = balancedTurnEvents(0);
    const rows = encodeStorageRows(events, false);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.rowType).toBeNull();
    const decoded = decodeStoredRows(rows);
    expect(decoded).toEqual(events);
  });

  it("结构事件开启折叠时仍逐条保存（不折叠非 chunk）", () => {
    const events = balancedTurnEvents(0);
    const rows = encodeStorageRows(events, true);
    expect(rows).toHaveLength(4);
    expect(decodeStoredRows(rows)).toEqual(events);
  });

  it("连续 chunk 开启折叠后行数显著减少且往返无损", () => {
    const chunks = [0, 1, 2, 3, 4].map((i) => chunkEvent(i, `t${i}`));
    const rows = encodeStorageRows(chunks, true);
    // 5 条同 block text-delta 应折叠为 1 行。
    expect(rows.length).toBeLessThan(chunks.length);
    const decoded = decodeStoredRows(rows);
    expect(decoded).toHaveLength(5);
    expect(decoded).toEqual(chunks);
  });

  it("混合事件（chunk + 结构）往返无损", () => {
    const events = [
      structuralEvent("turn/start", 0, { turn: 1 }),
      chunkEvent(1, "a"),
      chunkEvent(2, "b"),
      chunkEvent(3, "c"),
      structuralEvent("turn/end", 4, { turn: 1, reason: { kind: "completed" } }),
    ];
    const rows = encodeStorageRows(events, true);
    expect(decodeStoredRows(rows)).toEqual(events);
  });
});
