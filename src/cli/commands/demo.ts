/**
 * `memento demo` — the full SDD loop with zero setup, zero key, zero network.
 *
 * Starts a scripted local server that speaks the real OpenAI SSE wire format,
 * then runs the agent loop against a tiny throwaway workspace. The scripted
 * "model" reads greet.js, localizes it, adds a test, runs it, and the
 * reflection pass stores a new confidence-scored lesson — so a first-time
 * user sees recall → gate → build → verify → reflect exactly as it happens
 * with a real model.
 *
 * The scripted server is the same seam any custom gateway uses (an
 * `openai-compat` provider in config), so nothing here is special-cased
 * inside the kernel: the demo IS the real pipeline, minus the network.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { VERSION } from "../../version.ts";

export interface DemoOptions {
  root?: string;
  /** Workspace to run in. Defaults to a fresh temp dir (safe to delete). */
  workspace?: string;
  /** CLI entry to spawn (internal — tests inject the built cli.js). */
  cliEntry?: string;
}

const TASK = "change the greeting in greet.js to Chinese and add a test";

const GREETING_EDIT = {
  path: "greet.js",
  old_string: "return `Hello, ${name}!`;",
  new_string: "return `你好，${name}！`;",
};
const TEST_FILE = `import assert from "node:assert";
import { greet } from "./greet.js";

assert.equal(greet("世界"), "你好，世界！");
console.log("greet.test.js passed");
`;

function prepareWorkspace(ws: string): void {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(path.join(ws, ".memento", "spec"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".memento", "memory"), { recursive: true });

  fs.writeFileSync(
    path.join(ws, "greet.js"),
    `export function greet(name) {
  return \`Hello, \${name}!\`;
}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(ws, ".memento", "spec", "constitution.md"),
    `# Constitution

## Testing

- Every behavior change ships with a test that runs with plain \`node\` — no test framework is configured.
- Keep the public greeting API stable; change wording, not signatures.
`,
    "utf8",
  );

  const now = Date.now();
  const seedLesson = {
    op: "upsert",
    ts: now,
    lesson: {
      id: "l_demo_seed",
      text: "Tests in this project run with plain `node <file>.test.js` — there is no test framework.",
      kind: "pattern",
      confidence: 0.35,
      evidence: ["seeded for the demo run"],
      reinforced: 0,
      contradicted: 0,
      scope: "repo",
      created: now,
      lastSeen: now,
      tags: ["tests", "test", "greeting", "greet", "node", "framework", "project"],
      status: "active",
    },
  };
  fs.writeFileSync(path.join(ws, ".memento", "memory", "lessons.jsonl"), JSON.stringify(seedLesson) + "\n", "utf8");
}

/** The scripted "model": four deterministic turns over the greet task. */
function scriptedServer(): Promise<{ port: number; close: () => void; calls: () => number; injected: () => { lessons: boolean; spec: boolean } }> {
  let agentTurn = 0;
  let calls = 0;
  const injected = { lessons: false, spec: false };

  const script = (): { say: string; tools: [string, Record<string, unknown>][] } => {
    agentTurn += 1;
    if (agentTurn === 1) {
      return { say: "Let me look at greet.js first.", tools: [["read", { path: "greet.js" }]] };
    }
    if (agentTurn === 2) {
      return {
        say: "Now I'll localize the greeting and add a test.",
        tools: [
          ["edit", GREETING_EDIT],
          ["write", { path: "greet.test.js", content: TEST_FILE }],
        ],
      };
    }
    if (agentTurn === 3) {
      return {
        say: "Let me run the new test.",
        tools: [["bash", { command: "node greet.test.js", purpose: "verify the new test passes" }]],
      };
    }
    return { say: "Done — greet.js now returns 你好，<name>！ and greet.test.js verifies it (`node greet.test.js` passed).", tools: [] };
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls += 1;
      const body = JSON.parse(raw || "{}");
      const system = (body.messages as { role: string; content: string }[]).find((m) => m.role === "system")?.content ?? "";
      if (system.includes("Lessons from previous sessions")) injected.lessons = true;
      if (system.includes("Constitution")) injected.spec = true;

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const done = (usage?: { prompt_tokens: number; completion_tokens: number }) => {
        chunk({ choices: [{ finish_reason: "stop" }], usage: usage ?? { prompt_tokens: 0, completion_tokens: 0 } });
        res.write("data: [DONE]\n\n");
        res.end();
      };

      if (system.includes("spec gatekeeper")) {
        chunk({ choices: [{ delta: { content: JSON.stringify({ needsSpecChange: false, rationale: "Localizing a greeting keeps the same behavior contract; no spec delta needed." }) } }] });
        return done();
      }
      if (system.includes("reflection engine")) {
        chunk({
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  observations: [
                    {
                      text: "greet.js owns the greeting string; greet.test.js runs with plain `node`",
                      kind: "pattern",
                      evidence: "edited greet.js into a Chinese greeting and `node greet.test.js` passed",
                      relation: "new",
                    },
                  ],
                  specSuggestions: [],
                  summary: "Localized the greeting and added a passing test.",
                }),
              },
            },
          ],
        });
        return done();
      }

      const step = script();
      for (let i = 0; i < step.tools.length; i += 1) {
        const [name, args] = step.tools[i]!;
        chunk({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${agentTurn}_${i}`, type: "function", function: { name, arguments: "" } }] } }] });
        chunk({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(args) } }] } }] });
      }
      if (step.tools.length > 0) {
        chunk({ choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        chunk({ choices: [{ delta: { content: step.say } }] });
        done({ prompt_tokens: 100, completion_tokens: 20 });
      }
    });
  });

  return new Promise<{ port: number; close: () => void; calls: () => number; injected: () => { lessons: boolean; spec: boolean } }>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") return reject(new Error("bad listen address"));
      resolve({
        port: addr.port,
        close: () => server.close(),
        calls: () => calls,
        injected: () => ({ ...injected }),
      });
    });
  });
}

export async function demoTask(opts: DemoOptions): Promise<number> {
  const ws = opts.workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "memento-demo-"));
  prepareWorkspace(ws);

  process.stdout.write(pc.bold("\n◈ memento demo") + pc.dim(` v${VERSION} · scripted model, no API key, no network\n`));
  process.stdout.write(pc.dim(`workspace ${ws} (deleted on next demo run — safe to explore)\n`));

  const model = await scriptedServer();
  process.stdout.write(pc.dim(`scripted model on 127.0.0.1:${model.port}\n\n`));

  fs.writeFileSync(
    path.join(ws, ".memento", "config.json"),
    JSON.stringify(
      {
        provider: "demo",
        model: "demo-1",
        autoApprove: ["write", "edit"],
        providers: [
          {
            id: "demo",
            type: "openai-compat",
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            apiKeyEnv: "DEMO_KEY",
            models: [{ id: "demo-1", contextWindow: 32000, maxOutput: 2000, supportsTools: true }],
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // Run the real CLI on itself: the demo rides the exact same entry point a
  // user's `memento run` does, so what is on screen is what ships.
  const entry = opts.cliEntry ?? process.argv[1];
  if (!entry) {
    process.stderr.write(pc.red("cannot locate the CLI entry point\n"));
    return 1;
  }
  const child = spawn(process.execPath, [entry, "run", TASK, "-C", ws, "--yes", "--spec-gate", "auto"], {
    env: { ...process.env, DEMO_KEY: "demo" },
    stdio: "inherit",
  });

  const code: number = await new Promise((resolve) => child.on("close", resolve));
  model.close(); // the scripted server must not keep the event loop alive
  const injected = model.injected();
  const lessons = fs.readFileSync(path.join(ws, ".memento", "memory", "lessons.jsonl"), "utf8").trim().split("\n");
  const sessions = fs.readdirSync(path.join(ws, ".memento", "sessions"));

  process.stdout.write("\n──────── demo summary ────────\n");
  process.stdout.write(`exit code:      ${code}\n`);
  process.stdout.write(`model calls:    ${model.calls()} (gatekeeper + agent turns + reflection)\n`);
  process.stdout.write(`recall injected: ${injected.spec ? "spec excerpts" : "no spec"}${injected.lessons ? " + 1 lesson" : ""}\n`);
  process.stdout.write(`greet.js:       ${fs.readFileSync(path.join(ws, "greet.js"), "utf8").split("\n")[1]?.trim()}\n`);
  process.stdout.write(`lessons.jsonl:  ${lessons.length} record(s) (1 seeded + ${Math.max(0, lessons.length - 1)} learned this run)\n`);
  process.stdout.write(`session log:    ${path.join(ws, ".memento", "sessions", sessions[0] ?? "")}\n`);
  process.stdout.write("\nnext steps:\n");
  process.stdout.write(`  ${pc.cyan("memento lessons -C " + ws + " --all")}    # inspect the confidence-scored memory\n`);
  process.stdout.write(`  ${pc.cyan("memento show <id> -C " + ws)}        # replay the session transcript\n`);
  process.stdout.write(
    `  set DEEPSEEK_API_KEY=... and run \`memento run\` in a real repo — same loop, real model\n\n`,
  );
  return code ?? 0;
}
