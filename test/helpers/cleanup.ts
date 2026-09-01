import type { Connection } from "mysql2/promise";

/** 测试表前缀匹配：db.ts(t_)、e2e(e_)、冒烟(smoke_)、早期手动(c_)。 */
export const TEST_TABLE_PATTERN = /^(t_|e_|smoke_|c_)/;

/**
 * 清理指定库中所有测试遗留表（按前缀匹配），返回清理张数。
 * @param conn - 连接（需对目标库有 DROP 权限）。
 * @param database - 目标数据库名。
 * @returns 清理掉的表数量。
 */
export async function cleanTestTables(conn: Connection, database: string): Promise<number> {
  const [rows] = await conn.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
    [database],
  );
  let dropped = 0;
  for (const row of rows as Array<{ TABLE_NAME: string }>) {
    if (TEST_TABLE_PATTERN.test(row.TABLE_NAME)) {
      // 显式限定库名，兼容未选默认库的连接。
      await conn.query(`DROP TABLE IF EXISTS \`${database}\`.\`${row.TABLE_NAME}\``);
      dropped += 1;
    }
  }
  return dropped;
}
