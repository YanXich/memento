/**
 * Loop hooks shared by `memento run` and `memento resume` — plugin steering
 * plus context compaction. Keeping one copy means a fix to either command's
 * safety behavior lands for both.
 */
import type { LoopHooks } from "../kernel/loop.ts";
import type { LlmProvider, ModelInfo } from "../llm/types.ts";
import { textOf, toolCallsOf } from "../llm/types.ts";
import { complete } from "../llm/complete.ts";
import { COMPACT_SYSTEM } from "../prompts.ts";
import { dispatchPluginEvent } from "../plugins/loader.ts";
import { oneLine, truncate } from "../util/text.ts";
import type { Workspace } from "./workspace.ts";

export interface HooksLlm {
  provider: LlmProvider;
  model: ModelInfo;
  apiKey?: string;
}

export function buildLoopHooks(ws: Workspace, llm: HooksLlm, signal?: AbortSignal): LoopHooks {
  return {
    beforeTool: async (call, args) => {
      const patches = await dispatchPluginEvent(ws.pluginHost, { type: "before_tool", tool: call.name, args });
      for (const patch of patches) {
        if (patch && typeof patch === "object" && typeof (patch as { block?: unknown }).block === "string") {
          return (patch as { block: string }).block;
        }
      }
      return null;
    },
    afterTool: async (call, result) => {
      const patches = await dispatchPluginEvent(ws.pluginHost, {
        type: "after_tool",
        tool: call.name,
        output: result.output,
        isError: Boolean(result.isError),
      });
      let out = result;
      for (const patch of patches) {
        if (patch && typeof patch === "object") {
          const p = patch as { output?: string; isError?: boolean };
          if (typeof p.output === "string") out = { ...out, output: p.output };
          if (typeof p.isError === "boolean") out = { ...out, isError: p.isError };
        }
      }
      return out;
    },
    compact: async (messages, keepRecent) => {
      const head = messages.slice(0, Math.max(0, messages.length - keepRecent));
      if (head.length === 0) return null;
      const transcript = head
        .map((m) => {
          if (m.role === "assistant") {
            const calls = toolCallsOf(m)
              .map((c) => `${c.name}(${oneLine(JSON.stringify(c.args), 100)})`)
              .join(", ");
            return `ASSISTANT: ${oneLine(textOf(m), 300)}${calls ? ` | TOOLS: ${calls}` : ""}`;
          }
          if (m.role === "tool") {
            const block = m.content.find((b) => b.type === "toolResult") as { content: string; isError?: boolean } | undefined;
            return block ? `RESULT${block.isError ? "(error)" : ""}: ${oneLine(block.content, 220)}` : "";
          }
          return `${m.role.toUpperCase()}: ${oneLine(textOf(m), 300)}`;
        })
        .filter(Boolean)
        .join("\n");
      const res = await complete({
        provider: llm.provider,
        model: llm.model,
        ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
        ...(signal ? { signal } : {}),
        system: COMPACT_SYSTEM,
        user: truncate(transcript, 30_000),
        maxTokens: Math.min(llm.model.maxOutput, 2000),
      });
      return res.text.trim() || null;
    },
  };
}
