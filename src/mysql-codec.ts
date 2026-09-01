import {
  type ChunkRow,
  decodeStorageRecord,
  packChunkRuns,
  type SessionEvent,
  type StorageRecord,
} from "@deepseek-ai/dsh-session";

/**
 * 存储行：事件写入 MySQL 前的形态（payload 为存储记录 JSON）。
 */
export interface StoredRow {
  /** 存储行类型标记：NULL=裸事件；chunk 折叠行=对应折叠标签。 */
  readonly rowType: string | null;
  /** 存储记录 JSON 文本。 */
  readonly payload: string;
}

/**
 * 判断存储记录是否为 chunk 折叠行（无斜杠标签），而非裸 SessionEvent。
 * @param record - 存储记录。
 * @returns 折叠行为 true，裸事件为 false。
 */
function isChunkRow(record: StorageRecord): record is ChunkRow {
  return typeof record.type === "string" && !record.type.includes("/");
}

/**
 * 将一段连续事件编码为存储行。开启折叠时复用 packChunkRuns（阈值固定 ≥3，与 JSONL 一致）。
 * @param events - 连续事件批次（seq 有序）。
 * @param packChunks - 是否启用 chunk run 折叠。
 * @returns 存储行数组。
 */
export function encodeStorageRows(
  events: readonly SessionEvent[],
  packChunks: boolean,
): StoredRow[] {
  const records: StorageRecord[] = packChunks ? packChunkRuns(events) : [...events];
  return records.map((record) => ({
    rowType: isChunkRow(record) ? record.type : null,
    payload: JSON.stringify(record),
  }));
}

/**
 * 将存储行解码回事件序列（layout-blind：折叠/裸/混合均可）。
 * @param rows - 存储行（含 payload JSON）。
 * @returns 展开后的事件序列。
 */
export function decodeStoredRows(rows: readonly { payload: string }[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const row of rows) {
    const parsed: unknown = JSON.parse(row.payload);
    out.push(...decodeStorageRecord(parsed));
  }
  return out;
}
