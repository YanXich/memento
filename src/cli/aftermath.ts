/**
 * The session aftermath — VERIFY → REFLECT → COMMIT HINT.
 *
 * Shared by `memento run` and `memento resume`: every session ends the same
 * way, whether it started fresh or continued from an interrupted log.
 */
import path from "node:path";
import fs from "node:fs";
import pc from "picocolors";
import type { Workspace } from "./workspace.ts";
import type { HooksLlm } from "./hooks.ts";
import type { SessionLog } from "../kernel/session.ts";
import type { LoopResult } from "../kernel/loop.ts";
import { loadSpecBundle } from "../spec/store.ts";
import { verifySpec } from "../spec/verify.ts";
import { reflect } from "../memory/reflect.ts";
import type { SpecSuggestion } from "../memory/types.ts";
import { workingDiff, suggestCommitMessage } from "../git/commit-hint.ts";
import { oneLine } from "../util/text.ts";

export interface AftermathOptions {
  verify: boolean;
  reflect: boolean;
  commitHint: boolean;
}

/** Run the post-loop tail phases. Skips are silent; failures are non-events. */
export async function runAftermath(
  ws: Workspace,
  llm: HooksLlm,
  session: SessionLog,
  result: LoopResult,
  task: string,
  signal: AbortSignal | undefined,
  opts: AftermathOptions,
): Promise<void> {
  const ac = { ...(signal ? { signal } : {}) };

  // ------------------------------------------------------------- VERIFY
  if (opts.verify) {
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
  if (opts.reflect && result.status !== "aborted") {
    process.stdout.write(pc.cyan("\n▸ ") + pc.dim("reflecting on the session (self-improvement pass)\n"));
    const outcome = await reflect(
      {
        provider: llm.provider,
        model: llm.model,
        ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
        ...ac,
        onProgress: (line) => process.stdout.write(pc.dim(`  ${line}\n`)),
      },
      {
        sessionId: session.header.sessionId,
        task,
        status: result.status,
        messages: result.messages ?? [],
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
  if (opts.commitHint && result.status !== "aborted") {
    const diff = workingDiff(ws.root);
    if (diff) {
      const msg = await suggestCommitMessage(
        { provider: llm.provider, model: llm.model, ...(llm.apiKey ? { apiKey: llm.apiKey } : {}) },
        task,
        diff,
      ).catch(() => null);
      if (msg) {
        process.stdout.write(
          `\n${pc.bold("suggested commit")} ${pc.cyan(msg)}\n` +
            pc.dim(`  (memento never commits for you — paste this into git commit -m)\n`),
        );
        session.appendNote(`suggested commit message: ${msg}`, "system");
      }
    }
  }
}

export function printSummary(session: SessionLog, status: string, turns: number, usage: LoopResult["usage"], resumedFrom?: string): void {
  const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const statusColor = status === "done" ? pc.green : status === "error" ? pc.red : pc.yellow;
  const statusGlyph = status === "done" ? pc.green("✓") : status === "error" ? pc.red("✗") : pc.yellow("⚠");
  process.stdout.write(
    "\n" +
      pc.magenta("◈ ") +
      pc.bold(`session ${session.header.sessionId}`) +
      (resumedFrom ? pc.dim(` (resumed from ${resumedFrom})`) : "") +
      pc.dim(" · ") +
      statusGlyph +
      pc.dim(" ") +
      statusColor(status) +
      pc.dim(
        ` · ${turns} turn(s) · ${usage.inputTokens} in / ${usage.outputTokens} out${cache ? ` / ${cache} cache` : ""}\n` +
          `resume: memento resume ${session.header.sessionId} · replay: memento show ${session.header.sessionId}\n`,
      ),
  );
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
