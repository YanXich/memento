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

  it("parallel schedule: identical results to the sequential one, in task order", async () => {
    const file = writeTasks({
      tasks: [
        { name: "util-a", task: "Add a small util helper" },
        { name: "util-b", task: "Add another util helper" },
        { name: "util-c", task: "Add a third util helper" },
      ],
    });
    const code = await benchTask({ file, root, dry: true, json: true, jobs: 3 });
    expect(code).toBe(0);
    const out = JSON.parse(writes.join("")) as {
      tasks: Array<{ name: string; cold: { turns: number } | null; warm: { turns: number; lessons: number } }>;
    };
    // Slot order is task order regardless of how workers interleaved.
    expect(out.tasks.map((r) => r.name)).toEqual(["util-a", "util-b", "util-c"]);
    // Cold sandboxes stay pristine under parallelism.
    expect(out.tasks.map((r) => r.cold?.turns)).toEqual([2, 2, 2]);
    // The warm chain is still sequential — memory accumulates task by task.
    expect(out.tasks.map((r) => r.warm.turns)).toEqual([2, 1, 1]);
    expect(out.tasks.map((r) => r.warm.lessons)).toEqual([1, 2, 3]);
  });

  it("parallel schedule: --no-cold leaves every cold slot null", async () => {
    const file = writeTasks({
      tasks: [
        { name: "util-a", task: "Add a small util helper" },
        { name: "util-b", task: "Add another util helper" },
      ],
    });
    const code = await benchTask({ file, root, dry: true, json: true, noCold: true, jobs: 2 });
    expect(code).toBe(0);
    const out = JSON.parse(writes.join("")) as {
      tasks: Array<{ cold: null; warm: { turns: number } }>;
    };
    expect(out.tasks.map((r) => r.cold)).toEqual([null, null]);
    expect(out.tasks.map((r) => r.warm.turns)).toEqual([2, 1]);
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

  it("--report: writes a standalone brand-styled HTML report", async () => {
    const file = writeTasks({
      tasks: [
        { name: "util-a", task: "Add a small util helper" },
        { name: "util-b", task: "Add another util helper" },
      ],
    });
    // Nested path: the parent directories must be created, not assumed.
    const report = path.join(root, "out", "nested", "report.html");
    const code = await benchTask({ file, root, dry: true, json: true, report });
    expect(code).toBe(0);
    const html = fs.readFileSync(report, "utf8");
    // Standalone document, brand styling, real data, escaped text.
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("◈ memento");
    expect(html).toContain("Learning curve");
    expect(html).toContain("<polyline");
    expect(html).toContain("util-a");
    expect(html).toContain("turns saved vs memoryless");
    // Percentages are computed from the dry numbers: cold 2 → warm 1 turns.
    expect(html).toContain("−50%");
    // The task text is escaped, not injected raw.
    expect(html).not.toContain('<script');
  });
});
