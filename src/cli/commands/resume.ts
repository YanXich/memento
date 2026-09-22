/**
 * `memento resume <session>` — continue an interrupted (or finished) session.
 *
 * The session log is the single source of truth, so resuming is faithful: the
 * exact message stream the original run saw is replayed into the model, one
 * "you were interrupted" message is appended, and the loop continues into the
 * SAME log file — the result entries stack, `memento show` tells the full
 * story, and the tail phases (verify → reflect → commit hint) run again.
 */
import path from "node:path";
import fs from "node:fs";
import pc from "picocolors";
import { attachMcpServers, attachPlugins, createWorkspace, llmReadiness, resolveLlm } from "../workspace.ts";
import { SessionRenderer, createApprover } from "../ui.ts";
import { SessionLog, loadSession } from "../../kernel/session.ts";
import { runLoop } from "../../kernel/loop.ts";
import { buildLoopHooks } from "../hooks.ts";
import { printSummary, runAftermath } from "../aftermath.ts";
import { recallSpec } from "../../spec/recall.ts";
import { formatLessons, recallLessons } from "../../memory/recall.ts";
import { buildSystemPrompt } from "../../prompts.ts";
import { buildRepoMap } from "../../kernel/repomap.ts";
import { messageId } from "../../util/ids.ts";
import type { Message } from "../../llm/types.ts";
import { oneLine } from "../../util/text.ts";
import { VERSION } from "../../version.ts";

export interface ResumeOptions {
  /** Session id or unique prefix (as printed by `memento sessions`). */
  session: string;
  root: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  temperature?: number;
  yes?: boolean;
  reflect?: boolean;
  verify?: boolean;
  commitHint?: boolean;
  showThinking?: boolean;
  verboseTools?: boolean;
}

export async function resumeTask(opts: ResumeOptions): Promise<number> {
  const ws = createWorkspace(opts.root);

  // Locate the session file — same id/prefix matching as `memento show`.
  const sessionsDir = path.join(ws.root, ".memento", "sessions");
  let file: string | null = null;
  try {
    const names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl"));
    const match = names.find((n) => n === opts.session || n.startsWith(opts.session));
    if (match) file = path.join(sessionsDir, match);
  } catch {
    /* no sessions dir */
  }
  if (!file) {
    process.stderr.write(pc.red(`session not found: ${opts.session} (looked in ${sessionsDir})\n`));
    return 1;
  }

  const loaded = loadSession(file);
  if (loaded.messages.length === 0) {
    process.stderr.write(pc.red(`session ${loaded.header.sessionId} has no messages to resume from\n`));
    return 1;
  }

  // Model choice: explicit flags win, then the model that started the session.
  const llm = resolveLlm(ws, opts.provider ?? loaded.header.provider, opts.model ?? loaded.header.model);
  if ("error" in llm) {
    process.stderr.write(pc.red(`\n${llm.error}\n`) + pc.dim("  pass --provider/--model to resume with a different model.\n"));
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

  const ac = new AbortController();
  const approver = createApprover({ yes: opts.yes, autoApprove: ws.config.autoApprove ?? ["write", "edit"], signal: ac.signal });
  const renderer = new SessionRenderer({ showThinking: opts.showThinking, verboseTools: opts.verboseTools });
  const drain = renderer.attach(ws.bus);

  process.stdout.write(
    pc.magenta(pc.bold("◈ memento resume")) +
      pc.dim(` v${VERSION} · `) +
      pc.cyan(`${provider.id}/${model.id}`) +
      pc.dim(` · ${ws.root}\n`) +
      pc.dim(`session ${loaded.header.sessionId} (was ${loaded.status}) · `) +
      pc.dim(`task: `) +
      oneLine(loaded.header.task, 100) +
      "\n",
  );

  // Re-open the SAME log — appended entries continue the original audit trail.
  const session = SessionLog.open(file);

  const onSigint = () => {
    process.stdout.write(pc.yellow("\n\n(interrupt — finishing the current step, then stopping)\n"));
    ac.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    // Rebuild the system prompt for the current tree — the repo may have
    // moved on since the session started, so recall runs fresh.
    process.stdout.write(pc.cyan("▸ ") + pc.dim("recalling spec, lessons, and repo map\n"));
    const specContext = recallSpec(ws.spec, loaded.header.task, { budget: 6000 });
    const lessons = recallLessons(ws.lessons, loaded.header.task, { max: 12 });
    const repoMap = buildRepoMap(ws.root);
    const system = buildSystemPrompt({
      cwd: ws.root,
      specContext,
      lessonsContext: formatLessons(lessons),
      repoMap,
    });

    const resumeMsg: Message = {
      id: messageId(),
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Session resumed. The conversation above is the full transcript of the earlier run (it ended with status " +
            `"${loaded.status}"). Re-orient yourself from the last tool results, finish the remaining work for the task, then verify it.`,
        },
      ],
      ts: Date.now(),
      source: "system",
    };
    session.appendMessage(resumeMsg);
    await ws.bus.emit({ type: "message_start", message: resumeMsg });
    await ws.bus.emit({ type: "message_end", message: resumeMsg });

    process.stdout.write(pc.cyan("▸ ") + pc.dim("resuming loop\n"));

    const llmRef = { provider, model, ...(apiKey ? { apiKey } : {}) };
    const hooks = buildLoopHooks(ws, llmRef, ac.signal);

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
        signal: ac.signal,
        approve: (tool, args) => approver.approve(tool, args),
      },
      [...loaded.messages, resumeMsg],
    ).catch(async (err) => {
      session.appendNote(`resume loop crashed: ${(err as Error).message}`, "system");
      session.appendResult("error", 0);
      return {
        status: "error" as const,
        turns: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [],
        error: (err as Error).message,
      };
    });

    // ------------------------------------------- VERIFY → REFLECT → COMMIT
    await runAftermath(ws, llmRef, session, result, loaded.header.task, ac.signal, {
      verify: opts.verify !== false,
      reflect: opts.reflect !== false,
      commitHint: opts.commitHint !== false,
    });

    printSummary(session, result.status, result.turns, result.usage, loaded.status);
    return result.status === "done" || result.status === "max_turns" ? 0 : 1;
  } finally {
    process.off("SIGINT", onSigint);
    drain();
    approver.close();
    session.close();
    await ws.close();
  }
}
