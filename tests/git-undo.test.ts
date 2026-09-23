/**
 * Phase 3 ecosystem tests — git tools and the undo snapshot chain.
 *
 * git tools: real `git init` repositories in temp dirs, so status/diff/log
 * outputs are verified against actual git behaviour, not mocks.
 *
 * undo: the snapshot contract — write/edit/apply_patch must record the
 * pre-write state, and `undoLatest` must restore it (or delete new files),
 * step by step, newest first.
 */
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitDiffTool, gitLogTool, gitStatusTool } from "../src/tools/builtin/git.ts";
import { applyPatchTool, editTool, writeTool } from "../src/tools/builtin/files.ts";
import { snapshotBeforeWrite, undoLatest } from "../src/tools/snapshot.ts";
import { workingDiff } from "../src/git/commit-hint.ts";
import type { ToolContext } from "../src/tools/types.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-git-"));
});

afterEach(() => {
  rmWithRetry(dir);
});

const ctx = (): ToolContext => ({ cwd: dir, progress: () => {}, approve: async () => true });

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true }).trim();
}

describe("git tools", () => {
  beforeEach(() => {
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
  });

  it("git_status shows branch and modified files", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
    git(["add", "."]);
    git(["commit", "-qm", "initial"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "v2\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "new\n");

    const res = await gitStatusTool.execute({}, ctx());
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("M a.txt");
    expect(res.output).toContain("?? b.txt");
  });

  it("git_status reports a clean tree", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
    git(["add", "."]);
    git(["commit", "-qm", "initial"]);
    const res = await gitStatusTool.execute({}, ctx());
    expect(res.output).toContain("clean working tree");
  });

  it("git_diff shows unstaged changes, staged on demand", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
    git(["add", "."]);
    git(["commit", "-qm", "initial"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "v2\n");

    const unstaged = await gitDiffTool.execute({}, ctx());
    expect(unstaged.output).toContain("+v2");

    git(["add", "."]);
    const staged = await gitDiffTool.execute({ staged: true }, ctx());
    expect(staged.output).toContain("+v2");
  });

  it("git_log lists commits after changes", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
    git(["add", "."]);
    git(["commit", "-qm", "first"]);
    git(["commit", "--allow-empty", "-qm", "second"]);
    const res = await gitLogTool.execute({ n: 5 }, ctx());
    expect(res.output).toContain("second");
    expect(res.output).toContain("first");
  });

  it("reports an error when git is unavailable (no repo)", async () => {
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    const res = await gitStatusTool.execute({}, ctx());
    expect(res.isError).toBe(true);
  });
});

describe("undo snapshot chain", () => {
  it("write records the previous content; undo restores it", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "before\n");
    await writeTool.execute({ path: "a.txt", content: "after\n" }, ctx());
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("after\n");

    const result = undoLatest(dir);
    expect("restored" in result).toBe(true);
    if ("restored" in result) expect(result.restored).toEqual(["a.txt"]);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("before\n");
  });

  it("undo deletes files the agent created", async () => {
    await writeTool.execute({ path: "new.txt", content: "created by agent\n" }, ctx());
    expect(fs.existsSync(path.join(dir, "new.txt"))).toBe(true);

    const result = undoLatest(dir);
    if ("removed" in result) expect(result.removed).toEqual(["new.txt"]);
    expect(fs.existsSync(path.join(dir, "new.txt"))).toBe(false);
  });

  it("undo restores steps one at a time, newest first", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v0\n");
    await writeTool.execute({ path: "a.txt", content: "v1\n" }, ctx());
    await writeTool.execute({ path: "a.txt", content: "v2\n" }, ctx());
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("v2\n");

    undoLatest(dir);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("v1\n");
    undoLatest(dir);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("v0\n");
    const done = undoLatest(dir);
    expect("error" in done).toBe(true);
  });

  it("edit and apply_patch also snapshot", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "alpha beta\n");
    await editTool.execute({ path: "a.txt", old_string: "alpha", new_string: "omega" }, ctx());
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("omega beta\n");
    undoLatest(dir);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("alpha beta\n");

    fs.writeFileSync(path.join(dir, "b.txt"), "one\ntwo\nthree\n");
    await applyPatchTool.execute(
      { path: "b.txt", hunks: [{ old: "two", new: "TWO" }] },
      ctx(),
    );
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    undoLatest(dir);
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("prunes old batches to a bounded count", async () => {
    for (let i = 0; i < 25; i++) {
      snapshotBeforeWrite(dir, `f${i}.txt`);
    }
    const batches = fs.readdirSync(path.join(dir, ".memento", "undo"));
    expect(batches.length).toBeLessThanOrEqual(20);
  });
});

describe("commit hint (working diff)", () => {
  function initRepo(): void {
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(dir, ".gitignore"), ".memento/\n");
    git(["add", "."]);
    git(["commit", "-qm", "baseline"]);
  }

  it("includes untracked files the agent created", () => {
    initRepo();
    fs.writeFileSync(path.join(dir, "hello.txt"), "hello from memento\n");
    const diff = workingDiff(dir);
    expect(diff).not.toBeNull();
    expect(diff).toContain("hello.txt");
    expect(diff).toContain("+hello from memento");
    expect(diff).toContain("new file");
  });

  it("includes modified tracked files", () => {
    initRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
    git(["add", "."]);
    git(["commit", "-qm", "add a"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "v2\n");
    const diff = workingDiff(dir);
    expect(diff).toContain("+v2");
  });

  it("returns null on a clean tree", () => {
    initRepo();
    expect(workingDiff(dir)).toBeNull();
  });

  it("returns null outside a git repo", () => {
    expect(workingDiff(dir)).toBeNull();
  });

  it("treats binary untracked files as opaque, not text", () => {
    initRepo();
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const diff = workingDiff(dir);
    expect(diff).toContain("blob.bin");
    expect(diff).toContain("binary file");
  });
});
