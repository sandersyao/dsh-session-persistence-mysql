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
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  type SessionLocation,
  SessionOwnershipLostError,
  SessionPersistenceNotFoundError,
  type SessionPersistenceRevision,
  SessionReadOnlyError,
} from "@deepseek-ai/dsh-session-persistence";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

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
 * leases 表读取行。
 */
interface LeaseRow extends RowDataPacket {
  readonly owner_id: string;
  readonly fence_token: number;
  readonly expires_at: number;
}

/**
 * 写路径携带的租约围栏信息（cluster/lease 模式）；缺省表示未启用租约。
 */
export interface LeaseFence {
  /** 写所有者标识。 */
  readonly ownerId: string;
  /** 围栏令牌。 */
  readonly fenceToken: number;
  /** 租约 TTL（毫秒），用于写事务内机会式续租。 */
  readonly ttlMs: number;
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
  /** 是否启用跨进程租约（cluster/lease 模式）。 */
  private readonly leaseEnabled: boolean;

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
    this.leaseEnabled = settings.cluster.lease.enabled;
  }

  /** 租约是否启用（handle/index 构造时决定是否认领）。 */
  get leasesEnabled(): boolean {
    return this.leaseEnabled;
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
   * 事件内容比较用规范化串：按固定键序序列化（type/seq/time/ignorable/data +
   * 条件字段），避免两端对象键插入顺序不同造成“同内容判为不同”。
   * @param event - 会话事件。
   * @returns 规范化 JSON 文本。
   */
  private eventCanonical(event: SessionEvent): string {
    const ev = event as SessionEvent & {
      sourceEventSeqs?: readonly number[];
      surfaceOp?: unknown;
    };
    const canonical: Record<string, unknown> = {
      type: event.type,
      seq: event.seq,
      time: event.time,
      ignorable: event.ignorable,
      data: event.data,
    };
    if (ev.sourceEventSeqs !== undefined) canonical.sourceEventSeqs = ev.sourceEventSeqs;
    if (ev.surfaceOp !== undefined) canonical.surfaceOp = ev.surfaceOp;
    return JSON.stringify(canonical);
  }

  /**
   * 校验“本批事件是否已是该会话已提交日志的一部分（内容逐条一致）”。
   *
   * 为什么需要：调用方在「写库成功但 ack 前连接断开/超时」时会带着同一个
   * next-seq 重发同一批事件（at-least-once）；此时主键重复是「已提交的重放」，
   * 应按幂等 no-op 成功返回，而不是抛重复键让整个轮次失败。比较在**解码后的
   * 事件**上进行，并对逐条 seq 校验内容，杜绝“同 seq 不同内容”的真冲突被误判。
   * @param header - 会话头（提供 id 与解码错误信息）。
   * @param events - 待写入的事件批次。
   * @returns 全部事件都已在库中且内容一致时为 true（可安全 no-op）。
   */
  private async committedMatches(
    header: SessionHeader,
    events: readonly SessionEvent[],
  ): Promise<boolean> {
    if (events.length === 0) return true;
    const rows = await this.readEventRows(header.id, this.readPool);
    const existing = new Map<number, string>();
    for (const event of decodeStoredRows(header, rows)) {
      existing.set(event.seq, this.eventCanonical(event));
    }
    for (const event of events) {
      const canonical = existing.get(event.seq);
      if (canonical === undefined || canonical !== this.eventCanonical(event)) return false;
    }
    return true;
  }

  /**
   * 写事务内校验围栏并机会式续租。租约行不存在按兼容放行（单实例遗留会话）；
   * 令牌不符抛 {@link SessionOwnershipLostError}。用调用方同一 conn/事务，保证
   * 原子，且 `FOR UPDATE` 行锁阻止并发接管在本次写提交前发生。
   * @param conn - 写事务连接。
   * @param id - 会话 id。
   * @param lease - 围栏信息。
   */
  private async assertLeaseFence(
    conn: PoolConnection,
    id: SessionId,
    lease: LeaseFence,
  ): Promise<void> {
    const [rows] = await conn.query<LeaseRow[]>(
      `SELECT fence_token FROM \`${this.names.leases}\` WHERE session_id = ? FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return;
    if (Number(row.fence_token) !== lease.fenceToken) {
      throw new SessionOwnershipLostError(id);
    }
    // 机会式续租：活跃写顺带延长租约，避免在写事务进行中过期被接管。
    const now = Date.now();
    await conn.query(
      `UPDATE \`${this.names.leases}\` SET expires_at = ?, last_heartbeat_at = ? WHERE session_id = ? AND fence_token = ?`,
      [now + lease.ttlMs, now, id, lease.fenceToken],
    );
  }

  /**
   * 原子认领会话写所有权（cluster/lease 模式）。算法：先尝试接管已过期/已释放
   * 行；未命中则判定：活跃持有 → SessionAlreadyOwnedError；无行 → INSERT（撞
   * 1062 则回退重新判定）。fence 由行内 `+1` 在行锁内递增，永不回退。
   * @param id - 会话 id。
   * @param ownerId - 写所有者标识。
   * @param ttlMs - 租约 TTL（毫秒）。
   * @returns 认领到的围栏令牌。
   * @throws SessionAlreadyOwnedError 当会话被他人活跃持有。
   */
  async claimLease(id: SessionId, ownerId: string, ttlMs: number): Promise<number> {
    // 认领事务内的 UPDATE/SELECT/INSERT 会在两个并发的“空行认领”之间形成
    // 间隙锁 + 插入意向锁的环路 → InnoDB 报 1213 死锁（整个事务被回滚）。
    // 这里在事务之外包一层重试：回滚后以新事务重做，重做时会读到对方已插入的
    // 活跃行，从而正确地判为 SessionAlreadyOwnedError。
    for (let txAttempt = 0; txAttempt < 4; txAttempt += 1) {
      const conn = await this.writePool.getConnection();
      try {
        await conn.beginTransaction();
        const fence = await this.claimLeaseTx(conn, id, ownerId, ttlMs);
        await conn.commit();
        return fence;
      } catch (error) {
        await conn.rollback().catch(() => {});
        if (this.isDeadlock(error) && txAttempt < 3) continue;
        throw error;
      } finally {
        conn.release();
      }
    }
    // 仅在连续 3 次死锁重试后仍失败时到达；按“未取得所有权”收敛。
    throw new SessionAlreadyOwnedError(id);
  }

  /**
   * 单次认领事务体：接管已过期/已释放行，否则判定或插入；**不提交**，由调用方管理
   * 事务边界与死锁重试。fence 由行内 `+1` 在行锁内递增，永不回退。
   * @param conn - 已开启事务的连接。
   * @param id - 会话 id。
   * @param ownerId - 写所有者标识。
   * @param ttlMs - 租约 TTL（毫秒）。
   * @returns 认领到的围栏令牌。
   * @throws SessionAlreadyOwnedError 当会话被他人活跃持有。
   */
  private async claimLeaseTx(
    conn: PoolConnection,
    id: SessionId,
    ownerId: string,
    ttlMs: number,
  ): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = Date.now();
      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE \`${this.names.leases}\`
         SET owner_id = ?, fence_token = fence_token + 1, acquired_at = ?, expires_at = ?, last_heartbeat_at = ?
         WHERE session_id = ? AND expires_at <= ?`,
        [ownerId, now, now + ttlMs, now, id, now],
      );
      if (upd.affectedRows === 1) {
        const [rows] = await conn.query<LeaseRow[]>(
          `SELECT fence_token FROM \`${this.names.leases}\` WHERE session_id = ?`,
          [id],
        );
        return Number(rows[0]?.fence_token);
      }
      const [rows] = await conn.query<LeaseRow[]>(
        `SELECT owner_id, fence_token, expires_at FROM \`${this.names.leases}\` WHERE session_id = ?`,
        [id],
      );
      const row = rows[0];
      if (row === undefined) {
        try {
          await conn.query(
            `INSERT INTO \`${this.names.leases}\`
             (session_id, owner_id, fence_token, acquired_at, expires_at, last_heartbeat_at)
             VALUES (?, ?, 1, ?, ?, ?)`,
            [id, ownerId, now, now + ttlMs, now],
          );
          return 1;
        } catch (error) {
          // 空行认领竞态：另一并发方已插入 → 回退重读并重新判定。
          if (this.isDuplicateKey(error)) continue;
          throw error;
        }
      }
      if (Number(row.expires_at) > now) {
        throw new SessionAlreadyOwnedError(id);
      }
      // 已过期但 UPDATE 未命中（并发竞态）→ 重试接管。
    }
    throw new SessionAlreadyOwnedError(id);
  }

  /**
   * 心跳续租：仅当前 owner+fence 匹配时刷新到期时间。
   * @param id - 会话 id。
   * @param ownerId - 写所有者标识。
   * @param fenceToken - 围栏令牌。
   * @param ttlMs - 租约 TTL（毫秒）。
   * @returns 命中 1 行即续租成功；0 行表示已失去所有权。
   */
  async renewLease(
    id: SessionId,
    ownerId: string,
    fenceToken: number,
    ttlMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    const [res] = await this.writePool.query<ResultSetHeader>(
      `UPDATE \`${this.names.leases}\` SET expires_at = ?, last_heartbeat_at = ? WHERE session_id = ? AND owner_id = ? AND fence_token = ?`,
      [now + ttlMs, now, id, ownerId, fenceToken],
    );
    return res.affectedRows === 1;
  }

  /**
   * 释放租约：**不删除行**（保留 fence 单调性），仅标记为空闲（owner=''、expires_at=0）。
   * @param id - 会话 id。
   * @param ownerId - 写所有者标识。
   * @param fenceToken - 围栏令牌。
   */
  async releaseLease(id: SessionId, ownerId: string, fenceToken: number): Promise<void> {
    const now = Date.now();
    await this.writePool.query(
      `UPDATE \`${this.names.leases}\` SET owner_id = '', expires_at = 0, last_heartbeat_at = ? WHERE session_id = ? AND owner_id = ? AND fence_token = ?`,
      [now, id, ownerId, fenceToken],
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
   * @param lease - 可选的围栏信息（cluster/lease 模式）；缺省不校验围栏。
   */
  async persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffset,
    lease?: LeaseFence,
  ): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await this.persistBatchOnce(header, events, isMaterialized, inheritedEventCount, lease);
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
   * @param lease - 可选的围栏信息；在写事务内、幂等判定之前校验。
   */
  private async persistBatchOnce(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffset,
    lease?: LeaseFence,
  ): Promise<void> {
    const rows = encodeStorageRows(events);
    const conn = await this.writePool.getConnection();
    try {
      await conn.beginTransaction();
      // 围栏校验必须先于任何重复键/幂等 no-op 判定：陈旧 writer 的“同内容重放”
      // 不能拿到 no-op 成功，必须抛 SessionOwnershipLostError。
      if (lease !== undefined) {
        await this.assertLeaseFence(conn, header.id, lease);
      }
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
            // 首批重放：会话行已存在。内容一致 → 幂等 no-op；否则视为真冲突。
            const matches = await this.committedMatches(header, events);
            await conn.rollback();
            if (matches) return;
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
            // 已 materialize 的重放：events 主键已存在。内容一致 → no-op；否则真冲突。
            const matches = await this.committedMatches(header, events);
            await conn.rollback();
            if (matches) return;
            throw new Error(
              `append 冲突：会话 ${JSON.stringify(header.id)} 在相同 seq 上已有不同内容的事件` +
                `（疑似多个驱动方并发写同一会话：seq 由调用方分配，未跨进程串行化）`,
            );
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
      // 内层幂等分支可能已回滚；重复回滚无害，吞掉其错误。
      await conn.rollback().catch(() => {});
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
   * @param lease - 可选的围栏信息。
   */
  async persistHeader(
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    lease?: LeaseFence,
  ): Promise<void> {
    const conn = await this.writePool.getConnection();
    try {
      await conn.beginTransaction();
      if (lease !== undefined) {
        await this.assertLeaseFence(conn, header.id, lease);
      }
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
