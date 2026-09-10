import { describe, expect, it } from "vitest";

import type { ConnectionSettings, PoolSettings } from "../../src/config.js";
import { createReadPool } from "../../src/pool.js";

/** 构造连接设置。 */
function conn(host: string): ConnectionSettings {
  return {
    host,
    port: 3306,
    user: "u",
    password: "p",
    database: "d",
    tablePrefix: "t_",
    charset: "utf8mb4",
    connectTimeout: 1000,
    ssl: undefined,
    sslRequired: false,
  };
}

/** 构造池设置。 */
const POOL: PoolSettings = {
  poolSize: 1,
  minIdle: 0,
  idleTimeout: 1000,
  acquireTimeout: 1000,
  queueLimit: 0,
};

describe("createReadPool", () => {
  it("读库连接与写库不同时创建独立读池", async () => {
    const pool = createReadPool(conn("write-host"), conn("read-host"), POOL);
    expect(pool).toBeDefined();
    await pool.end();
  });
});
