/**
 * MCP server tests — wire protocol and memory tools.
 *
 * The wire layer is exercised with injected streams (no real process), and
 * the tools are exercised against a real LessonStore on a temp dir, so the
 * append-to-disk contract of add_lesson is verified, not mocked.
 */
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveStdio } from "../src/mcp/stdio.ts";
import { memoryTools } from "../src/mcp/memory-server.ts";
import { LessonStore } from "../src/memory/store.ts";
import { readJsonl } from "../src/util/paths.ts";

let dir: string;
let store: LessonStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-mcp-"));
  store = LessonStore.load(dir);
});

afterEach(() => {
  rmWithRetry(dir);
});

interface Frame {
  jsonrpc: string;
  id: number | null;
  result?: Record<string, unknown> & { content?: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

async function runServer(
  frames: unknown[],
  opts: { readOnly?: boolean } = {},
): Promise<{ frames: Frame[]; code: number }> {
  // Raw strings bypass JSON.stringify so malformed frames can be injected.
  const input = Readable.from(frames.map((f) => (typeof f === "string" ? f : JSON.stringify(f)) + "\n"));
  const out: Frame[] = [];
  const output = { write: (chunk: string) => out.push(JSON.parse(chunk.trim()) as Frame) };
  const code = await serveStdio({
    name: "memento",
    version: "test",
    tools: memoryTools(store, { readOnly: Boolean(opts.readOnly) }),
    input,
    output,
    log: () => {},
  });
  return { frames: out, code };
}

const rpc = (id: number, method: string, params?: unknown): unknown => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
const notification = (method: string, params?: unknown): unknown => ({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });

function seedLessons(): void {
  store.add({
    text: "Tests run with `pnpm test:unit` and must stay green before pushing",
    kind: "constraint",
    evidence: "session a",
    sessionId: "seed-1",
  });
  store.add({
    text: "The api client retries 429s with exponential backoff",
    kind: "pattern",
    evidence: "session b",
    sessionId: "seed-2",
  });
}

describe("MCP wire protocol", () => {
  it("handshakes: initialize returns protocol version, capabilities, serverInfo", async () => {
    const { frames, code } = await runServer([rpc(1, "initialize", { clientInfo: { name: "claude", version: "2" } })]);
    expect(code).toBe(0);
    expect(frames).toHaveLength(1);
    const res = frames[0]!;
    expect(res.id).toBe(1);
    expect(res.result?.protocolVersion).toBe("2024-11-05");
    expect(res.result?.capabilities).toEqual({ tools: {} });
    expect(res.result?.serverInfo).toEqual({ name: "memento", version: "test" });
  });

  it("rejects tools/list before initialize", async () => {
    const { frames } = await runServer([rpc(2, "tools/list")]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.error?.code).toBe(-32600);
  });

  it("tools/list returns all three memory tools with JSON schemas", async () => {
    const { frames } = await runServer([rpc(1, "initialize"), rpc(2, "tools/list")]);
    const list = frames[1]!.result?.tools as { name: string; inputSchema: Record<string, unknown> }[];
    expect(list.map((t) => t.name)).toEqual(["search_lessons", "add_lesson", "memory_stats"]);
    expect(list.every((t) => t.inputSchema.type === "object")).toBe(true);
  });

  it("ignores notifications (no response frame)", async () => {
    const { frames } = await runServer([
      rpc(1, "initialize"),
      notification("notifications/initialized"),
      notification("notifications/cancelled", { requestId: 1 }),
      rpc(2, "ping"),
    ]);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.id).toBe(2);
  });

  it("answers a parse error with id null, code -32700", async () => {
    const { frames } = await runServer(["{ broken json\n"]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBeNull();
    expect(frames[0]!.error?.code).toBe(-32700);
  });

  it("reports unknown tools as -32602 and unknown methods as -32601", async () => {
    const { frames } = await runServer([
      rpc(1, "initialize"),
      rpc(2, "tools/call", { name: "rm_rf" }),
      rpc(3, "do/something"),
    ]);
    expect(frames[1]!.error?.code).toBe(-32602);
    expect(frames[2]!.error?.code).toBe(-32601);
  });
});

describe("MCP memory tools", () => {
  it("search_lessons ranks by relevance and confidence", async () => {
    seedLessons();
    store.reinforce(store.active().find((l) => l.kind === "pattern")!.id, "again", "seed-3");
    const { frames } = await runServer([
      rpc(1, "initialize"),
      rpc(2, "tools/call", { name: "search_lessons", arguments: { query: "api client retries" } }),
    ]);
    const text = frames[1]!.result!.content![0]!.text;
    expect(text).toContain("retries 429s");
    // The reinforced pattern lesson outranks the constraint lesson.
    expect(text.indexOf("retries")).toBeLessThan(text.indexOf("pnpm"));
  });

  it("search_lessons filters by kind and honors minConfidence", async () => {
    seedLessons();
    store.reinforce(store.active().find((l) => l.kind === "pattern")!.id, "again", "seed-3");
    const { frames } = await runServer([
      rpc(1, "initialize"),
      rpc(2, "tools/call", { name: "search_lessons", arguments: { query: "", kind: "constraint" } }),
      rpc(3, "tools/call", { name: "search_lessons", arguments: { query: "", minConfidence: 0.5 } }),
    ]);
    expect(frames[1]!.result!.content![0]!.text).toContain("pnpm");
    expect(frames[1]!.result!.content![0]!.text).not.toContain("retries");
    expect(frames[2]!.result!.content![0]!.text).toContain("retries");
    expect(frames[2]!.result!.content![0]!.text).not.toContain("pnpm");
  });

  it("add_lesson appends to the real lesson store at low confidence", async () => {
    const { frames } = await runServer([
      rpc(1, "initialize", { clientInfo: { name: "claude" } }),
      rpc(2, "tools/call", {
        name: "add_lesson",
        arguments: { text: "Deploy runs `pnpm release` from the repo root", kind: "pattern", evidence: "observed in CI" },
      }),
    ]);
    expect(frames[1]!.result!.isError).toBeUndefined();
    const records = readJsonl<{ op: string; lesson: { text: string; confidence: number; evidence: string[] } }>(
      path.join(dir, ".memento", "memory", "lessons.jsonl"),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.op).toBe("upsert");
    expect(records[0]!.lesson.text).toContain("pnpm release");
    expect(records[0]!.lesson.confidence).toBe(0.35);
    expect(records[0]!.lesson.evidence.join(" ")).toContain("claude");
  });

  it("rejects add_lesson in --read-only mode", async () => {
    const { frames } = await runServer(
      [
        rpc(1, "initialize"),
        rpc(2, "tools/call", { name: "add_lesson", arguments: { text: "something" } }),
      ],
      { readOnly: true },
    );
    expect(frames[1]!.result!.isError).toBe(true);
    expect(frames[1]!.result!.content![0]!.text).toContain("read-only");
    expect(fs.existsSync(path.join(dir, ".memento", "memory", "lessons.jsonl"))).toBe(false);
  });

  it("validates add_lesson input (empty text, bad kind falls back safely)", async () => {
    const { frames } = await runServer([
      rpc(1, "initialize"),
      rpc(2, "tools/call", { name: "add_lesson", arguments: { text: "   " } }),
      rpc(3, "tools/call", { name: "add_lesson", arguments: { text: "a real lesson", kind: "not-a-kind" } }),
    ]);
    expect(frames[1]!.result!.isError).toBe(true);
    // Unknown kind falls back to "discovery" instead of failing.
    expect(frames[2]!.result!.isError).toBeUndefined();
    const records = readJsonl<{ lesson: { kind: string } }>(path.join(dir, ".memento", "memory", "lessons.jsonl"));
    expect(records[0]!.lesson.kind).toBe("discovery");
  });

  it("memory_stats reports counts, kinds, and recent lessons", async () => {
    seedLessons();
    const { frames } = await runServer([rpc(1, "initialize"), rpc(2, "tools/call", { name: "memory_stats", arguments: {} })]);
    const text = frames[1]!.result!.content![0]!.text;
    expect(text).toContain("2 active lesson(s)");
    expect(text).toContain("constraint 1");
    expect(text).toContain("pattern 1");
    expect(text).toContain("Most recent:");
  });
});
