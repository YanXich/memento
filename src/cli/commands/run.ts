/**
 * `memento run <task>` — the full SDD loop in one command.
 *
 *   RECALL   spec + lessons relevant to the task are selected
 *   GATE     the task is checked against the spec; a change is proposed & gated
 *   BUILD    the agent loop runs with tools, approval, and plugins
 *   VERIFY   spec checkers run against the resulting tree
 *   REFLECT  the session is distilled into lessons (confidence-scored)
 *
 * Each phase is visibly announced; nothing happens silently.
 */
import path from "node:path";
import fs from "node:fs";
import pc from "picocolors";
import type { Workspace } from "../workspace.ts";
import { attachMcpServers, attachPlugins, createWorkspace, resolveLlm } from "../workspace.ts";
import { SessionRenderer, createApprover } from "../ui.ts";
import { SessionLog } from "../../kernel/session.ts";
import type { LoopHooks } from "../../kernel/loop.ts";
import { runLoop } from "../../kernel/loop.ts";
import { dispatchPluginEvent } from "../../plugins/loader.ts";
import { recallSpec } from "../../spec/recall.ts";
import { loadSpecBundle, writeSpec } from "../../spec/store.ts";
import { verifySpec } from "../../spec/verify.ts";
import { proposeSpecDelta } from "../../spec/generator.ts";
import { formatLessons, recallLessons } from "../../memory/recall.ts";
import { reflect } from "../../memory/reflect.ts";
import type { SpecSuggestion } from "../../memory/types.ts";
import { COMPACT_SYSTEM, buildSystemPrompt } from "../../prompts.ts";
import { buildRepoMap } from "../../kernel/repomap.ts";
import { complete } from "../../llm/complete.ts";
import { messageId } from "../../util/ids.ts";
import type { Message, Usage } from "../../llm/types.ts";
import { textOf, toolCallsOf } from "../../llm/types.ts";
import { oneLine, truncate } from "../../util/text.ts";
import { VERSION } from "../../version.ts";
import { suggestCommitMessage, workingDiff } from "../../git/commit-hint.ts";

export interface RunOptions {
  task: string;
  root: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  temperature?: number;
  /** Approve everything without asking. */
  yes?: boolean;
  /** ask (default) | auto | off — the spec-delta gate. */
  specGate?: "ask" | "auto" | "off";
  /** Run the reflection pass (default true). */
  reflect?: boolean;
  /** Run spec verification after the loop (default true). */
  verify?: boolean;
  /** Suggest a commit message after the loop (default true). */
  commitHint?: boolean;
  /** A pre-approved plan (from `memento plan`) injected as the first message. */
  plan?: string;
  showThinking?: boolean;
  verboseTools?: boolean;
}

export async function runTask(opts: RunOptions): Promise<number> {
  const ws = createWorkspace(opts.root);
  const llm = resolveLlm(ws, opts.provider, opts.model);
  if ("error" in llm) {
    process.stderr.write(pc.red(`\n${llm.error}\n`));
    return 2;
  }
  const { provider, model, apiKey } = llm;
  await attachPlugins(ws);
  await attachMcpServers(ws);

  const ac = new AbortController();
  const approver = createApprover({ yes: opts.yes, autoApprove: ws.config.autoApprove ?? ["write", "edit"], signal: ac.signal });
  const renderer = new SessionRenderer({ showThinking: opts.showThinking, verboseTools: opts.verboseTools });
  const drain = renderer.attach(ws.bus);

  let finalMessages: Message[] = [];
  const capture = ws.bus.on((event) => {
    if (event.type === "agent_end") finalMessages = event.messages;
  });

  const header =
    pc.magenta(pc.bold("◈ memento")) +
    pc.dim(` v${VERSION}`) +
    pc.dim(" · ") +
    pc.cyan(`${provider.id}/${model.id}`) +
    pc.dim(` · ${ws.root}\n`);
  process.stdout.write(header);
  process.stdout.write(pc.dim("task: ") + oneLine(opts.task, 100) + "\n");

  const genDeps = {
    provider,
    model,
    ...(apiKey ? { apiKey } : {}),
    onProgress: (line: string) => process.stdout.write(pc.dim(`  ${line}\n`)),
  };

  const session = SessionLog.create(path.join(ws.root, ".memento", "sessions"), {
    cwd: ws.root,
    model: model.id,
    provider: provider.id,
    task: opts.task,
    mementoVersion: VERSION,
  });

  const onSigint = () => {
    process.stdout.write(pc.yellow("\n\n(interrupt — finishing the current step, then stopping)\n"));
    ac.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    // ---------------------------------------------------------- SPEC GATE
    const gate = opts.specGate ?? "ask";
    if (gate !== "off" && ws.spec.all.length > 0) {
      process.stdout.write(pc.cyan("\n▸ spec gate") + pc.dim(" — does this task change the spec?\n"));
      const relevant = recallSpec(ws.spec, opts.task, { budget: 3000 });
      const delta = await proposeSpecDelta(genDeps, opts.task, ws.spec, relevant).catch(() => null);
      if (delta) {
        process.stdout.write(
          `\n${pc.yellow("proposed spec change")} ${pc.bold(delta.target)} ${pc.dim(`(${delta.action})`)}\n` +
            pc.dim(`  why: ${delta.rationale}\n\n`) +
            indent(truncate(delta.content, 1400), "  ") +
            "\n",
        );
        const apply = gate === "auto" ? true : await approver.confirm(`Apply this spec change to ${delta.target}?`);
        if (apply) {
          writeSpec(ws.root, delta.target, delta.content);
          session.appendNote(`spec gate: wrote ${delta.target} — ${delta.rationale}`, "system");
          process.stdout.write(pc.green(`✓ spec updated: ${delta.target}\n`));
        } else {
          session.appendNote(`spec gate: proposal for ${delta.target} declined by user`, "system");
          process.stdout.write(pc.dim("spec change declined — the session proceeds against the current spec\n"));
        }
      } else {
        process.stdout.write(pc.dim("  no spec change required for this task\n"));
      }
    } else if (gate !== "off" && ws.spec.all.length === 0) {
      process.stdout.write(
        pc.yellow("note: no .memento/spec found — running without spec context. `memento spec init` enables the full SDD loop.\n"),
      );
    }

    // ------------------------------------------------------------- RECALL
    const specContext = recallSpec(ws.spec, opts.task, { budget: 6000 });
    const lessons = recallLessons(ws.lessons, opts.task, { max: 12 });
    if (lessons.length) {
      process.stdout.write(pc.cyan("\n▸ ") + pc.dim(`recalled ${lessons.length} lesson(s) from memory\n`));
    }
    process.stdout.write(pc.cyan("▸ ") + pc.dim("indexing repository\n"));
    const repoMap = buildRepoMap(ws.root);
    const system = buildSystemPrompt({
      cwd: ws.root,
      specContext,
      lessonsContext: formatLessons(lessons),
      repoMap,
    });

    // -------------------------------------------------------------- BUILD
    process.stdout.write(pc.cyan("\n▸ ") + pc.dim("building\n"));

    const hooks: LoopHooks = {
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
          provider,
          model,
          ...(apiKey ? { apiKey } : {}),
          ...(ac.signal ? { signal: ac.signal } : {}),
          system: COMPACT_SYSTEM,
          user: truncate(transcript, 30_000),
          maxTokens: Math.min(model.maxOutput, 2000),
        });
        return res.text.trim() || null;
      },
    };

    const userMsg: Message = {
      id: messageId(),
      role: "user",
      content: [{ type: "text", text: opts.task }],
      ts: Date.now(),
      source: "user",
    };
    session.appendMessage(userMsg);
    await ws.bus.emit({ type: "message_start", message: userMsg });
    await ws.bus.emit({ type: "message_end", message: userMsg });

    const initialMessages: Message[] = [userMsg];
    if (opts.plan) {
      // The human already approved this plan — hand it to the agent as the
      // first thing to follow. It rides a user message so no provider can
      // mistake it for model output.
      const planMsg: Message = {
        id: messageId(),
        role: "user",
        content: [
          {
            type: "text",
            text: `Approved plan (from \`memento plan\`) — execute it step by step, checking each step's verification before moving on:\n\n${opts.plan}`,
          },
        ],
        ts: Date.now(),
        source: "user",
      };
      session.appendMessage(planMsg);
      await ws.bus.emit({ type: "message_start", message: planMsg });
      await ws.bus.emit({ type: "message_end", message: planMsg });
      initialMessages.push(planMsg);
    }

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
      initialMessages,
    ).catch(async (err) => {
      // Last-resort containment: a crash here must still leave a finished,
      // resumable session behind — never a permanently "incomplete" log.
      session.appendNote(`runLoop crashed: ${(err as Error).message}`, "system");
      session.appendResult("error", 0);
      return {
        status: "error" as const,
        turns: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        error: (err as Error).message,
      };
    });

    // ------------------------------------------------------------- VERIFY
    if (opts.verify !== false) {
      const bundle = loadSpecBundle(ws.root);
      if (bundle.all.length > 0) {
        const report = verifySpec(ws.root, bundle, ws.specCheckers);
        printVerify(report);
        session.appendNote(
          `verify: ${report.passed ? "passed" : "failed"} — ${report.issues.length} issue(s) across ${report.checked} spec file(s)`,
          "system",
        );
      }
    }

    // ------------------------------------------------------------ REFLECT
    if (opts.reflect !== false && result.status !== "aborted" && finalMessages.length > 0) {
      process.stdout.write(pc.cyan("\n▸ ") + pc.dim("reflecting on the session (self-improvement pass)\n"));
      const outcome = await reflect(
        {
          provider,
          model,
          ...(apiKey ? { apiKey } : {}),
          ...(ac.signal ? { signal: ac.signal } : {}),
          onProgress: (line) => process.stdout.write(pc.dim(`  ${line}\n`)),
        },
        {
          sessionId: session.header.sessionId,
          task: opts.task,
          status: result.status,
          messages: finalMessages,
          store: ws.lessons,
        },
      );
      printReflection(outcome);
      if (outcome.summary) session.appendNote(outcome.summary, "reflect");
      if (outcome.suggestions.length) {
        // Double-write: lessons land in memory AND spec suggestions are
        // persisted for review — reflection must never silently evaporate.
        writeSpecSuggestions(ws.root, session.header.sessionId, outcome.suggestions);
        process.stdout.write(pc.dim("  suggestions appended to .memento/spec-suggestions.md\n"));
      }
    }

    // ------------------------------------------------------------- SUMMARY
    // Diff-aware commit hint: if the session changed files, one small model
    // call turns the diff into a conventional commit message. Never commits.
    if (opts.commitHint !== false && result.status !== "aborted") {
      const diff = workingDiff(ws.root);
      if (diff) {
        const msg = await suggestCommitMessage(genDeps, opts.task, diff).catch(() => null);
        if (msg) {
          process.stdout.write(
            `\n${pc.bold("suggested commit")} ${pc.cyan(msg)}\n` +
              pc.dim(`  (memento never commits for you — paste this into git commit -m)\n`),
          );
          session.appendNote(`suggested commit message: ${msg}`, "system");
        }
      }
    }

    printSummary(session, result.status, result.turns, result.usage);
    return result.status === "done" || result.status === "max_turns" ? 0 : 1;
  } finally {
    process.off("SIGINT", onSigint);
    capture();
    drain();
    approver.close();
    session.close();
    await ws.close();
  }
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function printVerify(report: ReturnType<typeof verifySpec>): void {
  process.stdout.write(
    pc.cyan("\n▸ spec verify") + pc.dim(" — ") + (report.passed ? pc.green("passed") : pc.red("failed")) + pc.dim(` (${report.checked} file(s))\n`),
  );
  for (const issue of report.issues.slice(0, 15)) {
    const tag = issue.severity === "error" ? pc.red("error") : issue.severity === "warning" ? pc.yellow("warn ") : pc.dim("info ");
    process.stdout.write(`  ${tag} [${issue.checker}] ${issue.file ? issue.file + ": " : ""}${issue.message}\n`);
  }
  if (report.issues.length > 15) process.stdout.write(pc.dim(`  … and ${report.issues.length - 15} more\n`));
}

function printReflection(outcome: Awaited<ReturnType<typeof reflect>>): void {
  if (outcome.error) {
    process.stdout.write(pc.dim(`  reflection skipped: ${outcome.error}\n`));
    return;
  }
  const parts: string[] = [];
  if (outcome.added.length) parts.push(pc.green(`+${outcome.added.length} new lesson(s)`));
  if (outcome.reinforced.length) parts.push(pc.green(`↑${outcome.reinforced.length} reinforced`));
  if (outcome.contradicted.length) parts.push(pc.yellow(`↓${outcome.contradicted.length} contradicted`));
  if (outcome.retired.length) parts.push(pc.yellow(`${outcome.retired.length} retired`));
  process.stdout.write(`  ${parts.length ? parts.join("  ") : pc.dim("no new lessons this session")}\n`);
  for (const lesson of outcome.added) {
    process.stdout.write(pc.dim(`    + [${lesson.kind}] ${oneLine(lesson.text, 90)} (${lesson.id})\n`));
  }
  if (outcome.suggestions.length) {
    process.stdout.write(pc.dim("  spec suggestions (review manually):\n"));
    for (const s of outcome.suggestions) {
      process.stdout.write(pc.dim(`    · ${s.priority}: ${s.target} — ${oneLine(s.rationale, 80)}\n`));
    }
  }
}

function writeSpecSuggestions(root: string, sessionId: string, suggestions: SpecSuggestion[]): void {
  const file = path.join(root, ".memento", "spec-suggestions.md");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const body = suggestions.map((s) => `- [${s.priority}] ${s.target} — ${oneLine(s.rationale, 120)}`).join("\n");
  // appendFileSync is a single O_APPEND write — concurrent sessions append
  // whole entries, never interleave.
  fs.appendFileSync(file, `\n## session ${sessionId} (${stamp})\n${body}\n`, "utf8");
}

function printSummary(session: SessionLog, status: string, turns: number, usage: Usage): void {
  const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const statusColor = status === "done" ? pc.green : status === "error" ? pc.red : pc.yellow;
  const statusGlyph = status === "done" ? pc.green("✓") : status === "error" ? pc.red("✗") : pc.yellow("⚠");
  process.stdout.write(
    "\n" +
      pc.magenta("◈ ") +
      pc.bold(`session ${session.header.sessionId}`) +
      pc.dim(" · ") +
      statusGlyph +
      pc.dim(" ") +
      statusColor(status) +
      pc.dim(
        ` · ${turns} turn(s) · ${usage.inputTokens} in / ${usage.outputTokens} out${cache ? ` / ${cache} cache` : ""}\n` +
          `resume context: memento show ${session.header.sessionId}\n`,
      ),
  );
}

export type { Workspace };
