/**
 * Lesson store — append-safe JSONL, one file per repo.
 *
 * Why JSONL and not a database: lessons must be reviewable in a PR, editable
 * by hand, and diffable in git. The store keeps a full history: updates append
 * new records with the same id, and `loadLessons` folds them (last write wins).
 * Nothing is ever silently destroyed — `retired` is a status, not a delete.
 */
import fs from "node:fs";
import path from "node:path";
import type { Lesson, LessonEvent, LessonKind, MemoryStats } from "./types.ts";
import { appendJsonl, ensureDir, readJsonl } from "../util/paths.ts";
import { sleepSync, withFileLock } from "../util/lock.ts";
import { lessonId } from "../util/ids.ts";
import { extractTerms } from "../util/text.ts";

export const MEMORY_DIR = ".memento/memory";
export const LESSONS_FILE = `${MEMORY_DIR}/lessons.jsonl`;

export const CONFIDENCE_START = 0.35;
export const CONFIDENCE_REINFORCE = 0.15;
export const CONFIDENCE_CONTRADICT = 0.3;
export const CONFIDENCE_RETIRE_BELOW = 0.12;

interface LessonRecord {
  op: "upsert" | "retire";
  ts: number;
  lesson: Lesson;
}

/**
 * Records kept per lesson after compaction. Eight points is enough to redraw
 * the confidence arc in the workbench (creation, reinforcements, a retirement)
 * while keeping the file bounded no matter how many sessions run.
 */
export const COMPACT_HISTORY_KEEP = 8;

export class LessonStore {
  readonly file: string;
  private lessons = new Map<string, Lesson>();

  private constructor(file: string) {
    this.file = file;
  }

  static load(root: string): LessonStore {
    const file = path.join(root, LESSONS_FILE);
    const store = new LessonStore(file);
    store.lessons = foldRecords(readJsonl<LessonRecord>(file));
    return store;
  }

  /**
   * Apply one mutation under the cross-process file lock, re-reading the fold
   * from disk INSIDE the critical section.
   *
   * Why re-read: two parallel agents reinforcing the same lesson would both
   * read the same previous confidence in their own in-memory maps and one
   * +0.15 would be lost (read-modify-write race). The lock makes the
   * read-modify-append atomic across processes. The cost is one small file
   * read per mutation — the log is bounded by compaction, and reflections
   * apply at most a handful of observations.
   */
  private mutate<T>(fn: (lessons: Map<string, Lesson>) => T): T {
    ensureDir(path.dirname(this.file)); // the lock file needs its parent dir
    const result = withFileLock(
      this.file,
      () => {
        const lessons = foldRecords(readJsonl<LessonRecord>(this.file));
        const out = fn(lessons);
        this.lessons = lessons;
        return out;
      },
      { retries: 10, retryDelayMs: 100 },
    );
    return result;
  }

  add(input: { text: string; kind: LessonKind; evidence: string; sessionId: string; scope?: "repo" | "user" }): Lesson {
    const now = Date.now();
    const lesson: Lesson = {
      id: lessonId(),
      text: input.text.trim(),
      kind: input.kind,
      confidence: CONFIDENCE_START,
      evidence: [input.evidence, `session:${input.sessionId}`].filter(Boolean),
      reinforced: 0,
      contradicted: 0,
      scope: input.scope ?? "repo",
      created: now,
      lastSeen: now,
      tags: extractTerms(input.text).slice(0, 12),
      status: "active",
    };
    return this.mutate((lessons) => {
      appendJsonl(this.file, { op: "upsert", ts: Date.now(), lesson } satisfies LessonRecord);
      lessons.set(lesson.id, lesson);
      return lesson;
    });
  }

  reinforce(id: string, evidence: string, sessionId: string): Lesson | null {
    return this.mutate((lessons) => {
      const prev = lessons.get(id);
      if (!prev) return null;
      const updated: Lesson = {
        ...prev,
        confidence: Math.min(1, prev.confidence + CONFIDENCE_REINFORCE),
        reinforced: prev.reinforced + 1,
        evidence: cap([...prev.evidence, evidence, `session:${sessionId}`], 12),
        lastSeen: Date.now(),
        status: "active",
      };
      appendJsonl(this.file, { op: "upsert", ts: Date.now(), lesson: updated } satisfies LessonRecord);
      lessons.set(id, updated);
      return updated;
    });
  }

  contradict(id: string, evidence: string, sessionId: string): Lesson | null {
    return this.mutate((lessons) => {
      const prev = lessons.get(id);
      if (!prev) return null;
      const confidence = Math.max(0, prev.confidence - CONFIDENCE_CONTRADICT);
      const updated: Lesson = {
        ...prev,
        confidence,
        contradicted: prev.contradicted + 1,
        evidence: cap([...prev.evidence, `CONTRADICTED: ${evidence}`, `session:${sessionId}`], 12),
        lastSeen: Date.now(),
        status: confidence < CONFIDENCE_RETIRE_BELOW ? "retired" : prev.status,
      };
      appendJsonl(
        this.file,
        { op: updated.status === "retired" ? "retire" : "upsert", ts: Date.now(), lesson: updated } satisfies LessonRecord,
      );
      lessons.set(id, updated);
      return updated;
    });
  }

  /** Manually retire (user said "forget this"). */
  retire(id: string): Lesson | null {
    return this.mutate((lessons) => {
      const prev = lessons.get(id);
      if (!prev) return null;
      const updated: Lesson = { ...prev, status: "retired" };
      appendJsonl(this.file, { op: "retire", ts: Date.now(), lesson: updated } satisfies LessonRecord);
      lessons.set(id, updated);
      return updated;
    });
  }

  get(id: string): Lesson | undefined {
    return this.lessons.get(id);
  }

  /**
   * Import a lesson from an export (team memory). The claim keeps its
   * confidence — someone else verified it — but the evidence trail gains an
   * `imported:` marker so the audit log stays honest about provenance.
   *
   * Returns why a lesson was skipped: same id, or the same claim already
   * present under a different id (text match after trimming).
   */
  importLesson(lesson: Lesson, source: string): "imported" | "skipped-id" | "skipped-text" {
    return this.mutate((lessons) => {
      if (lessons.has(lesson.id)) return "skipped-id";
      const text = lesson.text.trim().toLowerCase();
      for (const existing of lessons.values()) {
        if (existing.text.trim().toLowerCase() === text) return "skipped-text";
      }
      const imported: Lesson = {
        ...lesson,
        text: lesson.text.trim(),
        confidence: Math.min(1, Math.max(0, lesson.confidence)),
        evidence: cap([...lesson.evidence, `imported:${source}`], 12),
        lastSeen: Date.now(),
      };
      appendJsonl(this.file, { op: "upsert", ts: Date.now(), lesson: imported } satisfies LessonRecord);
      lessons.set(imported.id, imported);
      return "imported";
    });
  }

  all(): Lesson[] {
    return [...this.lessons.values()];
  }

  active(): Lesson[] {
    return this.all().filter((l) => l.status === "active");
  }

  stats(): MemoryStats {
    const all = this.all();
    const active = all.filter((l) => l.status === "active");
    const byKind = { constraint: 0, pattern: 0, failure: 0, preference: 0, discovery: 0 } as Record<LessonKind, number>;
    let confSum = 0;
    for (const lesson of active) {
      byKind[lesson.kind] += 1;
      confSum += lesson.confidence;
    }
    return {
      active: active.length,
      retired: all.length - active.length,
      byKind,
      avgConfidence: active.length ? confSum / active.length : 0,
    };
  }

  /**
   * Evolution arcs for every lesson, folded from the raw append-only log in a
   * single pass. Each event carries the confidence at that point in time —
   * this is the data behind the workbench's "the agent gets smarter" curve.
   */
  histories(): Map<string, LessonEvent[]> {
    const byId = new Map<string, LessonEvent[]>();
    for (const record of readJsonl<LessonRecord>(this.file)) {
      const lesson = record.lesson;
      if (!lesson?.id) continue;
      const list = byId.get(lesson.id) ?? [];
      list.push({
        op: record.op,
        ts: record.ts,
        confidence: lesson.confidence,
        reinforced: lesson.reinforced,
        contradicted: lesson.contradicted,
        status: lesson.status,
      });
      byId.set(lesson.id, list);
    }
    return byId;
  }

  /**
   * Fold the append-only history back to a bounded trail per lesson.
   *
   * Every reinforce/contradict appends a record, so the log grows with each
   * session. Compaction keeps the most recent records per lesson id — the
   * folded state is identical, the file shrinks, and the evolution arc stays
   * drawable (COMPACT_HISTORY_KEEP points). Retired lessons are kept:
   * retirement is a status, not a delete.
   *
   * Concurrency: the whole read → tmp-write → rename runs under the shared
   * file lock. A writer arriving mid-compaction waits, then appends to the
   * NEW inode — no append is lost to the rename (the naive version lost any
   * line written to the old inode after the swap). Windows can fail the
   * rename with EPERM while a peer's fd is momentarily open; a short retry
   * absorbs that instead of crashing. Atomic via temp-file + rename, so a
   * crash mid-write can never corrupt the store.
   */
  compact(): { before: number; after: number } {
    ensureDir(path.dirname(this.file)); // the lock file needs its parent dir
    return withFileLock(
      this.file,
      () => {
        const records = readJsonl<LessonRecord>(this.file);
        if (records.length === 0) return { before: 0, after: 0 };
        const byId = new Map<string, LessonRecord[]>();
        for (const record of records) {
          if (!record.lesson?.id) continue;
          const list = byId.get(record.lesson.id) ?? [];
          list.push(record);
          if (list.length > COMPACT_HISTORY_KEEP) list.shift();
          byId.set(record.lesson.id, list);
        }
        const folded = [...byId.values()].flat();
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, folded.map((r) => JSON.stringify(r) + "\n").join(""), "utf8");
        for (let attempt = 0; ; attempt++) {
          try {
            fs.renameSync(tmp, this.file);
            break;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EPERM" && attempt < 5) {
              sleepSync(50);
              continue;
            }
            throw err;
          }
        }
        // Rebuild the in-memory fold so live sessions see the compacted state.
        this.lessons = new Map(folded.map((r) => [r.lesson.id, r.lesson]));
        return { before: records.length, after: folded.length };
      },
      { retries: 20, retryDelayMs: 250 },
    );
  }
}

/** Fold raw records into the current lesson map (last write wins per id). */
function foldRecords(records: LessonRecord[]): Map<string, Lesson> {
  const lessons = new Map<string, Lesson>();
  for (const record of records) {
    if (record.op === "upsert" && record.lesson?.id) {
      lessons.set(record.lesson.id, record.lesson);
    } else if (record.op === "retire" && record.lesson?.id) {
      lessons.set(record.lesson.id, { ...record.lesson, status: "retired" });
    }
  }
  return lessons;
}

function cap<T>(arr: T[], max: number): T[] {
  return arr.length <= max ? arr : arr.slice(arr.length - max);
}

export function memoryFileExists(root: string): boolean {
  return fs.existsSync(path.join(root, LESSONS_FILE));
}
