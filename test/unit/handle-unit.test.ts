import type { Context } from "@deepseek-ai/cordis";
import {
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  SessionLogOffset,
} from "@deepseek-ai/dsh-session";
import { SessionPersistenceRevision } from "@deepseek-ai/dsh-session-persistence";
import { describe, expect, it } from "vitest";

import type { MysqlBackend } from "../../src/mysql-backend.js";
import {
  createMysqlSessionHandle,
  MysqlBackendTracker,
  type MysqlHandleStorage,
  MysqlSessionHandle,
  type StorageHandleState,
} from "../../src/mysql-handle.js";
import { balancedTurnEvents } from "../helpers/events.js";

/** 构造测试会话头。 */
function header(id: string): SessionHeader {
  return { version: 3, id: id as SessionId, createdAt: 1, isSeeded: false, cwd: "/tmp/u" };
}

/** 构造一条结构事件。 */
function ev(seq = 0): SessionEvent {
  return { type: "turn/start", seq, time: seq, data: { turn: 1 } } as unknown as SessionEvent;
}

/** 构造 handle 初始状态。 */
function state(materialized: boolean, cursor = 0): StorageHandleState {
  return { cursor, materialized, inheritedEventCount: SessionLogOffset(0) };
}

/**
 * 伪造的存储原语：记录调用、可按需注入失败，用于覆盖 handle 的失败/重试分支。
 */
class FakeStorage implements MysqlHandleStorage {
  readonly persisted: { events: readonly SessionEvent[]; isMaterialized: boolean }[] = [];
  headerWrites = 0;
  storedEvents: readonly SessionEvent[] = [];
  failBatch = false;

  async persistBatch(
    _header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    if (this.failBatch) {
      this.failBatch = false;
      throw new Error("simulated batch failure");
    }
    this.persisted.push({ events, isMaterialized });
  }

  async persistHeader(): Promise<void> {
    this.headerWrites += 1;
  }

  async readStoredLog(id: SessionId): Promise<{
    meta: SessionHeader;
    events: readonly SessionEvent[];
    inheritedEventCount: SessionLogOffset;
    eventCount: number;
    revision: SessionPersistenceRevision;
  }> {
    return {
      meta: header(String(id)),
      events: this.storedEvents,
      inheritedEventCount: SessionLogOffset(0),
      eventCount: this.storedEvents.length,
      revision: SessionPersistenceRevision("test:1"),
    };
  }

  async hasSession(): Promise<boolean> {
    return this.storedEvents.length > 0;
  }
}

/** 构造一个句柄并登记到 tracker。 */
function makeHandle(
  tracker: MysqlBackendTracker,
  storage: FakeStorage,
  id: string,
  access: "read" | "write",
  st: StorageHandleState,
): MysqlSessionHandle {
  const h = new MysqlSessionHandle(storage, tracker, id as SessionId, header(id), access, st);
  tracker.adopt(h);
  return h;
}

describe("MysqlSessionHandle / MysqlBackendTracker（fake storage）", () => {
  it("enqueueLive 计时器到期后批量落盘", async () => {
    const tracker = new MysqlBackendTracker("t");
    const storage = new FakeStorage();
    const h = makeHandle(tracker, storage, "s1", "write", state(true));
    expect(h.inheritedEventCount).toBe(0);
    h.enqueueLive(ev(0), () => {});
    await new Promise((r) => setTimeout(r, 260));
    expect(storage.persisted).toHaveLength(1);
    await h.close();
  });

  it("close 清掉待触发计时器并 drain", async () => {
    const tracker = new MysqlBackendTracker("t");
    const storage = new FakeStorage();
    const h = makeHandle(tracker, storage, "s2", "write", state(true));
    h.enqueueLive(ev(0), () => {});
    await h.close();
    expect(storage.persisted).toHaveLength(1);
  });

  it("drain 失败保留 buffered 并暂停，显式 flush 重试成功", async () => {
    const tracker = new MysqlBackendTracker("t");
    const storage = new FakeStorage();
    const h = makeHandle(tracker, storage, "s3", "write", state(true));
    h.enqueueLive(ev(0), () => {});
    storage.failBatch = true;
    await expect(h.drainLive()).rejects.toThrow(/simulated/);
    storage.failBatch = false;
    await h.flush();
    expect(storage.persisted).toHaveLength(1);
    await h.close();
  });

  it("read 检测存储相对已观察前缀收缩", async () => {
    const tracker = new MysqlBackendTracker("t");
    const storage = new FakeStorage();
    storage.storedEvents = balancedTurnEvents(0);
    const h = makeHandle(tracker, storage, "s4", "read", state(true, 4));
    expect((await h.read()).events).toHaveLength(4);
    storage.storedEvents = balancedTurnEvents(0).slice(0, 2);
    await expect(h.read()).rejects.toThrow(/shrank/);
  });

  it("flush 空未物化会话写 header", async () => {
    const tracker = new MysqlBackendTracker("t");
    const storage = new FakeStorage();
    const h = makeHandle(tracker, storage, "s5", "write", state(false));
    await h.flush();
    expect(storage.headerWrites).toBe(1);
    await h.close();
  });

  it("tracker：pending/claim 状态与重复注册错误", () => {
    const tracker = new MysqlBackendTracker("t");
    tracker.registerCreated(header("p1"), SessionLogOffset(0));
    expect(tracker.hasPending("p1" as SessionId)).toBe(true);
    expect(tracker.pendingOf("p1" as SessionId)?.header.id).toBe("p1");
    expect([...tracker.pendingEntries()]).toHaveLength(1);
    expect(() => tracker.registerCreated(header("p1"), SessionLogOffset(0))).toThrow();
    tracker.claimWrite("p2" as SessionId);
    expect(() => tracker.claimWrite("p2" as SessionId)).toThrow();
    tracker.releaseClaim("p2" as SessionId);
    expect(() => tracker.claimWrite("p2" as SessionId)).not.toThrow();
    tracker.materialized("p1" as SessionId);
    expect(tracker.hasPending("p1" as SessionId)).toBe(false);
  });

  it("flushAll 聚合写入失败", async () => {
    const tracker = new MysqlBackendTracker("t");
    const storage = new FakeStorage();
    tracker.claimWrite("f1" as SessionId);
    const h = new MysqlSessionHandle(
      storage,
      tracker,
      "f1" as SessionId,
      header("f1"),
      "write",
      state(true),
    );
    tracker.adopt(h);
    h.enqueueLive(ev(0), () => {});
    storage.failBatch = true;
    await expect(tracker.flushAll()).rejects.toThrow();
    await h.close();
  });

  it("install 路由 session/event|flush|disposed 与 effect sweep", async () => {
    const tracker = new MysqlBackendTracker("inst");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let effectResult: Promise<() => Promise<void>> | undefined;
    const ctx = {
      on: (name: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(name, fn);
      },
      effect: (fn: () => Promise<() => Promise<void>>) => {
        effectResult = fn();
      },
      logger: { warn: () => {} },
    } as unknown as Context;
    tracker.install(ctx);

    // 未知 id 与 pending（writer=null）都应早退。
    handlers.get("session/event")?.({ id: "nope" }, ev(0));
    tracker.registerCreated(header("pend"), SessionLogOffset(0));
    handlers.get("session/event")?.({ id: "pend" }, ev(0));

    const storage = new FakeStorage();
    tracker.claimWrite("w1" as SessionId);
    const h = makeHandle(tracker, storage, "w1", "write", state(true));
    handlers.get("session/event")?.({ id: "w1" }, ev(0));
    await handlers.get("session/flush")?.({ id: "w1" });
    handlers.get("session/disposed")?.({ id: "w1" });
    await new Promise((r) => setTimeout(r, 20));

    const dispose = await effectResult!;
    await dispose();
    expect(storage.persisted.length).toBeGreaterThanOrEqual(1);
  });

  it("install effect 聚合关闭失败", async () => {
    const tracker = new MysqlBackendTracker("inst2");
    let effectResult: Promise<() => Promise<void>> | undefined;
    const ctx = {
      on: () => {},
      effect: (fn: () => Promise<() => Promise<void>>) => {
        effectResult = fn();
      },
      logger: { warn: () => {} },
    } as unknown as Context;
    tracker.install(ctx);
    const storage = new FakeStorage();
    tracker.claimWrite("bad" as SessionId);
    const h = makeHandle(tracker, storage, "bad", "write", state(true));
    h.enqueueLive(ev(0), () => {});
    storage.failBatch = true;
    const dispose = await effectResult!;
    await expect(dispose()).rejects.toThrow();
  });

  it("createMysqlSessionHandle 工厂返回 handle", () => {
    const tracker = new MysqlBackendTracker("f");
    const h = createMysqlSessionHandle(
      {} as unknown as MysqlBackend,
      tracker,
      "f1" as SessionId,
      header("f1"),
      "read",
      state(false),
    );
    expect(h).toBeInstanceOf(MysqlSessionHandle);
  });
});
