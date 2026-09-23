/**
 * Concurrency & performance regression tests (audit round 5).
 *
 * Each test pins a real flaw found in review and fixed:
 *  - token estimation rescanning the conversation with a per-character
 *    regex (now a single code-point pass over the shared estimator)
 *  - surrogate pairs double-counted by text.length in the estimator
 *  - lock liveness mistaking a recycled pid for a live owner (now a
 *    24h staleness bound makes crashed-process locks stealable)
 *  - lockIsFresh for observers: a leftover lock must not read as "running"
 *  - config array fields (autoApprove / providers / mcpServers) replaced
 *    wholesale by the project config instead of merging
 *  - MCP bridge output capping helpers keep the informative tail on errors
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens, truncateTail } from "../src/util/text.ts";
import { lockIsFresh, acquireFileLock, releaseFileLock, STALE_LOCK_MS } from "../src/util/lock.ts";
import { loadConfig } from "../src/config.ts";

let dir: string | undefined;
let homes: string[] = [];

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  dir = undefined;
  homes = [];
  vi.restoreAllMocks();
});

describe("token estimation (C9)", () => {
  it("counts the full CJK range, including Ext A and compatibility ideographs", () => {
    // U+4E00 (unified), U+3431 (Ext A), U+F900 (compat) are all CJK.
    const text = "\u4e00\u3431\uf900";
    expect(estimateTokens(text)).toBe(Math.ceil((3 * 10) / 16));
    // Plain latin stays at 4 chars/token.
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("does not double-count surrogate pairs", () => {
    // 100 emoji = 100 code points but 200 UTF-16 units.
    const emoji = "👋".repeat(100);
    expect(estimateTokens(emoji)).toBe(Math.ceil(100 / 4));
    const mixed = estimateTokens("中👋文");
    expect(mixed).toBe(Math.ceil(2 / 4 + (2 * 10) / 16));
  });
});

describe("lock liveness (C10)", () => {
  it("lockIsFresh: no file, dead pid, and stale locks are all not fresh", () => {
    const lockFile = path.join(dir ?? (dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-lock-"))), "x.lock");
    expect(lockIsFresh(lockFile)).toBe(false); // missing
    // A pid that cannot exist — dead.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 99_999_999, startedAt: Date.now() }));
    expect(lockIsFresh(lockFile)).toBe(false);
    // Our own pid but held for longer than any plausible session — recycled.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() - STALE_LOCK_MS - 1000 }));
    expect(lockIsFresh(lockFile)).toBe(false);
  });

  it("lockIsFresh: our own live pid is fresh", () => {
    const lockFile = path.join(dir ?? (dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-lock-"))), "y.lock");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    expect(lockIsFresh(lockFile)).toBe(true);
  });

  it("steals a lock held by a recycled pid (alive but older than the bound)", () => {
    const file = path.join(dir ?? (dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-lock-"))), "z.jsonl");
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, startedAt: Date.now() - STALE_LOCK_MS - 5000 }));
    acquireFileLock(file); // must steal, not throw "locked by another memento process"
    expect(JSON.parse(fs.readFileSync(`${file}.lock`, "utf8"))).toMatchObject({ pid: process.pid });
    releaseFileLock(file, process.pid);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});

describe("config array merging (M14)", () => {
  function setup(user: unknown, project: unknown): { root: string; home: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memento-cfg-root-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memento-cfg-home-"));
    fs.mkdirSync(path.join(root, ".memento"), { recursive: true });
    fs.mkdirSync(path.join(home, ".memento"), { recursive: true });
    fs.writeFileSync(path.join(home, ".memento", "config.json"), JSON.stringify(user));
    fs.writeFileSync(path.join(root, ".memento", "config.json"), JSON.stringify(project));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    dir = root;
    homes.push(home);
    return { root, home };
  }

  it("unions autoApprove with dedup instead of replacing", () => {
    setup({ autoApprove: ["bash", "read"] }, { autoApprove: ["read", "grep"] });
    const { config } = loadConfig(dir!);
    expect(config.autoApprove).toEqual(["bash", "read", "grep"]);
  });

  it("merges providers by id, project entry winning per id", () => {
    setup(
      { providers: [{ id: "p1", baseUrl: "http://user", label: "u" }, { id: "p2", baseUrl: "http://user2" }] },
      { providers: [{ id: "p1", baseUrl: "http://project" }] },
    );
    const { config } = loadConfig(dir!);
    expect(config.providers).toHaveLength(2);
    expect(config.providers!.find((p) => p.id === "p1")!.baseUrl).toBe("http://project");
    expect(config.providers!.find((p) => p.id === "p2")).toBeTruthy();
  });

  it("merges mcpServers by name, project entry winning per name", () => {
    setup(
      { mcpServers: [{ name: "s1", command: "user-cmd" }, { name: "s2", command: "keep" }] },
      { mcpServers: [{ name: "s1", command: "project-cmd" }] },
    );
    const { config } = loadConfig(dir!);
    expect(config.mcpServers).toHaveLength(2);
    expect(config.mcpServers!.find((s) => s.name === "s1")!.command).toBe("project-cmd");
    expect(config.mcpServers!.find((s) => s.name === "s2")!.command).toBe("keep");
  });

  it("still lets project scalars win", () => {
    setup({ temperature: 0.2, model: "user-model" }, { temperature: 0.9 });
    const { config } = loadConfig(dir!);
    expect(config.temperature).toBe(0.9);
    expect(config.model).toBe("user-model");
  });
});

describe("MCP output capping helpers (M9)", () => {
  it("truncateTail keeps the end of error output", () => {
    const text = "a".repeat(100) + "CRASH";
    const out = truncateTail(text, 10);
    expect(out).toContain("CRASH");
    expect(out.length).toBeLessThan(text.length);
  });

  it("estimateTokens degrades gracefully on empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
