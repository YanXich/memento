/**
 * Bench tests — the memory benchmark harness.
 *
 * Everything runs through the deterministic dry provider (zero network), so
 * the cold/warm effect is asserted exactly: a memoryless run fumbles one
 * orienting turn, a warm run recalls and answers in one, and reflection
 * accumulates one lesson per task.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchTask } from "../src/cli/commands/bench.ts";

let root: string;
let writes: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memento-bench-test-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bench-fixture" }), "utf8");
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const x = 1;\n", "utf8");
  writes = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeTasks(tasks: unknown): string {
  const file = path.join(root, "bench-tasks.json");
  fs.writeFileSync(file, JSON.stringify(tasks), "utf8");
  return file;
}

describe("memento bench", () => {
  it("dry mode: cold costs 2 turns, warm learns to 1 as lessons accumulate", async () => {
    const file = writeTasks({
      tasks: [
        { name: "util-a", task: "Add a small util helper" },
        { name: "util-b", task: "Add another util helper" },
        { name: "util-c", task: "Add a third util helper" },
      ],
    });
    const code = await benchTask({ file, root, dry: true, json: true });
    expect(code).toBe(0);
    const out = JSON.parse(writes.join("")) as {
      dry: boolean;
      tasks: Array<{ cold: { turns: number; inputTokens: number } | null; warm: { turns: number; lessons: number; inputTokens: number } }>;
    };
    expect(out.dry).toBe(true);
    expect(out.tasks).toHaveLength(3);
    // Cold runs are pristine copies: always the two-turn fumble.
    for (const r of out.tasks) expect(r.cold?.turns).toBe(2);
    // Warm curve: first task has no memory (2), then recall kicks in (1, 1).
    expect(out.tasks.map((r) => r.warm.turns)).toEqual([2, 1, 1]);
    // Reflection accumulates one lesson per warm task.
    expect(out.tasks.map((r) => r.warm.lessons)).toEqual([1, 2, 3]);
    // Warm input tokens stay below cold for learned tasks.
    expect(out.tasks[2]!.warm.inputTokens).toBeLessThan(out.tasks[2]!.cold?.inputTokens ?? Infinity);
  });

  it("--no-cold: warm learning curve only", async () => {
    const file = writeTasks({ tasks: [{ name: "util-a", task: "Add a small util helper" }] });
    const code = await benchTask({ file, root, dry: true, noCold: true, json: true });
    expect(code).toBe(0);
    const out = JSON.parse(writes.join("")) as {
      tasks: Array<{ cold: { turns: number } | null; warm: { turns: number } }>;
    };
    expect(out.tasks[0]!.cold).toBeNull();
    expect(out.tasks[0]!.warm.turns).toBe(2);
  });

  it("accepts a bare JSON array of tasks", async () => {
    const file = writeTasks([{ name: "util-a", task: "Add a small util helper" }]);
    const code = await benchTask({ file, root, dry: true, noCold: true, json: true });
    expect(code).toBe(0);
    const out = JSON.parse(writes.join("")) as { tasks: unknown[] };
    expect(out.tasks).toHaveLength(1);
  });

  it("rejects a missing or malformed tasks file", async () => {
    const missing = path.join(root, "nope.json");
    await expect(benchTask({ file: missing, root, dry: true })).resolves.toBe(1);
    const malformed = path.join(root, "bad.json");
    fs.writeFileSync(malformed, "{not json", "utf8");
    await expect(benchTask({ file: malformed, root, dry: true })).resolves.toBe(1);
  });

  it("rejects an empty task list", async () => {
    const file = writeTasks({ tasks: [] });
    await expect(benchTask({ file, root, dry: true })).resolves.toBe(1);
  });
});
