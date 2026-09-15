import { Context } from "@deepseek-ai/cordis";
import SessionStore, {
  type SessionHeader,
  type SessionId,
  SessionLogOffset,
} from "@deepseek-ai/dsh-session";
import {
  SessionAlreadyOwnedError,
  SessionOwnershipLostError,
} from "@deepseek-ai/dsh-session-persistence";
import { afterEach, describe, expect, it } from "vitest";

import { MysqlSessionPersistence } from "../../src/index.js";
import { tableNames } from "../../src/schema.js";
import { setupTestDb, type TestDbHandle } from "../helpers/db.js";
import { balancedTurnEvents } from "../helpers/events.js";

/** 开启租约的设置覆盖（测试用短无关参数；TTL 足够长以免误过期）。 */
const LEASE = {
  cluster: {
    lease: {
      enabled: true,
      ttlMs: 60_000,
      heartbeatIntervalMs: 30_000,
      heartbeatMissThreshold: 1,
      ownerId: "",
    },
  },
} as const;

/** 被测试的主装配句柄。 */
let handle: TestDbHandle | undefined;
/** 模拟“另一进程”的第二实例。 */
let second: { ctx: Context; p: MysqlSessionPersistence } | undefined;

afterEach(async () => {
  if (second) {
    await second.ctx.fiber.dispose().catch(() => {});
    await second.p.dispose().catch(() => {});
    second = undefined;
  }
  await handle?.dispose();
  handle = undefined;
});

/** 用同一表前缀/同一库装配另一个插件实例（独立连接池，模拟另一进程）。 */
async function secondInstance(
  prefix: string,
): Promise<{ ctx: Context; p: MysqlSessionPersistence }> {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const p = new MysqlSessionPersistence(ctx, { connection: { tablePrefix: prefix }, ...LEASE });
  await p[Symbol.for("cordis.init")]?.();
  return { ctx, p };
}

/** 构造测试会话头。 */
function header(id: string): SessionHeader {
  return { version: 3, id: id as SessionId, createdAt: 1, isSeeded: false };
}

/** 读取 leases 行。 */
async function leaseRow(
  id: string,
): Promise<{ owner_id: string; fence_token: number; expires_at: number } | undefined> {
  const names = tableNames(handle!.prefix);
  const [rows] = await handle!.writePool.query(
    `SELECT owner_id, fence_token, expires_at FROM \`${names.leases}\` WHERE session_id = ?`,
    [id],
  );
  return (rows as Array<{ owner_id: string; fence_token: number; expires_at: number }>)[0];
}

describe("跨进程租约（cluster/lease）", () => {
  it("enabled=false：建表但不写 leases（零回归）", async () => {
    handle = await setupTestDb();
    const { persistence, writePool, prefix } = handle;
    const id = "s-off";
    const wh = await persistence.create(header(id));
    await wh.append(balancedTurnEvents(0));
    await wh.flush();
    await wh.close();
    const names = tableNames(prefix);
    const [rows] = await writePool.query(`SELECT COUNT(*) AS c FROM \`${names.leases}\``);
    expect(Number((rows as Array<{ c: number }>)[0]?.c)).toBe(0);
  });

  it("争抢：另一实例 open('write') 抛 SessionAlreadyOwnedError", async () => {
    handle = await setupTestDb(LEASE);
    const { persistence, prefix } = handle;
    const id = "s-contend";
    const wh = await persistence.create(header(id));
    await wh.append(balancedTurnEvents(0));
    await wh.flush();
    second = await secondInstance(prefix);
    await expect(second.p.open(id as SessionId, "write")).rejects.toBeInstanceOf(
      SessionAlreadyOwnedError,
    );
    await wh.close();
  });

  it("close 标记释放并保留 fence；再次认领 fence+1（不复位）", async () => {
    handle = await setupTestDb(LEASE);
    const { persistence, prefix } = handle;
    const id = "s-fence-reset";
    const wh = await persistence.create(header(id));
    await wh.append(balancedTurnEvents(0));
    await wh.flush();
    expect((await leaseRow(id))?.fence_token).toBe(1);
    await wh.close();
    const released = await leaseRow(id);
    expect(released?.owner_id).toBe("");
    expect(released?.fence_token).toBe(1);

    second = await secondInstance(prefix);
    const wh2 = await second.p.open(id as SessionId, "write");
    expect((await leaseRow(id))?.fence_token).toBe(2);
    await wh2.close();
  });

  it("过期接管：另一实例以 fence+1 接管", async () => {
    handle = await setupTestDb(LEASE);
    const { persistence, writePool, prefix } = handle;
    const id = "s-takeover";
    const wh = await persistence.create(header(id));
    await wh.append(balancedTurnEvents(0));
    await wh.flush();
    const names = tableNames(prefix);
    await writePool.query(`UPDATE \`${names.leases}\` SET expires_at = 0 WHERE session_id = ?`, [
      id,
    ]);

    second = await secondInstance(prefix);
    const wh2 = await second.p.open(id as SessionId, "write");
    expect((await leaseRow(id))?.fence_token).toBe(2);
    await wh2.close();
    await wh.close();
  });

  it("围栏：失锁 append 与同内容重放都抛 SessionOwnershipLostError（先于幂等 no-op）", async () => {
    handle = await setupTestDb(LEASE);
    const { persistence, backend, writePool, prefix } = handle;
    const id = "s-fenced";
    const meta = header(id);
    const wh = await persistence.create(meta);
    await wh.append(balancedTurnEvents(0));
    await wh.flush();
    const names = tableNames(prefix);
    await writePool.query(`UPDATE \`${names.leases}\` SET expires_at = 0 WHERE session_id = ?`, [
      id,
    ]);

    second = await secondInstance(prefix);
    const wh2 = await second.p.open(id as SessionId, "write"); // fence=2

    await expect(wh.append(balancedTurnEvents(4, 2))).rejects.toBeInstanceOf(
      SessionOwnershipLostError,
    );
    // 直接对后端重放“与已提交内容逐条一致”的批次：fence 校验先于幂等 no-op。
    await expect(
      backend.persistBatch(meta, balancedTurnEvents(0), true, SessionLogOffset(0), {
        ownerId: "stale",
        fenceToken: 1,
        ttlMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(SessionOwnershipLostError);

    await wh2.close();
    await wh.close();
  });

  it("backend claim/renew/release：fence 单调、续租语义与空行竞态", async () => {
    handle = await setupTestDb(LEASE);
    const { backend } = handle;
    const id = "s-backend-lease" as SessionId;
    const f1 = await backend.claimLease(id, "o1", 60_000);
    expect(f1).toBe(1);
    expect(await backend.renewLease(id, "o1", f1, 60_000)).toBe(true);
    expect(await backend.renewLease(id, "o2", f1, 60_000)).toBe(false);

    await backend.releaseLease(id, "o1", f1);
    expect(await backend.renewLease(id, "o1", f1, 60_000)).toBe(false);
    const f2 = await backend.claimLease(id, "o2", 60_000);
    expect(f2).toBe(2);

    // 空行竞态：并发认领同一新 id → 一方成功、另一方 AlreadyOwned（而非裸 1062）。
    const results = await Promise.allSettled([
      backend.claimLease("s-race" as SessionId, "a", 60_000),
      backend.claimLease("s-race" as SessionId, "b", 60_000),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(SessionAlreadyOwnedError);
  });
});
