/**
 * The agent loop — the kernel's beating heart.
 *
 * Shape (borrowed from pi, simplified): an outer turn loop with a hard turn cap.
 * Each turn: stream one assistant message → execute its tool calls → append
 * results → repeat until the model stops calling tools or the cap is hit.
 *
 * Hard rules enforced here:
 *  - "Length" stops fail the whole tool batch (truncated args are never executed).
 *  - Every message enters the session log BEFORE it is sent to the model.
 *  - Read-only tools run in parallel; mutating tools run sequentially behind approval.
 */
import type { LlmProvider, Message, ModelInfo, ToolCallBlock, Usage } from "../llm/types.ts";
import { hasToolCalls, toolCallsOf } from "../llm/types.ts";
import type { AgentEvent } from "./events.ts";
import { EventBus } from "./events.ts";
import type { SessionLog } from "./session.ts";
import type { Tool, ToolContext, ToolResult } from "../tools/types.ts";
import { ToolRegistry } from "../tools/types.ts";
import { messageId } from "../util/ids.ts";

export interface LoopHooks {
  /** Called before each tool executes. Return a reason string to block it. */
  beforeTool?: (call: ToolCallBlock, args: Record<string, unknown>) => Promise<string | null> | string | null;
  /** Called after each tool result. Return a replacement output to rewrite it. */
  afterTool?: (call: ToolCallBlock, result: ToolResult) => Promise<ToolResult | null> | ToolResult | null;
  /** Called at the start of every turn; may return an extra message to inject (steering). */
  beforeTurn?: (turn: number) => Promise<Message | null> | Message | null;
  /** Called when the context approaches the window; return a summary to compact with. */
  compact?: (messages: Message[], keepRecent: number) => Promise<string | null>;
}

export interface LoopOptions {
  provider: LlmProvider;
  model: ModelInfo;
  apiKey?: string;
  baseUrl?: string;
  system: string;
  registry: ToolRegistry;
  session: SessionLog;
  bus: EventBus;
  hooks?: LoopHooks;
  /** Working directory exposed to tools. Defaults to process.cwd(). */
  cwd?: string;
  /** Fraction of the context window at which compaction triggers. */
  compactAt?: number;
  maxTurns?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Approve mutating tool calls. Defaults to deny-with-reason (headless safe). */
  approve?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
}

export interface LoopResult {
  status: "done" | "aborted" | "error" | "max_turns";
  turns: number;
  usage: Usage;
  /** The conversation exactly as the model last saw it (post-compaction). */
  messages: Message[];
  error?: string;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

export async function runLoop(opts: LoopOptions, context: Message[]): Promise<LoopResult> {
  const bus = opts.bus;
  const session = opts.session;
  const maxTurns = opts.maxTurns ?? 50;
  const compactAt = opts.compactAt ?? 0.8;
  let turns = 0;
  let total = emptyUsage();
  let lengthStreak = 0;

  await bus.emit({ type: "agent_start", model: opts.model.id });

  while (turns < maxTurns) {
    if (opts.signal?.aborted) {
      await finish("aborted");
      session.appendResult("aborted", turns);
      return { status: "aborted", turns, usage: total, messages: context };
    }
    turns += 1;
    await bus.emit({ type: "turn_start", turn: turns });

    // --- Steering hook: allow plugins to inject a message between turns ---
    try {
      const injected = await opts.hooks?.beforeTurn?.(turns);
      if (injected) {
        // Plugins may steer, never impersonate: force a user-side message so
        // a hostile plugin can't fabricate "user says approve everything" or
        // masquerade as the model. Every provider maps user messages through.
        const safe: Message = { ...injected, role: "user", source: "system" };
        context.push(safe);
        session.appendMessage(safe);
        await bus.emit({ type: "message_start", message: safe });
        await bus.emit({ type: "message_end", message: safe });
      }
    } catch {
      // A broken steering hook must not kill the session.
    }

    // --- Compaction check ---
    await maybeCompact(context);

    // --- One assistant turn ---
    const assistant = await streamAssistant(context);
    if (assistant === null) {
      // Hard error already emitted; stop the session cleanly.
      await finish("error");
      session.appendResult("error", turns);
      return { status: "error", turns, usage: total, messages: context };
    }
    context.push(assistant);
    session.appendMessage(assistant);
    if (assistant.usage) {
      total = addUsage(total, assistant.usage);
      session.appendUsage(assistant.usage);
    }
    await bus.emit({ type: "turn_end", turn: turns, message: assistant, usage: assistant.usage ?? emptyUsage() });

    if (assistant.stopReason === "aborted") {
      await finish("aborted");
      session.appendResult("aborted", turns);
      return { status: "aborted", turns, usage: total, messages: context };
    }
    if (assistant.stopReason === "error") {
      await finish("error");
      session.appendResult("error", turns);
      return { status: "error", turns, usage: total, messages: context };
    }

    const calls = toolCallsOf(assistant);
    if (calls.length === 0 && assistant.stopReason === "length") {
      // Truncated mid-thought with no tool calls — nudging the model to
      // continue beats silently ending the session as "done".
      lengthStreak += 1;
      if (lengthStreak >= 3) {
        await finish("max_turns");
        session.appendResult("max_turns", turns);
        return { status: "max_turns", turns, usage: total, messages: context };
      }
      const nudge: Message = {
        id: messageId(),
        role: "user",
        ts: Date.now(),
        source: "system",
        content: [
          {
            type: "text",
            text: "Your previous response was cut off by the output token limit. Continue exactly where you stopped — re-emit anything that was truncated, then finish the task.",
          },
        ],
      };
      context.push(nudge);
      session.appendMessage(nudge);
      await bus.emit({ type: "message_start", message: nudge });
      await bus.emit({ type: "message_end", message: nudge });
      continue;
    }
    lengthStreak = 0;
    if (calls.length === 0) {
      await finish("done");
      session.appendResult("done", turns);
      return { status: "done", turns, usage: total, messages: context };
    }

    // --- Tool batch ---
    let results: Message[];
    if (assistant.stopReason === "length") {
      // Truncation safety valve: the arguments are possibly cut mid-JSON.
      // Fail the whole batch and tell the model to re-issue. Never execute garbage.
      results = calls.map((call) => toolResultMessage(call, {
        output:
          "ERROR: your previous response was cut off by the output token limit, so this tool call's arguments may be truncated and were NOT executed. Re-issue the tool call with complete arguments, or split the task into smaller steps.",
        isError: true,
      }));
      await bus.emit({ type: "tools_blocked", reason: "truncated_response", calls });
    } else {
      results = await executeBatch(calls);
    }

    for (let i = 0; i < results.length; i++) {
      const msg = results[i]!;
      context.push(msg);
      session.appendMessage(msg);
      await bus.emit({ type: "tool_end", call: calls[i]!, result: msg });
    }
  }

  await finish("max_turns");
  session.appendResult("max_turns", turns);
  return { status: "max_turns", turns, usage: total, messages: context };

  // ---------------------------------------------------------------- helpers

  async function finish(reason: "done" | "aborted" | "error" | "max_turns"): Promise<void> {
    await bus.emit({ type: "agent_end", messages: context, reason });
  }

  async function streamAssistant(context: Message[]): Promise<Message | null> {
    const request = {
      model: opts.model.id,
      system: opts.system,
      messages: context,
      tools: opts.registry.toSchemas(),
      maxTokens: opts.model.maxOutput,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };

    const msg: Message = { id: messageId(), role: "assistant", content: [], ts: Date.now(), source: "model" };
    await bus.emit({ type: "message_start", message: { ...msg } });

    // Accumulators — content blocks appear in arrival order.
    let text = "";
    let thinking = "";
    let stopReason: Message["stopReason"] = "end";
    let usage: Usage = emptyUsage();
    const pendingCalls = new Map<string, { id: string; name: string; argsJson: string; order: number }>();
    let order = 0;
    let sawStart = false;
    let lastError = "";

    // One retry for clean, retryable failures before anything was received —
    // a blipped gateway or a 429 must not cost the user their whole turn.
    for (let attempt = 0; attempt < 2; attempt++) {
      let retryableError = false;
      try {
        for await (const event of opts.provider.stream(request, {
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        })) {
          switch (event.type) {
            case "start":
              sawStart = true;
              break;
            case "text_delta":
              text += event.text;
              await bus.emit({ type: "text_delta", text: event.text });
              break;
            case "thinking_delta":
              thinking += event.text;
              await bus.emit({ type: "thinking_delta", text: event.text });
              break;
            case "toolcall_start":
              pendingCalls.set(event.id, { id: event.id, name: event.name, argsJson: "", order: order++ });
              break;
            case "toolcall_delta": {
              const state = pendingCalls.get(event.id);
              if (state) state.argsJson += event.argsDelta;
              break;
            }
            case "done":
              stopReason = event.stopReason;
              usage = event.usage;
              break;
            case "error":
              // Record, don't render: text set here would mask the "no
              // progress yet" condition that gates the retry below.
              stopReason = "error";
              retryableError = event.retryable;
              lastError = event.error;
              break;
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError" || (err as Error).message === "aborted") {
          stopReason = "aborted";
        } else {
          stopReason = "error";
          retryableError = true; // a mid-stream drop is worth one retry
          text = text || `[stream failure] ${(err as Error).message}`;
        }
      }
      const noProgress = !sawStart && !text && pendingCalls.size === 0;
      if (attempt === 0 && stopReason === "error" && retryableError && noProgress) {
        // Reset and retry exactly once.
        text = "";
        stopReason = "end";
        usage = emptyUsage();
        continue;
      }
      break;
    }

    if (!sawStart && stopReason === "end" && !text && pendingCalls.size === 0) {
      stopReason = "error";
      text = "[provider error] stream produced no events";
    }

    // Materialize blocks: text → thinking → calls (in arrival order).
    if (text) msg.content.push({ type: "text", text });
    if (thinking) msg.content.push({ type: "thinking", text: thinking });
    for (const state of [...pendingCalls.values()].sort((a, b) => a.order - b.order)) {
      let args: Record<string, unknown> = {};
      try {
        args = state.argsJson ? (JSON.parse(state.argsJson) as Record<string, unknown>) : {};
      } catch {
        // Keep rawArgs — validation will fail downstream with a clean error.
        args = {};
      }
      msg.content.push({ type: "toolCall", id: state.id, name: state.name, args, rawArgs: state.argsJson });
    }

    msg.stopReason = stopReason;
    msg.usage = usage;

    if (stopReason === "error" && msg.content.length === 0) {
      msg.content.push({ type: "text", text: lastError ? `[provider error] ${lastError}` : "[provider error] empty response" });
    }

    await bus.emit({ type: "message_end", message: msg });
    return msg;
  }

  function toolResultMessage(call: ToolCallBlock, result: ToolResult): Message {
    return {
      id: messageId(),
      role: "tool",
      toolCallId: call.id,
      content: [{ type: "toolResult", toolCallId: call.id, content: result.output, ...(result.isError ? { isError: true } : {}) }],
      ts: Date.now(),
      source: "system",
    };
  }

  async function executeBatch(calls: ToolCallBlock[]): Promise<Message[]> {
    // Validate everything first — a bad call fails fast without touching side effects.
    const prepared = calls.map((call) => {
      const check = opts.registry.validate(call.name, call.args);
      return { call, check };
    });

    const toolCtx: ToolContext = {
      cwd: opts.cwd ?? process.cwd(),
      ...(opts.signal ? { signal: opts.signal } : {}),
      progress: () => {},
      approve: async () => false,
      // Tools that spawn their own mini-loop (subagent) reuse the parent's
      // provider; tools that audit (subagent) get the parent's session log.
      llm: {
        provider: opts.provider,
        model: opts.model,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      },
      session: opts.session,
    };

    // Runs preserve the model's call order end to end: consecutive read-only
    // calls form one run (executed in parallel — independent reads are the
    // common case), while every mutating/approval-gated call forms its own
    // run so side effects stay strictly ordered and approval prompts never
    // interleave mid-batch.
    const isMutating = (p: (typeof prepared)[number]) => {
      const tool = opts.registry.get(p.call.name);
      if (tool?.mutating) return true;
      if (p.check.ok && tool?.requiresApproval) return tool.requiresApproval(p.check.args);
      return false;
    };
    const runs: (typeof prepared)[number][][] = [];
    for (const p of prepared) {
      const prev = runs[runs.length - 1];
      if (isMutating(p) || !prev || isMutating(prev[0]!)) {
        runs.push([p]);
      } else {
        prev.push(p);
      }
    }

    const runOne = async (p: (typeof prepared)[number]): Promise<ToolResult> => {
      const { call, check } = p;
      await bus.emit({ type: "tool_start", call });
      if (!check.ok) {
        return { output: check.error, isError: true };
      }
      const tool = opts.registry.get(call.name)!;
      const args = check.args as Record<string, unknown>;

      const blocked = await opts.hooks?.beforeTool?.(call, args);
      if (blocked) {
        await bus.emit({ type: "tools_blocked", reason: blocked, calls: [call] });
        return { output: `Blocked: ${blocked}`, isError: true };
      }

      if (tool.mutating || tool.requiresApproval?.(args)) {
        const approved = opts.approve ? await opts.approve(call.name, args) : false;
        if (!approved) {
          return { output: `Denied: ${call.name} requires approval. Ask the user how to proceed.`, isError: true };
        }
      }

      try {
        const raw = await tool.execute(args, toolCtx);
        const rewritten = await opts.hooks?.afterTool?.(call, raw);
        return rewritten ?? raw;
      } catch (err) {
        return { output: `Tool ${call.name} failed: ${(err as Error).message}`, isError: true };
      }
    };

    const settled: ToolResult[] = [];
    for (const run of runs) {
      if (run.length === 1) {
        settled.push(await runOne(run[0]!));
      } else {
        settled.push(...(await Promise.all(run.map((p) => runOne(p)))));
      }
    }
    return settled.map((result, i) => toolResultMessage(prepared[i]!.call, result));
  }

  async function maybeCompact(context: Message[]): Promise<void> {
    const approxTokens = context.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    const budget = Math.floor(opts.model.contextWindow * compactAt);
    if (approxTokens < budget) return;
    const keepRecent = Math.max(4, Math.floor(context.length * 0.25));
    const summary = await opts.hooks?.compact?.(context, keepRecent).catch(() => null);
    if (!summary) return;

    const removed = context.length - keepRecent;
    const kept = context.slice(-keepRecent);
    context.length = 0;
    context.push({
      id: messageId(),
      role: "user",
      content: [
        {
          type: "text",
          text: `<compacted-context>\nThe earlier part of this conversation (${removed} messages) was summarized because the context window is nearly full:\n\n${summary}\n</compacted-context>`,
        },
      ],
      ts: Date.now(),
      source: "system",
    });
    context.push(...kept);
    session.appendCompaction(summary, removed, approxTokens);
    await bus.emit({ type: "context_compacted", replacedTokens: approxTokens, summaryTokens: Math.ceil(summary.length / 4) });
  }
}

function estimateMessageTokens(message: Message): number {
  // CJK characters pack roughly one token each; latin text about 4 chars
  // per token. Counting CJK separately keeps the compaction trigger honest
  // for Chinese/Japanese/Korean conversations.
  let chars = 0;
  let cjk = 0;
  for (const block of message.content) {
    let text = "";
    if (block.type === "text" || block.type === "thinking") text = block.text;
    else if (block.type === "toolResult") text = block.content;
    else if (block.type === "toolCall") text = (block.rawArgs ?? "") + block.name;
    for (const ch of text) {
      if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(ch)) cjk += 1;
      else chars += 1;
    }
  }
  return Math.ceil(chars / 4) + cjk + 8;
}

export { hasToolCalls };
