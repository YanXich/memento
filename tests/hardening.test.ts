/**
 * Hardening regression tests (audit round 4).
 *
 * Each test pins a real escape vector found in review and fixed:
 *  - approval bypass via `find -delete/-exec` and `awk system()` (H3)
 *  - secret-file exfiltration through read/grep/shell (H4)
 *  - plugin name traversal deleting the whole state dir (C1)
 *  - plugin `#subdir` staging escape (H2)
 *  - the one-shot stream retry that never fired (H5)
 *  - duplicated tool-name deltas producing "readread" (H6)
 *  - ReDoS shapes and overlong-line skipping in grep (H7)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { classifyCommand, commandTouchesSecrets, guardReadPath } from "../src/tools/guard.ts";
import { bashTool } from "../src/tools/builtin/shell.ts";
import { readTool, grepTool } from "../src/tools/builtin/files.ts";
import { pluginsTask } from "../src/cli/commands/plugins.ts";
import { runLoop } from "../src/kernel/loop.ts";
import { SessionLog } from "../src/kernel/session.ts";
import { EventBus } from "../src/kernel/events.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { MOCK_MODEL } from "./support/mock-provider.ts";
import type { LlmProvider, StreamEvent } from "../src/llm/types.ts";
import type { ToolContext } from "../src/tools/types.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-hardening-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function ctx(): ToolContext {
  return {
    cwd: dir,
    progress: () => {},
    approve: async () => false,
  };
}

describe("approval classifier: read-only head token subcommands (H3)", () => {
  it("gates find -delete / -exec / -ok", () => {
    expect(classifyCommand("find . -delete").mutating).toBe(true);
    expect(classifyCommand("find . -exec rm -rf {} \\;").mutating).toBe(true);
    expect(classifyCommand("find . -ok rm {} \\;").mutating).toBe(true);
    expect(classifyCommand("find . -execdir sh -c 'x' \\;").mutating).toBe(true);
  });

  it("still approves read-only find", () => {
    expect(classifyCommand("find . -name '*.ts' -maxdepth 2").mutating).toBe(false);
  });

  it("gates awk system() and piped getline, even hidden in quotes", () => {
    expect(classifyCommand(`awk 'BEGIN{system("rm -rf /tmp/x")}'`).mutating).toBe(true);
    expect(classifyCommand(`awk 'BEGIN{"cmd" | getline}' file`).mutating).toBe(true);
  });

  it("still approves read-only awk", () => {
    expect(classifyCommand(`awk '{print $1}' file.txt`).mutating).toBe(false);
  });

  it("gates sed entirely — GNU sed has an e command that executes shell code", () => {
    expect(classifyCommand(`sed '1e touch /tmp/pwn' file.txt`).mutating).toBe(true);
    expect(classifyCommand(`sed -n '1p' file.txt`).mutating).toBe(true); // fail-safe, not silent
  });
});

describe("secret-file protection (H4)", () => {
  it("flags secret names in shell commands", () => {
    expect(commandTouchesSecrets("cat .env")).toBe(true);
    expect(commandTouchesSecrets("type id_rsa")).toBe(true);
    expect(commandTouchesSecrets("cat .env.local")).toBe(true);
    expect(commandTouchesSecrets("openssl x509 -in cert.pem -text")).toBe(true);
    expect(commandTouchesSecrets("cat package.json")).toBe(false);
    expect(commandTouchesSecrets("git status")).toBe(false);
  });

  it("shell tool requires approval for commands touching secrets", () => {
    expect(bashTool.requiresApproval!({ command: "cat .env" })).toBe(true);
    expect(bashTool.requiresApproval!({ command: "cat package.json" })).toBe(false);
  });

  it("guardReadPath flags secrets and keeps the workspace boundary", () => {
    expect(guardReadPath(dir, path.join(dir, ".env"))).toMatchObject({ allowed: false, secret: true });
    expect(guardReadPath(dir, path.join(dir, "src", "index.ts"))).toMatchObject({ allowed: true });
    expect(guardReadPath(dir, path.join(dir, "..", "other", "x.txt"))).toMatchObject({ allowed: false, secret: false });
  });

  it("read tool refuses .env without approval and honors approval", async () => {
    fs.writeFileSync(path.join(dir, ".env"), "API_KEY=supersecret\n");
    const refused = await readTool.execute({ path: ".env" }, ctx());
    expect(refused.isError).toBe(true);
    expect(String(refused.output)).toContain("Refused");

    const approved = await readTool.execute(
      { path: ".env" },
      { ...ctx(), approve: async () => true },
    );
    expect(approved.isError).toBeFalsy();
    expect(String(approved.output)).toContain("API_KEY=supersecret");
  });

  it("grep never searches secret files", async () => {
    fs.writeFileSync(path.join(dir, ".env"), "MATCH_ME=secret\n");
    fs.writeFileSync(path.join(dir, "notes.md"), "MATCH_ME=public\n");
    const result = await grepTool.execute({ pattern: "MATCH_ME" }, ctx());
    expect(String(result.output)).toContain("notes.md");
    expect(String(result.output)).not.toContain(".env");
  });
});

describe("grep ReDoS defence (H7)", () => {
  it("rejects classic catastrophic shapes", async () => {
    for (const pattern of ["(a+)+", "(a|aa)*", "a*a*a*a*b", "[^x]*[^x]*x", "(.*)*", "(ab|abc)+"]) {
      const result = await grepTool.execute({ pattern }, ctx());
      expect(result.isError).toBe(true);
      expect(String(result.output)).toContain("rejected");
    }
  });

  it("accepts benign quantified patterns", async () => {
    const result = await grepTool.execute({ pattern: "(\\w+)\\s+(\\w+)" }, ctx());
    expect(result.isError).toBeFalsy();
  });

  it("skips overlong lines instead of betting the event loop on them", async () => {
    fs.writeFileSync(path.join(dir, "big.js"), "x".repeat(30_000) + "\n");
    const result = await grepTool.execute({ pattern: "y" }, ctx());
    expect(String(result.output)).toContain("overlong");
  });
});

describe("plugin name traversal (C1) and #subdir escape (H2)", () => {
  it("remove .. must never delete the state dir", async () => {
    fs.mkdirSync(path.join(dir, ".memento", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".memento", "keep.txt"), "sentinel");
    const code = await pluginsTask({ action: "remove", name: "..", root: dir });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(dir, ".memento", "keep.txt"))).toBe(true);
  });

  it("remove . must not delete the plugin dir itself", async () => {
    fs.mkdirSync(path.join(dir, ".memento", "plugins"), { recursive: true });
    const code = await pluginsTask({ action: "remove", name: ".", root: dir });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(dir, ".memento", "plugins"))).toBe(true);
  });

  it("init refuses names with path separators", async () => {
    const code = await pluginsTask({ action: "init", name: "../evil", root: dir });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(dir, "..", "evil.ts"))).toBe(false);
  });

  it("install refuses #subdir that escapes the staged source", async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-plugin-src-"));
    fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {};\n");
    try {
      // #../.. resolves to a path outside the staging dir entirely.
      const code = await pluginsTask({ action: "install", source: `${pluginDir}#../..`, root: dir, yes: true });
      expect(code).toBe(1);
      // The refusal happens before anything is copied — no plugin dir is even created.
      expect(fs.existsSync(path.join(dir, ".memento", "plugins"))).toBe(false);
    } finally {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("still removes a legitimately installed plugin", async () => {
    fs.mkdirSync(path.join(dir, ".memento", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".memento", "plugins", "ok-plugin.ts"), "export default {};\n");
    const code = await pluginsTask({ action: "remove", name: "ok-plugin", root: dir });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, ".memento", "plugins", "ok-plugin.ts"))).toBe(false);
  });
});

describe("one-shot stream retry (H5)", () => {
  it("retries once when the first request throws before any data", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      id: "flaky",
      label: "flaky",
      models: [MOCK_MODEL],
      resolveModel: () => MOCK_MODEL,
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        if (calls === 1) throw new Error("ECONNRESET");
        yield { type: "start" };
        yield { type: "text_delta", text: "recovered" };
        yield { type: "done", stopReason: "end", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const registry = new ToolRegistry();
    const session = SessionLog.create(path.join(dir, "sessions"), {
      cwd: dir,
      model: MOCK_MODEL.id,
      provider: "flaky",
      task: "test",
      mementoVersion: "test",
    });
    const result = await runLoop(
      { provider, model: MOCK_MODEL, system: "test", registry, session, bus: new EventBus() },
      [{ id: "m1", role: "user", content: [{ type: "text", text: "go" }], ts: Date.now() } as never],
    );
    expect(calls).toBe(2);
    expect(result.status).toBe("done");
    expect(result.messages.some((m) => m.content.some((b) => b.type === "text" && b.text.includes("recovered")))).toBe(true);
  });

  it("does not retry after a mid-stream drop (progress was made)", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      id: "midstream",
      label: "midstream",
      models: [MOCK_MODEL],
      resolveModel: () => MOCK_MODEL,
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "start" };
        yield { type: "text_delta", text: "partial" };
        throw new Error("stream dropped");
      },
    };
    const registry = new ToolRegistry();
    const session = SessionLog.create(path.join(dir, "sessions"), {
      cwd: dir,
      model: MOCK_MODEL.id,
      provider: "midstream",
      task: "test",
      mementoVersion: "test",
    });
    const result = await runLoop(
      { provider, model: MOCK_MODEL, system: "test", registry, session, bus: new EventBus() },
      [{ id: "m1", role: "user", content: [{ type: "text", text: "go" }], ts: Date.now() } as never],
    );
    expect(calls).toBe(1);
    expect(result.status).toBe("error");
  });
});

describe("duplicated tool-name deltas (H6)", () => {
  it("merges idempotently: a cumulative re-send must not produce 'readread'", async () => {
    let executed: string | null = null;
    let calls = 0;
    const provider: LlmProvider = {
      id: "dupnames",
      label: "dupnames",
      models: [MOCK_MODEL],
      resolveModel: () => MOCK_MODEL,
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "start" };
        if (calls === 1) {
          yield { type: "toolcall_start", id: "call_1", name: "read" };
          // Gateway resends the FULL accumulated name (not just the fragment).
          yield { type: "toolcall_name_delta", id: "call_1", nameDelta: "read" };
          yield { type: "toolcall_delta", id: "call_1", argsDelta: JSON.stringify({ path: "a.txt" }) };
          yield { type: "toolcall_end", id: "call_1" };
          yield { type: "done", stopReason: "toolUse", usage: { inputTokens: 10, outputTokens: 5 } };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "end", usage: { inputTokens: 10, outputTokens: 5 } };
        }
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      name: "read",
      description: "test read",
      schema: z.object({ path: z.string() }),
      async execute(args) {
        executed = String((args as { path: string }).path);
        return { output: "ok" };
      },
    });
    const session = SessionLog.create(path.join(dir, "sessions"), {
      cwd: dir,
      model: MOCK_MODEL.id,
      provider: "dupnames",
      task: "test",
      mementoVersion: "test",
    });
    const result = await runLoop(
      { provider, model: MOCK_MODEL, system: "test", registry, session, bus: new EventBus() },
      [{ id: "m1", role: "user", content: [{ type: "text", text: "go" }], ts: Date.now() } as never],
    );
    expect(result.status).toBe("done");
    expect(executed).toBe("a.txt"); // the real `read` tool ran — the name was not doubled
  });
});
