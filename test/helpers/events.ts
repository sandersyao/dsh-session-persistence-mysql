import type { SessionEvent } from "@deepseek-ai/dsh-session";

/**
 * 构造一个结构事件（turn/step 边界），data 为最小合法形状。
 * @param type - 事件类型（turn/start、step/start、step/end、turn/end 等）。
 * @param seq - 事件序号。
 * @param data - 事件数据。
 * @returns 会话事件。
 */
export function structuralEvent(
  type: "turn/start" | "step/start" | "step/end" | "turn/end",
  seq: number,
  data: Record<string, unknown>,
): SessionEvent {
  return { type, seq, time: 1_000 + seq, data: data as never } as SessionEvent;
}

/**
 * 构造一条完整的平衡事件序列（turn/start→step/start→step/end→turn/end）。
 * @param startSeq - 起始序号。
 * @param turn - turn 编号。
 * @returns 平衡事件数组。
 */
export function balancedTurnEvents(startSeq = 0, turn = 1): SessionEvent[] {
  return [
    structuralEvent("turn/start", startSeq, { turn }),
    structuralEvent("step/start", startSeq + 1, { turn, step: 1 }),
    structuralEvent("step/end", startSeq + 2, { turn, step: 1 }),
    structuralEvent("turn/end", startSeq + 3, { turn, reason: { kind: "completed" } }),
  ];
}

/**
 * 构造一个 assistant/chunk 事件（text-delta），用于测折叠。
 * @param seq - 事件序号。
 * @param text - 增量文本。
 * @param index - 块索引。
 * @returns chunk 事件。
 */
export function chunkEvent(seq: number, text: string, index = 0): SessionEvent {
  return {
    type: "assistant/chunk",
    seq,
    time: 1_000 + seq,
    data: { turn: 1, step: 1, chunk: { type: "text-delta", index, text } },
  } as SessionEvent;
}
