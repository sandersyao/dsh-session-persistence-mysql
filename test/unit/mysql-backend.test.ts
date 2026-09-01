import { describe, expect, it } from "vitest";

import type { MysqlSettings } from "../../src/config.js";
import { MysqlBackend } from "../../src/mysql-backend.js";
import { balancedTurnEvents } from "../helpers/events.js";

/** 死锁错误（errno 1213）。 */
function deadlockError(): Error & { errno: number } {
  return Object.assign(new Error("Deadlock found"), { errno: 1213 });
}

/** 构造最小化的后端设置（仅 MysqlBackend 用到的最小字段）。 */
function minimalSettings(tablePrefix = "t_"): MysqlSettings {
  return {
    connection: {
      host: "127.0.0.1",
      port: 3306,
      user: "dsh",
      password: "x",
      database: "test",
      tablePrefix,
      charset: "utf8mb4",
      connectTimeout: 1000,
      ssl: undefined,
      sslRequired: false,
    },
    readConnection: {
      host: "127.0.0.1",
      port: 3306,
      user: "dsh",
      password: "x",
      database: "test",
      tablePrefix,
      charset: "utf8mb4",
      connectTimeout: 1000,
      ssl: undefined,
      sslRequired: false,
    },
    pool: { poolSize: 1, minIdle: 0, idleTimeout: 1000, acquireTimeout: 1000, queueLimit: 0 },
    persistence: { writeBatchMaxDelayMs: 10, preparedSessionCacheSize: 1, packChunks: false },
    security: { encryptionKey: undefined, schemaAutoMigrate: true },
  };
}

/** 构造一个模拟连接：beginTransaction 可被注入死锁/异常，其余操作成功。 */
function fakeConnection(beginTransactionImpl: () => Promise<void>) {
  return {
    beginTransaction: beginTransactionImpl,
    query: async () => [{ affectedRows: 1 }],
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
}

/** 记录 end() 调用次数的假池。 */
function fakePool(conn: unknown) {
  let endCalls = 0;
  return {
    getConnection: async () => conn,
    end: async () => {
      endCalls += 1;
    },
    endCalls: () => endCalls,
  };
}

const header = { version: 0, id: "s1", createdAt: 1 };

describe("MysqlBackend.appendBatch：死锁重试", () => {
  it("瞬时死锁（前 2 次抛 1213）后重试成功", async () => {
    let beginCalls = 0;
    const beginTransaction = async () => {
      beginCalls += 1;
      if (beginCalls <= 2) throw deadlockError();
    };
    const pool = fakePool(fakeConnection(beginTransaction));
    const backend = new MysqlBackend(pool as never, pool as never, true, minimalSettings());

    await backend.appendBatch(header, balancedTurnEvents(0), false);
    // 3 次 beginTransaction：2 次死锁 + 1 次成功。
    expect(beginCalls).toBe(3);
  });

  it("持续死锁 4 次后放弃并抛错", async () => {
    let beginCalls = 0;
    const beginTransaction = async () => {
      beginCalls += 1;
      throw deadlockError();
    };
    const pool = fakePool(fakeConnection(beginTransaction));
    const backend = new MysqlBackend(pool as never, pool as never, true, minimalSettings());

    await expect(backend.appendBatch(header, balancedTurnEvents(0), false)).rejects.toThrow();
    // 初始 1 次 + 重试 3 次 = 4 次。
    expect(beginCalls).toBe(4);
  });
});

describe("MysqlBackend.close：读写分离关闭", () => {
  it("同库模式（sharedPool=true）只关闭写池一次", async () => {
    const pool = fakePool(fakeConnection(async () => {}));
    const backend = new MysqlBackend(pool as never, pool as never, true, minimalSettings());
    await backend.close();
    expect(pool.endCalls()).toBe(1);
  });

  it("异库模式（sharedPool=false）关闭写池与读池", async () => {
    const writePool = fakePool(fakeConnection(async () => {}));
    const readPool = fakePool(fakeConnection(async () => {}));
    const backend = new MysqlBackend(
      writePool as never,
      readPool as never,
      false,
      minimalSettings(),
    );
    await backend.close();
    expect(writePool.endCalls()).toBe(1);
    expect(readPool.endCalls()).toBe(1);
  });
});
