import {
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  SessionLogOffset,
} from "@deepseek-ai/dsh-session";
import {
  type PersistenceBackend,
  SessionPersistenceRevision,
  type SessionStorageMetadata,
  type StoredPrefix,
  type StoredSuffix,
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
 * MySQL 会话持久化后端。实现 {@link PersistenceBackend}（tornMarker 恒为
 * undefined：写路径单事务，InnoDB 原子，无撕裂尾部），写 hook 走写池、读
 * hook 走读池。
 */
export class MysqlBackend implements PersistenceBackend<undefined> {
  /** 后端标签，用于协调器诊断与 dispose 失败汇总。 */
  readonly name = "session-persistence-mysql";
  /** 写连接池。 */
  private readonly writePool: Pool;
  /** 读连接池（同库模式复用写池）。 */
  private readonly readPool: Pool;
  /** 是否为同库模式（写/读共用一个池）。 */
  private readonly sharedPool: boolean;
  /** 表名集合。 */
  private readonly names: TableNames;
  /** revision 来源限定前缀（区分不同存储源）。 */
  private readonly revisionPrefix: string;
  /** 是否启用 chunk run 折叠写入。 */
  private readonly packChunks: boolean;

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
    this.packChunks = settings.persistence.packChunks;
  }

  /**
   * 构造来源限定的 revision 字符串。
   * @param logRev - 会话日志修订号。
   * @returns 品牌化 revision。
   */
  private revision(logRev: number): SessionPersistenceRevision {
    return SessionPersistenceRevision(`${this.revisionPrefix}#${logRev}`);
  }

  /**
   * 从会话头行还原 SessionHeader。旧模型把 fork 边界存于 header.seedLength；
   * 0.1.2 起 header 以必填 isSeeded 表达，继承前缀长度改由 inheritedEventCount
   * 单独承载。落盘仍用 seed_length 列编码该前缀（仅 isSeeded 时非空），与 JSONL
   * 参考实现逐位一致，故此处由「列非空」推导 isSeeded。
   * @param row - sessions 表行。
   * @returns 还原的会话头（含 isSeeded，不含已移除的 seedLength）。
   */
  private headerFromRow(row: SessionRow): SessionHeader {
    return {
      version: row.version,
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
   * 从会话头行还原存储元数据（header + 继承前缀长度）。loadStored/loadStoredFrom
   * 需返回 StoredPrefix/StoredSuffix 所要求的 inheritedEventCount。
   * @param row - sessions 表行。
   * @returns 存储元数据。
   */
  private storageFromRow(row: SessionRow): SessionStorageMetadata {
    return {
      meta: this.headerFromRow(row),
      inheritedEventCount: SessionLogOffset(row.seed_length ?? 0),
    };
  }

  /**
   * 由会话头 + 继承前缀长度派生 sessions 表插入值（不含 log_rev，缺省为 0）。
   * seed_length 列承载 isSeeded 会话的继承前缀长度；未 seed 会话写 NULL
   * （与 JSONL header 仅在 isSeeded 时携带 seedLength 的编码一致）。
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
   * 读取存储前缀（header + 全部事件）。无记录返回 undefined。
   * @param id - 会话 id。
   * @param signal - 取消信号。
   * @returns 存储前缀，含 revision，无 tornMarker。
   */
  async loadStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<undefined> | undefined> {
    signal?.throwIfAborted();
    const header = await this.readHeader(id, this.readPool);
    if (header === undefined) return undefined;
    signal?.throwIfAborted();
    const eventRows = await this.readEventRows(id, this.readPool);
    signal?.throwIfAborted();
    return {
      ...this.storageFromRow(header),
      events: decodeStoredRows(eventRows),
      revision: this.revision(header.log_rev),
    };
  }

  /**
   * 只读会话日志修订号（不载入事件）。
   * @param id - 会话 id。
   * @param signal - 取消信号。
   * @returns 当前 revision 或 undefined。
   */
  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted();
    const [rows] = await this.readPool.query<SessionRow[]>(
      `SELECT log_rev FROM \`${this.names.sessions}\` WHERE session_id = ?`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : this.revision(row.log_rev);
  }

  /**
   * seek-capable 后缀读（readFrom 的后端支撑）。
   * @param id - 会话 id。
   * @param fromSeq - 起始 seq（含）。
   * @param signal - 取消信号。
   * @returns header + seq>=fromSeq 的事件，或 undefined。
   */
  async loadStoredFrom(
    id: SessionId,
    fromSeq: SessionLogOffset,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted();
    const header = await this.readHeader(id, this.readPool);
    if (header === undefined) return undefined;
    signal?.throwIfAborted();
    const eventRows = await this.readEventRows(id, this.readPool, fromSeq);
    signal?.throwIfAborted();
    return { ...this.storageFromRow(header), events: decodeStoredRows(eventRows) };
  }

  /**
   * 判断错误是否为 MySQL 死锁（errno 1213），用于有限重试。
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
   * 持久化一段连续事件批次，lazy materialization 与首批事件同一事务原子提交。
   * @param storage - 存储元数据（会话头 + 继承前缀长度）。
   * @param events - 连续事件批次（seq 有序）。
   * @param isMaterialized - 会话是否已 materialize。
   */
  async appendBatch(
    storage: SessionStorageMetadata,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    // 死锁有限重试：跨进程写同 id 时偶发，退避后重试。
    let attempt = 0;
    for (;;) {
      try {
        await this.appendBatchOnce(storage, events, isMaterialized);
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
   * appendBatch 的单次事务执行体。
   * @param storage - 存储元数据（会话头 + 继承前缀长度）。
   * @param events - 事件批次。
   * @param isMaterialized - 是否已 materialize。
   */
  private async appendBatchOnce(
    storage: SessionStorageMetadata,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    const meta = storage.meta;
    const rows = encodeStorageRows(events, this.packChunks);
    const conn = await this.writePool.getConnection();
    try {
      await conn.beginTransaction();
      if (!isMaterialized) {
        await conn.query(
          `INSERT INTO \`${this.names.sessions}\`
           (session_id, version, created_at, cwd, parent_session, seed_length,
            origin, delegation_depth, agent_preset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          this.headerInsert(meta, storage.inheritedEventCount),
        );
      } else {
        // 锁定会话行，序列化同 id 跨进程写入。
        const [lock] = await conn.query<SessionRow[]>(
          `SELECT log_rev FROM \`${this.names.sessions}\` WHERE session_id = ? FOR UPDATE`,
          [meta.id],
        );
        if (lock[0] === undefined) {
          throw new Error(
            `append 目标会话未 materialize：${JSON.stringify(meta.id)}（协调器状态与存储不一致）`,
          );
        }
      }
      // 多行批量插入事件；复合主键唯一约束兜底同 id 双写。
      const values: unknown[][] = rows.map((row, index) => [
        meta.id,
        events[index]?.seq,
        row.rowType,
        row.payload,
      ]);
      await conn.query(
        `INSERT INTO \`${this.names.events}\` (session_id, seq, row_type, payload) VALUES ?`,
        [values],
      );
      const [update] = await conn.query<ResultSetHeader>(
        `UPDATE \`${this.names.sessions}\` SET log_rev = log_rev + 1 WHERE session_id = ?`,
        [meta.id],
      );
      if (update.affectedRows !== 1) {
        throw new Error(
          `log_rev 递增失败：会话 ${JSON.stringify(meta.id)} 更新 ${update.affectedRows} 行`,
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
   * 空会话持久化 header（ensureMaterialized 的落点）：不造任何会话事件，仅
   * 物化一行 sessions。协调器按 id 串行化，不会与 append 的 lazy materialize 竞争。
   * @param storage - 存储元数据。
   */
  async materializeHeader(storage: SessionStorageMetadata): Promise<void> {
    const conn = await this.writePool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO \`${this.names.sessions}\`
         (session_id, version, created_at, cwd, parent_session, seed_length,
          origin, delegation_depth, agent_preset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.headerInsert(storage.meta, storage.inheritedEventCount),
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 持久化崩溃修复：追加 closers。tornMarker 恒为 undefined（事务原子无撕裂尾）。
   * @param storage - 存储元数据。
   * @param _tornMarker - 恒为 undefined。
   * @param closers - 合成关闭事件。
   */
  async commitRepair(
    storage: SessionStorageMetadata,
    _tornMarker: undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (closers.length === 0) return;
    await this.appendBatch(storage, closers, true);
  }

  /**
   * 列出所有已 materialize 会话的 header（轻量，不载事件）。
   * @param signal - 取消信号。
   * @returns 会话头数组。
   */
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    const [rows] = await this.readPool.query<SessionRow[]>(
      `SELECT * FROM \`${this.names.sessions}\` ORDER BY session_id`,
    );
    return rows.map((row) => this.headerFromRow(row));
  }

  /**
   * 轻量列出会话快照：header + 来源限定 revision（单次查询，不载事件）。
   * @param signal - 取消信号。
   * @returns 会话快照数组。
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
   * 关闭后端持有的连接池（同库模式只关一次）。
   */
  async close(): Promise<void> {
    if (this.sharedPool) {
      await this.writePool.end();
    } else {
      await Promise.all([this.writePool.end(), this.readPool.end()]);
    }
  }
}
