import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  materializeAppendBatch,
  type SessionHeader,
  validateStoredEvents,
} from "@deepseek-ai/dsh-session-persistence";

/**
 * 存储行：事件写入 MySQL 前的形态（payload 为存储记录 JSON）。
 *
 * 0.1.5 起 chunk run 折叠交给上游 format catalog 处理（每个事件原样落盘）。
 * `rowType` 字段保留为 NULL 兼容旧 schema；`payload` 是 `encodeCurrentEvent`
 * 之后的 JSON 文本。
 */
export interface StoredRow {
  /** 存储行类型标记：固定为 NULL（新版本不再折叠 chunk）。 */
  readonly rowType: string | null;
  /** 存储记录 JSON 文本。 */
  readonly payload: string;
}

/**
 * 把一段连续事件编码为存储行。
 *
 * 0.1.5 起 chunk 折叠由 format catalog 在 `encodeCurrentEvent` 内部处理，
 * 此处只是 lossless JSON 序列化。如果 `materializeAppendBatch` 因非 JSON
 * 数据拒绝，直接抛 TypeError（fail-closed），不静默丢弃。
 *
 * @param events - 连续事件批次（seq 有序）。
 * @returns 存储行数组。
 */
export function encodeStorageRows(events: readonly SessionEvent[]): StoredRow[] {
  // 一次性 validate + snapshot，保证写入的就是校验过的。
  const snapshot = materializeAppendBatch(events);
  return snapshot.map((event) => ({
    rowType: null,
    payload: JSON.stringify(event),
  }));
}

/**
 * 把存储行解码为事件序列，并按 contract 校验当前 build 可识别的事件。
 *
 * @param meta - 关联会话头（用于错误信息与跨字段校验）。
 * @param rows - 存储行（含 payload JSON）。
 * @returns 验证后的事件序列（直接传给 Session.fromRestore 即可）。
 */
export function decodeStoredRows(
  meta: SessionHeader,
  rows: readonly { payload: string }[],
): readonly SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const row of rows) {
    const parsed: unknown = JSON.parse(row.payload);
    if (!isObject(parsed) || typeof parsed.type !== "string") {
      throw new TypeError(
        `session "${meta.id}" stored row is not a SessionEvent JSON record: ${row.payload.slice(0, 120)}`,
      );
    }
    events.push(parsed as SessionEvent);
  }
  return validateStoredEvents(meta, events);
}

/** 简单的 object 判断（避免引用 Object 类型）。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
