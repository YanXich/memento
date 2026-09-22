import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { reviewTask, parseFindings, buildSystemPrompt } from "../src/cli/commands/review.ts";
import { createWorkspace } from "../src/cli/workspace.ts";
import { LessonStore } from "../src/memory/store.ts";

let dir: string;
let out: string;
let err: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-review-"));
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", dir, "add", "a.ts"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function dirtyTree(): void {
  fs.appendFileSync(path.join(dir, "a.ts"), "export const b = 2;\n");
}

describe("memento review", () => {
  it("--dry --json emits structured findings from the deterministic provider", async () => {
    dirtyTree();
    const code = await reviewTask({ root: dir, dry: true, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.findings.length).toBe(2);
    expect(parsed.findings[0].file).toBe("src/auth/login.ts");
    expect(parsed.notes).toContain("dry run — deterministic demo output");
  });

  it("--dry text mode prints findings with severity colors and advisory footer", async () => {
    dirtyTree();
    const code = await reviewTask({ root: dir, dry: true });
    expect(code).toBe(0);
    expect(out).toContain("src/auth/login.ts");
    expect(out).toContain("memento review");
    expect(out).toContain("advisory");
  });

  it("reports nothing to review on a clean tree (exit 0)", async () => {
    const code = await reviewTask({ root: dir, dry: true });
    expect(code).toBe(0);
    expect(out).toContain("nothing to review");
  });

  it("reports nothing to review outside a git repo (exit 0)", async () => {
    const plain = fs.mkdtempSync(path.join(dir, "plain-"));
    const code = await reviewTask({ root: plain, dry: true });
    expect(code).toBe(0);
    expect(out).toContain("nothing to review");
  });

  it("--base reviews the diff against an older ref", async () => {
    dirtyTree();
    execFileSync("git", ["-C", dir, "add", "a.ts"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "second"]);
    fs.appendFileSync(path.join(dir, "a.ts"), "export const c = 3;\n");
    const code = await reviewTask({ root: dir, dry: true, json: true, base: "HEAD~1" });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.diffChars).toBeGreaterThan(0);
  });
});

describe("parseFindings", () => {
  it("parses clean JSON and sanitizes severity to warning|error|nit", () => {
    const r = parseFindings(
      JSON.stringify({
        findings: [
          { file: "x.ts", line: 3, severity: "critical", message: "m", suggestion: "s" },
          { file: "y.ts", severity: "error", message: "boom" },
          { file: "bad", line: "not-a-number", severity: "nit", message: "" },
        ],
        notes: ["n"],
      }),
    );
    expect(r.findings).toHaveLength(2); // the invalid one is dropped
    expect(r.findings[0]!.severity).toBe("warning"); // "critical" sanitized
    expect(r.findings[1]!.severity).toBe("error");
    expect(r.notes).toEqual(["n"]);
  });

  it("strips markdown fences", () => {
    const r = parseFindings('```json\n{"findings":[],"notes":[]}\n```');
    expect(r.findings).toEqual([]);
  });

  it("falls back to a raw note on invalid JSON instead of crashing", () => {
    const r = parseFindings("sorry, no json today");
    expect(r.findings).toEqual([]);
    expect(r.notes[0]).toContain("not valid JSON");
  });
});

describe("buildSystemPrompt", () => {
  it("recalls lessons and spec into the reviewer prompt", () => {
    const store = LessonStore.load(dir);
    store.add({ text: "rate limit must live in shared middleware", kind: "constraint", evidence: "test", sessionId: "test" });
    fs.mkdirSync(path.join(dir, ".memento", "spec", "features"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".memento", "spec", "features", "api.md"), "# API\n\n- login routes chain through middleware\n");
    const ws = createWorkspace(dir);
    const { system } = buildSystemPrompt(ws, "diff --git a/src/auth/login.ts\n+ inline rate limit");
    expect(system).toContain("middleware");
    expect(system).toContain("api.md");
  });

  it("notes when nothing was recalled", () => {
    const ws = createWorkspace(dir);
    const { notes } = buildSystemPrompt(ws, "unrelated diff content zzz");
    expect(notes.join(" ")).toContain("no lessons");
  });
});
