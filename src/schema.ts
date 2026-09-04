import type { Pool, RowDataPacket } from "mysql2/promise";

/** 当前 schema 结构版本号。递增代表一次结构变更（需新增迁移）。 */
export const SCHEMA_VERSION = 1;

/**
 * 表前缀合法字符集：仅允许字母、数字、下划线，防止标识符注入。
 */
export const TABLE_PREFIX_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * 表名集合：由前缀派生的三张表名。
 */
export interface TableNames {
  /** 会话头表。 */
  readonly sessions: string;
  /** 事件日志表。 */
  readonly events: string;
  /** schema 版本表。 */
  readonly meta: string;
}

/**
 * 校验表前缀是否只含安全字符。
 * @param prefix - 待校验的表前缀。
 * @returns 原值（校验通过）。
 * @throws 前缀含非法字符时抛出，防止标识符注入。
 */
export function assertTablePrefix(prefix: string): string {
  if (!TABLE_PREFIX_PATTERN.test(prefix)) {
    throw new Error(`表前缀非法：仅允许 [A-Za-z0-9_]，收到 ${JSON.stringify(prefix)}`);
  }
  return prefix;
}

/**
 * 由合法前缀派生三张表名。
 * @param prefix - 已校验的表前缀。
 * @returns 表名集合。
 */
export function tableNames(prefix: string): TableNames {
  assertTablePrefix(prefix);
  return {
    sessions: `${prefix}sessions`,
    events: `${prefix}events`,
    meta: `${prefix}_meta`,
  };
}

/**
 * sessions 表 DDL（幂等建表）。每个字段以中文注释说明用途。
 * @param name - sessions 表名。
 * @returns DDL 语句。
 */
export function sessionsDdl(name: string): string {
  return `CREATE TABLE IF NOT EXISTS \`${name}\` (
  session_id       VARCHAR(255) NOT NULL COMMENT '品牌化会话 id；唯一标识。仅参数化绑定，绝不作 SQL 标识符拼接',
  version          INT NOT NULL COMMENT '会话头格式版本（SESSION_FORMAT_VERSION，当前 v0）',
  created_at       BIGINT NOT NULL COMMENT '会话创建时间（epoch 毫秒）；重建时还原原始 createdAt',
  cwd              TEXT NULL COMMENT '会话工作目录（可选），用于导航/隔离',
  parent_session   VARCHAR(255) NULL COMMENT '父会话 id（lineage，可选）',
  seed_length      INT NULL COMMENT 'fork 继承前缀长度（=inheritedEventCount）；非空即 isSeeded，未 seed 会话为 NULL',
  origin           VARCHAR(64) NULL COMMENT '会话来源标记（可选）',
  delegation_depth INT NOT NULL COMMENT '委托深度；磁盘上必需，顶层为 0',
  agent_preset     VARCHAR(255) NULL COMMENT '决定恢复后工具与提示词的 agent preset（可选但建议持久化）',
  log_rev          BIGINT NOT NULL DEFAULT 0 COMMENT '日志修订号；每次 append/repair 同事务自增；构成 revision 日志版本',
  PRIMARY KEY (session_id)
) ENGINE=InnoDB COMMENT='会话头表：每会话一行（=已 materialize 的会话头）';
`;
}

/**
 * events 表 DDL（幂等建表）。每个字段以中文注释说明用途。
 * @param name - events 表名。
 * @param sessionsName - 被外键引用的 sessions 表名。
 * @returns DDL 语句。
 */
export function eventsDdl(name: string, sessionsName: string): string {
  return `CREATE TABLE IF NOT EXISTS \`${name}\` (
  session_id VARCHAR(255) NOT NULL COMMENT '所属会话 id，引用 sessions；与 seq 构成复合主键',
  seq        BIGINT NOT NULL COMMENT '事件在日志中的序号，从 0 连续递增；复合主键唯一约束兜底同 id 双写',
  row_type   VARCHAR(32) NULL COMMENT '存储行类型；NULL=裸事件；text-chunks/reasoning-chunks/tool-call-chunks=packed chunk 行',
  payload    LONGTEXT NOT NULL COMMENT '存储记录 JSON；参数化写入；非 JSON 可序列化在写入前被拒绝',
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id)
    REFERENCES \`${sessionsName}\`(session_id)
) ENGINE=InnoDB COMMENT='事件日志表：会话事件日志（append-only，事实源）';
`;
}

/**
 * schema 版本表 DDL（幂等建表）。
 * @param name - meta 表名。
 * @returns DDL 语句。
 */
export function metaDdl(name: string): string {
  return `CREATE TABLE IF NOT EXISTS \`${name}\` (
  version INT NOT NULL,
  applied_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
  PRIMARY KEY (version)
) ENGINE=InnoDB
COMMENT='schema 版本表：记录已应用的迁移版本';
`;
}

/**
 * schema 迁移选项。
 */
export interface EnsureSchemaOptions {
  /** 期望结构版本；缺省为当前 {@link SCHEMA_VERSION}。 */
  readonly expectedVersion?: number;
  /** 是否允许自动迁移（false 时版本不匹配即失败）。 */
  readonly autoMigrate: boolean;
}

/**
 * 确保 schema 就绪：幂等建表 + 版本校验/迁移。
 * @param pool - 用于执行 DDL 的写连接池。
 * @param prefix - 表前缀。
 * @param options - 迁移选项。
 * @throws 期望版本低于已应用版本（降级不支持）或禁止自动迁移但版本不匹配时抛出。
 */
export async function ensureSchema(
  pool: Pool,
  prefix: string,
  options: EnsureSchemaOptions,
): Promise<void> {
  const expected = options.expectedVersion ?? SCHEMA_VERSION;
  const names = tableNames(prefix);

  // 幂等建表（IF NOT EXISTS）。
  await pool.query(metaDdl(names.meta));
  await pool.query(sessionsDdl(names.sessions));
  await pool.query(eventsDdl(names.events, names.sessions));

  // 读取已应用的最大版本。
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(MAX(version), 0) AS v FROM \`${names.meta}\``,
  );
  const applied = Number(rows[0]?.v ?? 0);

  if (applied > expected) {
    throw new Error(`schema 版本降级：已应用 ${applied}，期望 ${expected}。不支持降级。`);
  }
  if (applied === expected) return;

  // applied < expected：需要迁移。
  if (!options.autoMigrate) {
    throw new Error(`schema 版本落后：已应用 ${applied}，期望 ${expected}，且禁止自动迁移。`);
  }
  await pool.query(`INSERT INTO \`${names.meta}\` (version) VALUES (?)`, [expected]);
}
