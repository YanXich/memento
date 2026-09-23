/**
 * `memento chat` — interactive REPL over the same loop as `run`.
 *
 * Driven end-to-end against the fake OpenAI-compatible wire server: a piped
 * input stream feeds the REPL two lines ("write a hello file", "/exit"), the
 * agent answers with a tool call that really writes a file, the second
 * exchange completes, and the whole conversation lands in one session log
 * with a reflection pass at exit.
 */
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasToolResult, startFakeOpenAi, systemText } from "./support/fake-openai.ts";
import type { FakeServer } from "./support/fake-openai.ts";
import { chatTask } from "../src/cli/commands/chat.ts";
import { loadSession, listSessions } from "../src/kernel/session.ts";

let dir: string;
let server: FakeServer | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-chat-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await server.close();
  server = null;
  rmWithRetry(dir);
});

async function setup(): Promise<string> {
  server = await startFakeOpenAi([
    // Reflection pass at exit — routed by its own system prompt first: it also
    // carries tool results in context, so it must win over the wrap-up rule.
    {
      match: (b) => systemText(b).includes("reflection engine"),
      text: '{"observations":[{"text":"chat writes hello files in one tool call","kind":"discovery","evidence":"chat test","relation":"new"}],"specSuggestions":[],"summary":"chat reflect"}',
    },
    // First call: no tool result in context → propose the write.
    { match: (b) => !hasToolResult(b), toolCalls: [{ name: "write", args: { path: "hello.txt", content: "hello from chat\n" } }] },
    // Tool result in context → wrap up. Fallback rule — must stay last.
    { match: () => true, text: "Wrote hello.txt." },
  ]);
  fs.mkdirSync(path.join(dir, ".memento"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".memento/config.json"),
    JSON.stringify({
      provider: "fake",
      model: "fake-1",
      autoApprove: ["write", "edit"],
      providers: [{ id: "fake", type: "openai-compat", baseUrl: server.url, apiKeyEnv: "FAKE_KEY" }],
    }),
  );
  process.env.FAKE_KEY = "k";
  return server.url;
}

function drive(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + "\n"));
}

describe("memento chat", () => {
  it("runs one exchange end to end: tool executes, session logs, reflection distils", async () => {
    await setup();
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });

    const code = await chatTask({ root: dir, yes: true, input: drive(["write a hello file", "/exit"]) });
    expect(code).toBe(0);

    // The tool really executed.
    expect(fs.readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe("hello from chat\n");

    // One session, logged faithfully: user message + assistant + tool result.
    const sessions = listSessions(path.join(dir, ".memento", "sessions"));
    expect(sessions).toHaveLength(1);
    const loaded = loadSession(sessions[0]!.file);
    expect(loaded.header.task).toBe("interactive chat");
    expect(loaded.messages.some((m) => m.role === "tool")).toBe(true);
    expect(loaded.messages.filter((m) => m.role === "user").length).toBeGreaterThanOrEqual(1);

    // The exit reflection distilled the conversation into a lesson.
    const lessons = fs
      .readFileSync(path.join(dir, ".memento", "memory", "lessons.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { op: string });
    expect(lessons.length).toBeGreaterThanOrEqual(1);
    expect(lessons.some((l) => l.op === "upsert")).toBe(true);

    // The header carries the session id so the user can resume.
    expect(writes.join("")).toContain("session ");
  });

  it("handles REPL commands without touching the model", async () => {
    await setup();
    const code = await chatTask({ root: dir, yes: true, input: drive(["/help", "/memory", "/nope", "/exit"]) });
    expect(code).toBe(0);

    // No exchange was dispatched: only the header line exists in the log.
    const sessions = listSessions(path.join(dir, ".memento", "sessions"));
    const loaded = loadSession(sessions[0]!.file);
    expect(loaded.messages).toHaveLength(0);
  });

  it("continues an existing session when --session is passed", async () => {
    await setup();
    const first = await chatTask({ root: dir, yes: true, input: drive(["write a hello file", "/exit"]) });
    expect(first).toBe(0);
    const sessions = listSessions(path.join(dir, ".memento", "sessions"));
    const id = sessions[0]!.header.sessionId;

    const again = await chatTask({ root: dir, yes: true, session: id, input: drive(["ask what you wrote", "/exit"]) });
    expect(again).toBe(0);
    // Same file, not a second one — the conversation continued.
    expect(listSessions(path.join(dir, ".memento", "sessions"))).toHaveLength(1);
    const loaded = loadSession(sessions[0]!.file);
    expect(loaded.messages.filter((m) => m.role === "user").length).toBeGreaterThanOrEqual(2);
  });
});
