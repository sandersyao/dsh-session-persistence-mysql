import { afterEach, describe, expect, it } from "vitest";

import { setupTestDb, type TestDbHandle } from "../helpers/db.js";
import { balancedTurnEvents } from "../helpers/events.js";

/** 被测试的装配句柄。 */
let handle: TestDbHandle | undefined;

afterEach(async () => {
  await handle?.dispose();
  handle = undefined;
});

/** 会话数与批次数的乘积即写入操作数。 */
const SESSIONS = 20;
const BATCHES = 50;

describe("性能：写入吞吐与并发安全（宽松回归门禁）", () => {
  it("批量写入吞吐不低于宽松下限（感知能力退化）", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    // 先 create 所有会话的 write handle。
    const handles = await Promise.all(
      Array.from({ length: SESSIONS }, (_, s) =>
        persistence.create({ version: 3, id: `perf-${s}`, createdAt: 1, isSeeded: false }),
      ),
    );
    const start = performance.now();
    for (let b = 0; b < BATCHES; b++) {
      await Promise.all(
        handles.map((h, s) =>
          h.append(balancedTurnEvents(b * 4, b + 1)),
        ),
      );
    }
    for (const h of handles) await h.flush();
    const elapsed = performance.now() - start;
    const opsPerSec = (SESSIONS * BATCHES) / (elapsed / 1000);
    // 宽松下限：本机应远高于此；门禁只捕获极端退化。
    expect(opsPerSec).toBeGreaterThan(50);
    for (const h of handles) await h.close();
  });

  it("并发写多会话无死锁，全部提交成功", async () => {
    handle = await setupTestDb();
    const { persistence, backend } = handle;
    const handles = await Promise.all(
      Array.from({ length: SESSIONS }, (_, s) =>
        persistence.create({ version: 3, id: `conc-${s}`, createdAt: 1, isSeeded: false }),
      ),
    );
    // 并发向不同会话写。
    await Promise.all(handles.map((h) => h.append(balancedTurnEvents(0))));
    for (const h of handles) await h.flush();
    const headers = await backend.listSnapshots();
    expect(headers.length).toBe(SESSIONS);
    for (const h of headers) {
      const readHandle = await persistence.open(h.header.id, "read");
      const loaded = await readHandle.read();
      expect(loaded.events.length).toBe(4);
      await readHandle.close();
    }
    for (const h of handles) await h.close();
  });
});
