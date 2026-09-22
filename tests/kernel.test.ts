/**
 * Kernel tests — the loop's hard guarantees.
 *
 * These test the rules that make the agent safe, not the happy path:
 * truncation never executes tools, denials stop side effects, and the session
 * log always contains exactly what the model saw.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runLoop } from "../src/kernel/loop.ts";
import { SessionLog, loadSession } from "../src/kernel/session.ts";
import { EventBus } from "../src/kernel/events.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { registerBuiltins } from "../src/tools/builtin/index.ts";
import { MOCK_MODEL, createMockProvider } from "./support/mock-provider.ts";
import type { Message } from "../src/llm/types.ts";
import { appendJsonl, readJsonl } from "../src/util/paths.ts";

let dir: string;
let sessionDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-kernel-"));
  sessionDir = path.join(dir, "sessions");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newSession(): SessionLog {
  return SessionLog.create(sessionDir, {
    cwd: dir,
    model: MOCK_MODEL.id,
    provider: "mock",
    task: "test task",
    mementoVersion: "test",
  });
}

function userMessage(text: string): Message {
  return { id: "m_user", role: "user", content: [{ type: "text", text }], ts: Date.now() };
}

describe("runLoop", () => {
  it("executes a tool call, writes the file, and logs everything", async () => {
    const provider = createMockProvider([
      { toolCalls: [{ name: "write", args: { path: "hello.txt", content: "from the model" } }] },
      { text: "Done — wrote hello.txt." },
    ]);
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const session = newSession();
    const bus = new EventBus();
    const toolCtxCwd = process.cwd();
    process.chdir(dir); // tools resolve against process.cwd()

    try {
      const result = await runLoop(
        {
          provider,
          model: MOCK_MODEL,
          system: "test",
          registry,
          session,
          bus,
          approve: async () => true,
        },
        [userMessage("create hello.txt")],
      );

      expect(result.status).toBe("done");
      expect(result.turns).toBe(2);
      expect(fs.readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe("from the model");

      // The session log reconstructs the exact conversation.
      const loaded = loadSession(session.file);
      expect(loaded.status).toBe("done");
      const roles = loaded.messages.map((m) => m.role);
      expect(roles).toEqual(["assistant", "tool", "assistant"]);
      const toolMsg = loaded.messages[1]!;
      expect(toolMsg.content[0]).toMatchObject({ type: "toolResult", content: expect.stringContaining("hello.txt") });
    } finally {
      process.chdir(toolCtxCwd);
      session.close();
    }
  });

  it("never executes a tool batch when the response was truncated (length)", async () => {
    const provider = createMockProvider([
      {
        toolCalls: [{ name: "write", args: { path: "danger.txt", content: "should never exist" } }],
        stopReason: "length",
      },
      { text: "Understood, I will retry." },
    ]);
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const session = newSession();
    const bus = new EventBus();
    const previousCwd = process.cwd();
    process.chdir(dir);

    try {
      const result = await runLoop(
        { provider, model: MOCK_MODEL, system: "test", registry, session, bus, approve: async () => true },
        [userMessage("create danger.txt")],
      );

      expect(result.status).toBe("done");
      expect(fs.existsSync(path.join(dir, "danger.txt"))).toBe(false);

      const loaded = loadSession(session.file);
      const toolMsg = loaded.messages.find((m) => m.role === "tool")!;
      expect(toolMsg.content[0]).toMatchObject({ isError: true, content: expect.stringContaining("NOT executed") });
    } finally {
      process.chdir(previousCwd);
      session.close();
    }
  });

  it("denies mutating tools when approval is withheld", async () => {
    const provider = createMockProvider([
      { toolCalls: [{ name: "write", args: { path: "denied.txt", content: "nope" } }] },
      { text: "I could not write the file." },
    ]);
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const session = newSession();
    const bus = new EventBus();
    const previousCwd = process.cwd();
    process.chdir(dir);

    try {
      const result = await runLoop(
        { provider, model: MOCK_MODEL, system: "test", registry, session, bus, approve: async () => false },
        [userMessage("create denied.txt")],
      );

      expect(result.status).toBe("done");
      expect(fs.existsSync(path.join(dir, "denied.txt"))).toBe(false);
      const loaded = loadSession(session.file);
      const toolMsg = loaded.messages.find((m) => m.role === "tool")!;
      expect(toolMsg.content[0]).toMatchObject({ isError: true, content: expect.stringContaining("Denied") });
    } finally {
      process.chdir(previousCwd);
      session.close();
    }
  });

  it("stops at maxTurns and records the result", async () => {
    // Every turn calls a tool → the loop can never finish on its own.
    const provider = createMockProvider([
      { toolCalls: [{ name: "ls", args: {} }] },
      { toolCalls: [{ name: "ls", args: {} }] },
    ]);
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const session = newSession();
    const bus = new EventBus();
    const previousCwd = process.cwd();
    process.chdir(dir);

    try {
      const result = await runLoop(
        { provider, model: MOCK_MODEL, system: "test", registry, session, bus, maxTurns: 2, approve: async () => true },
        [userMessage("loop forever")],
      );
      expect(result.status).toBe("max_turns");
      expect(result.turns).toBe(2);
      const loaded = loadSession(session.file);
      expect(loaded.status).toBe("max_turns");
    } finally {
      process.chdir(previousCwd);
      session.close();
    }
  });

  it("validates tool arguments before execution and reports schema errors", async () => {
    const provider = createMockProvider([
      { toolCalls: [{ name: "read", args: { path: 12345 } }] }, // path must be a string
      { text: "fixed" },
    ]);
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const session = newSession();
    const bus = new EventBus();

    try {
      const result = await runLoop(
        { provider, model: MOCK_MODEL, system: "test", registry, session, bus, approve: async () => true },
        [userMessage("read with bad args")],
      );
      expect(result.status).toBe("done");
      const loaded = loadSession(session.file);
      const toolMsg = loaded.messages.find((m) => m.role === "tool")!;
      expect(toolMsg.content[0]).toMatchObject({ isError: true, content: expect.stringContaining("Invalid arguments") });
    } finally {
      session.close();
    }
  });

  it("runs consecutive read-only calls in parallel while mutating calls stay strictly ordered", async () => {
    // Batch: [readA, readB, write, readC]. readA/readB overlap in time;
    // write must not start until both finish; readC must not start until write finishes.
    const timeline: { name: string; at: "start" | "end"; t: number }[] = [];
    const timed = (name: string, mutating: boolean) => ({
      name,
      description: "timed",
      mutating,
      schema: z.object({}),
      requiresApproval: mutating ? () => true : undefined,
      execute: async () => {
        timeline.push({ name, at: "start", t: Date.now() });
        await new Promise((r) => setTimeout(r, 40));
        timeline.push({ name, at: "end", t: Date.now() });
        return { output: name };
      },
    });
    const registry = new ToolRegistry();
    registry.register(timed("readA", false));
    registry.register(timed("readB", false));
    registry.register(timed("write", true));
    registry.register(timed("readC", false));

    const provider = createMockProvider([
      {
        toolCalls: [
          { name: "readA", args: {} },
          { name: "readB", args: {} },
          { name: "write", args: {} },
          { name: "readC", args: {} },
        ],
      },
      { text: "done" },
    ]);
    const session = newSession();
    const result = await runLoop(
      { provider, model: MOCK_MODEL, system: "test", registry, session, bus: new EventBus(), approve: async () => true },
      [userMessage("timed batch")],
    );
    expect(result.status).toBe("done");

    const at = (name: string, kind: "start" | "end") => timeline.find((e) => e.name === name && e.at === kind)!.t;
    // readA and readB overlap
    expect(Math.max(at("readA", "start"), at("readB", "start"))).toBeLessThan(Math.min(at("readA", "end"), at("readB", "end")));
    // write is strictly after both reads, readC strictly after write
    expect(at("write", "start")).toBeGreaterThanOrEqual(at("readA", "end"));
    expect(at("write", "start")).toBeGreaterThanOrEqual(at("readB", "end"));
    expect(at("readC", "start")).toBeGreaterThanOrEqual(at("write", "end"));
    session.close();
  });

  it("retries exactly once when a retryable provider error arrives before any content", async () => {
    const provider = createMockProvider([
      { error: { error: "429 rate limited", retryable: true } },
      { text: "recovered", stopReason: "end" },
    ]);
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const session = newSession();
    const result = await runLoop(
      { provider, model: MOCK_MODEL, system: "test", registry, session, bus: new EventBus() },
      [userMessage("retry me")],
    );
    expect(result.status).toBe("done");
    expect(provider.requests.length).toBe(2);
    session.close();
  });

  it("does not retry a non-retryable provider error", async () => {
    const provider = createMockProvider([
      { error: { error: "invalid api key", retryable: false } },
      { text: "should never run", stopReason: "end" },
    ]);
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const session = newSession();
    const result = await runLoop(
      { provider, model: MOCK_MODEL, system: "test", registry, session, bus: new EventBus() },
      [userMessage("bad key")],
    );
    expect(result.status).toBe("error");
    expect(provider.requests.length).toBe(1);
    session.close();
  });
});

describe("appendJsonl (concurrent append safety)", () => {
  it("never loses or corrupts lines across concurrent writers", async () => {
    const file = path.join(dir, "shared.jsonl");
    const lines = 300;
    await Promise.all(
      Array.from({ length: lines }, (_, i) => appendJsonl(file, { i, line: `line-${i}` })),
    );
    const records = readJsonl<{ i: number; line: string }>(file);
    expect(records).toHaveLength(lines);
    const ids = new Set(records.map((r) => r.i));
    expect(ids.size).toBe(lines);
    for (const r of records) expect(r.line).toBe(`line-${r.i}`);
  });
});
