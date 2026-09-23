/**
 * Resume tests — the session log is the single source of truth, so resuming
 * must replay the exact transcript and continue into the SAME file.
 */
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumeTask } from "../src/cli/commands/resume.ts";
import { SessionLog, loadSession } from "../src/kernel/session.ts";
import { messageId } from "../src/util/ids.ts";
import { startFakeOpenAi } from "./support/fake-openai.ts";
import type { FakeServer } from "./support/fake-openai.ts";

let dir: string;
let server: FakeServer;
const KEY_ENV = "MEMENTO_TEST_KEY";
const savedKey = process.env[KEY_ENV];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-resume-"));
  process.env[KEY_ENV] = "test-key";
  server = await startFakeOpenAi([
    {
      match: () => true,
      text: "Continuing from where the previous run stopped — the remaining work is done.",
    },
  ]);
  fs.mkdirSync(path.join(dir, ".memento"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".memento", "config.json"),
    JSON.stringify({
      provider: "fake",
      model: "fake-1",
      autoApprove: ["write", "edit"],
      providers: [
        {
          id: "fake",
          type: "openai-compat",
          baseUrl: server.url,
          apiKeyEnv: KEY_ENV,
          models: [{ id: "fake-1", contextWindow: 32000, maxOutput: 2000, supportsTools: true }],
        },
      ],
    }),
    "utf8",
  );
});

afterEach(async () => {
  await server.close();
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  rmWithRetry(dir);
});

function seedSession(task: string): { id: string; file: string } {
  const sessionsDir = path.join(dir, ".memento", "sessions");
  const log = SessionLog.create(sessionsDir, {
    cwd: dir,
    model: "fake-1",
    provider: "fake",
    task,
    mementoVersion: "0.1.0",
  });
  log.appendMessage({
    id: messageId(),
    role: "user",
    content: [{ type: "text", text: task }],
    ts: Date.now(),
    source: "user",
  });
  log.appendMessage({
    id: messageId(),
    role: "assistant",
    content: [{ type: "text", text: "I read the file but the session was cut off mid-edit." }],
    ts: Date.now(),
    stopReason: "end",
    source: "model",
  });
  log.appendResult("max_turns", 2);
  log.close();
  return { id: log.header.sessionId, file: log.file };
}

describe("memento resume", () => {
  it("continues an interrupted session into the same log", async () => {
    const seeded = seedSession("localize the greeting");
    const before = loadSession(seeded.file);

    const code = await resumeTask({
      session: seeded.id,
      root: dir,
      yes: true,
      reflect: false,
      verify: false,
      commitHint: false,
    });
    expect(code).toBe(0);

    const after = loadSession(seeded.file);
    // Original transcript intact + resume message + one new assistant turn.
    expect(after.messages.length).toBe(before.messages.length + 2);
    expect(
      after.messages.some((m) => {
        if (m.role !== "user" || m.source !== "system") return false;
        const first = m.content[0];
        return first?.type === "text" && /Session resumed/.test(first.text);
      }),
    ).toBe(true);
    // The last result entry now says done — results stack, show tells the story.
    expect(after.status).toBe("done");
    // The model actually saw the full original transcript: the fake server
    // received a request whose messages include the original user task.
    const saw = server.requests.some((r) => r.messages.some((m) => m.role === "user" && (m.content ?? "").includes("localize the greeting")));
    expect(saw).toBe(true);
  });

  it("matches a session by unique prefix", async () => {
    const seeded = seedSession("prefix matching task");
    const code = await resumeTask({
      session: seeded.id.slice(0, 8),
      root: dir,
      yes: true,
      reflect: false,
      verify: false,
      commitHint: false,
    });
    expect(code).toBe(0);
  });

  it("fails cleanly when the session does not exist", async () => {
    const code = await resumeTask({ session: "no_such_session", root: dir, yes: true });
    expect(code).toBe(1);
  });
});
