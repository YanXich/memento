/**
 * Memory export/import — memory as code. The team story: one repo exports
 * its lessons to JSON, the file is committed, every teammate imports it.
 * Idempotent: re-importing changes nothing, and a claim that already exists
 * (even under a different id) is never duplicated.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LessonStore } from "../src/memory/store.ts";
import { memoryExportCmd, memoryImportCmd } from "../src/cli/commands/memory.ts";
import type { Lesson } from "../src/memory/types.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-memx-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(root: string, texts: string[]): string[] {
  const store = LessonStore.load(root);
  return texts.map((text) => store.add({ text, kind: "pattern", evidence: "test", sessionId: "t" }).id);
}

function capture(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    writes.push(String(c));
    return true;
  });
  return writes;
}

describe("memory export/import", () => {
  it("exports to a file and imports it into a fresh repo", () => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    seed(a, ["Login routes chain through middleware/index.ts", "Rate limits live in src/middleware/"]);
    const out = path.join(dir, "team-memory.json");
    expect(memoryExportCmd({ root: a, out })).toBe(0);
    const payload = JSON.parse(fs.readFileSync(out, "utf8")) as { version: number; lessons: Lesson[] };
    expect(payload.version).toBe(1);
    expect(payload.lessons).toHaveLength(2);

    const writes = capture();
    expect(memoryImportCmd({ root: b, file: out })).toBe(0);
    expect(writes.join("")).toContain("2 added");

    const storeB = LessonStore.load(b);
    expect(storeB.all()).toHaveLength(2);
    // Provenance marker lands in every imported lesson's evidence trail.
    expect(storeB.all().every((l) => l.evidence.some((e) => e.includes("imported:")))).toBe(true);
  });

  it("re-importing is idempotent — everything is skipped, nothing duplicates", () => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    seed(a, ["One claim"]);
    const out = path.join(dir, "team.json");
    memoryExportCmd({ root: a, out });
    memoryImportCmd({ root: b, file: out });

    const writes = capture();
    expect(memoryImportCmd({ root: b, file: out })).toBe(0);
    expect(writes.join("")).toContain("1 skipped (same id)");
    expect(LessonStore.load(b).all()).toHaveLength(1);
  });

  it("the same claim under a different id is never duplicated", () => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const [localId] = seed(b, ["Login routes chain through middleware/index.ts"]);
    const storeA = LessonStore.load(a);
    const lessonA = storeA.add({
      text: "Login routes chain through middleware/index.ts",
      kind: "pattern",
      evidence: "t",
      sessionId: "t",
    });
    expect(lessonA.id).not.toBe(localId);
    const out = path.join(dir, "team.json");
    memoryExportCmd({ root: a, out });
    memoryImportCmd({ root: b, file: out });
    expect(LessonStore.load(b).all()).toHaveLength(1);
  });

  it("invalid entries are ignored while valid ones import", () => {
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const file = path.join(dir, "mixed.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        lessons: [
          { id: "ok-1", text: "A valid claim", kind: "pattern", confidence: 0.6, evidence: ["t"], scope: "repo", created: 1, lastSeen: 1, reinforced: 0, contradicted: 0, tags: [], status: "active" },
          { id: "", text: "no id", kind: "pattern", confidence: 0.5, evidence: [] },
          { id: "bad-kind", text: "bad kind", kind: "nope", confidence: 0.5, evidence: [] },
          "garbage",
        ],
      }),
      "utf8",
    );
    const writes = capture();
    expect(memoryImportCmd({ root: b, file })).toBe(0);
    expect(writes.join("")).toContain("1 added");
    expect(writes.join("")).toContain("3 invalid ignored");
    expect(LessonStore.load(b).all()).toHaveLength(1);
  });

  it("rejects missing files, non-export shapes, and broken JSON", () => {
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    expect(memoryImportCmd({ root: b, file: path.join(dir, "nope.json") })).toBe(1);
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ something: "else" }), "utf8");
    expect(memoryImportCmd({ root: b, file: bad })).toBe(1);
    fs.writeFileSync(bad, "not json", "utf8");
    expect(memoryImportCmd({ root: b, file: bad })).toBe(1);
  });

  it("returns 2 when nothing in the file was importable", () => {
    const b = path.join(dir, "b");
    fs.mkdirSync(b);
    const file = path.join(dir, "junk.json");
    fs.writeFileSync(file, JSON.stringify({ lessons: ["garbage", 42] }), "utf8");
    expect(memoryImportCmd({ root: b, file })).toBe(2);
    expect(LessonStore.load(b).all()).toHaveLength(0);
  });
});
