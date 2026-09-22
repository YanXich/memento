/**
 * Read-only git tools — the model navigates repo state through these instead
 * of guessing. Diff awareness is what lets a session report "what changed and
 * why" and propose a real commit message instead of "update files".
 */
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../types.ts";
import { truncate } from "../../util/text.ts";

const GIT_MISSING = "git is not available in this environment.";

function git(cwd: string, args: string[], maxOutput = 20_000): { out: string; err?: string } {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { out: truncate(out, maxOutput) };
  } catch (err) {
    const e = err as { code?: string | number; stderr?: string; stdout?: string };
    if (typeof e.code === "number") {
      // git exits non-zero for "no diff" (1) — that's a valid answer.
      return { out: truncate(String(e.stdout ?? ""), maxOutput), err: String(e.stderr ?? "").trim() };
    }
    return { out: "", err: GIT_MISSING };
  }
}

export const gitStatusTool: Tool = {
  name: "git_status",
  description:
    "Show the git working tree state: current branch, staged and unstaged changes (porcelain format). Read-only.",
  schema: z.object({}),
  async execute(_args, ctx) {
    const { out, err } = git(ctx.cwd, ["status", "--branch", "--porcelain=v1"]);
    if (err) return { output: err, isError: true };
    const lines = out.trim().split("\n").filter(Boolean);
    // Porcelain v1 prints only the `## branch` header when the tree is clean.
    const hasChanges = lines.some((l) => !l.startsWith("## "));
    return { output: hasChanges ? out.trim() : `${lines[0] ?? "no branch"} (clean working tree)` };
  },
};

export const gitDiffTool: Tool = {
  name: "git_diff",
  description:
    "Show uncommitted changes as a unified diff. Pass staged: true for staged changes, or a path to narrow to one file. Read-only.",
  schema: z.object({
    staged: z.boolean().optional().describe("Show staged (git add'ed) changes instead of unstaged"),
    path: z.string().optional().describe("Limit the diff to one path"),
  }),
  async execute(args: { staged?: boolean; path?: string }, ctx) {
    const a = ["diff", ...(args.staged ? ["--cached"] : []), "--unified=3", "--", ...(args.path ? [args.path] : [])];
    const { out, err } = git(ctx.cwd, a, 30_000);
    if (err) return { output: err, isError: true };
    return { output: out.trim() || "(no uncommitted changes)" };
  },
};

export const gitLogTool: Tool = {
  name: "git_log",
  description: "Show recent commit history (one line each). Read-only.",
  schema: z.object({
    n: z.number().int().min(1).max(50).optional().describe("How many commits (default 10)"),
  }),
  async execute(args: { n?: number }, ctx) {
    const { out, err } = git(ctx.cwd, ["log", "--oneline", "-n", String(args.n ?? 10)]);
    if (err) return { output: err, isError: true };
    return { output: out.trim() || "(no commits yet)" };
  },
};
