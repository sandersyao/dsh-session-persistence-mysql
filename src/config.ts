import { config as loadDotenv } from "dotenv";

/**
 * 连接设置：MySQL 连接参数（凭据只来自环境变量/.env，绝不硬编码）。
 */
export interface ConnectionSettings {
  /** 主机地址。 */
  readonly host: string;
  /** 端口。 */
  readonly port: number;
  /** 用户名（专项最小权限用户，非 root）。 */
  readonly user: string;
  /** 密码（敏感，仅供连接使用，不回显、不进日志）。 */
  readonly password: string;
  /** 目标数据库名。 */
  readonly database: string;
  /** 表前缀（校验过安全字符集）。 */
  readonly tablePrefix: string;
  /** 连接字符集。 */
  readonly charset: string;
  /** 连接超时（毫秒）。 */
  readonly connectTimeout: number;
  /** SSL/TLS 选项（本轮暂缓强制，保留配置位）。 */
  readonly ssl: import("mysql2/promise").PoolOptions["ssl"];
  /** 是否强制 TLS。 */
  readonly sslRequired: boolean;
}

/**
 * 连接池设置：写池与读池共用。
 */
export interface PoolSettings {
  /** 池大小上限。 */
  readonly poolSize: number;
  /** 最小空闲连接。 */
  readonly minIdle: number;
  /** 空闲连接超时（毫秒）。 */
  readonly idleTimeout: number;
  /** 获取连接超时（毫秒）。 */
  readonly acquireTimeout: number;
  /** 排队上限。 */
  readonly queueLimit: number;
}

/**
 * 持久化语义设置。
 */
export interface PersistenceSettings {
  /** 空闲队列收到写入后，固定 batching 等待窗口（毫秒）。 */
  readonly writeBatchMaxDelayMs: number;
  /** 冷加载后保留供复用的未发布会话数上限。 */
  readonly preparedSessionCacheSize: number;
  /** 是否启用 chunk run 折叠写入。 */
  readonly packChunks: boolean;
}

/**
 * 安全设置。
 */
export interface SecuritySettings {
  /** 可选应用层字段加密 key（base64）。本轮默认空 = 明文。 */
  readonly encryptionKey: string | undefined;
  /** 启动时是否自动执行 schema 迁移。 */
  readonly schemaAutoMigrate: boolean;
}

/**
 * 合并后的完整 MySQL 后端设置。
 */
export interface MysqlSettings {
  /** 写库连接设置。 */
  readonly connection: ConnectionSettings;
  /** 读库连接设置（读写分离；缺省复用写库）。 */
  readonly readConnection: ConnectionSettings;
  /** 连接池设置。 */
  readonly pool: PoolSettings;
  /** 持久化语义设置。 */
  readonly persistence: PersistenceSettings;
  /** 安全设置。 */
  readonly security: SecuritySettings;
}

/** 默认连接超时（毫秒）。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** 默认字符集。 */
const DEFAULT_CHARSET = "utf8mb4";

/**
 * 解析整数环境变量；缺失/非法时回退到默认值。
 * @param value - 原始环境变量值。
 * @param fallback - 默认值。
 * @param label - 用于报错的字段名。
 * @returns 解析后的非负整数。
 */
function intFromEnv(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`环境变量 ${label} 非法：期望非负整数，收到 "${value}"`);
  }
  return n;
}

/**
 * 加载 `.env`（若存在）并解析为完整设置。凭据与表前缀均由此注入。
 * @param env - 环境变量快照（默认 process.env）。
 * @returns 合并后的后端设置；连接参数缺失即抛错（fail-closed）。
 */
export function loadSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): MysqlSettings {
  // 可选加载项目根目录 .env（不存在则忽略）。
  loadDotenv({ quiet: true });

  const host = env.MYSQL_HOST;
  const user = env.MYSQL_USER;
  const password = env.MYSQL_PASSWORD;
  const database = env.MYSQL_DATABASE;
  const tablePrefix = env.MYSQL_TABLE_PREFIX;
  if (host === undefined || host === "") {
    throw new Error("MYSQL_HOST 缺失：连接凭据必须来自环境变量");
  }
  if (user === undefined || user === "") {
    throw new Error("MYSQL_USER 缺失：连接凭据必须来自环境变量");
  }
  if (password === undefined || password === "") {
    throw new Error("MYSQL_PASSWORD 缺失：连接凭据必须来自环境变量");
  }
  if (database === undefined || database === "") {
    throw new Error("MYSQL_DATABASE 缺失");
  }
  if (tablePrefix === undefined || tablePrefix === "") {
    throw new Error("MYSQL_TABLE_PREFIX 缺失：表前缀必须来自环境变量");
  }

  const readHost = env.MYSQL_READ_HOST;
  const readUser = env.MYSQL_READ_USER;
  const readPassword = env.MYSQL_READ_PASSWORD;

  const connection: ConnectionSettings = {
    host,
    port: intFromEnv(env.MYSQL_PORT, 3306, "MYSQL_PORT"),
    user,
    password,
    database,
    tablePrefix,
    charset: env.MYSQL_CHARSET ?? DEFAULT_CHARSET,
    connectTimeout: intFromEnv(
      env.MYSQL_CONNECT_TIMEOUT,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "MYSQL_CONNECT_TIMEOUT",
    ),
    ssl: undefined,
    sslRequired: env.MYSQL_SSL_REQUIRED === "true" || env.MYSQL_SSL_REQUIRED === "1",
  };

  // 读库：未配置 MYSQL_READ_HOST 时复用写库连接（测试同库模式）。
  const readConnection: ConnectionSettings =
    readHost !== undefined && readHost !== ""
      ? {
          ...connection,
          host: readHost,
          user: readUser !== undefined && readUser !== "" ? readUser : user,
          password: readPassword ?? password,
        }
      : connection;

  const pool: PoolSettings = {
    poolSize: intFromEnv(env.MYSQL_POOL_SIZE, 10, "MYSQL_POOL_SIZE"),
    minIdle: intFromEnv(env.MYSQL_POOL_MIN_IDLE, 0, "MYSQL_POOL_MIN_IDLE"),
    idleTimeout: intFromEnv(env.MYSQL_POOL_IDLE_TIMEOUT, 60_000, "MYSQL_POOL_IDLE_TIMEOUT"),
    acquireTimeout: intFromEnv(
      env.MYSQL_POOL_ACQUIRE_TIMEOUT,
      10_000,
      "MYSQL_POOL_ACQUIRE_TIMEOUT",
    ),
    queueLimit: intFromEnv(env.MYSQL_POOL_QUEUE_LIMIT, 0, "MYSQL_POOL_QUEUE_LIMIT"),
  };

  const persistence: PersistenceSettings = {
    writeBatchMaxDelayMs: intFromEnv(
      env.MYSQL_WRITE_BATCH_DELAY_MS,
      200,
      "MYSQL_WRITE_BATCH_DELAY_MS",
    ),
    preparedSessionCacheSize: intFromEnv(
      env.MYSQL_PREPARED_CACHE_SIZE,
      5,
      "MYSQL_PREPARED_CACHE_SIZE",
    ),
    packChunks: env.MYSQL_PACK_CHUNKS !== "false",
  };

  const encryptionKey = env.ENCRYPTION_KEY;
  const security: SecuritySettings = {
    encryptionKey: encryptionKey !== undefined && encryptionKey !== "" ? encryptionKey : undefined,
    schemaAutoMigrate: env.MYSQL_SCHEMA_AUTO_MIGRATE !== "false",
  };

  return { connection, readConnection, pool, persistence, security };
}

/**
 * 连接字段覆盖（用户可在 Config 中覆盖 env 基址的对应字段）。
 */
export type ConnectionOverrides = Partial<
  Pick<
    ConnectionSettings,
    | "host"
    | "port"
    | "user"
    | "password"
    | "database"
    | "tablePrefix"
    | "charset"
    | "connectTimeout"
    | "sslRequired"
  >
>;

/**
 * 用户提供的设置覆盖（全部可选）。
 */
export interface SettingsOverrides {
  /** 写库连接覆盖。 */
  readonly connection?: ConnectionOverrides;
  /** 读库连接覆盖。 */
  readonly readConnection?: ConnectionOverrides;
  /** 池设置覆盖。 */
  readonly pool?: Partial<PoolSettings>;
  /** 持久化语义覆盖。 */
  readonly persistence?: Partial<PersistenceSettings>;
  /** 安全设置覆盖。 */
  readonly security?: Partial<SecuritySettings>;
}

/**
 * 将用户覆盖合并到 env 基址设置上（env 为默认，用户覆盖优先级更高）。
 * @param base - env 解析的基址设置。
 * @param overrides - 用户覆盖（可空）。
 * @returns 合并后的设置。
 */
export function mergeSettings(
  base: MysqlSettings,
  overrides: SettingsOverrides | undefined,
): MysqlSettings {
  const c = overrides?.connection;
  const rc = overrides?.readConnection;
  const p = overrides?.pool;
  const ps = overrides?.persistence;
  const sc = overrides?.security;

  const connection: ConnectionSettings = {
    host: c?.host ?? base.connection.host,
    port: c?.port ?? base.connection.port,
    user: c?.user ?? base.connection.user,
    password: c?.password ?? base.connection.password,
    database: c?.database ?? base.connection.database,
    tablePrefix: c?.tablePrefix ?? base.connection.tablePrefix,
    charset: c?.charset ?? base.connection.charset,
    connectTimeout: c?.connectTimeout ?? base.connection.connectTimeout,
    ssl: base.connection.ssl,
    sslRequired: c?.sslRequired ?? base.connection.sslRequired,
  };

  const readConnection: ConnectionSettings = {
    host: rc?.host ?? base.readConnection.host,
    port: rc?.port ?? base.readConnection.port,
    user: rc?.user ?? base.readConnection.user,
    password: rc?.password ?? base.readConnection.password,
    database: rc?.database ?? base.readConnection.database,
    tablePrefix: rc?.tablePrefix ?? base.readConnection.tablePrefix,
    charset: rc?.charset ?? base.readConnection.charset,
    connectTimeout: rc?.connectTimeout ?? base.readConnection.connectTimeout,
    ssl: base.readConnection.ssl,
    sslRequired: rc?.sslRequired ?? base.readConnection.sslRequired,
  };

  return {
    connection,
    readConnection,
    pool: {
      poolSize: p?.poolSize ?? base.pool.poolSize,
      minIdle: p?.minIdle ?? base.pool.minIdle,
      idleTimeout: p?.idleTimeout ?? base.pool.idleTimeout,
      acquireTimeout: p?.acquireTimeout ?? base.pool.acquireTimeout,
      queueLimit: p?.queueLimit ?? base.pool.queueLimit,
    },
    persistence: {
      writeBatchMaxDelayMs: ps?.writeBatchMaxDelayMs ?? base.persistence.writeBatchMaxDelayMs,
      preparedSessionCacheSize:
        ps?.preparedSessionCacheSize ?? base.persistence.preparedSessionCacheSize,
      packChunks: ps?.packChunks ?? base.persistence.packChunks,
    },
    security: {
      encryptionKey: sc?.encryptionKey ?? base.security.encryptionKey,
      schemaAutoMigrate: sc?.schemaAutoMigrate ?? base.security.schemaAutoMigrate,
    },
  };
}
