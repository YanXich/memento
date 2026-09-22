/**
 * Lesson recall — select the top-K lessons to inject into the system prompt.
 *
 * Ranking: relevance (term overlap with task) × confidence, with recency as a
 * light tiebreaker. Retired lessons never surface. Low-confidence lessons are
 * included only when directly relevant — an unproven guess should not steer
 * unrelated work.
 */
import type { Lesson } from "./types.ts";
import type { LessonStore } from "./store.ts";
import { extractTerms, termOverlap } from "../util/text.ts";

export interface RecallLessonsOptions {
  max?: number;
}

export function recallLessons(store: LessonStore, task: string, opts: RecallLessonsOptions = {}): Lesson[] {
  const max = opts.max ?? 12;
  const taskTerms = extractTerms(task);
  const pool = store.active();
  if (pool.length === 0) return [];

  const now = Date.now();
  const week = 7 * 24 * 3600 * 1000;

  const scored = pool.map((lesson) => {
    const relevance = lesson.tags.length
      ? termOverlap(taskTerms, lesson.tags)
      : termOverlap(taskTerms, extractTerms(lesson.text));
    const recency = Math.max(0, 1 - (now - lesson.lastSeen) / (4 * week)); // decays over a month
    const base = relevance * 3 + lesson.confidence * 1.5 + recency * 0.3;
    return { lesson, score: base, relevance };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: Lesson[] = [];
  for (const { lesson, relevance } of scored) {
    if (selected.length >= max) break;
    if (relevance < 0.02 && lesson.confidence < 0.7) continue; // skip irrelevant + unproven
    selected.push(lesson);
  }
  return selected;
}

/** Format lessons for system-prompt injection. */
export function formatLessons(lessons: Lesson[]): string {
  if (lessons.length === 0) return "";
  const lines = lessons.map((l) => {
    const conf = l.confidence >= 0.7 ? "high" : l.confidence >= 0.45 ? "medium" : "low";
    const tag = { constraint: "rule", pattern: "pattern", failure: "avoid", preference: "pref", discovery: "fact" }[l.kind];
    return `- [${tag}, ${conf}] ${l.text}  (${l.id})`;
  });
  return [
    "## Lessons from previous sessions",
    "These are accumulated insights about this project and user. Treat high-confidence rules as binding. If one proves wrong, say so explicitly — it will be down-weighted next session.",
    ...lines,
  ].join("\n");
}
