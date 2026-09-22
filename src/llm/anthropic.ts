/**
 * Anthropic Messages API provider.
 * Wire format differs enough from OpenAI that it gets its own translation layer:
 * system is a top-level field, tool results ride inside `user` messages,
 * and streaming uses named SSE events with content-block indexing.
 */
import type {
  LlmProvider,
  LlmRequest,
  Message,
  ModelInfo,
  StopReason,
  StreamEvent,
  ToolSchema,
  Usage,
} from "./types.ts";
import { combineSignals, describeHttpError, isAbortError, sseLines } from "./sse.ts";

/** Hard cap on the whole request+stream — a hung gateway must not hang the agent. */
const REQUEST_TIMEOUT_MS = 600_000;

export interface AnthropicProviderOptions {
  id: string;
  label?: string;
  baseUrl: string;
  models: ModelInfo[];
  headers?: Record<string, string>;
}

interface WireBlock {
  type: string;
  [k: string]: unknown;
}

/** Anthropic requires strict alternation context: tool results become user content blocks. */
function toWireMessages(messages: Message[]): { role: "user" | "assistant"; content: WireBlock[] }[] {
  const out: { role: "user" | "assistant"; content: WireBlock[] }[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      out.push({ role: "user", content: [{ type: "text", text }] });
    } else if (msg.role === "assistant") {
      const blocks: WireBlock[] = [];
      for (const b of msg.content) {
        if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
        else if (b.type === "thinking" && b.text) blocks.push({ type: "thinking", thinking: b.text });
        else if (b.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: b.id,
            name: b.name,
            input: b.args ?? {},
          });
        }
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
    } else if (msg.role === "tool") {
      const result = msg.content.find((b) => b.type === "toolResult") as
        | { content: string; isError?: boolean }
        | undefined;
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "",
            content: result?.content ?? "",
            ...(result?.isError ? { is_error: true } : {}),
          },
        ],
      });
    }
  }
  return out;
}

function toWireTools(tools: ToolSchema[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): LlmProvider {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    id: opts.id,
    label: opts.label ?? opts.id,
    models: opts.models,
    resolveModel(model: string) {
      return (
        opts.models.find((m) => m.id === model) ??
        (opts.models.length === 1 ? opts.models[0] : undefined)
      );
    },
    async *stream(req: LlmRequest, o): AsyncIterable<StreamEvent> {
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens ?? 8192,
        system: req.system,
        messages: toWireMessages(req.messages),
        stream: true,
      };
      if (req.tools.length > 0) body.tools = toWireTools(req.tools);
      if (req.temperature !== undefined) body.temperature = req.temperature;

      const sig = combineSignals(o.signal, REQUEST_TIMEOUT_MS);
      const reqSignal = sig.signal;
      let res: Response;
      try {
        res = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            ...(o.apiKey ? { "x-api-key": o.apiKey } : {}),
            ...opts.headers,
          },
          body: JSON.stringify(body),
          signal: reqSignal,
        });
      } catch (err) {
        sig.dispose();
        if (isAbortError(err)) {
          yield { type: "done", stopReason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } };
        } else {
          yield { type: "error", error: `Network error: ${(err as Error).message}`, retryable: true };
        }
        return;
      }
      // Fetch resolved — drop the request timer, but keep abort propagation
      // alive: Ctrl-C during a slow stream must still tear it down.
      sig.clearTimeout();

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const { message, retryable } = describeHttpError(res.status, text);
        sig.dispose();
        yield { type: "error", error: message, retryable };
        return;
      }

      yield { type: "start" };

      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: string | null = null;
      // content block index -> kind + real tool_use id, so deltas and stop
      // events address the same id the kernel saw in toolcall_start.
      const blockKinds = new Map<number, { kind: string; id?: string }>();
      let currentEvent: string | null = null;

      try {
        for await (const line of sseLines(res.body, reqSignal, () => sig.dispose())) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let data: any;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (currentEvent) {
            case "message_start": {
              usage.inputTokens = data.message?.usage?.input_tokens ?? 0;
              if (data.message?.usage?.cache_read_input_tokens) {
                usage.cacheReadTokens = data.message.usage.cache_read_input_tokens;
              }
              break;
            }
            case "content_block_start": {
              const idx: number = data.index ?? 0;
              const block = data.content_block ?? {};
              blockKinds.set(idx, { kind: block.type ?? "text", id: block.id as string | undefined });
              if (block.type === "tool_use") {
                yield { type: "toolcall_start", id: block.id ?? `toolu_${idx}`, name: block.name ?? "" };
              }
              break;
            }
            case "content_block_delta": {
              const idx: number = data.index ?? 0;
              const delta = data.delta ?? {};
              if (delta.type === "text_delta" && delta.text) {
                yield { type: "text_delta", text: delta.text };
              } else if (delta.type === "thinking_delta" && delta.thinking) {
                yield { type: "thinking_delta", text: delta.thinking };
              } else if (delta.type === "input_json_delta" && delta.partial_json) {
                const blockId = blockKinds.get(idx)?.id ?? `toolu_${idx}`;
                yield { type: "toolcall_delta", id: blockId, argsDelta: delta.partial_json };
              }
              break;
            }
            case "content_block_stop": {
              const idx: number = data.index ?? 0;
              if (blockKinds.get(idx)?.kind === "tool_use") {
                yield { type: "toolcall_end", id: blockKinds.get(idx)?.id ?? `toolu_${idx}` };
              }
              break;
            }
            case "message_delta": {
              if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
              if (data.usage?.output_tokens) usage.outputTokens = data.usage.output_tokens;
              break;
            }
            case "error": {
              yield {
                type: "error",
                error: data.error?.message ?? "Unknown Anthropic stream error",
                retryable: data.error?.type === "overloaded_error",
              };
              return;
            }
          }
        }
      } catch (err) {
        if (isAbortError(err)) {
          yield { type: "done", stopReason: "aborted", usage };
          return;
        }
        yield { type: "error", error: `Stream error: ${(err as Error).message}`, retryable: true };
        return;
      }

      const mapped: StopReason =
        stopReason === "tool_use"
          ? "toolUse"
          : stopReason === "max_tokens"
            ? "length"
            : stopReason === null
              ? "length" // stream died early — treat as truncation, never as clean end
              : "end";
      yield { type: "done", stopReason: mapped, usage };
    },
  };
}
