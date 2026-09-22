/**
 * Memento demo — the full SDD loop with zero setup.
 *
 * Starts a scripted local server that speaks the real OpenAI SSE wire format,
 * then runs `memento run` against a tiny demo workspace (`.demo/`). No API key,
 * no network. Great for a first look:
 *
 *   npm run build && node scripts/demo.mjs
 *
 * The scripted "model" reads greet.js, localizes it, adds a test, runs it,
 * and the reflection pass stores a new confidence-scored lesson.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(root, ".demo");
const cli = path.join(root, "dist", "cli.js");

if (!fs.existsSync(cli)) {
  console.error("dist/cli.js not found — run `npm run build` first.");
  process.exit(1);
}

const TASK = "change the greeting in greet.js to Chinese and add a test";

// ---------------------------------------------------------------- workspace
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

const seedLesson = {
  op: "upsert",
  ts: Date.now(),
  lesson: {
    id: "l_demo_seed",
    text: "Tests in this project run with plain `node <file>.test.js` — there is no test framework.",
    kind: "pattern",
    confidence: 0.35,
    evidence: ["seeded for the demo run"],
    reinforced: 0,
    contradicted: 0,
    scope: "repo",
    created: Date.now(),
    lastSeen: Date.now(),
    tags: ["tests", "test", "greeting", "greet", "node", "framework", "project"],
    status: "active",
  },
};
fs.writeFileSync(path.join(ws, ".memento", "memory", "lessons.jsonl"), JSON.stringify(seedLesson) + "\n", "utf8");

// ------------------------------------------------------- scripted "model"
let agentTurn = 0;
let calls = 0;
const injected = { lessons: false, spec: false };

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

function script() {
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
    return { say: "Let me run the new test.", tools: [["bash", { command: "node greet.test.js", purpose: "verify the new test passes" }]] };
  }
  return { say: "Done — greet.js now returns 你好，<name>！ and greet.test.js verifies it (`node greet.test.js` passed).", tools: [] };
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    calls += 1;
    const body = JSON.parse(raw || "{}");
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("Lessons from previous sessions")) injected.lessons = true;
    if (system.includes("Constitution")) injected.spec = true;

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const done = (usage) => {
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
      const [name, args] = step.tools[i];
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

// ------------------------------------------------------------------- drive
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
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
            baseUrl: `http://127.0.0.1:${port}/v1`,
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

  console.log(`\n# Memento demo — scripted model on 127.0.0.1:${port} (no API key needed)\n`);
  const child = spawn(process.execPath, [cli, "run", TASK, "-C", ws, "--yes", "--spec-gate", "auto"], {
    cwd: root,
    env: { ...process.env, DEMO_KEY: "demo" },
    stdio: "inherit",
  });

  child.on("close", (code) => {
    server.close();
    const lessons = fs.readFileSync(path.join(ws, ".memento", "memory", "lessons.jsonl"), "utf8").trim().split("\n");
    const sessions = fs.readdirSync(path.join(ws, ".memento", "sessions"));
    console.log("\n──────── demo summary ────────");
    console.log(`exit code:      ${code}`);
    console.log(`model calls:    ${calls} (gatekeeper + agent turns + reflection)`);
    console.log(`recall injected: ${injected.spec ? "spec excerpts" : "no spec"}${injected.lessons ? " + 1 lesson" : ""}`);
    console.log(`greet.js:       ${fs.readFileSync(path.join(ws, "greet.js"), "utf8").split("\n")[1].trim()}`);
    console.log(`lessons.jsonl:  ${lessons.length} record(s) (1 seeded + ${Math.max(0, lessons.length - 1)} learned this run)`);
    console.log(`session log:    .demo/.memento/sessions/${sessions[0]}`);
    console.log("\nnext steps:");
    console.log("  node dist/cli.js lessons -C .demo --all    # inspect the confidence-scored memory");
    console.log("  node dist/cli.js show <id> -C .demo        # replay the session transcript");
    console.log("  set DEEPSEEK_API_KEY=... and run `memento run` in a real repo — same loop, real model\n");
    process.exit(code ?? 0);
  });
});
