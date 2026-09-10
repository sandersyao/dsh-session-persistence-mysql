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
 * 构造一个 assistant/message 事件（0.1.5 替代旧 assistant/chunk 的 assistant 内容块）。
 * 仅用于测试落盘路径——validateStoredEvents 要求 message 含 id/role/source/content。
 * @param seq - 事件序号。
 * @param text - 完整消息文本。
 * @returns assistant message 事件。
 */
export function chunkEvent(seq: number, text: string): SessionEvent {
  return {
    type: "assistant/message",
    seq,
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `msg-${seq}`,
        role: "assistant",
        source: { kind: "model", provider: "test", model: "test" },
        content: [{ kind: "text", text }],
      },
    },
    surfaceOp: "append",
  } as unknown as SessionEvent;
}
