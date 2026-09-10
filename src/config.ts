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
 *
 * 0.1.5 起 batching 策略下沉到 handle 层（{@link MysqlSessionHandle} 的
 * `LIVE_WRITE_BATCH_MAX_DELAY_MS` 内部常量，与 JSONL 后端对齐）。插件
 * 只保留与存储介质相关的 `packChunks` 开关。
 */
export interface PersistenceSettings {
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
 * 读取一个配置项：本插件独享的 `SESSION_*` 优先，缺省回退到共享 `MYSQL_*`。
 * 与 dsh-storage-mysql 的 `STORAGE_*`、dsh-credentials-mysql 的 `CREDENTIALS_*`
 * 同一模式：多 MySQL 插件共用一套 `MYSQL_*` 部署，又各自能被独享前缀独立配置
 * （指向专属库 / 专属表前缀 / 专属凭据），同库共存。
 *
 * 0.1.5 起 `WRITE_BATCH_DELAY_MS` 与 `PREPARED_CACHE_SIZE` 已下沉为 handle
 * 层内部常量，不再从环境变量读取；保留它们的回退解析仅为历史兼容（值会被忽略）。
 * @param env - 环境变量快照。
 * @param key - 配置段名（如 `HOST`、`READ_HOST`、`POOL_SIZE`）。
 * @returns 独享值或共享回退值，均可能为 undefined。
 */
function fromEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const independent = env[`SESSION_${key}`];
  if (independent !== undefined && independent !== "") return independent;
  const shared = env[`MYSQL_${key}`];
  if (shared !== undefined && shared !== "") return shared;
  return undefined;
}

/**
 * 加载 `.env`（若存在）并解析为完整设置。凭据与表前缀均由此注入，
 * 缺省复用共享 `MYSQL_*`，可用本插件独享的 `SESSION_*` 覆盖。
 * @param env - 环境变量快照（默认 process.env）。
 * @returns 合并后的后端设置；连接参数缺失即抛错（fail-closed）。
 */
export function loadSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): MysqlSettings {
  // 可选加载项目根目录 .env（不存在则忽略）。
  loadDotenv({ quiet: true });

  const host = fromEnv(env, "HOST");
  const user = fromEnv(env, "USER");
  const password = fromEnv(env, "PASSWORD");
  const database = fromEnv(env, "DATABASE");
  const tablePrefix = fromEnv(env, "TABLE_PREFIX");
  if (host === undefined) {
    throw new Error("缺少 SESSION_HOST / MYSQL_HOST：连接凭据必须来自环境变量");
  }
  if (user === undefined) {
    throw new Error("缺少 SESSION_USER / MYSQL_USER：连接凭据必须来自环境变量");
  }
  if (password === undefined) {
    throw new Error("缺少 SESSION_PASSWORD / MYSQL_PASSWORD：连接凭据必须来自环境变量");
  }
  if (database === undefined) throw new Error("缺少 SESSION_DATABASE / MYSQL_DATABASE");
  if (tablePrefix === undefined) {
    throw new Error("缺少 SESSION_TABLE_PREFIX / MYSQL_TABLE_PREFIX：表前缀必须来自环境变量");
  }

  const readHost = fromEnv(env, "READ_HOST");
  const readUser = fromEnv(env, "READ_USER");
  const readPassword = fromEnv(env, "READ_PASSWORD");

  const connection: ConnectionSettings = {
    host,
    port: intFromEnv(fromEnv(env, "PORT"), 3306, "SESSION_PORT/MYSQL_PORT"),
    user,
    password,
    database,
    tablePrefix,
    charset: env.SESSION_CHARSET ?? env.MYSQL_CHARSET ?? DEFAULT_CHARSET,
    connectTimeout: intFromEnv(
      env.SESSION_CONNECT_TIMEOUT ?? env.MYSQL_CONNECT_TIMEOUT,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "SESSION_CONNECT_TIMEOUT/MYSQL_CONNECT_TIMEOUT",
    ),
    ssl: undefined,
    sslRequired:
      env.SESSION_SSL_REQUIRED === "true" ||
      env.SESSION_SSL_REQUIRED === "1" ||
      env.MYSQL_SSL_REQUIRED === "true" ||
      env.MYSQL_SSL_REQUIRED === "1",
  };

  // 读库：未配置读库连接（SESSION_READ_HOST / MYSQL_READ_HOST）时复用写库连接（测试同库模式）。
  const readConnection: ConnectionSettings =
    readHost !== undefined
      ? {
          ...connection,
          host: readHost,
          user: readUser ?? user,
          password: readPassword ?? password,
        }
      : connection;

  const pool: PoolSettings = {
    poolSize: intFromEnv(fromEnv(env, "POOL_SIZE"), 10, "SESSION_POOL_SIZE/MYSQL_POOL_SIZE"),
    minIdle: intFromEnv(
      fromEnv(env, "POOL_MIN_IDLE"),
      0,
      "SESSION_POOL_MIN_IDLE/MYSQL_POOL_MIN_IDLE",
    ),
    idleTimeout: intFromEnv(
      fromEnv(env, "POOL_IDLE_TIMEOUT"),
      60_000,
      "SESSION_POOL_IDLE_TIMEOUT/MYSQL_POOL_IDLE_TIMEOUT",
    ),
    acquireTimeout: intFromEnv(
      fromEnv(env, "POOL_ACQUIRE_TIMEOUT"),
      10_000,
      "SESSION_POOL_ACQUIRE_TIMEOUT/MYSQL_POOL_ACQUIRE_TIMEOUT",
    ),
    queueLimit: intFromEnv(
      fromEnv(env, "POOL_QUEUE_LIMIT"),
      0,
      "SESSION_POOL_QUEUE_LIMIT/MYSQL_POOL_QUEUE_LIMIT",
    ),
  };

  const persistence: PersistenceSettings = {
    // 布尔默认开：仅当任一来源显式 "false" 时关闭（与 storage 的 autoMigrate 语义一致）。
    packChunks: env.SESSION_PACK_CHUNKS !== "false" && env.MYSQL_PACK_CHUNKS !== "false",
  };

  // 加密 key 可选：独享 SESSION_ENCRYPTION_KEY > 共享 MYSQL_ENCRYPTION_KEY > 旧版裸 ENCRYPTION_KEY。
  const encryptionKey = fromEnv(env, "ENCRYPTION_KEY") ?? env.ENCRYPTION_KEY;
  const security: SecuritySettings = {
    encryptionKey: encryptionKey !== undefined && encryptionKey !== "" ? encryptionKey : undefined,
    schemaAutoMigrate:
      env.SESSION_SCHEMA_AUTO_MIGRATE !== "false" && env.MYSQL_SCHEMA_AUTO_MIGRATE !== "false",
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
      packChunks: ps?.packChunks ?? base.persistence.packChunks,
    },
    security: {
      encryptionKey: sc?.encryptionKey ?? base.security.encryptionKey,
      schemaAutoMigrate: sc?.schemaAutoMigrate ?? base.security.schemaAutoMigrate,
    },
  };
}
