/**
 * Memory tests — the self-improvement mechanism must be honest:
 * confidence starts low, rises with evidence, falls on contradiction,
 * and a lesson that falls far enough is retired (never deleted).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIDENCE_START,
  LessonStore,
} from "../src/memory/store.ts";
import { recallLessons, formatLessons } from "../src/memory/recall.ts";
import { reflect } from "../src/memory/reflect.ts";
import { createMockProvider, MOCK_MODEL } from "./support/mock-provider.ts";
import type { Message } from "../src/llm/types.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-memory-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("LessonStore", () => {
  it("starts at low confidence and reinforces to the cap", () => {
    const store = LessonStore.load(dir);
    const lesson = store.add({ text: "Tests run with npm test", kind: "constraint", evidence: "observed", sessionId: "s_1" });
    expect(lesson.confidence).toBeCloseTo(CONFIDENCE_START);

    store.reinforce(lesson.id, "ran it again", "s_2");
    store.reinforce(lesson.id, "and again", "s_3");
    expect(store.get(lesson.id)!.confidence).toBeCloseTo(CONFIDENCE_START + 0.3);
    expect(store.get(lesson.id)!.reinforced).toBe(2);

    // Reload from disk — the JSONL log folds back to the same state.
    const reloaded = LessonStore.load(dir);
    expect(reloaded.get(lesson.id)!.confidence).toBeCloseTo(CONFIDENCE_START + 0.3);
  });

  it("retires a lesson once contradictions push it below the floor", () => {
    const store = LessonStore.load(dir);
    const lesson = store.add({ text: "The API uses pagination", kind: "discovery", evidence: "read code", sessionId: "s_1" });
    // A fresh lesson has never been confirmed — one contradiction retires it.
    const after = store.contradict(lesson.id, "the endpoint returns everything", "s_2");
    expect(after!.status).toBe("retired");
    expect(store.active().find((l) => l.id === lesson.id)).toBeUndefined();
    // Nothing was deleted — the full history is in the file.
    const lines = fs.readFileSync(path.join(dir, ".memento/memory/lessons.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2); // upsert + retire
  });

  it("a reinforced lesson survives one contradiction and retires on the next", () => {
    const store = LessonStore.load(dir);
    const lesson = store.add({ text: "Lockfiles are generated, not hand-edited", kind: "constraint", evidence: "e", sessionId: "s_1" });
    store.reinforce(lesson.id, "confirmed again", "s_2"); // 0.35 + 0.15 = 0.50
    store.contradict(lesson.id, "someone hand-edited it", "s_3"); // 0.50 - 0.30 = 0.20 → still active
    expect(store.get(lesson.id)!.status).toBe("active");
    store.contradict(lesson.id, "confirmed hand-edits", "s_4"); // 0.20 - 0.30 → below floor
    expect(store.get(lesson.id)!.status).toBe("retired");
  });

  it("compacts the history to one record per lesson without changing state", () => {
    const store = LessonStore.load(dir);
    const kept = store.add({ text: "Tests run with npm test", kind: "constraint", evidence: "e", sessionId: "s_1" });
    store.reinforce(kept.id, "again", "s_2");
    store.reinforce(kept.id, "and again", "s_3");
    const retired = store.add({ text: "The API uses pagination", kind: "discovery", evidence: "e", sessionId: "s_1" });
    store.retire(retired.id);
    const lines = () =>
      fs.readFileSync(path.join(dir, ".memento/memory/lessons.jsonl"), "utf8").trim().split("\n");
    expect(lines().length).toBe(5); // upsert×4 + retire

    const { before, after } = store.compact();
    expect(before).toBe(5);
    expect(after).toBe(2); // one record per lesson, retired kept
    expect(lines().length).toBe(2);

    // Folded state survives the rewrite exactly.
    const reloaded = LessonStore.load(dir);
    expect(reloaded.get(kept.id)!.confidence).toBeCloseTo(CONFIDENCE_START + 0.3);
    expect(reloaded.get(kept.id)!.reinforced).toBe(2);
    expect(reloaded.get(retired.id)!.status).toBe("retired");
  });

  it("compacting an empty store is a no-op", () => {
    const store = LessonStore.load(dir);
    expect(store.compact()).toEqual({ before: 0, after: 0 });
  });
});

describe("recallLessons", () => {
  it("ranks relevant lessons above irrelevant ones", () => {
    const store = LessonStore.load(dir);
    store.add({ text: "Database migrations run with pnpm db:migrate", kind: "constraint", evidence: "e", sessionId: "s" });
    store.add({ text: "The landing page uses a serif font", kind: "preference", evidence: "e", sessionId: "s" });
    const picked = recallLessons(store, "add a migration for the users table");
    expect(picked[0]!.text).toContain("migration");
  });

  it("never surfaces retired lessons", () => {
    const store = LessonStore.load(dir);
    const lesson = store.add({ text: "Use tabs not spaces everywhere", kind: "constraint", evidence: "e", sessionId: "s" });
    store.retire(lesson.id);
    expect(recallLessons(store, "use tabs or spaces")).toHaveLength(0);
  });

  it("formats lessons with kind and confidence tags", () => {
    const store = LessonStore.load(dir);
    store.add({ text: "Tests run with npm test", kind: "constraint", evidence: "e", sessionId: "s" });
    const formatted = formatLessons(store.active());
    expect(formatted).toContain("## Lessons from previous sessions");
    expect(formatted).toContain("[rule, low]");
  });
});

describe("reflect", () => {
  const transcript: Message[] = [
    { id: "m1", role: "user", content: [{ type: "text", text: "run the tests" }], ts: 1 },
    { id: "m2", role: "assistant", content: [{ type: "text", text: "I ran npm test — 12 passed." }], ts: 2, stopReason: "end" },
  ];

  it("adds new lessons, reinforces duplicates, and rejects evidenceless claims", async () => {
    const store = LessonStore.load(dir);
    const provider = createMockProvider([
      {
        text: JSON.stringify({
          observations: [
            { text: "Tests in this repo run with `npm test`", kind: "constraint", evidence: "assistant ran npm test", relation: "new" },
            { text: "No evidence here", kind: "pattern", evidence: "", relation: "new" }, // must be rejected
            { text: "Write clean code", kind: "pattern", evidence: "vibes", relation: "new" }, // too generic? no—rejected only by length/kind rules; length ok. keep.
          ],
          specSuggestions: [{ target: ".memento/spec/features/testing.md", rationale: "testing is now specified", priority: "medium" }],
          summary: "ran the test suite",
        }),
      },
    ]);

    const outcome = await reflect(
      { provider, model: MOCK_MODEL },
      { sessionId: "s_test", task: "run tests", status: "done", messages: transcript, store },
    );

    expect(outcome.error).toBeUndefined();
    // "No evidence here" was rejected (empty evidence).
    const addedTexts = outcome.added.map((l) => l.text);
    expect(addedTexts).toContain("Tests in this repo run with `npm test`");
    expect(addedTexts).not.toContain("No evidence here");
    expect(outcome.suggestions).toHaveLength(1);
    expect(outcome.suggestions[0]!.target).toMatch(/^\.memento\/spec\//);

    // Every added lesson carries evidence linking back to the session.
    for (const lesson of outcome.added) {
      expect(lesson.evidence.some((e) => e.includes("s_test"))).toBe(true);
    }
  });

  it("applies reinforce and contradict relations to existing lessons", async () => {
    const store = LessonStore.load(dir);
    const target = store.add({ text: "The CLI entry is src/cli.ts", kind: "discovery", evidence: "e", sessionId: "s_old" });
    const before = target.confidence;

    const provider = createMockProvider([
      {
        text: JSON.stringify({
          observations: [
            { text: "CLI entry point confirmed at src/cli.ts", kind: "discovery", evidence: "edited the file", relation: "reinforce", relatesTo: target.id },
          ],
          specSuggestions: [],
          summary: "",
        }),
      },
    ]);

    const outcome = await reflect(
      { provider, model: MOCK_MODEL },
      { sessionId: "s_new", task: "edit cli", status: "done", messages: transcript, store },
    );
    expect(outcome.reinforced).toHaveLength(1);
    expect(store.get(target.id)!.confidence).toBeGreaterThan(before);
  });

  it("survives a broken model response without throwing (non-event failures)", async () => {
    const store = LessonStore.load(dir);
    const provider = createMockProvider([{ text: "not json at all, sorry" }]);
    const outcome = await reflect(
      { provider, model: MOCK_MODEL },
      { sessionId: "s_x", task: "t", status: "done", messages: transcript, store },
    );
    expect(outcome.error).toBeTruthy();
    expect(outcome.added).toHaveLength(0);
  });

  it("deduplicates a model that repeats the same new lesson within one batch", async () => {
    const store = LessonStore.load(dir);
    const provider = createMockProvider([
      {
        text: JSON.stringify({
          observations: [
            { text: "Tests in this repo run with `npm test`", kind: "constraint", evidence: "ran it", relation: "new" },
            { text: "Tests in this repo run with `npm test`", kind: "constraint", evidence: "ran it again", relation: "new" },
          ],
          specSuggestions: [],
          summary: "",
        }),
      },
    ]);

    const outcome = await reflect(
      { provider, model: MOCK_MODEL },
      { sessionId: "s_dup", task: "run tests", status: "done", messages: transcript, store },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.added).toHaveLength(1); // second occurrence reinforces the first
    expect(outcome.reinforced).toHaveLength(1);
    expect(store.active()).toHaveLength(1);
  });
});
