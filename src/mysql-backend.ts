import {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  SessionLogOffset,
} from "@deepseek-ai/dsh-session";
import {
  assertStoredId,
  assertVersion,
  SessionPersistenceRevision as brandRevision,
  SessionAlreadyExistsError,
  SessionHandleClosedError,
  type SessionLocation,
  SessionPersistenceNotFoundError,
  type SessionPersistenceRevision,
  SessionReadOnlyError,
} from "@deepseek-ai/dsh-session-persistence";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type { MysqlSettings } from "./config.js";
import { decodeStoredRows, encodeStorageRows } from "./mysql-codec.js";
import { SCHEMA_VERSION, type TableNames, tableNames } from "./schema.js";

/**
 * events 表读取行（payload 为存储记录 JSON 文本）。
 */
interface EventRow extends RowDataPacket {
  readonly seq: number;
  readonly payload: string;
}

/**
 * sessions 表读取行（字段与表结构一一对应）。
 */
interface SessionRow extends RowDataPacket {
  readonly session_id: string;
  readonly version: number;
  readonly created_at: number;
  readonly cwd: string | null;
  readonly parent_session: string | null;
  readonly seed_length: number | null;
  readonly origin: string | null;
  readonly delegation_depth: number;
  readonly agent_preset: string | null;
  readonly log_rev: number;
}

/**
 * 一个成功读取的会话存储视图。承载 handle.read 所需的所有信息。
 */
interface ReadStoredLog {
  /** 反序列化的会话头（已对齐到当前 SESSION_FORMAT_VERSION）。 */
  readonly meta: SessionHeader;
  /** 连续事件序列（无撕裂尾）。 */
  readonly events: readonly SessionEvent[];
  /** 继承前缀长度（独立元数据，0 表示未 seed）。 */
  readonly inheritedEventCount: SessionLogOffset;
  /** 当前事件总数（用于 read offset 边界）。 */
  readonly eventCount: number;
  /** 来源限定 revision（stat/list 用）。 */
  readonly revision: SessionPersistenceRevision;
}

/**
 * MySQL 存储原语层。把"会话头 + 事件流"映射到 InnoDB 表上的原子写；
 * 写路径单事务（无撕裂尾），并发写用 SELECT ... FOR UPDATE + 复合主键兜底。
 * 不持有任何进程内状态——单写者由 tracker 保证，跨进程序列化由 MySQL 锁保证。
 */
export class MysqlBackend {
  /** 后端标签（诊断与 effect 命名）。 */
  readonly name = "session-persistence-mysql";
  /** 写连接池。 */
  private readonly writePool: Pool;
  /** 读连接池（同库模式复用写池）。 */
  private readonly readPool: Pool;
  /** 是否为同库模式（写/读共用一个池）。 */
  private readonly sharedPool: boolean;
  /** 表名集合。 */
  private readonly names: TableNames;
  /** revision 来源限定前缀。 */
  private readonly revisionPrefix: string;

  /**
   * 构造 MySQL 后端。
   * @param writePool - 写连接池。
   * @param readPool - 读连接池。
   * @param sharedPool - 是否与写池共用同一实例。
   * @param settings - 合并后的后端设置。
   */
  constructor(writePool: Pool, readPool: Pool, sharedPool: boolean, settings: MysqlSettings) {
    this.writePool = writePool;
    this.readPool = readPool;
    this.sharedPool = sharedPool;
    this.names = tableNames(settings.connection.tablePrefix);
    this.revisionPrefix = `${settings.connection.database}/${settings.connection.tablePrefix}:v${SCHEMA_VERSION}`;
  }

  /**
   * 构造来源限定的 revision 字符串。
   * @param logRev - 会话日志修订号。
   * @returns 品牌化 revision。
   */
  private revision(logRev: number): SessionPersistenceRevision {
    return brandRevision(`${this.revisionPrefix}#${logRev}`);
  }

  /**
   * 从会话头行还原 SessionHeader。旧模型把 fork 边界存于 header.seedLength；
   * 0.1.5 起 header 不再带 seedLength，由 inheritedEventCount 单独承载。落盘
   * 沿用 seed_length 列：非空即 isSeeded，数值为 inheritedEventCount。
   * 版本字段固定刷为当前 SESSION_FORMAT_VERSION（schema 迁移已就位）。
   * @param row - sessions 表行。
   * @returns 还原的会话头。
   */
  private headerFromRow(row: SessionRow): SessionHeader {
    return {
      version: SESSION_FORMAT_VERSION,
      id: row.session_id as SessionId,
      createdAt: row.created_at,
      isSeeded: row.seed_length !== null,
      ...(row.cwd !== null ? { cwd: row.cwd } : {}),
      ...(row.parent_session !== null ? { parentSession: row.parent_session as SessionId } : {}),
      ...(row.origin !== null ? { origin: row.origin as "subagent" } : {}),
      ...(row.delegation_depth !== 0 ? { delegationDepth: row.delegation_depth } : {}),
      ...(row.agent_preset !== null ? { agentPreset: row.agent_preset } : {}),
    };
  }

  /**
   * 由会话头 + 继承前缀长度派生 sessions 表插入值（不含 log_rev，缺省为 0）。
   * seed_length 列承载 isSeeded 会话的 inheritedEventCount；未 seed 会话写 NULL。
   * @param meta - 会话头。
   * @param inheritedEventCount - fork 继承前缀长度。
   * @returns 与列序一致的插入数组。
   */
  private headerInsert(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
  ): (string | number | null)[] {
    return [
      meta.id,
      meta.version,
      meta.createdAt,
      meta.cwd ?? null,
      meta.parentSession ?? null,
      meta.isSeeded ? inheritedEventCount : null,
      meta.origin ?? null,
      meta.delegationDepth ?? 0,
      meta.agentPreset ?? null,
    ];
  }

  /**
   * 读取一个会话的 header 行。
   * @param id - 会话 id。
   * @param pool - 使用的连接池。
   * @returns header 行或 undefined。
   */
  private async readHeader(id: SessionId, pool: Pool): Promise<SessionRow | undefined> {
    const [rows] = await pool.query<SessionRow[]>(
      `SELECT * FROM \`${this.names.sessions}\` WHERE session_id = ?`,
      [id],
    );
    return rows[0];
  }

  /**
   * 读取一个会话的全部事件行（seq 升序）。
   * @param id - 会话 id。
   * @param pool - 使用的连接池。
   * @param fromSeq - 可选下界（含）。
   * @returns 事件行数组。
   */
  private async readEventRows(id: SessionId, pool: Pool, fromSeq?: number): Promise<EventRow[]> {
    const sql =
      fromSeq === undefined
        ? `SELECT seq, payload FROM \`${this.names.events}\` WHERE session_id = ? ORDER BY seq`
        : `SELECT seq, payload FROM \`${this.names.events}\` WHERE session_id = ? AND seq >= ? ORDER BY seq`;
    const [rows] = await pool.query<EventRow[]>(sql, fromSeq === undefined ? [id] : [id, fromSeq]);
    return rows;
  }

  /**
   * 判断错误是否为 MySQL 死锁（errno 1213）。
   * @param error - 捕获的错误。
   * @returns 是否死锁。
   */
  private isDeadlock(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "errno" in error &&
      (error as { errno?: unknown }).errno === 1213
    );
  }

  /**
   * 判断错误是否为 MySQL 重复键（errno 1062），用于把跨进程写者撞 seq 转为
   * SessionOwnershipLostError 的上游语义依据。
   * @param error - 捕获的错误。
   * @returns 是否重复键。
   */
  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "errno" in error &&
      (error as { errno?: unknown }).errno === 1062
    );
  }

  /**
   * 读取并校验整个会话日志。session 不存在抛 SessionPersistenceNotFoundError。
   * @param id - 会话 id。
   * @param signal - 取消信号。
   * @returns 已校验的完整存储视图。
   */
  async readStoredLog(id: SessionId, signal?: AbortSignal): Promise<ReadStoredLog> {
    signal?.throwIfAborted();
    const row = await this.readHeader(id, this.readPool);
    if (row === undefined) throw new SessionPersistenceNotFoundError(id);
    signal?.throwIfAborted();
    const header = this.headerFromRow(row);
    const events = decodeStoredRows(header, await this.readEventRows(id, this.readPool));
    signal?.throwIfAborted();
    assertStoredId(id, header);
    assertVersion(header, this.locate(header));
    return {
      meta: header,
      events,
      inheritedEventCount: SessionLogOffset(row.seed_length ?? 0),
      eventCount: events.length,
      revision: this.revision(row.log_rev),
    };
  }

  /**
   * 仅判断会话是否已 materialize（不读事件）。
   * @param id - 会话 id。
   * @param signal - 取消信号。
   * @returns 是否存在 header 行。
   */
  async hasSession(id: SessionId, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const [rows] = await this.readPool.query<RowDataPacket[]>(
      `SELECT 1 FROM \`${this.names.sessions}\` WHERE session_id = ? LIMIT 1`,
      [id],
    );
    return rows.length > 0;
  }

  /**
   * 列出所有已 materialize 会话的快照（单次查询，不载事件）。
   * @param signal - 取消信号。
   * @returns 快照数组。
   */
  async listSnapshots(
    signal?: AbortSignal,
  ): Promise<{ header: SessionHeader; revision: SessionPersistenceRevision }[]> {
    signal?.throwIfAborted();
    const [rows] = await this.readPool.query<SessionRow[]>(
      `SELECT * FROM \`${this.names.sessions}\` ORDER BY session_id`,
    );
    return rows.map((row) => ({
      header: this.headerFromRow(row),
      revision: this.revision(row.log_rev),
    }));
  }

  /**
   * 持久化一段连续事件批次：lazy materialization 与首批事件同一事务原子提交。
   * 已 materialize 的会话通过 SELECT ... FOR UPDATE 序列化同 id 跨进程写入。
   * @param header - 会话头。
   * @param events - 连续事件批次（seq 有序）。
   * @param isMaterialized - 会话是否已 materialize。
   * @param inheritedEventCount - fork 继承前缀长度。
   */
  async persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await this.persistBatchOnce(header, events, isMaterialized, inheritedEventCount);
        return;
      } catch (error) {
        if (this.isDeadlock(error) && attempt < 3) {
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * persistBatch 的单次事务执行体。
   * @param header - 会话头。
   * @param events - 事件批次。
   * @param isMaterialized - 是否已 materialize。
   * @param inheritedEventCount - fork 继承前缀长度。
   */
  private async persistBatchOnce(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void> {
    const rows = encodeStorageRows(events);
    const conn = await this.writePool.getConnection();
    try {
      await conn.beginTransaction();
      if (!isMaterialized) {
        try {
          await conn.query(
            `INSERT INTO \`${this.names.sessions}\`
             (session_id, version, created_at, cwd, parent_session, seed_length,
              origin, delegation_depth, agent_preset)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            this.headerInsert(header, inheritedEventCount),
          );
        } catch (error) {
          if (this.isDuplicateKey(error)) {
            throw new SessionAlreadyExistsError(header.id);
          }
          throw error;
        }
      } else {
        // 锁定会话行，序列化同 id 跨进程写入。
        const [lock] = await conn.query<SessionRow[]>(
          `SELECT log_rev FROM \`${this.names.sessions}\` WHERE session_id = ? FOR UPDATE`,
          [header.id],
        );
        if (lock[0] === undefined) {
          throw new SessionHandleClosedError(header.id, "append");
        }
      }
      // 多行批量插入事件；复合主键唯一约束兜底同 id 双写。
      const values: unknown[][] = rows.map((row, index) => [
        header.id,
        events[index]?.seq,
        row.rowType,
        row.payload,
      ]);
      if (values.length > 0) {
        try {
          await conn.query(
            `INSERT INTO \`${this.names.events}\` (session_id, seq, row_type, payload) VALUES ?`,
            [values],
          );
        } catch (error) {
          if (this.isDuplicateKey(error)) {
            throw new SessionHandleClosedError(header.id, "append");
          }
          throw error;
        }
      }
      const [update] = await conn.query<ResultSetHeader>(
        `UPDATE \`${this.names.sessions}\` SET log_rev = log_rev + 1 WHERE session_id = ?`,
        [header.id],
      );
      if (update.affectedRows !== 1) {
        throw new Error(
          `log_rev 递增失败：会话 ${JSON.stringify(header.id)} 更新 ${update.affectedRows} 行`,
        );
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 空会话持久化 header（flush 的落点）：不造任何会话事件，仅物化一行 sessions。
   * 协调器按 id 串行化，不会与 append 的 lazy materialize 竞争。
   * @param header - 会话头。
   * @param inheritedEventCount - fork 继承前缀长度。
   */
  async persistHeader(header: SessionHeader, inheritedEventCount: SessionLogOffset): Promise<void> {
    const conn = await this.writePool.getConnection();
    try {
      await conn.beginTransaction();
      try {
        await conn.query(
          `INSERT INTO \`${this.names.sessions}\`
           (session_id, version, created_at, cwd, parent_session, seed_length,
            origin, delegation_depth, agent_preset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          this.headerInsert(header, inheritedEventCount),
        );
      } catch (error) {
        if (this.isDuplicateKey(error)) {
          throw new SessionAlreadyExistsError(header.id);
        }
        throw error;
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 解析后端工件位置：MySQL 整库即后端，会话 id 即物理位置。
   * @param meta - 会话头。
   * @returns 定位信息（kind=数据库 schema，path=表前缀 + session id）。
   */
  locate(meta: SessionHeader): SessionLocation {
    return {
      kind: `mysql:${this.names.sessions}`,
      path: `${this.names.sessions}/${meta.id}`,
    };
  }

  /**
   * 在 read 上下文（handle.read 之前）调用：保证目标会话存在并可读。
   * @param id - 会话 id。
   * @param signal - 取消信号。
   */
  async assertReadable(id: SessionId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const exists = await this.hasSession(id, signal);
    if (!exists) throw new SessionPersistenceNotFoundError(id);
  }

  /**
   * 关闭后端持有的连接池（同库模式只关一次）。
   */
  async close(): Promise<void> {
    if (this.sharedPool) {
      await this.writePool.end();
    } else {
      await Promise.all([this.writePool.end(), this.readPool.end()]);
    }
  }

  /** 内部辅助：给 SessionReadOnlyError 抛点用。 */
  static readonly ReadOnlySentinel = new SessionReadOnlyError(
    "__sentinel__" as SessionId,
    "__noop__",
  );
}
