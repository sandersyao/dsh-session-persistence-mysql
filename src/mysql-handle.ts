import type { Context } from "@deepseek-ai/cordis";
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
  SessionSeedEventState,
} from "@deepseek-ai/dsh-session";
import {
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionPersistenceRevision,
  SessionPersistenceRevision as brandRevision,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
} from "@deepseek-ai/dsh-session-persistence";

import type { MysqlBackend } from "./mysql-backend.js";

/**
 * 写 handle 的可变状态：cursor 是该 handle 已知的逻辑末尾，
 * materialized 表示该会话是否已落盘。
 */
export interface StorageHandleState {
  /** 该 handle 已知的逻辑下一 seq（即已接受的最大 seq + 1）。 */
  cursor: number;
  /** 是否已落盘（lazy materialization 后为 true）。 */
  materialized: boolean;
  /** fork 继承前缀长度（create 时固定，open write 时从存储读出）。 */
  inheritedEventCount: SessionLogOffset;
}

/**
 * 单个写者最近一次 published 的 live event seq；handle.read 用此保证
 * monotonic view——单读不会回退到比之前 observeLength 更早的尾部。
 */
const OBSERVED_LENGTH_INIT = 0;

/** Live event 批量写入的默认最大延迟（ms）。 */
export const LIVE_WRITE_BATCH_MAX_DELAY_MS = 200;

/**
 * 文件存储原语契约，handle 通过它与 MySQL 后端解耦。
 */
export interface MysqlHandleStorage {
  /** 持久化一段连续事件。 */
  persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void>;
  /** 仅持久化 header（用于 flush 一个空的刚 create 的会话）。 */
  persistHeader(header: SessionHeader, inheritedEventCount: SessionLogOffset): Promise<void>;
  /** 读取并校验已落盘的整段日志。 */
  readStoredLog(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<{
    meta: SessionHeader;
    events: readonly SessionEvent[];
    inheritedEventCount: SessionLogOffset;
    eventCount: number;
    revision: SessionPersistenceRevision;
  }>;
  /** 是否已 materialize。 */
  hasSession(id: SessionId, signal?: AbortSignal): Promise<boolean>;
}

/**
 * MySQL 后端的会话 handle。实现 SessionHandle 契约：
 *  - read：在本 handle 上 monotonic view，从存储读到当前物理完整段并按 offset/length 切片。
 *  - append：串行化在 per-handle chain 上，cursor 推进；首次 append 触发 lazy materialize。
 *  - flush：把当前 buffered 全部刷盘；空会话首次 flush 触发 persistHeader。
 *  - close：先 drain 再幂等解锁所有状态（这里无独立 lease）。
 *
 * Live event 路由：tracker.install 后，session/event 把 published events 投递给
 * 当前写 handle 的 buffered 队列，由 setTimeout 触发后台批量 drain。drain 失败
 * 不丢失数据——events 保留在 buffered 中，等待下一次 drain / 显式 flush。
 */
export class MysqlSessionHandle implements SessionHandle {
  /** 底层存储原语。 */
  private readonly storage: MysqlHandleStorage;
  /** 写者 tracker（owner 校验 + close 时清理）。 */
  private readonly tracker: MysqlBackendTracker;
  /** 会话 id。 */
  readonly id: SessionId;
  /** 会话头（create/open 时固定）。 */
  readonly header: SessionHeader;
  /** 访问权限（read/write）。 */
  readonly access: SessionAccess;
  /** 会话状态。 */
  private readonly state: StorageHandleState;
  /** 串行化所有 mutating 操作的链（包含 append/flush/close）。 */
  private chain: Promise<void> = Promise.resolve();
  /** 关闭进行中：再次 close 视为幂等返回同一 promise。 */
  private closing: Promise<void> | undefined;
  /** 单 handle 上 monotonic 观察到的最大事件数。 */
  private observedLength: number;
  /** 待批量写入的 live events（structuredClone 持有，引用独立于发布方）。 */
  private buffered: SessionEvent[] = [];
  /** 后台批量写入计时器。 */
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  /** 上一次 drain 是否失败；true 时静默等下次显式触发，避免雪崩。 */
  private drainPaused = false;
  /** 当前 drain promise（合并并发 drain）。 */
  private draining: Promise<void> | undefined;

  /**
   * 构造 handle。
   * @param storage - 后端存储原语。
   * @param tracker - 写者 tracker。
   * @param id - 会话 id。
   * @param header - 会话头。
   * @param access - 访问权限。
   * @param state - 初始状态。
   */
  constructor(
    storage: MysqlHandleStorage,
    tracker: MysqlBackendTracker,
    id: SessionId,
    header: SessionHeader,
    access: SessionAccess,
    state: StorageHandleState,
  ) {
    this.storage = storage;
    this.tracker = tracker;
    this.id = id;
    this.header = header;
    this.access = access;
    this.state = state;
    this.observedLength = state.cursor;
  }

  /** 继承前缀长度（handle 暴露字段）。 */
  get inheritedEventCount(): SessionLogOffset {
    return this.state.inheritedEventCount;
  }

  /**
   * 读取一段 contiguous 事件。保证 monotonic：在该 handle 上不会观察到比之前更短的尾部。
   * @param offset - 起始 seq（默认 0）。
   * @param length - 最大返回数（默认整段剩余）。
   * @param options - 取消选项。
   * @returns 事件切片 + 状态。
   */
  async read(
    offset = 0,
    length = Number.MAX_SAFE_INTEGER,
    options?: SessionHandleReadOptions,
  ): Promise<SessionHandleReadResult> {
    this.assertOpen("read");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`);
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`);
    }
    options?.signal?.throwIfAborted();

    // 已 materialize：从存储读最新完整段。
    // 未 materialize + 无 buffered live：返回空 detached 段。
    if (!this.state.materialized && this.access === "write" && this.buffered.length === 0) {
      this.observedLength = Math.max(this.observedLength, 0);
      return { eventState: "detached" as SessionSeedEventState, events: [] };
    }
    if (!this.state.materialized) {
      // 没有 buffered 也没有任何 events 时仍可能是 read handle 上的未 materialize 写
      // ——但 read handle 永远 materialized（open 时已 requireStoredLog）。
      options?.signal?.throwIfAborted();
    }

    // 走存储读（read handle 或有 buffered 的写 handle 都走这里）。
    let storedEvents: readonly SessionEvent[];
    let eventState: SessionSeedEventState;
    if (this.state.materialized) {
      const stored = await this.storage.readStoredLog(this.id, options?.signal);
      storedEvents = stored.events;
      eventState = "detached";
    } else {
      storedEvents = [];
      eventState = "detached";
    }

    // live 拼接：已 durable 段 + 本进程内未刷盘的 buffered live。
    // 这里假定 stored.events 已包含此前所有持久化事件；buffered 是 durable 之后的增量。
    const live = this.buffered.map((e) => e);
    const combined = [...storedEvents, ...live];

    if (combined.length < this.observedLength) {
      throw new Error(
        `session "${this.id}": stored log shrank below a previously observed prefix (${combined.length} < ${this.observedLength})`,
      );
    }
    this.observedLength = combined.length;

    return {
      eventState,
      events: combined.slice(offset, offset + length),
    };
  }

  /**
   * 把一段 contiguous 事件落盘。
   * @param events - 连续事件（seq 续接 cursor）。
   * @param _options - 取消选项（MySQL 写路径短，无需内部可中断）。
   */
  async append(events: readonly SessionEvent[], _options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen("append");
    return this.runMutation("append", async () => {
      await this.persistContiguous(events);
    });
  }

  /**
   * 把当前 buffered 全部刷盘并触发 materialize。空会话的首次 flush 等同
   * persistHeader（让一个 create-但未 append 的会话对其他进程可见）。
   * @param options - 取消选项。
   */
  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen("flush");
    return this.runMutation("flush", async () => {
      options?.signal?.throwIfAborted();
      if (this.access !== "write") throw new SessionReadOnlyError(this.id, "flush");
      await this.drainBuffered();
      if (!this.state.materialized) {
        await this.storage.persistHeader(this.header, this.state.inheritedEventCount);
        this.state.materialized = true;
        this.tracker.materialized(this.id);
      }
    });
  }

  /**
   * 关闭 handle：先 drain，再丢弃 buffered，tracker 释放 owner 状态。
   * 幂等，第二次调用复用 closing。
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    return (this.closing = (async () => {
      // 先清掉计时器（避免 close 期间还在排新的 drain）。
      if (this.batchTimer !== undefined) {
        clearTimeout(this.batchTimer);
        this.batchTimer = undefined;
      }
      // drain 当前 buffered（若已经在 drain 则等待它）。
      await this.drainLive();
      await this.chain;
      this.tracker.release(this, this.state.materialized);
    })());
  }

  /** `await using` 支持：等价于 close。 */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * 把一条 published live event 排入 buffered；启动批量计时器。
   * 仅 tracker（live event 路由监听）调用。
   * @param event - 来自 session/event 的事件。
   * @param reportFailure - 后台 drain 失败的上报钩子。
   */
  enqueueLive(event: SessionEvent, reportFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event));
    if (this.batchTimer !== undefined || this.drainPaused) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      this.drainLive().catch(reportFailure);
    }, LIVE_WRITE_BATCH_MAX_DELAY_MS);
  }

  /**
   * 把当前 buffered 一并写入。失败保留 buffered 以便后续 flush 重试。
   */
  drainLive(): Promise<void> {
    return (this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined;
    }));
  }

  /**
   * 关闭前释放 owner 状态（与 close 配合，但允许外部直接调用——比如
   * 创建后从未 append 就关闭时）。
   */
  abort(): Promise<void> {
    return this.close();
  }

  /**
   * 在 chain 串行化下真正持久化一段 contiguous 事件。
   * @param events - 连续事件。
   */
  private async persistContiguous(events: readonly SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (events[0]!.seq !== this.state.cursor) {
      throw new Error(
        `append seq mismatch for "${this.id}": expected ${this.state.cursor} at index 0, got ${events[0]!.seq}`,
      );
    }
    for (let i = 1; i < events.length; i += 1) {
      if (events[i]!.seq !== this.state.cursor + i) {
        throw new Error(
          `append seq mismatch for "${this.id}": expected ${this.state.cursor + i} at index ${i}, got ${events[i]!.seq}`,
        );
      }
    }
    await this.storage.persistBatch(
      this.header,
      events,
      this.state.materialized,
      this.state.inheritedEventCount,
    );
    this.state.cursor += events.length;
    if (!this.state.materialized) {
      this.state.materialized = true;
      // 首次 append 把 create-only 的 pending 转成 materialized，从 pending 列表清除。
      this.tracker.materialized(this.id);
    }
  }

  /**
   * 实际写 buffered 到存储；并发 drain 共享一个 draining promise。
   */
  private async drainBuffered(): Promise<void> {
    if (this.buffered.length === 0) return;
    const batch = this.buffered;
    this.buffered = [];
    try {
      await this.persistContiguous(batch);
    } catch (error) {
      // 把 batch 放回队首（保持顺序），并暂停后台计时器等下一次显式触发。
      this.buffered = [...batch, ...this.buffered];
      this.drainPaused = true;
      throw error;
    }
    this.drainPaused = false;
  }

  /**
   * 把一次 mutation 串行化到 per-handle chain 上。
   * @param op - 调试用 op 名。
   * @param fn - 实际工作。
   */
  private async runMutation(op: string, fn: () => Promise<void>): Promise<void> {
    this.assertOpen(op);
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    try {
      return await next;
    } finally {
      // no-op
    }
  }

  /**
   * 校验 handle 仍开放；否则抛 SessionHandleClosedError。
   * @param operation - 被调用的 op 名（用于错误信息）。
   */
  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation);
  }
}

/**
 * 一个 create-但未 materialize 的会话条目（仅在本进程内可见）。
 */
export interface PendingSession {
  readonly header: SessionHeader;
  readonly revision: SessionPersistenceRevision;
  readonly inheritedEventCount: SessionLogOffset;
}

/**
 * 进程内单写者约束 + open handle 跟踪 + live event 路由：
 * - writers 跟踪每会话当前是否被本进程的写 handle 持有；
 * - pending 跟踪本进程 create 过但还没落到磁盘的会话（list 用）；
 * - openHandles 跟踪 teardown 时需要关闭的 handle。
 */
export class MysqlBackendTracker {
  /** 后端标签（用于日志与错误聚合）。 */
  readonly name: string;
  /** 所有仍开放的 handle；teardown 关闭剩下的。 */
  readonly openHandles: Set<MysqlSessionHandle> = new Set();
  /** 每会话当前是否有写 handle；`null` 表示 claim 在 handle 构造中。 */
  private readonly writers: Map<SessionId, MysqlSessionHandle | null> = new Map();
  /** 本进程内 create 但未 materialize 的会话。 */
  private readonly pending: Map<SessionId, PendingSession> = new Map();
  /** 进程内 revision 计数（pending 用）。 */
  private counter = 0;

  /**
   * 构造 tracker。
   * @param name - 后端标签。
   */
  constructor(name: string) {
    this.name = name;
  }

  /**
   * 注册一个新 create 的会话为 pending；throw 当已有写 handle 持有 id。
   * @param header - 已校验 header。
   * @param inheritedEventCount - 继承前缀长度。
   */
  registerCreated(header: SessionHeader, inheritedEventCount: SessionLogOffset): void {
    if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(header.id);
    this.writers.set(header.id, null);
    this.pending.set(header.id, {
      header,
      revision: brandRevision(`memory:${this.name}:${++this.counter}`),
      inheritedEventCount,
    });
  }

  /**
   * 认领已有会话的写权；throw 当另一写 handle 已存在。
   * @param id - 会话 id。
   */
  claimWrite(id: SessionId): void {
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
    this.writers.set(id, null);
  }

  /**
   * 撤销一个失败的 claimWrite（claim 后 handle 构造失败时调用）。
   * @param id - 会话 id。
   */
  releaseClaim(id: SessionId): void {
    this.writers.delete(id);
  }

  /** pending 查找。 */
  pendingOf(id: SessionId): PendingSession | undefined {
    return this.pending.get(id);
  }

  /** 是否仍是 pending。 */
  hasPending(id: SessionId): boolean {
    return this.pending.has(id);
  }

  /** pending 列表迭代器。 */
  pendingEntries(): IterableIterator<[SessionId, PendingSession]> {
    return this.pending.entries();
  }

  /** 当 pending 会话落盘时清掉条目。 */
  materialized(id: SessionId): void {
    this.pending.delete(id);
  }

  /**
   * 把构造好的 handle 登记到 tracker：加入 openHandles，并把 writers 中
   * 的占位（null）替换为真实 handle。
   * @param handle - 刚构造完的 handle。
   * @returns 同一 handle（构造点可链式）。
   */
  adopt(handle: MysqlSessionHandle): MysqlSessionHandle {
    this.openHandles.add(handle);
    if (handle.access === "write") this.writers.set(handle.id, handle);
    return handle;
  }

  /**
   * close 时由 handle 调用：删除 openHandles、释放 writer 状态、若该会话
   * 始终未 materialize 则一并清掉 pending（该 create 相当于从未发生）。
   * @param handle - 正在关闭的 handle。
   * @param materialized - 该会话是否落盘过。
   */
  release(handle: MysqlSessionHandle, materialized: boolean): void {
    this.openHandles.delete(handle);
    if (handle.access !== "write") return;
    this.writers.delete(handle.id);
    if (!materialized) this.pending.delete(handle.id);
  }

  /**
   * 服务级 flush：等待每个写 handle 的 buffered 排干并落盘。
   * 部分失败聚合到 AggregateError；其余仍 flush。
   */
  async flushAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const writer of [...this.writers.values()]) {
      if (writer === null) continue;
      try {
        await writer.drainLive();
        await writer.flush();
      } catch (error) {
        if (error instanceof SessionHandleClosedError) continue;
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${this.name} flush failed`);
    }
  }

  /**
   * 把 tracker 装到 ctx：监听 session/event 路由 live events，session/flush 触发 drain，
   * session/disposed 触发 handle close，effect 收尾 sweep 剩余 handle。
   * @param ctx - Cordis 上下文。
   */
  install(ctx: Context): void {
    ctx.on("session/event", (session, event) => {
      const writer = this.writers.get(session.id);
      if (writer === null || writer === undefined) return;
      if (writer.access !== "write") return;
      // 只看 handle 的 buffered；不在 live 路径上 modify cursor。
      writer.enqueueLive(event, (error: unknown) => {
        ctx.logger?.warn?.(
          `session-persistence: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`,
        );
      });
    });
    ctx.on("session/flush", (session) => {
      const writer = this.writers.get(session.id);
      if (writer === null || writer === undefined) return;
      return (async () => {
        await writer.drainLive();
        await writer.flush();
      })();
    });
    ctx.on("session/disposed", (session) => {
      const writer = this.writers.get(session.id);
      if (writer === null || writer === undefined) return;
      writer.close().catch((error: unknown) => {
        ctx.logger?.warn?.(
          `session-persistence: final drain for session "${session.id}" failed: ${String(error)}`,
        );
      });
    });
    ctx.effect(async () => {
      return async () => {
        const errors: unknown[] = [];
        for (const handle of [...this.openHandles]) {
          try {
            await handle.close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, `${this.name} dispose failed`);
        }
      };
    }, `${this.name} open handles`);
  }
}

/**
 * 暴露仅给 tracker 的工厂句柄（在 MySQL backend 中组装）。
 */
export function createMysqlSessionHandle(
  backend: MysqlBackend,
  tracker: MysqlBackendTracker,
  id: SessionId,
  header: SessionHeader,
  access: SessionAccess,
  state: StorageHandleState,
): MysqlSessionHandle {
  return new MysqlSessionHandle(backend as unknown as MysqlHandleStorage, tracker, id, header, access, state);
}

/** 防止 read-only sentinel 被外部 import 时类型悬空。 */
export const __readOnlySentinel = SessionReadOnlyError;
