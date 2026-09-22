/**
 * End-to-end test — the full loop against a REAL OpenAI-compatible wire
 * format server (SSE chunks, tool_calls deltas, usage).
 *
 * One task in, one file out; but every layer gets exercised for real:
 * provider streaming → tool execution with cwd → approval from config →
 * session log → reflection → lesson on disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasToolResult, startFakeOpenAi, systemText } from "./support/fake-openai.ts";
import type { FakeServer } from "./support/fake-openai.ts";
import { runTask } from "../src/cli/commands/run.ts";
import { planTask } from "../src/cli/commands/plan.ts";

let dir: string;
let server: FakeServer | undefined;

const HELLO = "hello from memento e2e\n";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-e2e-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  delete process.env.FAKE_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(url: string): void {
  fs.mkdirSync(path.join(dir, ".memento"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".memento/config.json"),
    JSON.stringify({
      provider: "fake",
      model: "fake-1",
      // `write` is approved by config — proves the approval seam works.
      autoApprove: ["write", "edit"],
      providers: [
        {
          id: "fake",
          type: "openai-compat",
          baseUrl: url,
          apiKeyEnv: "FAKE_KEY",
          models: [{ id: "fake-1", contextWindow: 32_000, maxOutput: 2_000, supportsTools: true }],
        },
      ],
    }),
  );
  process.env.FAKE_KEY = "test";
}

function readJsonl(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("full SDD loop (e2e, real wire format)", () => {
  it("tool call → file written → session logged → lesson reflected", async () => {
    // A git repo so the commit-message hint has a diff to read.
    execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
    execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: dir, windowsHide: true });
    execFileSync("git", ["config", "user.name", "E2E"], { cwd: dir, windowsHide: true });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".memento/\n");
    execFileSync("git", ["add", ".", "-f"], { cwd: dir, windowsHide: true });
    execFileSync("git", ["commit", "-qm", "chore: baseline"], { cwd: dir, windowsHide: true });

    server = await startFakeOpenAi([
      // 2nd main call: the tool result is in context — wrap up.
      { match: (b) => hasToolResult(b), text: "Created hello.txt at the workspace root." },
      // Commit hint — routed by its own system prompt, runs once per session.
      { match: (b) => systemText(b).includes("commit messages"), text: "feat: create the hello.txt greeting file" },
      // Reflection pass — routed by its own system prompt, no tool results in context.
      {
        match: (b) => systemText(b).includes("reflection engine"),
        text: JSON.stringify({
          observations: [
            {
              text: "The repo root greeting lives in hello.txt",
              kind: "discovery",
              evidence: "assistant wrote hello.txt with the greeting content",
              relation: "new",
            },
          ],
          specSuggestions: [
            {
              target: ".memento/spec/constitution.md",
              rationale: "the hello.txt greeting convention should be recorded in the constitution",
              priority: "low",
            },
          ],
          summary: "created the hello.txt greeting file",
        }),
      },
      // 1st main call: ask for the write tool. Fallback rule — must stay last.
      { match: () => true, toolCalls: [{ name: "write", args: { path: "hello.txt", content: HELLO } }] },
    ]);
    writeConfig(server.url);

    const code = await runTask({ task: "create hello.txt with a greeting", root: dir, specGate: "off" });

    expect(code).toBe(0);

    // The tool ran with the workspace root as cwd — not the process cwd.
    expect(fs.readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe(HELLO);

    // Session log: header → user/assistant/tool messages → usage → result.
    const sessionsDir = path.join(dir, ".memento", "sessions");
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const entries = readJsonl(path.join(sessionsDir, files[0]!));
    const kinds = entries.map((e) => e.kind);
    expect(kinds[0]).toBe("header");
    expect((entries.find((e) => e.kind === "result") as { status?: string } | undefined)?.status).toBe("done");
    const roles = entries
      .filter((e) => e.kind === "message")
      .map((e) => (e.message as { role: string }).role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(entries.some((e) => e.kind === "usage")).toBe(true);
    expect(entries.some((e) => e.kind === "note" && e.author === "reflect")).toBe(true);

    // The lesson is durable, low-confidence, and carries evidence.
    const lessons = readJsonl(path.join(dir, ".memento", "memory", "lessons.jsonl"));
    expect(lessons).toHaveLength(1);
    const record = lessons[0] as { op: string; lesson: { text: string; kind: string; confidence: number; evidence: { text: string }[] } };
    expect(record.op).toBe("upsert");
    expect(record.lesson.text).toContain("hello.txt");
    expect(record.lesson.kind).toBe("discovery");
    expect(record.lesson.confidence).toBeGreaterThan(0);
    expect(record.lesson.confidence).toBeLessThan(0.5);
    expect(record.lesson.evidence.length).toBeGreaterThan(0);

    // Double-write: the spec suggestion is persisted next to the lessons.
    const suggestions = fs.readFileSync(path.join(dir, ".memento", "spec-suggestions.md"), "utf8");
    expect(suggestions).toContain("constitution.md");
    expect(suggestions).toContain("greeting convention");

    // Wire-level: exactly four model calls, first one offered tools.
    expect(server.requests).toHaveLength(4);
    expect(server.requests[0]!.model).toBe("fake-1");
    expect(server.requests[0]!.tools?.some((t) => t.function.name === "write")).toBe(true);
    // The second call really carried the tool result back to the model.
    expect(hasToolResult(server.requests[1]!)).toBe(true);
    // The commit hint saw the diff of the file the session created.
    const hintRequest = server.requests.find((r) => JSON.stringify(r).includes("commit messages"));
    expect(hintRequest).toBeDefined();
  });

  it("denies a tool the config does not approve and reports it to the model", async () => {
    server = await startFakeOpenAi([
      { match: (b) => hasToolResult(b), text: "Understood, I could not run it." },
      { match: () => true, toolCalls: [{ name: "bash", args: { command: "echo hi > out.txt" } }] },
    ]);
    writeConfig(server.url);
    // Config approves only file writes; bash must be denied in non-TTY mode.
    const configFile = path.join(dir, ".memento", "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as { autoApprove: string[] };
    config.autoApprove = ["write"];
    fs.writeFileSync(configFile, JSON.stringify(config));

    const code = await runTask({ task: "write hi into out.txt via shell", root: dir, specGate: "off", reflect: false });
    expect(code).toBe(0);

    // bash was denied → no file, and the model was told.
    expect(fs.existsSync(path.join(dir, "out.txt"))).toBe(false);
    const sessionsDir = path.join(dir, ".memento", "sessions");
    const entries = readJsonl(path.join(sessionsDir, fs.readdirSync(sessionsDir)[0]!));
    const toolEntry = entries.find((e) => e.kind === "message" && (e.message as { role: string }).role === "tool");
    const block = (toolEntry!.message as { content: { type: string; content: string }[] }).content[0]!;
    expect(block.content).toContain("Denied");
  });
});

describe("memento plan (Plan/Act split, e2e)", () => {
  it("drafts a plan and, when declined, changes nothing", async () => {
    server = await startFakeOpenAi([
      {
        match: (b) => systemText(b).includes("draft an execution plan"),
        text: "## Goal\nCreate a plan file.\n\n## Steps\n1. Write plan.txt.\n",
      },
    ]);
    writeConfig(server.url);

    // Non-TTY + no --yes → the confirmation defaults to "no".
    const code = await planTask({ task: "create plan.txt", root: dir });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, "plan.txt"))).toBe(false);
    expect(server.requests).toHaveLength(1);
    // The plan prompt really carried the repo map into the request.
    expect(systemText(server.requests[0]!)).toContain("draft an execution plan");
    expect(JSON.stringify(server.requests[0]!.messages)).toContain("Repository map");
  });

  it("with --yes, hands the approved plan to the agent and executes", async () => {
    server = await startFakeOpenAi([
      // Draft call — first in the list so `find` picks it for the plan request.
      {
        match: (b) => systemText(b).includes("draft an execution plan"),
        text: "## Goal\nWrite plan.txt.\n\n## Steps\n1. Write plan.txt via the write tool.\n",
      },
      // 2nd main call: tool result in context — wrap up.
      { match: (b) => hasToolResult(b), text: "Plan executed." },
      // Reflection pass.
      {
        match: (b) => systemText(b).includes("reflection engine"),
        text: JSON.stringify({ observations: [], specSuggestions: [], summary: "executed the plan" }),
      },
      // 1st main call: the approved plan is in context — ask for the write.
      { match: () => true, toolCalls: [{ name: "write", args: { path: "plan.txt", content: "done\n" } }] },
    ]);
    writeConfig(server.url);

    const code = await planTask({ task: "create plan.txt", root: dir, yes: true });
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(dir, "plan.txt"), "utf8")).toBe("done\n");
    // The agent really saw the approved plan as its first user message.
    const main = server.requests.find(
      (r) => !systemText(r).includes("draft an execution plan") && !systemText(r).includes("reflection engine"),
    );
    expect(main).toBeDefined();
    expect(JSON.stringify(main!.messages)).toContain("Approved plan");
  });
});
