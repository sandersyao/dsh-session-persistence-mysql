import { type SessionHeader, type SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";

import { setupTestDb, type TestDbHandle } from "../helpers/db.js";
import { balancedTurnEvents, structuralEvent } from "../helpers/events.js";

/** 被测试的装配句柄。 */
let handle: TestDbHandle | undefined;

afterEach(async () => {
  await handle?.dispose();
  handle = undefined;
});

/** 构造测试会话头。 */
function header(id: string, isSeeded = false): SessionHeader {
  return {
    version: 3,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    isSeeded,
    cwd: "/tmp/h",
  };
}

describe("MysqlSessionPersistence / SessionHandle（服务级 API + 后端错误分支）", () => {
  it("locate 返回后端位置", async () => {
    handle = await setupTestDb();
    const loc = handle.persistence.locate(header("s-locate"));
    expect(loc.kind).toContain("mysql:");
    expect(loc.path).toContain("s-locate");
  });

  it("create→append→read→flush→stat→list→open(read) 全流程", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "s-flow";
    const wh = await persistence.create(header(id));
    expect(wh.inheritedEventCount).toBe(0);
    await wh.append(balancedTurnEvents(0));
    expect((await wh.read()).events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    await wh.flush();
    expect((await persistence.stat(id))?.eventCount).toBe(4);
    expect((await persistence.list()).map((s) => s.header.id)).toContain(id);
    const rh = await persistence.open(id, "read");
    expect((await rh.read(1, 2)).events.map((e) => e.seq)).toEqual([1, 2]);
    await rh.close();
    await wh.close();
  });

  it("pending 会话：stat/list/open(read)/read 空视图", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "s-pending";
    const wh = await persistence.create(header(id));
    expect((await persistence.stat(id))?.header.id).toBe(id);
    expect((await persistence.list()).map((s) => s.header.id)).toContain(id);
    const rh = await persistence.open(id, "read");
    expect((await rh.read()).events).toEqual([]);
    await rh.close();
    expect((await wh.read()).events).toEqual([]);
    await wh.close();
  });

  it("handle.flush 空会话落 header（persistHeader）", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "s-empty";
    const wh = await persistence.create(header(id));
    await wh.flush();
    expect((await persistence.stat(id))?.eventCount).toBe(0);
    await wh.close();
  });

  it("只读 handle：read 参数校验 + flush 拒绝", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "s-ro";
    const wh = await persistence.create(header(id));
    await wh.append(balancedTurnEvents(0));
    await wh.flush();
    await wh.close();
    const rh = await persistence.open(id, "read");
    await expect(rh.read(-1)).rejects.toThrow(/offset/);
    await expect(rh.read(0, -1)).rejects.toThrow(/length/);
    await expect(rh.flush()).rejects.toThrow();
    await rh.close();
  });

  it("append seq 不连续被拒（首条 / 后续分支）", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const wh = await persistence.create(header("s-gap"));
    await expect(wh.append(balancedTurnEvents(5))).rejects.toThrow(/seq mismatch/);
    const bad = [
      structuralEvent("turn/start", 0, { turn: 1 }),
      structuralEvent("step/start", 2, { turn: 1, step: 1 }),
    ];
    await expect(wh.append(bad as never)).rejects.toThrow(/seq mismatch/);
    await wh.close();
  });

  it("create/open 错误路径", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    await expect(persistence.create(header("s-seed0", true))).rejects.toThrow(/seeded/);
    await expect(
      persistence.create(header("s-unseed"), { inheritedEventCount: SessionLogOffset(1) }),
    ).rejects.toThrow(/not seeded/);
    const wh = await persistence.create(header("s-dup"));
    await expect(persistence.create(header("s-dup"))).rejects.toThrow();
    await wh.close();
    await expect(persistence.open("missing-r" as never, "read")).rejects.toThrow();
    await expect(persistence.open("missing-w" as never, "write")).rejects.toThrow();
  });

  it("single-writer：第二个 open write 被拒", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "s-owner";
    const wh = await persistence.create(header(id));
    await wh.append(balancedTurnEvents(0));
    await wh.flush();
    // 第一个写 handle 仍持有所有权 → 再开写被拒（claimWrite 抛 SessionAlreadyOwnedError）。
    await expect(persistence.open(id, "write")).rejects.toThrow();
    await wh.close();
    // 释放后可再次认领。
    const w2 = await persistence.open(id, "write");
    await w2.close();
  });

  it("closed handle 拒绝操作；close 幂等；abort/asyncDispose", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "s-closed";
    const wh = await persistence.create(header(id));
    await wh.append(balancedTurnEvents(0));
    await wh.abort();
    await wh.close();
    await expect(wh.read()).rejects.toThrow();
    await expect(wh.append(balancedTurnEvents(4, 2))).rejects.toThrow();
    await expect(wh.flush()).rejects.toThrow();
    const rh = await persistence.open(id, "read");
    await rh[Symbol.asyncDispose]();
  });

  it("服务级 flush：无写入者 no-op；有写入者 drain 落盘", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    await persistence.flush();
    const id = "s-svc";
    const wh = await persistence.create(header(id));
    await wh.append(balancedTurnEvents(0));
    await persistence.flush();
    expect((await persistence.stat(id))?.eventCount).toBe(4);
    await wh.close();
  });

  it("后端错误分支：异内容重复 / persistHeader 重复 / 缺行锁 / assertReadable", async () => {
    handle = await setupTestDb();
    const { persistence, backend } = handle;
    const id = "s-be";
    const meta = header(id);
    const off = SessionLogOffset(0);
    const wh = await persistence.create(meta);
    await wh.append(balancedTurnEvents(0));
    await wh.flush();

    // 同 seq 但内容不同 → 真冲突（幂等只放行内容一致的重放）。
    const conflict = balancedTurnEvents(0).map((e, i) => (i === 0 ? { ...e, time: 999 } : e));
    await expect(backend.persistBatch(meta, conflict as never, false, off)).rejects.toThrow();
    await expect(backend.persistBatch(meta, conflict as never, true, off)).rejects.toThrow();
    await expect(backend.persistHeader(meta, off)).rejects.toThrow();
    await expect(backend.assertReadable("nope" as never)).rejects.toThrow();

    // 缺行锁：对不存在的会话以 isMaterialized=true 追加 → FOR UPDATE 空 → 抛错。
    await expect(
      backend.persistBatch(header("s-no-lock"), balancedTurnEvents(0), true, off),
    ).rejects.toThrow();
    await wh.close();
  });

  it("导出路径：open(read) 全量读取并可序列化为 canonical JSONL", async () => {
    handle = await setupTestDb();
    const { persistence } = handle;
    const id = "s-export";
    const wh = await persistence.create(header(id));
    await wh.append(balancedTurnEvents(0));
    await wh.flush();
    await wh.close();

    // 0.1.5 `dsh-session-log-export` 的读取路径：open(read) + read(0, undefined)。
    const rh = await persistence.open(id, "read");
    const { events } = await rh.read(0, undefined);
    const headerLine = JSON.stringify({ type: "session", ...rh.header });
    const content = `${headerLine}\n${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await rh.close();

    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    const lines = content.trimEnd().split("\n");
    expect(JSON.parse(lines[0] as string).type).toBe("session");
    expect(lines).toHaveLength(1 + events.length);
  });
});
