/**
 * Shell tool. Cross-platform by design: PowerShell on Windows, /bin/sh elsewhere,
 * overridable via MEMENTO_SHELL. Dangerous commands are classified and gated by
 * the approval seam (see tools/guard.ts) instead of being pattern-blocked silently.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.ts";
import { classifyCommand, commandTouchesSecrets } from "../guard.ts";
import { truncate } from "../../util/text.ts";

const MAX_OUTPUT = 30_000;

/** Kill the whole process tree — `child.kill()` alone orphans grandchildren. */
function killTree(child: ChildProcess): void {
  if (!child.pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    return;
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return;
  }
  // Detached children get their own process group (-pid) on POSIX.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export interface ShellSpec {
  command: string;
  args: string[];
}

export function defaultShell(): ShellSpec {
  const override = process.env.MEMENTO_SHELL;
  if (override) return { command: override, args: ["-c"] };
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
    };
  }
  return { command: "/bin/sh", args: ["-c"] };
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the workspace and return its combined output. Uses PowerShell on Windows, sh elsewhere. Read-only commands (ls, cat, git status, test runners…) run directly; anything that writes or is not recognizably read-only — every destructive command, and anything touching secret files (.env, keys) — requires explicit approval.",
  schema: z.object({
    command: z.string().describe("Command to run"),
    timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("Timeout in ms (default 120000)"),
    purpose: z.string().optional().describe("One-line reason shown in the approval prompt"),
  }),
  requiresApproval: (args: unknown) => {
    const command = String((args as { command?: unknown }).command ?? "");
    const verdict = classifyCommand(command);
    if (verdict.dangerous || verdict.mutating) return true;
    // Read-only commands that would print secret files (cat .env, type id_rsa)
    // still need a human — "read-only" says nothing about what leaves the machine.
    return commandTouchesSecrets(command);
  },
  async execute(args: { command: string; timeout_ms?: number; purpose?: string }, ctx: ToolContext) {
    const timeout = args.timeout_ms ?? 120_000;
    const verdict = classifyCommand(args.command);
    if (verdict.dangerous) {
      // Reached only when policy auto-approves; keep the reason in the record.
      ctx.progress(`⚠ approved dangerous command: ${verdict.reason}`);
    } else if (verdict.mutating) {
      ctx.progress(`approved non-read-only command: ${verdict.reason ?? "mutation"}`);
    }

    const shell = defaultShell();
    const started = Date.now();
    return await new Promise<{ output: string; isError?: boolean; details?: Record<string, unknown> }>((resolve) => {
      const child = spawn(shell.command, [...shell.args, args.command], {
        cwd: ctx.cwd,
        env: process.env,
        windowsHide: true,
        // POSIX: own process group so killTree can reach grandchildren.
        detached: process.platform !== "win32",
      });

      let stdout = "";
      let stderr = "";
      let stdoutOverflow = false;
      let stderrOverflow = false;
      let killedBy: "timeout" | "abort" | null = null;

      const timer = setTimeout(() => {
        killedBy = "timeout";
        killTree(child);
      }, timeout);

      const onAbort = () => {
        killedBy = "abort";
        killTree(child);
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      // O(1) per chunk: once the cap is hit, drop new data instead of
      // re-slicing the whole accumulated string on every chunk.
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutOverflow) return;
        stdout += chunk.toString("utf8");
        if (stdout.length > MAX_OUTPUT * 2) {
          stdoutOverflow = true;
          stdout = stdout.slice(0, MAX_OUTPUT * 2);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrOverflow) return;
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_OUTPUT) {
          stderrOverflow = true;
          stderr = stderr.slice(0, MAX_OUTPUT);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve({ output: `Failed to start shell: ${err.message}`, isError: true });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const elapsed = Date.now() - started;
        let out = "";
        if (stdout) out += stdout;
        if (stderr) out += (out ? "\n[stderr]\n" : "") + stderr;
        if (!out) out = "(no output)";
        out = truncate(out, MAX_OUTPUT);
        const meta = `\n[exit ${code ?? "?"} · ${elapsed}ms${killedBy ? ` · killed by ${killedBy}` : ""}]`;
        resolve({
          output: out + meta,
          isError: code !== 0 || killedBy !== null,
          details: { exitCode: code, elapsed, killedBy: killedBy ?? undefined },
        });
      });
    });
  },
};
