/**
 * `subagent` — dispatch a read-only exploration sub-agent.
 *
 * The parent loop asks one question; a fresh mini-loop with a read-only
 * toolbelt (read/grep/glob/ls + git inspection) investigates and returns a
 * condensed answer. Two hard benefits:
 *
 *   - Context hygiene: file dumps stay in the sub-loop's transcript, the
 *     parent only sees the digest.
 *   - Audit: the sub-agent writes its own session log under
 *     `.memento/sessions/` and the parent's log links to it.
 *
 * Safety by construction: the sub-loop's registry has no mutating tools, and
 * `subagent` is deliberately NOT registered there — no recursion, no writes.
 */
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types.ts";
import { ToolRegistry } from "../types.ts";
import { SessionLog } from "../../kernel/session.ts";
import { runLoop } from "../../kernel/loop.ts";
import { EventBus } from "../../kernel/events.ts";
import { VERSION } from "../../version.ts";
import { messageId } from "../../util/ids.ts";
import { textOf } from "../../llm/types.ts";
import type { Message } from "../../llm/types.ts";
import { globTool, grepTool, lsTool, readTool } from "./files.ts";
import { gitDiffTool, gitLogTool, gitStatusTool } from "./git.ts";

const SUBAGENT_SYSTEM = `You are a read-only exploration sub-agent inside Memento. A parent agent asked you one question. Investigate the repository with your tools, then answer it.

Rules:
- You have NO write tools — reading is all you can do, so never ask to modify anything.
- Answer in plain text, under 300 words. Cite file paths for every claim.
- Stop calling tools as soon as you can answer; do not keep browsing.
- Answer only the question you were given. If the answer is not in the repo, say so.`;

const SUBAGENT_MAX_TURNS = 6;

export const subagentTool: Tool = {
  name: "subagent",
  description:
    "Dispatch a read-only exploration sub-agent to investigate the repository and answer ONE question. " +
    "Use this to keep long file dumps out of your context window: the sub-agent reads the files, you get a condensed answer with file paths. " +
    "It can only read (read/grep/glob/ls, git status/diff/log); it cannot modify anything. One sub-agent per question — ask several in parallel if you need several answers.",
  schema: z.object({
    purpose: z.string().max(80).describe("one-line goal, e.g. 'map the auth flow'"),
    question: z.string().max(500).describe("the question the sub-agent must answer"),
  }),
  execute: async (args: unknown, ctx) => {
    const a = args as { purpose: string; question: string };
    if (!ctx.llm) {
      return { output: "subagent unavailable: the loop has no LLM in its tool context", isError: true };
    }
    const { provider, model, apiKey, baseUrl } = ctx.llm;

    // Read-only toolbelt. `subagent` itself is NOT registered here — the
    // exploration tree is exactly one level deep by construction.
    const registry = new ToolRegistry();
    for (const tool of [readTool, grepTool, globTool, lsTool, gitStatusTool, gitDiffTool, gitLogTool]) {
      registry.register(tool);
    }

    const sessionsDir = path.join(ctx.cwd, ".memento", "sessions");
    const subSession = SessionLog.create(sessionsDir, {
      cwd: ctx.cwd,
      model: model.id,
      provider: provider.id,
      task: `subagent: ${a.purpose}`,
      mementoVersion: VERSION,
    });
    subSession.appendNote(`parent question: ${a.question}`, "system");
    ctx.progress(`subagent exploring: ${a.purpose}`);

    try {
      const userMsg: Message = {
        id: messageId(),
        role: "user",
        content: [{ type: "text", text: a.question }],
        ts: Date.now(),
        source: "user",
      };
      subSession.appendMessage(userMsg);

      const result = await runLoop(
        {
          provider,
          model,
          ...(apiKey ? { apiKey } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          system: SUBAGENT_SYSTEM,
          registry,
          session: subSession,
          bus: new EventBus(),
          cwd: ctx.cwd,
          maxTurns: SUBAGENT_MAX_TURNS,
          compactAt: 0.8,
          approve: async () => false, // nothing mutating exists in the registry
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        [userMsg],
      );

      const answer = lastAssistantText(result.messages);
      if (!answer) {
        return {
          output: `subagent finished (${result.status}) without a text answer.`,
          isError: result.status !== "done",
          details: { sessionId: subSession.header.sessionId, turns: result.turns, status: result.status },
        };
      }

      ctx.session?.appendNote(
        `subagent ${subSession.header.sessionId} explored "${a.purpose}" in ${result.turns} turn(s)`,
        "system",
      );
      return {
        output: answer,
        details: { sessionId: subSession.header.sessionId, turns: result.turns, status: result.status },
      };
    } catch (err) {
      return {
        output: `subagent crashed: ${(err as Error).message}`,
        isError: true,
        details: { sessionId: subSession.header.sessionId },
      };
    } finally {
      subSession.close();
    }
  },
};

/** The final assistant text of a loop — the sub-agent's condensed answer. */
function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const text = textOf(m).trim();
      if (text) return text;
    }
  }
  return "";
}
