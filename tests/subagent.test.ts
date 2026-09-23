/**
 * Sub-agent tests — the agent chain, end to end.
 *
 * The fake provider scripts the whole tree: the main loop dispatches one
 * `subagent` call, the sub-loop reads a file and answers, the main loop
 * wraps up. Asserted: the answer round-trips, the sub-session log exists
 * beside the parent's, and the parent's log links to it.
 */
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTask } from "../src/cli/commands/run.ts";
import { hasToolResult, startFakeOpenAi, systemText } from "./support/fake-openai.ts";
import type { FakeServer } from "./support/fake-openai.ts";

let dir: string;
let server: FakeServer;
const KEY_ENV = "MEMENTO_SUBAGENT_KEY";
const savedKey = process.env[KEY_ENV];

function readJsonl(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-subagent-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const greeting = 'hello';\n", "utf8");
  process.env[KEY_ENV] = "test-key";
  server = await startFakeOpenAi([
    // Sub-loop turn 2: the file was read — answer the question.
    {
      match: (b) => systemText(b).includes("exploration sub-agent") && hasToolResult(b),
      text: "src/app.ts exports `greeting = 'hello'`.",
    },
    // Sub-loop turn 1: investigate — read the file.
    {
      match: (b) => systemText(b).includes("exploration sub-agent"),
      toolCalls: [{ name: "read", args: { path: "src/app.ts" } }],
    },
    // Main loop turn 2: the sub-agent answered — wrap up.
    { match: (b) => hasToolResult(b), text: "Noted: greeting comes from src/app.ts." },
    // Main loop turn 1: dispatch the sub-agent. Fallback rule — must stay last.
    {
      match: () => true,
      toolCalls: [{ name: "subagent", args: { purpose: "map the greeting", question: "what does src/app.ts export?" } }],
    },
  ]);
  fs.mkdirSync(path.join(dir, ".memento"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".memento", "config.json"),
    JSON.stringify({
      provider: "fake",
      model: "fake-1",
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

describe("subagent (agent chain)", () => {
  it("dispatches a read-only explorer, gets the answer, and logs the sub-session", async () => {
    const code = await runTask({
      task: "find out what src/app.ts exports",
      root: dir,
      specGate: "off",
      reflect: false,
      commitHint: false,
    });
    expect(code).toBe(0);

    // Two session logs: the parent run and the sub-agent exploration.
    const sessionsDir = path.join(dir, ".memento", "sessions");
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(2);

    const entries = files.map((f) => readJsonl(path.join(sessionsDir, f)));

    // The parent log links to the sub-session and answers the user's task.
    const parent = entries.find((e) => !(e[0]?.task as string | undefined)?.startsWith("subagent:"))!;
    expect(parent).toBeDefined();
    const notes = parent.filter((e) => e.kind === "note").map((e) => String(e.text));
    expect(notes.some((n) => n.includes("subagent") && n.includes("explored"))).toBe(true);
    const parentText = parent.map((e) => JSON.stringify(e)).join("\n");
    expect(parentText).toContain("Noted: greeting comes from src/app.ts");

    // The sub log carries the read tool call and the condensed answer.
    const sub = entries.find((e) => (e[0]?.task as string | undefined)?.startsWith("subagent:"))!;
    expect(sub).toBeDefined();
    const subText = sub
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(subText).toContain("src/app.ts");
    expect(subText).toContain("exports `greeting = 'hello'`");
  });

  it("is not registered in the sub-loop — the tree is one level deep", async () => {
    // A sub-agent that tries to dispatch its own sub-agent gets "Unknown tool".
    await server.close();
    server = await startFakeOpenAi([
      { match: (b) => systemText(b).includes("exploration sub-agent") && hasToolResult(b), text: "gave up." },
      { match: (b) => systemText(b).includes("exploration sub-agent"), toolCalls: [{ name: "subagent", args: { purpose: "recurse", question: "?" } }] },
      { match: (b) => hasToolResult(b), text: "fine." },
      { match: () => true, toolCalls: [{ name: "subagent", args: { purpose: "probe", question: "probe" } }] },
    ]);
    fs.writeFileSync(
      path.join(dir, ".memento", "config.json"),
      JSON.stringify({
        provider: "fake",
        model: "fake-1",
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
    const code = await runTask({ task: "probe", root: dir, specGate: "off", reflect: false, commitHint: false });
    expect(code).toBe(0);
    const sessionsDir = path.join(dir, ".memento", "sessions");
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    const sub = files
      .map((f) => readJsonl(path.join(sessionsDir, f)))
      .find((e) => (e[0]?.task as string | undefined)?.startsWith("subagent:"))!;
    const subText = sub.map((e) => JSON.stringify(e)).join("\n");
    expect(subText).toContain("Unknown tool: subagent");
  });
});
