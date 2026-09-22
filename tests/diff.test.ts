/**
 * Phase 2 differentiation tests — repo map and apply_patch.
 *
 * Repo map: the deterministic symbol sketch must be complete enough to
 * navigate by, and must never leak file *contents* (only signatures).
 *
 * apply_patch: the all-or-nothing contract is the point — a failing hunk
 * must leave the file byte-for-byte untouched, and whitespace drift in the
 * model's copy-paste must not fail a unique match.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRepoMap } from "../src/kernel/repomap.ts";
import { applyPatchTool } from "../src/tools/builtin/files.ts";
import type { ToolContext } from "../src/tools/types.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-diff-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

const ctx = (): ToolContext => ({
  cwd: dir,
  progress: () => {},
  approve: async () => false,
});

describe("buildRepoMap", () => {
  it("lists files with key symbols and line numbers across languages", () => {
    write("src/main.ts", "export function run(): void {}\nexport class App {}\nconst x = 1;\n");
    write("src/util.py", "def helper():\n    pass\n\nclass Helper:\n    pass\n");
    write("README.md", "# hi\n");
    const map = buildRepoMap(dir);
    expect(map).toContain("src/main.ts");
    expect(map).toContain("1: export function run(): void {}");
    expect(map).toContain("2: export class App {}");
    expect(map).toContain("src/util.py");
    expect(map).toContain("def helper()");
    expect(map).toContain("class Helper:");
    expect(map).toContain("README.md");
  });

  it("ignores node_modules, dist, and .memento internals", () => {
    write("node_modules/pkg/index.js", "export function evil() {}\n");
    write("dist/bundle.js", "export function bundled() {}\n");
    write(".memento/memory/lessons.jsonl", '{"op":"add"}\n');
    write("src/ok.ts", "export function fine() {}\n");
    const map = buildRepoMap(dir);
    expect(map).not.toContain("node_modules");
    expect(map).not.toContain("dist");
    expect(map).not.toContain(".memento");
    expect(map).toContain("src/ok.ts");
  });

  it("emits signatures only — never file contents", () => {
    write("src/secret.ts", "export function f() {}\n// the password is hunter2\nconst PASSWORD = \"hunter2\";\n");
    const map = buildRepoMap(dir);
    expect(map).not.toContain("hunter2");
  });

  it("caps total output to the prompt budget", () => {
    let content = "";
    for (let i = 0; i < 300; i++) content += `export function fn${i}(): void {}\n`;
    write("src/big.ts", content);
    const map = buildRepoMap(dir, { maxSymbolsPerFile: 500, maxOutputChars: 1500 });
    expect(map.length).toBeLessThanOrEqual(1800);
    expect(map).toContain("truncated");
  });
});

describe("applyPatchTool", () => {
  it("applies multiple hunks in one call, back-to-front safely", async () => {
    write("a.txt", "hello\nworld\nfoo\nbar\n");
    const res = await applyPatchTool.execute(
      {
        path: "a.txt",
        hunks: [
          { old: "hello\nworld", new: "HELLO\nWORLD" },
          { old: "foo", new: "FOO" },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("HELLO\nWORLD\nFOO\nbar\n");
  });

  it("writes nothing when any hunk fails (all-or-nothing)", async () => {
    write("b.txt", "alpha\nbeta\ngamma\n");
    const before = fs.readFileSync(path.join(dir, "b.txt"), "utf8");
    const res = await applyPatchTool.execute(
      {
        path: "b.txt",
        hunks: [
          { old: "alpha", new: "ALPHA" },
          { old: "does-not-exist", new: "X" },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe(before);
  });

  it("reports non-unique matches instead of guessing", async () => {
    write("c.txt", "dup\ndup\n");
    const res = await applyPatchTool.execute({ path: "c.txt", hunks: [{ old: "dup", new: "DUP" }] }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("matches 2 times");
    expect(fs.readFileSync(path.join(dir, "c.txt"), "utf8")).toBe("dup\ndup\n");
  });

  it("matches with whitespace tolerance when the exact match misses", async () => {
    write("d.txt", "  indented line\n");
    const res = await applyPatchTool.execute(
      { path: "d.txt", hunks: [{ old: "indented line", new: "replaced" }] },
      ctx(),
    );
    expect(res.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "d.txt"), "utf8")).toBe("  replaced\n");
  });

  it("refuses overlapping hunks (order-dependent result)", async () => {
    write("e.txt", "common text here\n");
    const res = await applyPatchTool.execute(
      {
        path: "e.txt",
        hunks: [
          { old: "common text", new: "A" },
          { old: "text here", new: "B" },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(fs.readFileSync(path.join(dir, "e.txt"), "utf8")).toBe("common text here\n");
  });
});
