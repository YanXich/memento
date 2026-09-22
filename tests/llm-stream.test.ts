/**
 * LLM stream-parsing regression tests (audit round 2).
 *
 * Pins three OpenAI-compat wire-format edge cases that real gateways
 * (DeepSeek, Qwen, Ollama) produce in practice:
 *  L1 the tool name arrives in fragments → must be joined, not truncated,
 *  L2 the tool_call id arrives late → args must not be dropped on a fallback id,
 *  L3 a tool call with no args fragments → start/end pairing must still hold.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiCompatProvider } from "../src/llm/openai.ts";
import type { StreamEvent } from "../src/llm/types.ts";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function data(json: string): string {
  return `data: ${json}\n\n`;
}

const MODEL = { id: "fake-1", contextWindow: 32000, maxOutput: 2000, supportsTools: true };

function provider(): ReturnType<typeof createOpenAiCompatProvider> {
  return createOpenAiCompatProvider({ id: "fake", baseUrl: "http://fake.local/v1", models: [MODEL] });
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai-compat tool-call streaming", () => {
  it("L1+L2: joins fragmented names and never drops args on a late id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          // No id yet, name fragment "re" — a fallback id would be born here.
          data(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"re","arguments":""}}]}}]}`),
          // Real id and the second name fragment arrive before any args.
          data(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xyz","function":{"name":"ad","arguments":"{\\"path\\":"}}]}}]}`),
          data(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}`),
          data(`{"choices":[{"finish_reason":"tool_calls"}]}`),
          data(`[DONE]`),
        ]),
      ),
    );
    const events = await collect(provider().stream({ model: "fake-1", system: "", messages: [], tools: [] }, {}));

    const starts = events.filter((e) => e.type === "toolcall_start") as Extract<StreamEvent, { type: "toolcall_start" }>[];
    expect(starts).toHaveLength(1);
    expect(starts[0]!.id).toBe("call_xyz"); // the real id, not `call_0`
    expect(starts[0]!.name).toBe("read"); // "re" + "ad" joined

    const deltas = events.filter((e) => e.type === "toolcall_delta") as Extract<StreamEvent, { type: "toolcall_delta" }>[];
    const args = deltas.map((d) => d.argsDelta).join("");
    expect(args).toBe(`{"path":"a.txt"}`); // nothing lost

    const done = events.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
    expect(done.stopReason).toBe("toolUse");
  });

  it("L1b: forwards name fragments that arrive after the start", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          // name "ed" plus the first args fragment → start fires with "ed".
          data(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"ed","arguments":"{}"}}]}}]}`),
          // The rest of the name arrives later.
          data(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"it","arguments":""}}]}}]}`),
          data(`{"choices":[{"finish_reason":"tool_calls"}]}`),
          data(`[DONE]`),
        ]),
      ),
    );
    const events = await collect(provider().stream({ model: "fake-1", system: "", messages: [], tools: [] }, {}));

    const names = events.filter((e) => e.type === "toolcall_name_delta") as Extract<
      StreamEvent,
      { type: "toolcall_name_delta" }
    >[];
    expect(names).toHaveLength(1);
    expect(names[0]!.id).toBe("call_1");
    expect(names[0]!.nameDelta).toBe("it");
  });

  it("L3: emits start+end even for a tool call with no args fragments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          data(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"status","arguments":""}}]}}]}`),
          data(`{"choices":[{"finish_reason":"tool_calls"}]}`),
          data(`[DONE]`),
        ]),
      ),
    );
    const events = await collect(provider().stream({ model: "fake-1", system: "", messages: [], tools: [] }, {}));

    const starts = events.filter((e) => e.type === "toolcall_start");
    const ends = events.filter((e) => e.type === "toolcall_end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect((starts[0] as { name: string }).name).toBe("status");
  });
});
