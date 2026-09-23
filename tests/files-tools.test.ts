/**
 * Audit round 2 regression tests — tools/files correctness.
 *
 * Each test pins a review finding from the files/paths/guard/subagent audit:
 *  A1 loose edit matching must never cross newlines,
 *  A2 grep rejects catastrophic-backtracking patterns,
 *  A3 grep/glob ignore `.memento`/`.demo` (the agent's own state),
 *  A4 guardWritePath covers secret-file variants,
 *  A5 read refuses binary files,
 *  A6 subagent surfaces session-log failures instead of throwing.
 */
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatchTool, globTool, grepTool, readTool } from "../src/tools/builtin/files.ts";
import { subagentTool } from "../src/tools/builtin/subagent.ts";
import { guardWritePath } from "../src/tools/guard.ts";
import type { ToolContext } from "../src/tools/types.ts";
import type { LlmProvider, ModelInfo } from "../src/llm/types.ts";

let dir: string;

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return { cwd: dir, progress: () => {}, approve: async () => false, ...extra };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-files-"));
});

afterEach(() => {
  rmWithRetry(dir);
});

describe("read (A5 binary detection)", () => {
  it("refuses binary files with NUL bytes instead of dumping garbage", async () => {
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
    const res = await readTool.execute({ path: "blob.bin" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Binary");
  });

  it("still reads normal text files", async () => {
    fs.writeFileSync(path.join(dir, "ok.txt"), "line one\nline two\n");
    const res = await readTool.execute({ path: "ok.txt" }, ctx());
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("line one");
  });
});

describe("grep (A2 ReDoS guard)", () => {
  it("rejects nested-quantifier patterns that can hang the search", async () => {
    fs.writeFileSync(path.join(dir, "f.ts"), "const a = 'aaaa';\n");
    for (const p of ["(a+)+$", "(a|b)*x", "(.*)*"]) {
      const res = await grepTool.execute({ pattern: p }, ctx());
      expect(res.isError, `pattern ${p}`).toBe(true);
      expect(res.output).toContain("Pattern rejected");
    }
  });

  it("rejects oversized patterns", async () => {
    const res = await grepTool.execute({ pattern: "x".repeat(2001) }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("too long");
  });

  it("still accepts normal patterns", async () => {
    fs.writeFileSync(path.join(dir, "f.ts"), "TODO fix me\nok\n");
    const res = await grepTool.execute({ pattern: "TODO|FIXME" }, ctx());
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("TODO fix me");
  });
});

describe("grep/glob ignore agent state (A3)", () => {
  it("grep skips .memento and .demo but finds real sources", async () => {
    fs.mkdirSync(path.join(dir, ".memento", "sessions"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".demo", "run1"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".memento", "sessions", "s.jsonl"), '{"text":"LEAK_TOKEN_9981"}\n');
    fs.writeFileSync(path.join(dir, ".demo", "run1", "sandbox.ts"), "const t = 'LEAK_TOKEN_9981';\n");
    fs.writeFileSync(path.join(dir, "app.ts"), "export const token = 'LEAK_TOKEN_9981';\n");
    const res = await grepTool.execute({ pattern: "LEAK_TOKEN_9981" }, ctx());
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("app.ts");
    expect(res.output).not.toContain(".memento");
    expect(res.output).not.toContain(".demo");
  });

  it("glob skips .memento too", async () => {
    fs.mkdirSync(path.join(dir, ".memento"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".memento", "undo.json"), "{}");
    fs.writeFileSync(path.join(dir, "real.ts"), "x");
    const res = await globTool.execute({ pattern: "**/*" }, ctx());
    expect(res.output).toContain("real.ts");
    expect(res.output).not.toContain(".memento");
  });
});

describe("apply_patch loose matching (A1)", () => {
  it("never crosses newlines: a one-line needle cannot swallow a line break", async () => {
    // The words are on two lines; a `\s`-based loose match would wrongly
    // swallow the newline and replace across the line boundary.
    fs.writeFileSync(path.join(dir, "x.txt"), "alpha\nbeta\n");
    const res = await applyPatchTool.execute(
      { path: "x.txt", hunks: [{ old: "alpha beta", new: "REPLACED" }] },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(fs.readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("alpha\nbeta\n");
  });

  it("still tolerates in-line spaces and tabs", async () => {
    fs.writeFileSync(path.join(dir, "y.txt"), "key\t\tvalue\n");
    const res = await applyPatchTool.execute(
      { path: "y.txt", hunks: [{ old: "key value", new: "done" }] },
      ctx(),
    );
    expect(res.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "y.txt"), "utf8")).toBe("done\n");
  });
});

describe("guardWritePath secrets (A4)", () => {
  it("blocks secret-file variants beyond the canonical list", () => {
    for (const name of [
      ".env", ".env.staging", ".env.ci.local", "server.key", "cert.pem",
      "id_rsa.pub", "id_ed25519", "credentials.json", ".npmrc", ".pypirc",
    ]) {
      const verdict = guardWritePath(dir, path.join(dir, name));
      expect(verdict.allowed, name).toBe(false);
    }
  });

  it("still allows ordinary source files and lockfiles", () => {
    for (const name of ["src/app.ts", "package.json", "package-lock.json", "README.md", "env.ts"]) {
      const verdict = guardWritePath(dir, path.join(dir, name));
      expect(verdict.allowed, name).toBe(true);
    }
  });
});

describe("subagent startup failure (A6)", () => {
  it("returns a clean tool error when the session log cannot be created", async () => {
    // `.memento` is a FILE here, so SessionLog.create must fail (ENOTDIR).
    fs.writeFileSync(path.join(dir, ".memento"), "not a directory");
    const model: ModelInfo = { id: "fake-model", contextWindow: 8000, maxOutput: 1024, supportsTools: true };
    const provider = { id: "stub", label: "stub", models: [model] } as unknown as LlmProvider;
    const res = await subagentTool.execute({ purpose: "probe", question: "anything" }, ctx({ llm: { provider, model } }));
    expect(res.isError).toBe(true);
    expect(res.output).toContain("subagent failed to start");
  });
});
