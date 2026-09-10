import { type Context, Service } from "@deepseek-ai/cordis";
import {
  SessionLogOffset,
  type SessionId,
  type SessionHeader,
  SESSION_FORMAT_VERSION,
} from "@deepseek-ai/dsh-session";
import {
  SessionAlreadyExistsError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  materializeAppendBatch,
  materializeCreateHeader,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
  type SessionPersistenceRevision,
} from "@deepseek-ai/dsh-session-persistence";
import z from "@deepseek-ai/schemastery";

import { loadSettingsFromEnv, mergeSettings, type SettingsOverrides } from "./config.js";
import { MysqlBackend } from "./mysql-backend.js";
import {
  MysqlBackendTracker,
  MysqlSessionHandle,
  type StorageHandleState,
} from "./mysql-handle.js";
import { createReadPool, createWritePool } from "./pool.js";
import { ensureSchema } from "./schema.js";

/**
 * 写库连接 schema（字段缺省可选，凭据缺省由 env/.env 提供）。
 */
const connectionSchema = z.object({
  host: z.string(),
  port: z.number(),
  user: z.string(),
  password: z.string(),
  database: z.string(),
  tablePrefix: z.string(),
  charset: z.string(),
  connectTimeout: z.number(),
  sslRequired: z.boolean(),
});

/**
 * 插件 Config schema：字段缺省可选，env 为基址、Config 覆盖。凭据只来自 env。
 */
export const MysqlConfig = z.object({
  connection: connectionSchema,
  readConnection: connectionSchema,
  pool: z.object({
    poolSize: z.number(),
    minIdle: z.number(),
    idleTimeout: z.number(),
    acquireTimeout: z.number(),
    queueLimit: z.number(),
  }),
  persistence: z.object({
    packChunks: z.boolean(),
  }),
  security: z.object({
    encryptionKey: z.string(),
    schemaAutoMigrate: z.boolean(),
  }),
});

/**
 * MySQL 会话持久化后端插件。加载后注册为 `ctx.sessionPersistence`，并接管
 * session/event / session/flush / session/disposed 三个事件流做 live event
 * 路由与 teardown drain。与 JSONL 后端契约等价，但用 InnoDB 行锁替代跨进程
 * 文件锁；事件 append 用复合主键唯一约束兜底同 id 双写。
 */
export class MysqlSessionPersistence extends SessionPersistence {
  /** 后端标签（诊断用，遮蔽基类 name 但不改变注册键 sessionPersistence）。 */
  override readonly name = "session-persistence-mysql";
  /** 注入 sessions 服务（live event 路由依赖 ctx.sessions）。 */
  static inject = ["sessions"];
  /** 插件配置 schema。 */
  static Config = MysqlConfig;
  /** 后端存储原语。 */
  private readonly backend: MysqlBackend;
  /** 写连接池（dispose 关闭）。 */
  private readonly writePool: import("mysql2/promise").Pool;
  /** 合并后的后端设置。 */
  private readonly settings: import("./config.js").MysqlSettings;
  /** 进程内 tracker（单写者约束 + open handles + live 路由）。 */
  private readonly tracker: MysqlBackendTracker;
  /** 启动时是否已就绪（init 完成）。 */
  private ready: Promise<void> | undefined;

  /**
   * 构造插件：解析 env 设置、建池、建后端与 tracker。schema 初始化推迟到 init。
   * @param ctx - Cordis 上下文。
   * @param config - 用户配置覆盖（可空，env 为基址）。
   */
  constructor(ctx: Context, config: SettingsOverrides = {}) {
    super(ctx);
    const settings = mergeSettings(loadSettingsFromEnv(), config);
    this.settings = settings;
    const writePool = createWritePool(settings.connection, settings.pool);
    const readPool = createReadPool(settings.connection, settings.readConnection, settings.pool);
    this.writePool = writePool;
    this.backend = new MysqlBackend(writePool, readPool, readPool === writePool, settings);
    this.tracker = new MysqlBackendTracker(this.name);
  }

  /**
   * 异步初始化：连接测试 + 幂等 schema + 版本校验；完成后挂载 tracker 路由。
   */
  async [Service.init](): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await ensureSchema(this.writePool, this.settings.connection.tablePrefix, {
        autoMigrate: this.settings.security.schemaAutoMigrate,
      });
      this.tracker.install(this.ctx);
    })();
    return this.ready;
  }

  /**
   * 解析后端工件位置：MySQL 整库即后端，会话 id 即物理位置。
   * @param meta - 会话头。
   * @returns 定位信息。
   */
  locate(meta: SessionHeader): { kind: string; path: string } {
    return this.backend.locate(meta);
  }

  /**
   * Create a new stored session and take its write ownership. The session is
   * visible to this process immediately; the physical row appears on its
   * first append or flush.
   * @param header - 会话头（须 lossless JSON + 非负整数 createdAt）。
   * @param options - 含 inheritedEventCount 与可选 signal。
   * @returns owned write handle.
   */
  override async create(
    header: SessionHeader,
    options?: SessionPersistenceCreateOptions,
  ): Promise<SessionHandle> {
    await this.ready;
    options?.signal?.throwIfAborted();
    const snapshot = materializeCreateHeader(header);
    if (snapshot.version !== SESSION_FORMAT_VERSION) {
      // materializer 可能保留了别的版本号；MySQL 后端要求严格 v3，强制修正。
      (snapshot as { version: number }).version = SESSION_FORMAT_VERSION;
    }
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0);
    if (snapshot.isSeeded && inheritedEventCount === 0) {
      throw new TypeError(
        `session "${snapshot.id}" is seeded but inheritedEventCount is 0; create refused to attach zero-length fork lineage`,
      );
    }
    if (!snapshot.isSeeded && inheritedEventCount !== 0) {
      throw new TypeError(
        `session "${snapshot.id}" is not seeded but inheritedEventCount=${inheritedEventCount}; create refused`,
      );
    }
    options?.signal?.throwIfAborted();
    // 已存在性检查（同一后端内存 + 数据库合并判断）。
    if (this.tracker.hasPending(snapshot.id) || (await this.backend.hasSession(snapshot.id, options?.signal))) {
      throw new SessionAlreadyExistsError(snapshot.id);
    }
    options?.signal?.throwIfAborted();
    this.tracker.registerCreated(snapshot, inheritedEventCount);
    const state: StorageHandleState = {
      cursor: 0,
      materialized: false,
      inheritedEventCount,
    };
    return this.tracker.adopt(
      new MysqlSessionHandle(this.backend, this.tracker, snapshot.id, snapshot, "write", state),
    );
  }

  /**
   * Open an existing stored session for `read` or single-writer `write`.
   * @param id - 会话 id。
   * @param access - `read` 或 `write`。
   * @param options - 可选 signal。
   * @returns opened handle.
   */
  override async open(
    id: SessionId,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    await this.ready;
    options?.signal?.throwIfAborted();

    // pending（create 过但未落盘）：仅本进程可见；read 直接基于 pending header 给出空事件视图。
    const pending = this.tracker.pendingOf(id);
    if (access === "read") {
      if (pending !== undefined) {
        const state: StorageHandleState = {
          cursor: 0,
          materialized: false,
          inheritedEventCount: pending.inheritedEventCount,
        };
        return this.tracker.adopt(
          new MysqlSessionHandle(this.backend, this.tracker, id, pending.header, "read", state),
        );
      }
      const stored = await this.backend.readStoredLog(id, options?.signal);
      const state: StorageHandleState = {
        cursor: stored.eventCount,
        materialized: true,
        inheritedEventCount: stored.inheritedEventCount,
      };
      return this.tracker.adopt(
        new MysqlSessionHandle(this.backend, this.tracker, id, stored.meta, "read", state),
      );
    }

    // write：先认领；若失败清理。
    this.tracker.claimWrite(id);
    try {
      const stored = await this.backend.readStoredLog(id, options?.signal);
      this.tracker.materialized(id); // 即便本来是 pending 路径，到此也已落盘，清掉 pending。
      const state: StorageHandleState = {
        cursor: stored.eventCount,
        materialized: true,
        inheritedEventCount: stored.inheritedEventCount,
      };
      return this.tracker.adopt(
        new MysqlSessionHandle(this.backend, this.tracker, id, stored.meta, "write", state),
      );
    } catch (error) {
      this.tracker.releaseClaim(id);
      if (
        !(error instanceof SessionPersistenceNotFoundError) &&
        !(error instanceof Error && /not found/i.test(error.message))
      ) {
        throw error;
      }
      throw new SessionPersistenceNotFoundError(id);
    }
  }

  /**
   * 服务级 flush：等待每个写 handle 的 buffered 排干并落盘。
   */
  override flush(): Promise<void> {
    return this.tracker.flushAll();
  }

  /**
   * 读取某个会话的快照（不读事件）。
   * @param id - 会话 id。
   * @param options - 可选 signal。
   * @returns snapshot 或 undefined。
   */
  override async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    await this.ready;
    options?.signal?.throwIfAborted();
    const pending = this.tracker.pendingOf(id);
    if (pending !== undefined) {
      return { header: pending.header, revision: pending.revision };
    }
    const exists = await this.backend.hasSession(id, options?.signal);
    if (!exists) return undefined;
    const stored = await this.backend.readStoredLog(id, options?.signal);
    return {
      header: stored.meta,
      revision: stored.revision,
      eventCount: stored.eventCount,
    };
  }

  /**
   * 列出所有可见会话快照（本进程 pending + 已落盘）。
   * @param options - 可选 signal。
   * @returns 快照数组。
   */
  override async list(
    options?: SessionPersistenceListOptions,
  ): Promise<readonly SessionPersistenceSnapshot[]> {
    await this.ready;
    options?.signal?.throwIfAborted();
    const listed = new Set<SessionId>();
    const snapshots: SessionPersistenceSnapshot[] = [];
    const stored = await this.backend.listSnapshots(options?.signal);
    for (const snap of stored) {
      listed.add(snap.header.id);
      snapshots.push({
        header: snap.header,
        revision: snap.revision,
      });
    }
    for (const [id, entry] of this.tracker.pendingEntries()) {
      if (listed.has(id)) continue;
      snapshots.push({ header: entry.header, revision: entry.revision });
    }
    return snapshots;
  }

  /**
   * 关闭后端持有的连接池（Cordis dispose 时由本实现负责关闭）。
   */
  async dispose(): Promise<void> {
    await this.backend.close();
  }
}

export default MysqlSessionPersistence;

/**
 * 重导出便于消费方按需导入的 helper / 类型。
 */
export type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
  SessionPersistenceCreateOptions,
  SessionPersistenceListOptions,
  SessionPersistenceOpenOptions,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
  SessionPersistenceRevision,
};
// Keep `materialize*` symbols re-exportable to ease downstream consumption.
export { materializeAppendBatch, materializeCreateHeader };
