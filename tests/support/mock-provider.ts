/**
 * In-memory mock provider — for kernel unit tests where HTTP is noise.
 * Each `stream()` call consumes one scripted turn.
 */
import type { LlmProvider, LlmRequest, ModelInfo, StreamEvent } from "../../src/llm/types.ts";

export interface MockTurn {
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  stopReason?: "end" | "toolUse" | "length" | "error";
  usage?: { inputTokens: number; outputTokens: number };
  /** Yield an error event instead of a normal turn. */
  error?: { error: string; retryable: boolean };
}

export interface MockProvider extends LlmProvider {
  requests: LlmRequest[];
  /** How many turns are still scripted. */
  remaining(): number;
}

export const MOCK_MODEL: ModelInfo = {
  id: "mock-1",
  contextWindow: 100_000,
  maxOutput: 4_096,
  supportsTools: true,
};

export function createMockProvider(turns: MockTurn[]): MockProvider {
  const requests: LlmRequest[] = [];
  let index = 0;
  return {
    id: "mock",
    label: "Mock",
    models: [MOCK_MODEL],
    resolveModel: (id: string) => (id === MOCK_MODEL.id ? MOCK_MODEL : undefined),
    requests,
    remaining: () => Math.max(0, turns.length - index),
    async *stream(req: LlmRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      const turn = turns[index];
      index += 1;
      if (!turn) {
        yield { type: "error", error: "mock provider: no turns left", retryable: false };
        return;
      }
      if (turn.error) {
        yield { type: "error", error: turn.error.error, retryable: turn.error.retryable };
        return;
      }
      yield { type: "start" };
      if (turn.thinking) yield { type: "thinking_delta", text: turn.thinking };
      if (turn.text) yield { type: "text_delta", text: turn.text };
      for (const [i, call] of (turn.toolCalls ?? []).entries()) {
        const id = `call_${index}_${i}`;
        yield { type: "toolcall_start", id, name: call.name };
        yield { type: "toolcall_delta", id, argsDelta: JSON.stringify(call.args) };
        yield { type: "toolcall_end", id };
      }
      const toolUse = (turn.toolCalls?.length ?? 0) > 0;
      yield {
        type: "done",
        stopReason: turn.stopReason ?? (toolUse ? "toolUse" : "end"),
        usage: turn.usage ?? { inputTokens: 50, outputTokens: 10 },
      };
    },
  };
}
