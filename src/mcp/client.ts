/**
 * MCP client — connects Memento to external MCP servers over stdio.
 *
 * One line of config turns any MCP server (filesystem, github, database,
 * browser …) into first-class Memento tools:
 *
 *   { "mcpServers": [{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }] }
 *
 * Safety model (mirrors the plugin rule — checkout code must never execute):
 *   - Servers are loaded from the USER config (`~/.memento/config.json`) only.
 *   - A project can declare servers only when the user sets
 *     `trustProjectMcp: true` in their own user config.
 *   - Every bridged tool is `mutating` by default → approval + serialized
 *     writes, until the user whitelists it in `trustedTools`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-call timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Tool names that skip approval (read-only tools you trust). */
  trustedTools?: string[];
  disabled?: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError?: boolean;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const MAX_STDERR_LINES = 20;

/**
 * Quote one argument for cmd.exe. Without this, paths containing spaces
 * ("C:\Users\Dev One\…") break the spawn on Windows when a .cmd shim
 * (npx, pnpm, …) forces shell execution.
 */
function quoteWinArg(arg: string): string {
  if (!/[\s"&|<>^]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export class McpClient {
  private constructor(
    private readonly cfg: McpServerConfig,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly pending: Map<number, Pending>,
    private readonly stderrLines: string[],
    private nextId: number,
  ) {}

  static async connect(cfg: McpServerConfig, log?: (line: string) => void): Promise<McpClient> {
    // On Windows, .cmd shims (npx, pnpm, …) cannot be spawned directly — they
    // need cmd.exe. Quote every argument so paths with spaces survive the
    // shell round-trip. The command string comes from the user's own config
    // file, never from a checkout.
    const needsShell = process.platform === "win32";
    const commandLine = [cfg.command, ...(cfg.args ?? [])].map(quoteWinArg).join(" ");
    const child = spawn(needsShell ? commandLine : cfg.command, needsShell ? [] : (cfg.args ?? []), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...cfg.env },
      windowsHide: true,
      shell: needsShell,
    });

    const pending = new Map<number, Pending>();
    const stderrLines: string[] = [];
    let nextId = 1;

    child.on("error", (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });

    // A dead server must never leave callers hanging: on shell platforms a
    // missing binary surfaces as exit code 1, not as an 'error' event.
    child.on("exit", (code) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server "${cfg.name}" exited (code ${code ?? "signal"})`));
      }
      pending.clear();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of String(chunk).split("\n")) {
        const t = line.trim();
        if (!t) continue;
        stderrLines.push(t);
        if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
      }
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: { id?: number | null; result?: unknown; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(trimmed) as typeof msg;
      } catch {
        return; // garbage on stdout — ignore, like the server side ignores it
      }
      if (typeof msg.id !== "number" || msg.id === null) return; // notification
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    });

    const client = new McpClient(cfg, child, pending, stderrLines, nextId);

    // Handshake: initialize, then list tools. Either failure surfaces as a
    // loud warning by the caller — the session continues without this server.
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "memento", version: "0" },
    }, HANDSHAKE_TIMEOUT_MS);
    // A notification — the server must NOT answer, so don't wait for one.
    client.notify("notifications/initialized", undefined);
    const listed = (await client.request("tools/list", undefined, HANDSHAKE_TIMEOUT_MS)) as { tools?: McpToolInfo[] };
    const toolList = listed.tools ?? [];
    client.setTools(toolList);

    log?.(`connected MCP server "${cfg.name}": ${toolList.length} tool(s)`);
    return client;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  /** Fire-and-forget notification — no id, no pending entry, no answer expected. */
  private notify(method: string, params: unknown): void {
    const payload = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  /** Tool manifest, filled by connect() after tools/list. */
  private toolCache: McpToolInfo[] = [];

  private setTools(tools: McpToolInfo[]): void {
    this.toolCache = tools;
  }

  tools(): McpToolInfo[] {
    return this.toolCache;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, this.cfg.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const content = result.content ?? [];
    const text = content
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} content]`))
      .join("\n");
    return { text: text || "(empty result)", ...(result.isError === true ? { isError: true } : {}) };
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("MCP client closed"));
    }
    this.pending.clear();
    try {
      this.child.stdin.end();
    } catch {
      // stdin may already be gone
    }
    const forceKill = setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, 500);
    forceKill.unref?.();
    this.child.kill();
  }
}
