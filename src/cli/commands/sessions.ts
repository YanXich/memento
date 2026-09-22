/**
 * `memento sessions` / `memento show` — the session log is the audit trail.
 *
 * Because the log is the single source of truth ("what the model saw ⟺ what
 * was logged"), `show` reconstructs the exact conversation — useful for
 * debugging an agent run months later.
 */
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { listSessions, loadSession, resolveSessionFile } from "../../kernel/session.ts";
import type { SessionEntry } from "../../kernel/session.ts";
import { textOf, toolCallsOf } from "../../llm/types.ts";
import { appendJsonl } from "../../util/paths.ts";
import { oneLine } from "../../util/text.ts";

const STATUS_COLOR: Record<string, (s: string) => string> = {
  done: pc.green,
  aborted: pc.yellow,
  error: pc.red,
  max_turns: pc.yellow,
  incomplete: pc.dim,
};

function sessionsDir(root: string): string {
  return path.join(root, ".memento", "sessions");
}

export function sessionsCmd(root: string, limit = 20): number {
  const all = listSessions(sessionsDir(root));
  process.stdout.write(pc.bold(`\nsessions — ${all.length} total`) + pc.dim(` (newest first)\n\n`));
  if (all.length === 0) {
    process.stdout.write(pc.dim("  (none yet — `memento run <task>` creates one)\n"));
    return 0;
  }
  for (const s of all.slice(0, limit)) {
    const when = new Date(s.header.startedAt).toISOString().replace("T", " ").slice(0, 16);
    const color = STATUS_COLOR[s.status] ?? pc.dim;
    process.stdout.write(
      `  ${pc.bold(s.header.sessionId)}  ${color(s.status.padEnd(10))} ${pc.dim(when)}  ` +
        `${pc.dim(`${s.header.provider}/${s.header.model}`)}  ${oneLine(s.header.task, 60)}\n`,
    );
  }
  process.stdout.write(pc.dim(`\n  inspect: memento show <id>\n`));
  return 0;
}

export function sessionShowCmd(root: string, idOrPrefix: string, full = false): number {
  const dir = sessionsDir(root);
  const resolved = resolveSessionFile(dir, idOrPrefix);
  if (resolved === null) {
    process.stderr.write(pc.red(`session not found: ${idOrPrefix} (looked in ${dir})\n`));
    return 1;
  }
  if ("ambiguous" in resolved) {
    process.stderr.write(
      pc.yellow(`"${idOrPrefix}" is ambiguous — it matches ${resolved.ambiguous.length} sessions:\n`) +
        resolved.ambiguous.map((n) => `  ${pc.cyan(n.replace(/\.jsonl$/, ""))}`).join("\n") +
        "\n" +
        pc.dim("use a longer prefix or the full id\n"),
    );
    return 1;
  }
  const file = resolved.file;

  const loaded = loadSession(file);
  const color = STATUS_COLOR[loaded.status] ?? pc.dim;
  process.stdout.write(
    pc.bold(`\n${loaded.header.sessionId}`) +
      color(`  ${loaded.status}`) +
      pc.dim(`  ${loaded.header.provider}/${loaded.header.model}\n`) +
      pc.dim(`started ${new Date(loaded.header.startedAt).toISOString()} · cwd ${loaded.header.cwd}\n`) +
      pc.bold(`task: `) +
      loaded.header.task +
      "\n\n",
  );

  for (const entry of loaded.entries) {
    printEntry(entry, full);
  }
  return 0;
}

function printEntry(entry: SessionEntry, full: boolean): void {
  const cap = full ? 100_000 : 300;
  switch (entry.kind) {
    case "header":
      break;
    case "message": {
      const m = entry.message;
      if (m.role === "user") {
        process.stdout.write(pc.bold("\n▸ user\n") + indent(oneLine(textOf(m), cap)) + "\n");
      } else if (m.role === "assistant") {
        const text = textOf(m);
        if (text) process.stdout.write(pc.bold("\n▸ assistant\n") + indent(oneLine(text, cap)) + "\n");
        for (const call of toolCallsOf(m)) {
          process.stdout.write(pc.cyan(`  ⏺ ${call.name}`) + pc.dim(`(${oneLine(JSON.stringify(call.args), full ? 2000 : 160)})`) + "\n");
        }
      } else if (m.role === "tool") {
        const block = m.content.find((b) => b.type === "toolResult") as { content: string; isError?: boolean } | undefined;
        if (block) {
          const body = oneLine(block.content, cap);
          process.stdout.write((block.isError ? pc.red("  ✗ ") : pc.dim("  · ")) + pc.dim(body) + "\n");
        }
      }
      break;
    }
    case "compaction":
      process.stdout.write(pc.dim(`\n⌁ context compacted: ${entry.replacedCount} messages → summary (${entry.tokensSaved} tokens)\n`));
      if (full) process.stdout.write(indent(pc.dim(entry.summary), "  ") + "\n");
      break;
    case "note":
      process.stdout.write(pc.dim(`\n[${entry.author}] ${oneLine(entry.text, full ? 100_000 : 220)}\n`));
      break;
    case "usage":
      break;
    case "result":
      process.stdout.write(pc.bold(`\nresult: ${entry.status}`) + pc.dim(` after ${entry.turns} turn(s)\n`));
      break;
  }
}

function indent(text: string, pad = "  "): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

/** A session id and timestamp, appended to a per-repo index for quick listing. */
export function appendSessionIndex(root: string, sessionId: string, task: string, status: string): void {
  appendJsonl(path.join(sessionsDir(root), "index.jsonl"), {
    ts: Date.now(),
    sessionId,
    task: oneLine(task, 120),
    status,
  });
}
