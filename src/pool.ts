import { createPool, type Pool, type PoolOptions } from "mysql2/promise";

import type { ConnectionSettings, PoolSettings } from "./config.js";

/**
 * 由连接设置与池设置构造 mysql2 连接池选项。
 * @param connection - 连接设置。
 * @param pool - 池设置。
 * @returns 可直接交给 createPool 的选项。
 */
export function buildPoolOptions(connection: ConnectionSettings, pool: PoolSettings): PoolOptions {
  return {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    charset: connection.charset,
    connectTimeout: connection.connectTimeout,
    // ssl 未配置时不带该键，避免 exactOptionalPropertyTypes 冲突。
    ...(connection.ssl !== undefined ? { ssl: connection.ssl } : {}),
    connectionLimit: pool.poolSize,
    idleTimeout: pool.idleTimeout,
    waitForConnections: true,
    queueLimit: pool.queueLimit,
  };
}

/**
 * 创建写连接池（读写分离中的写侧）。
 * @param connection - 写库连接设置。
 * @param pool - 池设置。
 * @returns 写池实例。
 */
export function createWritePool(connection: ConnectionSettings, pool: PoolSettings): Pool {
  return createPool(buildPoolOptions(connection, pool));
}

/**
 * 创建读连接池（读写分离中的读侧）。读写库为同一连接时返回同一池实例，避免重复持有。
 * @param writeConnection - 写库连接设置。
 * @param readConnection - 读库连接设置。
 * @param pool - 池设置。
 * @returns 读池实例（与写池同一连接时复用写池）。
 */
export function createReadPool(
  writeConnection: ConnectionSettings,
  readConnection: ConnectionSettings,
  pool: PoolSettings,
): Pool {
  if (
    readConnection.host === writeConnection.host &&
    readConnection.port === writeConnection.port &&
    readConnection.user === writeConnection.user &&
    readConnection.password === writeConnection.password &&
    readConnection.database === writeConnection.database
  ) {
    // 同库模式：直接复用写池，调用方据此只关闭一次。
    return createWritePool(writeConnection, pool);
  }
  return createPool(buildPoolOptions(readConnection, pool));
}
