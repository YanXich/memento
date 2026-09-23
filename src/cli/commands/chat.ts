/**
 * `memento chat` — an interactive session with the agent.
 *
 * The REPL runs the same loop as `memento run`, one user message at a time,
 * but in one persistent session: every exchange is logged, tool approvals are
 * asked inline (the REPL and the approver share one input stream), and memory
 * is recalled per message — the next question you ask benefits from the last
 * one you asked. One reflection pass at exit distils the whole conversation.
 *
 * The conversation context lives in-process for fidelity (compaction included
 * — nothing is reconstructed from the log), while the session log stays the
 * audit trail: `memento show <id>` replays it, `memento resume <id>` continues
 * it, and `memento chat --session <id>` picks a conversation back up.
 */
import path from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import type { Workspace } from "../workspace.ts";
import { attachMcpServers, attachPlugins, createWorkspace, llmReadiness, resolveLlm } from "../workspace.ts";
import { SessionRenderer, createApprover } from "../ui.ts";
import { SessionLog, loadSession, resolveSessionFile } from "../../kernel/session.ts";
import { runLoop } from "../../kernel/loop.ts";
import type { LoopResult } from "../../kernel/loop.ts";
import { buildLoopHooks } from "../hooks.ts";
import { runAftermath } from "../aftermath.ts";
import { recallSpec } from "../../spec/recall.ts";
import { formatLessons, recallLessons } from "../../memory/recall.ts";
import { buildSystemPrompt } from "../../prompts.ts";
import { buildRepoMap } from "../../kernel/repomap.ts";
import { messageId } from "../../util/ids.ts";
import type { Message } from "../../llm/types.ts";
import { VERSION } from "../../version.ts";

export interface ChatOptions {
  root: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  temperature?: number;
  /** Approve all tool calls without asking. */
  yes?: boolean;
  /** Continue an existing session (id or prefix, as `memento sessions` prints). */
  session?: string;
  showThinking?: boolean;
  verboseTools?: boolean;
  /** Test seam: alternate input stream (defaults to process.stdin). */
  input?: NodeJS.ReadableStream;
}

export async function chatTask(opts: ChatOptions): Promise<number> {
  const ws = createWorkspace(opts.root);
  const llm = resolveLlm(ws, opts.provider, opts.model);
  if ("error" in llm) {
    process.stderr.write(pc.red(`\n${llm.error}\n`));
    return 2;
  }
  const readiness = llmReadiness(ws, llm.provider.id);
  if (!readiness.ok) {
    process.stderr.write(pc.red(`\n${readiness.detail} — set it, or switch provider. Run \`memento doctor\` for a full check.\n`));
    return 2;
  }
  const { provider, model, apiKey } = llm;
  await attachPlugins(ws);
  await attachMcpServers(ws);

  // -------- session: continue an existing one, or start a fresh conversation
  const sessionsDir = path.join(ws.root, ".memento", "sessions");
  let session: SessionLog;
  let context: Message[];
  if (opts.session) {
    const resolved = resolveSessionFile(sessionsDir, opts.session);
    if (resolved === null) {
      process.stderr.write(pc.red(`session not found: ${opts.session} (looked in ${sessionsDir})\n`));
      return 1;
    }
    if ("ambiguous" in resolved) {
      process.stderr.write(
        pc.yellow(`"${opts.session}" is ambiguous — it matches ${resolved.ambiguous.length} sessions:\n`) +
          resolved.ambiguous.map((n) => `  ${pc.cyan(n.replace(/\.jsonl$/, ""))}`).join("\n") +
          "\n" +
          pc.dim("continue with a longer prefix or the full id — resuming the wrong conversation would corrupt the audit trail\n"),
      );
      return 1;
    }
    const file = resolved.file;
    const loaded = loadSession(file);
    session = SessionLog.open(file);
    context = [...loaded.messages];
    process.stdout.write(
      pc.magenta(pc.bold("◈ memento chat")) +
        pc.dim(` v${VERSION} · resumed · `) +
        pc.cyan(`${provider.id}/${model.id}`) +
        pc.dim(` · ${ws.root}\n`) +
        pc.dim(`session ${loaded.header.sessionId} · ${loaded.messages.length} message(s) replayed\n`),
    );
  } else {
    session = SessionLog.create(sessionsDir, {
      cwd: ws.root,
      model: model.id,
      provider: provider.id,
      task: "interactive chat",
      mementoVersion: VERSION,
    });
    context = [];
    process.stdout.write(
      pc.magenta(pc.bold("◈ memento chat")) +
        pc.dim(` v${VERSION} · `) +
        pc.cyan(`${provider.id}/${model.id}`) +
        pc.dim(` · ${ws.root}\n`),
    );
  }

  // One input stream for the REPL and the approver — prompts never interleave
  // because the REPL only asks between turns. Promises flavour so the shared
  // interface type-matches the approver's question().
  const rl = createInterface({ input: opts.input ?? process.stdin, output: process.stdout });
  const acTeardown = new AbortController();
  const approver = createApprover({ yes: opts.yes, autoApprove: ws.config.autoApprove ?? ["write", "edit"], rl });
  const renderer = new SessionRenderer({ showThinking: opts.showThinking, verboseTools: opts.verboseTools });
  const drain = renderer.attach(ws.bus);

  process.stdout.write(
    pc.dim("type a task — or ") + pc.cyan("/help") + pc.dim(" · ") + pc.cyan("/memory") + pc.dim(" · ") + pc.cyan("/exit") + pc.dim("\n\n"),
  );

  const repoMap = buildRepoMap(ws.root);
  let ended = false;
  rl.once("close", () => {
    ended = true;
  });
  let lastResult: LoopResult | null = null;
  let turnAc: AbortController | null = null;
  let running = false;
  let exitRequested = false;

  const onSigint = () => {
    if (running && turnAc) {
      turnAc.abort();
    } else {
      exitRequested = true;
      rl.close();
    }
  };
  process.on("SIGINT", onSigint);

  try {
    for (;;) {
      if (exitRequested || ended) break;
      // The input stream can end (Ctrl-D, or a piped script finishing) while a
      // turn is still running — readline closes itself once every buffered line
      // is consumed, so the next question either resolves empty or rejects with
      // ERR_USE_AFTER_CLOSE. Either way we wind down cleanly.
      let line: string;
      try {
        line = await Promise.race([
          rl.question(pc.dim("❯ ")),
          new Promise<string>((resolve) => {
            const onClose = () => resolve("");
            rl.once("close", onClose);
            rl.once("line", () => rl.off("close", onClose));
          }),
        ]);
      } catch {
        break; // interface closed while waiting for input
      }
      if (exitRequested) break;
      const input = line.trim();
      if (!input) continue;

      const cmd = input.toLowerCase();
      if (cmd === "/exit" || cmd === "/quit" || cmd === "/q") break;
      if (cmd === "/help") {
        process.stdout.write(
          pc.dim(
            "  /help     this list\n" +
              "  /memory   what the agent has learned so far\n" +
              "  /exit     end the chat (one reflection pass distils it into lessons)\n" +
              "  anything else is sent to the agent — tools, approval and memory work like `memento run`\n",
          ) + "\n",
        );
        continue;
      }
      if (cmd === "/memory") {
        const stats = ws.lessons.stats();
        process.stdout.write(
          pc.dim(`  memory: ${stats.active} active lesson(s) · ${stats.retired} retired · avg confidence ${stats.avgConfidence}\n\n`),
        );
        continue;
      }
      if (input.startsWith("/")) {
        process.stdout.write(pc.dim(`  unknown command "${input}" — /help lists commands\n\n`));
        continue;
      }

      // ------------------------------------------------------- one exchange
      const userMsg: Message = {
        id: messageId(),
        role: "user",
        content: [{ type: "text", text: input }],
        ts: Date.now(),
        source: "user",
      };
      context.push(userMsg);
      session.appendMessage(userMsg);
      await ws.bus.emit({ type: "message_start", message: userMsg });
      await ws.bus.emit({ type: "message_end", message: userMsg });

      // Memory is recalled per message — a chat jumps topics, so the recall
      // query is this message, not a session-wide task string.
      const specContext = recallSpec(ws.spec, input, { budget: 6000 });
      const lessons = recallLessons(ws.lessons, input, { max: 12 });
      if (lessons.length > 0) {
        process.stdout.write(pc.dim(`recalled ${lessons.length} lesson(s) from memory\n`));
      }
      const system = buildSystemPrompt({
        cwd: ws.root,
        specContext,
        lessonsContext: formatLessons(lessons),
        repoMap,
      });

      const llmRef = { provider, model, ...(apiKey ? { apiKey } : {}) };
      turnAc = new AbortController();
      running = true;
      try {
        const hooks = buildLoopHooks(ws, llmRef, turnAc.signal);
        const result = await runLoop(
          {
            provider,
            model,
            ...(apiKey ? { apiKey } : {}),
            system,
            cwd: ws.root,
            registry: ws.tools,
            session,
            bus: ws.bus,
            hooks,
            maxTurns: opts.maxTurns ?? ws.config.maxTurns ?? 50,
            compactAt: ws.config.compactAt ?? 0.8,
            ...(opts.temperature !== undefined
              ? { temperature: opts.temperature }
              : ws.config.temperature !== undefined
                ? { temperature: ws.config.temperature }
                : {}),
            signal: turnAc.signal,
            approve: (tool, args) => approver.approve(tool, args),
          },
          context,
        ).catch(async (err) => {
          session.appendNote(`chat turn crashed: ${(err as Error).message}`, "system");
          session.appendResult("error", 0);
          return {
            status: "error" as const,
            turns: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [],
            error: (err as Error).message,
          };
        });
        lastResult = result;
        if (result.status === "error") {
          process.stdout.write(pc.red(`\n(turn failed: ${result.error ?? "unknown"} — the chat continues)\n`));
        } else if (result.status === "aborted") {
          process.stdout.write(pc.dim("(interrupted)\n"));
        }
      } finally {
        running = false;
        turnAc = null;
      }
      process.stdout.write("\n");
    }

    // One reflection pass distils the whole conversation into lessons — the
    // chat teaches memory exactly like a run does.
    if (lastResult) {
      process.stdout.write(pc.dim("reflecting on the conversation…\n"));
      const llmRef = { provider, model, ...(apiKey ? { apiKey } : {}) };
      await runAftermath(ws, llmRef, session, lastResult, "interactive chat", acTeardown.signal, {
        verify: false,
        reflect: true,
        commitHint: false,
      });
    }
    process.stdout.write(
      "\n" + pc.dim("session ") + pc.cyan(session.header.sessionId) + pc.dim(` — \`memento show ${session.header.sessionId}\` replays it, \`memento chat --session ${session.header.sessionId}\` continues it`) + "\n",
    );
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    drain();
    approver.close();
    if (!ended) rl.close();
    session.close();
    await ws.close();
  }
}

export type { Workspace };
