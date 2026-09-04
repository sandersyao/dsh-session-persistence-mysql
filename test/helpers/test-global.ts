import { config as loadDotenv } from "dotenv";
import { createConnection } from "mysql2/promise";

import { cleanTestTables } from "./cleanup.js";

/**
 * vitest globalSetup：主进程运行一次。导出 { setup, teardown }。
 * - setup：用 root 引导独立测试库（建库 + 授权，幂等）。
 * - teardown：兜底清理测试库中的遗留测试表（个别 dispose 已删自有表，
 *   这里捕获异常中断/漏删的残留）。
 * 连接参数解析优先本插件独享 SESSION_*，缺省回退共享 MYSQL_*。
 */
loadDotenv({ quiet: true });

/** 测试库名：SESSION_TEST_DATABASE > MYSQL_TEST_DATABASE > test。 */
const TEST_DATABASE =
  process.env.SESSION_TEST_DATABASE ?? process.env.MYSQL_TEST_DATABASE ?? "test";
/** 运行测试的 DB 用户（缺省 dsh）。 */
const DB_USER = process.env.SESSION_USER ?? process.env.MYSQL_USER ?? "dsh";
/** root 连接参数（仅供引导测试库）。 */
const rootConnection = {
  host: process.env.SESSION_HOST ?? process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.SESSION_PORT ?? process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_ROOT_USER ?? "root",
  password: process.env.MYSQL_ROOT_PASSWORD ?? "root_dev_password",
};

/**
 * 引导测试库：建库并授权给测试用户。
 */
export async function setup(): Promise<void> {
  const conn = await createConnection(rootConnection);
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${TEST_DATABASE}\``);
    // GRANT 目标来自受控 env；测试库本地授权，非公网。
    await conn.query(`GRANT ALL PRIVILEGES ON \`${TEST_DATABASE}\`.* TO '${DB_USER}'@'%'`);
    await conn.query("FLUSH PRIVILEGES");
  } finally {
    await conn.end();
  }
}

/**
 * 兜底清理测试库遗留表。
 */
export async function teardown(): Promise<void> {
  const conn = await createConnection(rootConnection);
  try {
    const dropped = await cleanTestTables(conn, TEST_DATABASE);
    console.log(`[teardown] 测试库 ${TEST_DATABASE} 清理遗留测试表 ${dropped} 张`);
  } finally {
    await conn.end();
  }
}
