/**
 * Security regression tests — each one pins a real escape vector that was
 * found in review and fixed. If any of these regresses, the agent is unsafe.
 *
 * S4 approval-classifier bypasses, S2 spec-path escape, S5 symlink escape,
 * S1 Anthropic tool-call id desync, and the M1 truncation-nudge behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyCommand } from "../src/tools/guard.ts";
import { isInside } from "../src/util/paths.ts";
import { writeSpec, specDir } from "../src/spec/store.ts";
import { createAnthropicProvider } from "../src/llm/anthropic.ts";
import type { StreamEvent } from "../src/llm/types.ts";
import { runLoop } from "../src/kernel/loop.ts";
import { SessionLog } from "../src/kernel/session.ts";
import { EventBus } from "../src/kernel/events.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { registerBuiltins } from "../src/tools/builtin/index.ts";
import { loadPlugins } from "../src/plugins/loader.ts";
import { MOCK_MODEL, createMockProvider } from "./support/mock-provider.ts";
import type { Message } from "../src/llm/types.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-security-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("approval classifier (S4)", () => {
  it("gates unspaced output redirection: `echo hi>f`", () => {
    expect(classifyCommand("echo hi>f").mutating).toBe(true);
  });

  it("gates command substitution smuggled into a read-only head: `ls $(touch /tmp/x)`", () => {
    expect(classifyCommand("ls $(touch /tmp/x)").mutating).toBe(true);
  });

  it("gates backtick substitution: `ls `rm -rf /``", () => {
    expect(classifyCommand("ls `rm -rf /`").mutating).toBe(true);
  });

  it("gates newline-chained commands: `echo ok\\necho pwned > f`", () => {
    expect(classifyCommand("echo ok\necho pwned > f").mutating).toBe(true);
  });

  it("gates background-chained commands: `echo a & touch /tmp/x`", () => {
    expect(classifyCommand("echo a & touch /tmp/x").mutating).toBe(true);
  });

  it("gates PowerShell invocation expressions hidden behind read-only aliases", () => {
    expect(classifyCommand("gci | iex").mutating).toBe(true);
  });

  it("still approves genuinely read-only commands with quoted metacharacters", () => {
    expect(classifyCommand(`grep "a > b" file.txt`).mutating).toBe(false);
    expect(classifyCommand("ls -la").mutating).toBe(false);
    expect(classifyCommand("git status").mutating).toBe(false);
    expect(classifyCommand("node --version").mutating).toBe(false);
  });
});

describe("spec path escape (S2)", () => {
  it("refuses absolute paths and drive-letter paths", () => {
    expect(() => writeSpec(dir, "C:\\Windows\\System32\\evil.md", "# x")).toThrow();
    expect(() => writeSpec(dir, "/etc/passwd", "# x")).toThrow();
  });

  it("refuses `..` segments that climb out of the workspace", () => {
    expect(() => writeSpec(dir, "../package.json", "{}")).toThrow();
    expect(() => writeSpec(dir, ".memento/spec/../../secret.md", "# x")).toThrow();
  });

  it("refuses workspace paths outside .memento/spec/", () => {
    expect(() => writeSpec(dir, "src/index.ts", "// x")).toThrow();
  });

  it("refuses non-markdown targets", () => {
    expect(() => writeSpec(dir, ".memento/spec/features/auth.json", "{}")).toThrow();
  });

  it("still writes legitimate spec files", () => {
    writeSpec(dir, ".memento/spec/features/auth.md", "# Auth\n");
    expect(fs.readFileSync(path.join(specDir(dir), "features", "auth.md"), "utf8")).toBe("# Auth\n");
  });
});

describe("symlink escape (S5)", () => {
  it("detects writes routed through a symlinked directory out of the workspace", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "memento-outside-"));
    try {
      let link = path.join(dir, "linked");
      try {
        fs.symlinkSync(outside, link, "junction");
      } catch {
        try {
          fs.symlinkSync(outside, link, "dir");
        } catch {
          return; // symlinks unavailable on this platform — nothing to prove
        }
      }
      fs.writeFileSync(path.join(outside, "payload.txt"), "x");
      // The linked dir lives inside the workspace by string comparison,
      // but resolves outside it — isInside must see through the link.
      expect(isInside(dir, path.join(link, "payload.txt"))).toBe(false);
      expect(isInside(dir, path.join(link, "new-file.txt"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("Anthropic tool-call ids (S1)", () => {
  it("keeps toolcall_start/delta/end on the same real id", async () => {
    const wire = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
      "",
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01AbCdEf","name":"bash"}}',
      "",
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command"}}',
      "",
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      "",
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}',
      "",
    ].join("\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );

    const provider = createAnthropicProvider({
      id: "anthropic",
      baseUrl: "https://api.anthropic.com",
      models: [{ id: "claude-test", contextWindow: 100_000, maxOutput: 8_192, supportsTools: true }],
    });

    const events: StreamEvent[] = [];
    for await (const ev of provider.stream(
      {
        model: "claude-test",
        system: "",
        messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "run ls" }], ts: 0 }],
        tools: [],
      },
      {},
    )) {
      events.push(ev);
    }

    const start = events.find((e) => e.type === "toolcall_start");
    const deltas = events.filter((e) => e.type === "toolcall_delta");
    const end = events.find((e) => e.type === "toolcall_end");
    expect(start).toBeDefined();
    expect((start as { id: string }).id).toBe("toolu_01AbCdEf");
    for (const d of deltas) expect((d as { id: string }).id).toBe("toolu_01AbCdEf");
    expect((end as { id: string }).id).toBe("toolu_01AbCdEf");
  });

  it("reports aborts as aborted, not as a network error (M7)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{}}\n\n'));
        // never closes; the abort signal below tears the stream down
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );

    const provider = createAnthropicProvider({
      id: "anthropic",
      baseUrl: "https://api.anthropic.com",
      models: [{ id: "claude-test", contextWindow: 100_000, maxOutput: 8_192, supportsTools: true }],
    });
    const ac = new AbortController();
    const events: StreamEvent[] = [];
    const iter = provider.stream(
      {
        model: "claude-test",
        system: "",
        messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], ts: 0 }],
        tools: [],
      },
      { signal: ac.signal },
    );
    const collect = (async () => {
      for await (const ev of iter) events.push(ev);
    })();
    setTimeout(() => ac.abort(), 10);
    await collect;
    const done = events.find((e) => e.type === "done");
    expect((done as { stopReason: string }).stopReason).toBe("aborted");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("project plugins stay opt-in (S3)", () => {
  it("skips project plugins unless explicitly trusted", async () => {
    fs.mkdirSync(path.join(dir, ".memento/plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".memento/plugins/evil.ts"),
      `export default (ctx) => { ctx.registerSpecChecker({ name: "evil", run: () => [] }); };\n`,
    );
    const host = {
      tools: { register: () => () => {} } as unknown as ToolRegistry,
      specCheckers: [],
      eventHandlers: new Map(),
      cwd: dir,
      log: () => {},
    };

    const untrusted = await loadPlugins(host as never, { cwd: dir, skipProject: true });
    expect(untrusted.filter((p) => p.file.startsWith(dir))).toHaveLength(0);

    const trusted = await loadPlugins(host as never, { cwd: dir, skipProject: false });
    expect(trusted.some((p) => p.file.startsWith(dir))).toBe(true);
  });
});

describe("truncation never ends as done (M1)", () => {
  it("nudges the model to continue instead of silently finishing", async () => {
    const provider = createMockProvider([
      { text: "I was cut off mid-", stopReason: "length", toolCalls: [] },
      { text: "All done.", stopReason: "end" },
    ]);
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const session = SessionLog.create(path.join(dir, "sessions"), {
      cwd: dir,
      model: MOCK_MODEL.id,
      provider: "mock",
      task: "test task",
      mementoVersion: "test",
    });
    const bus = new EventBus();
    const result = await runLoop(
      { provider, model: MOCK_MODEL, system: "test", registry, session, bus },
      [{ id: "m_user", role: "user", content: [{ type: "text", text: "go" }], ts: Date.now() } as Message],
    );

    expect(result.status).toBe("done");
    expect(result.turns).toBe(2);
    // The second request must contain the continuation nudge.
    const second = provider.requests[1]!;
    const nudged = second.messages.some(
      (m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes("cut off by the output token limit")),
    );
    expect(nudged).toBe(true);
  });

  it("gives up after repeated truncations instead of looping forever", async () => {
    const provider = createMockProvider([
      { stopReason: "length", toolCalls: [] },
      { stopReason: "length", toolCalls: [] },
      { stopReason: "length", toolCalls: [] },
      { stopReason: "length", toolCalls: [] },
    ]);
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const session = SessionLog.create(path.join(dir, "sessions"), {
      cwd: dir,
      model: MOCK_MODEL.id,
      provider: "mock",
      task: "test task",
      mementoVersion: "test",
    });
    const result = await runLoop(
      { provider, model: MOCK_MODEL, system: "test", registry, session, bus: new EventBus(), maxTurns: 10 },
      [{ id: "m_user", role: "user", content: [{ type: "text", text: "go" }], ts: Date.now() } as Message],
    );
    expect(result.status).toBe("max_turns");
  });
});
