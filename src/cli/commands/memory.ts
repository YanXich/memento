/**
 * `memento remember` / `memento lessons` / `memento memory export|import` —
 * memory as a first-class artifact.
 *
 * Lessons live in `.memento/memory/lessons.jsonl`, append-only and reviewable
 * in a diff. Confidence is never edited in place: reinforce/contradict append
 * new records, so the history of belief is preserved.
 *
 * Export/import make memory a team artifact: export to JSON, commit it next
 * to the repo, and every teammate's agent imports what the team already
 * learned. Memory as code.
 */
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { createWorkspace } from "../workspace.ts";
import type { Lesson, LessonKind } from "../../memory/types.ts";
import { oneLine } from "../../util/text.ts";

const KINDS: LessonKind[] = ["constraint", "pattern", "failure", "preference", "discovery"];

export interface RememberOptions {
  root: string;
  text: string;
  kind?: string;
  evidence?: string;
}

export function rememberCmd(opts: RememberOptions): number {
  const ws = createWorkspace(opts.root);
  const kind = (opts.kind ?? "discovery") as LessonKind;
  if (!KINDS.includes(kind)) {
    process.stderr.write(pc.red(`invalid --kind "${opts.kind}". Use one of: ${KINDS.join(", ")}\n`));
    return 2;
  }
  const lesson = ws.lessons.add({
    text: opts.text,
    kind,
    evidence: opts.evidence?.trim() || "added manually",
    sessionId: "manual",
  });
  process.stdout.write(
    pc.green("✓ lesson recorded") +
      `\n  ${lesson.id} [${lesson.kind}] ${oneLine(lesson.text, 100)}\n` +
      pc.dim(`  confidence ${lesson.confidence.toFixed(2)} — it rises when future sessions confirm it.\n`),
  );
  return 0;
}

export interface LessonsOptions {
  root: string;
  all?: boolean;
  json?: boolean;
  retire?: string;
  reinforce?: string;
  contradict?: string;
  evidence?: string;
  /** Fold the append-only history back to one record per lesson. */
  compact?: boolean;
}

export function lessonsCmd(opts: LessonsOptions): number {
  const ws = createWorkspace(opts.root);
  const store = ws.lessons;

  if (opts.compact) {
    const { before, after } = store.compact();
    if (before === 0) {
      process.stdout.write(pc.dim("no lessons recorded yet — nothing to compact\n"));
      return 0;
    }
    process.stdout.write(
      pc.green("✓ compacted memory") +
        pc.dim(` — ${before} history record(s) folded to ${after} lesson(s)\n`) +
        pc.dim("  state is unchanged; only the append-only log was rewritten.\n"),
    );
    return 0;
  }

  if (opts.retire) {
    const updated = store.retire(opts.retire);
    if (!updated) return notFound(opts.retire);
    process.stdout.write(pc.yellow(`✗ retired ${updated.id}: ${oneLine(updated.text, 80)}\n`));
    return 0;
  }
  if (opts.reinforce) {
    const updated = store.reinforce(opts.reinforce, opts.evidence ?? "reinforced manually", "manual");
    if (!updated) return notFound(opts.reinforce);
    process.stdout.write(pc.green(`↑ reinforced ${updated.id} → confidence ${updated.confidence.toFixed(2)}\n`));
    return 0;
  }
  if (opts.contradict) {
    const updated = store.contradict(opts.contradict, opts.evidence ?? "contradicted manually", "manual");
    if (!updated) return notFound(opts.contradict);
    const tag = updated.status === "retired" ? pc.yellow("retired") : "active";
    process.stdout.write(pc.yellow(`↓ contradicted ${updated.id} → confidence ${updated.confidence.toFixed(2)} (${tag})\n`));
    return 0;
  }

  const lessons = opts.all ? store.all() : store.active();
  const stats = store.stats();

  if (opts.json) {
    process.stdout.write(JSON.stringify({ stats, lessons }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    pc.bold(`\nlessons — ${stats.active} active, ${stats.retired} retired`) +
      pc.dim(` · avg confidence ${stats.avgConfidence.toFixed(2)}\n\n`),
  );
  if (lessons.length === 0) {
    process.stdout.write(pc.dim("  (none yet — they accumulate automatically after each `memento run`)\n"));
    return 0;
  }
  for (const l of lessons) {
    const conf = l.confidence >= 0.7 ? pc.green(l.confidence.toFixed(2)) : l.confidence >= 0.4 ? pc.yellow(l.confidence.toFixed(2)) : pc.dim(l.confidence.toFixed(2));
    const status = l.status === "retired" ? pc.dim(" [retired]") : "";
    process.stdout.write(`  ${conf} ${pc.dim(l.id)} [${l.kind}]${status} ${oneLine(l.text, 120)}\n`);
    if (opts.all && l.evidence.length) {
      for (const e of l.evidence.slice(-2)) process.stdout.write(pc.dim(`        evidence: ${oneLine(e, 110)}\n`));
    }
  }
  process.stdout.write(pc.dim("\n  adjust: memento lessons --reinforce <id> | --contradict <id> | --retire <id>\n"));
  return 0;
}

function notFound(id: string): number {
  process.stderr.write(pc.red(`no lesson with id ${id}\n`));
  return 1;
}

/* ---------------------------------------------------------------- export */

export interface MemoryExportOptions {
  root: string;
  out?: string;
  activeOnly?: boolean;
}

export function memoryExportCmd(opts: MemoryExportOptions): number {
  const ws = createWorkspace(opts.root);
  const lessons = opts.activeOnly ? ws.lessons.active() : ws.lessons.all();
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    lessons,
  };
  const json = JSON.stringify(payload, null, 2) + "\n";
  if (opts.out) {
    const target = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json, "utf8");
    process.stdout.write(
      pc.green("✓ exported memory") + pc.dim(` — ${lessons.length} lesson(s) → ${opts.out}\n`) +
        pc.dim("  commit it next to the repo; teammates import it with `memento memory import <file>`\n"),
    );
  } else {
    process.stdout.write(json);
  }
  return 0;
}

/* ---------------------------------------------------------------- import */

export interface MemoryImportOptions {
  root: string;
  file: string;
}

const KINDS_SET = new Set<LessonKind>(["constraint", "pattern", "failure", "preference", "discovery"]);

/** Shape check — an import must never inject junk into the memory log. */
function isLessonShape(v: unknown): v is Lesson {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.id === "string" &&
    l.id.length > 0 &&
    typeof l.text === "string" &&
    l.text.trim().length > 0 &&
    KINDS_SET.has(l.kind as LessonKind) &&
    typeof l.confidence === "number" &&
    Number.isFinite(l.confidence) &&
    Array.isArray(l.evidence)
  );
}

export function memoryImportCmd(opts: MemoryImportOptions): number {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(opts.file), "utf8"));
  } catch (err) {
    process.stderr.write(pc.red(`cannot read memory export: ${(err as Error).message}\n`));
    return 1;
  }
  const list = Array.isArray(raw) ? raw : (raw as { lessons?: unknown[] } | null)?.lessons;
  if (!Array.isArray(list)) {
    process.stderr.write(pc.red(`not a memory export — expected {"lessons":[…]}\n`));
    return 1;
  }

  const ws = createWorkspace(opts.root);
  const source = path.basename(opts.file);
  let imported = 0;
  let skippedId = 0;
  let skippedText = 0;
  let invalid = 0;
  for (const item of list) {
    if (!isLessonShape(item)) {
      invalid++;
      continue;
    }
    const outcome = ws.lessons.importLesson(item, source);
    if (outcome === "imported") imported++;
    else if (outcome === "skipped-id") skippedId++;
    else skippedText++;
  }

  process.stdout.write(
    pc.green(`✓ memory imported`) +
      pc.dim(` — ${imported} added`) +
      (skippedId ? pc.dim(`, ${skippedId} skipped (same id)`) : "") +
      (skippedText ? pc.dim(`, ${skippedText} skipped (same claim)`) : "") +
      (invalid ? pc.yellow(`, ${invalid} invalid ignored`) : "") +
      pc.dim(`\n  source: ${source} — provenance stays in each lesson's evidence\n`),
  );
  return imported === 0 && skippedId === 0 && skippedText === 0 ? 2 : 0;
}
