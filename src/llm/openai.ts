/**
 * OpenAI-compatible chat completions provider.
 *
 * Covers OpenAI, DeepSeek, Moonshot, Qwen (DashScope compat), Ollama,
 * LM Studio, vLLM and every gateway that speaks the same dialect.
 */
import type {
  LlmProvider,
  LlmRequest,
  Message,
  ModelInfo,
  StreamEvent,
  ToolSchema,
  Usage,
} from "./types.ts";
import { combineSignals, describeHttpError, isAbortError, sseLines } from "./sse.ts";

/** Hard cap on the whole request+stream — a hung gateway must not hang the agent. */
const REQUEST_TIMEOUT_MS = 600_000;

export interface OpenAiCompatOptions {
  id: string;
  label?: string;
  baseUrl: string;
  models: ModelInfo[];
  headers?: Record<string, string>;
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export function toWireMessages(messages: Message[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      out.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      const calls = msg.content
        .filter((b) => b.type === "toolCall")
        .map((b) => {
          const call = b as { id: string; name: string; rawArgs?: string; args: unknown };
          return {
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.rawArgs ?? JSON.stringify(call.args ?? {}) },
          };
        });
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else if (msg.role === "tool") {
      const text = msg.content
        .filter((b) => b.type === "toolResult")
        .map((b) => (b as { content: string }).content)
        .join("\n");
      out.push({ role: "tool", content: text, tool_call_id: msg.toolCallId ?? "" });
    }
  }
  return out;
}

function toWireTools(tools: ToolSchema[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function createOpenAiCompatProvider(opts: OpenAiCompatOptions): LlmProvider {
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
        messages: [{ role: "system", content: req.system }, ...toWireMessages(req.messages)],
        stream: true,
        stream_options: { include_usage: true },
      };
      if (req.tools.length > 0) body.tools = toWireTools(req.tools);
      if (req.maxTokens) body.max_tokens = req.maxTokens;
      if (req.temperature !== undefined) body.temperature = req.temperature;

      const sig = combineSignals(o.signal, REQUEST_TIMEOUT_MS);
      const reqSignal = sig.signal;
      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}),
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

      // Tool call streaming state — OpenAI streams arguments incrementally per index.
      const toolCalls = new Map<number, { id: string; name: string; args: string; started: boolean }>();
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let finishReason: string | null = null;
      let sawDone = false;

      try {
        for await (const line of sseLines(res.body, reqSignal, () => sig.dispose())) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            sawDone = true;
            break;
          }
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
            };
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text_delta", text: delta.content };
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            yield { type: "thinking_delta", text: delta.reasoning_content };
          }
          for (const call of delta.tool_calls ?? []) {
            const idx: number = call.index ?? 0;
            let state = toolCalls.get(idx);
            if (!state) {
              state = { id: call.id ?? `call_${idx}`, name: "", args: "", started: false };
              toolCalls.set(idx, state);
            }
            if (call.id && call.id !== state.id) state.id = call.id;
            if (call.function?.name) {
              state.name += call.function.name;
              // Name fragments after the start? Some gateways chunk the name —
              // forward them so the kernel can repair its copy.
              if (state.started) {
                yield { type: "toolcall_name_delta", id: state.id, nameDelta: call.function.name };
              }
            }
            if (typeof call.function?.arguments === "string" && call.function.arguments.length > 0) {
              if (!state.started) {
                // Defer the start until the first args fragment: by then every
                // real dialect has delivered the full id and name. Starting
                // earlier would announce a fallback id or a truncated name
                // that later fragments invalidate — and the kernel keys its
                // pending-call map on that id, so a mismatch silently drops
                // every args delta.
                state.started = true;
                yield { type: "toolcall_start", id: state.id, name: state.name };
              }
              state.args += call.function.arguments;
              yield { type: "toolcall_delta", id: state.id, argsDelta: call.function.arguments };
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

      for (const [, state] of toolCalls) {
        // A tool call with no args fragments (rare, but legal) never emitted
        // its start — announce it now so start/end pairing holds for the kernel.
        if (!state.started) yield { type: "toolcall_start", id: state.id, name: state.name };
        yield { type: "toolcall_end", id: state.id };
      }

      const stopReason =
        finishReason === "tool_calls" || toolCalls.size > 0
          ? "toolUse"
          : finishReason === "length"
            ? "length"
            : "end";
      if (!sawDone && finishReason === null) {
        // Stream ended without [DONE] or finish_reason — treat as truncation.
        yield { type: "done", stopReason: "length", usage };
        return;
      }
      yield { type: "done", stopReason, usage };
    },
  };
}
