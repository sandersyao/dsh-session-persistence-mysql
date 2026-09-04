import { type Context, Service } from "@deepseek-ai/cordis";
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
  SessionPreparation,
} from "@deepseek-ai/dsh-session";
import {
  type BorrowedSessionSource,
  PersistenceCoordinator,
  type SessionEventSuffix,
  type SessionInspection,
  type SessionLocation,
  SessionPersistence,
  type SessionPersistenceSnapshot,
} from "@deepseek-ai/dsh-session-persistence";
import z from "@deepseek-ai/schemastery";

import { loadSettingsFromEnv, mergeSettings, type SettingsOverrides } from "./config.js";
import { MysqlBackend } from "./mysql-backend.js";
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
    writeBatchMaxDelayMs: z.number(),
    preparedSessionCacheSize: z.number(),
    packChunks: z.boolean(),
  }),
  security: z.object({
    encryptionKey: z.string(),
    schemaAutoMigrate: z.boolean(),
  }),
});

/**
 * MySQL 会话持久化后端插件。加载后注册为 `ctx.sessionPersistence`，并通过
 * 协调器安装写入路径。与 JSONL 后端行为契约等价。
 */
export class MysqlSessionPersistence extends SessionPersistence {
  /** 后端标签（诊断用，遮蔽基类 name 但不改变注册键 sessionPersistence）。 */
  override readonly name = "session-persistence-mysql";
  /** 本后端不暴露每会话独立工件。 */
  override readonly supportsRawArtifacts = false;
  /** 注入 sessions 服务（硬依赖）。 */
  static inject = ["sessions"];
  /** 插件配置 schema。 */
  static Config = MysqlConfig;
  /** 后端实例（实现 PersistenceBackend）。 */
  private readonly backend: MysqlBackend;
  /** 写/读连接池共享标记。 */
  private readonly sharedPool: boolean;
  /** 写连接池（close 用）。 */
  private readonly writePool: import("mysql2/promise").Pool;
  /** 合并后的后端设置（env 基址 + 用户覆盖）。 */
  private readonly settings: import("./config.js").MysqlSettings;
  /** 协调器（在 [Service.init] 中创建，确保 schema 就绪）。 */
  private coordinator!: PersistenceCoordinator<undefined>;

  /**
   * 构造插件：解析 env 设置、建池、建后端。异步 schema 初始化推迟到 init。
   * @param ctx - Cordis 上下文。
   * @param config - 用户配置覆盖（可空，env 为基址）。
   */
  constructor(ctx: Context, config: SettingsOverrides = {}) {
    super(ctx);
    const settings = mergeSettings(loadSettingsFromEnv(), config);
    this.settings = settings;
    const writePool = createWritePool(settings.connection, settings.pool);
    const readPool = createReadPool(settings.connection, settings.readConnection, settings.pool);
    this.sharedPool = readPool === writePool;
    this.writePool = writePool;
    this.backend = new MysqlBackend(writePool, readPool, this.sharedPool, settings);
  }

  /**
   * 异步初始化：连接测试 + 幂等 schema + 版本校验，然后创建协调器（写入
   * 路径监听在 schema 就绪后才安装）。
   */
  async [Service.init](): Promise<void> {
    await ensureSchema(this.writePool, this.settings.connection.tablePrefix, {
      autoMigrate: this.settings.security.schemaAutoMigrate,
    });
    this.coordinator = new PersistenceCoordinator(this.ctx, this.backend, {
      preparedSessionCacheSize: this.settings.persistence.preparedSessionCacheSize,
      writeBatchMaxDelayMs: this.settings.persistence.writeBatchMaxDelayMs,
    });
  }

  /**
   * 解析后端工件位置：MySQL 无每会话独立工件，返回 undefined。
   * @param _meta - 会话头。
   * @returns 恒为 undefined。
   */
  override locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined;
  }

  /**
   * 注册新会话元数据（lazy，首次 append 时 materialize）。
   * @param meta - 会话头。
   * @param inheritedEventCount - 继承父会话的前缀长度（仅 seeded 会话传）。
   */
  override create(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<void> {
    return this.coordinator.create(meta, inheritedEventCount);
  }

  /**
   * 空会话也持久化 header（即便无任何会话事件也构成可恢复资源）。
   * @param session - 已登记到写路径的会话实例。
   */
  override ensureMaterialized(session: Session): Promise<void> {
    return this.coordinator.ensureMaterialized(session);
  }

  /**
   * 持久化一段连续事件批次。
   * @param id - 会话 id。
   * @param events - 连续事件批次。
   */
  override append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events);
  }

  /**
   * 准备并预留用于 resume 的未发布会话。
   * @param id - 会话 id。
   * @param signal - 取消信号。
   */
  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal);
  }

  /**
   * 加载平衡的逻辑日志视图并提交冷恢复。
   * @param id - 会话 id。
   */
  override load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id);
  }

  /**
   * 非破坏检查逻辑会话。
   * @param id - 会话 id。
   * @param signal - 取消信号。
   */
  override inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal);
  }

  /**
   * 借用一个精确的会话视图，同时钉住其可复用的 prepared 会话源，便于后续
   * prepare 复用。返回的可 Disposable 观测在释放前保持未发布会话不被回收。
   * @param id - 待观察的已持久化会话。
   * @param signal - 取消信号。
   */
  override borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal);
  }

  /**
   * 从 fromSeq 起读存储事件（detached 后缀读）。
   * @param id - 会话 id。
   * @param fromSeq - 起始日志偏移（含）。
   * @param signal - 取消信号。
   */
  override readFrom(
    id: SessionId,
    fromSeq: SessionLogOffset,
    signal?: AbortSignal,
  ): Promise<SessionEventSuffix> {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }

  /**
   * 轻量列出所有 materialized 会话 header。
   * @param signal - 取消信号。
   */
  override list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.backend.list(signal);
  }

  /**
   * 轻量列出会话快照（header + 来源限定 revision）。
   * @param signal - 取消信号。
   */
  override listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return this.backend.listSnapshots(signal);
  }
}

export default MysqlSessionPersistence;
