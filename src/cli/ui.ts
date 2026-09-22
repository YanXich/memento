/**
 * Terminal UI — event rendering + approval prompts.
 *
 * Rendering is a pure function of the kernel event stream: swap this file and
 * the agent behaves identically, which is the point of the event seam. No
 * spinners, no ANSI cursor tricks — plain append-only output that survives
 * being piped to a file and copied into an issue.
 */
import { createInterface, type Interface } from "node:readline/promises";
import pc from "picocolors";
import type { AgentEvent } from "../kernel/events.ts";
import type { EventBus } from "../kernel/events.ts";
import { oneLine } from "../util/text.ts";

export interface RendererOptions {
  showThinking?: boolean;
  /** Print tool results fully instead of a 6-line preview. */
  verboseTools?: boolean;
}

export class SessionRenderer {
  private opts: RendererOptions;
  private thinkingOpen = false;
  private lastWasText = false;
  private disposers: (() => void)[] = [];

  constructor(opts: RendererOptions = {}) {
    this.opts = opts;
  }

  attach(bus: EventBus): () => void {
    this.disposers.push(bus.on((event) => this.render(event)));
    return () => this.detach();
  }

  detach(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    if (this.thinkingOpen) {
      process.stdout.write(pc.dim("\n[/thinking]\n"));
      this.thinkingOpen = false;
    }
  }

  private render(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        process.stdout.write(
          pc.dim("\n") + pc.magenta("◈ ") + pc.dim("agent started · ") + pc.cyan(`model ${event.model}`) + "\n",
        );
        break;
      case "turn_start":
        if (event.turn > 1) process.stdout.write(pc.dim("\n── ") + pc.cyan(`turn ${event.turn}`) + pc.dim(" ──\n"));
        break;
      case "thinking_delta":
        if (!this.opts.showThinking) return;
        if (!this.thinkingOpen) {
          process.stdout.write(pc.dim("\n[thinking] "));
          this.thinkingOpen = true;
        }
        process.stdout.write(pc.dim(event.text));
        break;
      case "text_delta":
        if (this.thinkingOpen) {
          process.stdout.write(pc.dim("\n[/thinking]\n\n"));
          this.thinkingOpen = false;
        }
        this.lastWasText = true;
        process.stdout.write(event.text);
        break;
      case "tool_start": {
        if (this.thinkingOpen) {
          process.stdout.write(pc.dim("\n[/thinking]\n"));
          this.thinkingOpen = false;
        }
        if (this.lastWasText) process.stdout.write("\n\n");
        this.lastWasText = false;
        const preview = previewArgs(event.call.name, event.call.args);
        process.stdout.write(pc.magenta("⏺ ") + pc.cyan(event.call.name) + pc.dim(preview ? `(${preview})` : "") + "\n");
        break;
      }
      case "tool_progress":
        process.stdout.write(pc.dim(`  … ${event.line}\n`));
        break;
      case "tool_end": {
        const block = event.result.content.find((b) => b.type === "toolResult") as
          | { content: string; isError?: boolean }
          | undefined;
        if (!block) break;
        const maxLines = this.opts.verboseTools ? 40 : 6;
        const lines = block.content.split("\n");
        const shown = lines.slice(0, maxLines);
        const body = shown.map((l) => "  " + l).join("\n");
        if (block.isError) {
          process.stdout.write(pc.red(body) + "\n");
        } else {
          process.stdout.write(pc.dim(body) + "\n");
        }
        if (lines.length > maxLines) {
          process.stdout.write(pc.dim(`  … (${lines.length - maxLines} more lines)\n`));
        }
        break;
      }
      case "tools_blocked":
        process.stdout.write(pc.yellow(`⚠ blocked: ${event.reason}\n`));
        break;
      case "context_compacted":
        process.stdout.write(pc.dim(`⌁ context compacted (~${event.replacedTokens} → ~${event.summaryTokens} tokens)\n`));
        break;
      case "turn_end": {
        const u = event.usage;
        const cache = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
        process.stdout.write(
          pc.dim("\n· turn ") +
            pc.cyan(`${event.turn}`) +
            pc.dim(`: ${u.inputTokens} in / ${u.outputTokens} out${cache ? ` / ${cache} cache` : ""}\n`),
        );
        break;
      }
      case "agent_end": {
        const glyph =
          event.reason === "done"
            ? pc.green("✓")
            : event.reason === "error"
              ? pc.red("✗")
              : pc.yellow("⚠");
        process.stdout.write(
          pc.dim("\n") + pc.magenta("◈ ") + pc.dim("agent finished: ") + glyph + pc.dim(` ${event.reason}\n`),
        );
        break;
      }
      case "message_start":
      case "message_end":
        break;
    }
  }
}

function previewArgs(name: string, args: Record<string, unknown>): string {
  const first = (keys: string[]): string | null => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value) return oneLine(value, 72);
    }
    return null;
  };
  const preview =
    first(["command", "path", "file_path", "pattern", "query", "prompt", "task"]) ?? first(["old_string", "content"]);
  return preview ?? "";
}

// ------------------------------------------------------------------ approvals

export interface ApproverOptions {
  /** Auto-approve everything (--yes). */
  yes?: boolean;
  /** Tool names always approved. */
  autoApprove?: string[];
  /** Applies to the whole run ("always" answers). */
  sessionApproved?: Set<string>;
  /** Abort a pending question (Ctrl-C) — resolves as a denial instead of hanging. */
  signal?: AbortSignal;
}

export interface Approver {
  approve(tool: string, args: Record<string, unknown>, reason?: string): Promise<boolean>;
  /** Approve/deny a free-form proposal (e.g. a spec delta). */
  confirm(question: string, details?: string): Promise<boolean>;
  close(): void;
}

export function createApprover(opts: ApproverOptions = {}): Approver {
  const sessionApproved = opts.sessionApproved ?? new Set<string>();
  const auto = new Set(opts.autoApprove ?? []);
  const interactive = Boolean(process.stdin.isTTY) && !opts.yes;
  let rl: Interface | null = null;

  const getRl = (): Interface => {
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
    }
    return rl;
  };

  const ask = async (question: string): Promise<string> => {
    if (opts.signal?.aborted) throw new Error("aborted");
    const answer = await Promise.race([
      getRl().question(question),
      new Promise<never>((_, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
    return answer.trim().toLowerCase();
  };

  const askCatch = async (question: string): Promise<string> => {
    try {
      return await ask(question);
    } catch (err) {
      if ((err as Error).message === "aborted") return "n"; // abort denies
      throw err;
    }
  };

  return {
    async approve(tool, args, reason) {
      if (opts.yes || auto.has(tool) || sessionApproved.has(tool)) return true;
      if (!interactive) {
        process.stdout.write(pc.yellow(`\n✗ ${tool} requires approval (non-interactive; run with --yes or add to autoApprove)\n`));
        return false;
      }
      const preview = previewArgs(tool, args);
      process.stdout.write("\n" + pc.yellow(`▲ ${tool} wants to run:`) + `\n  ${preview}\n`);
      if (reason) process.stdout.write(pc.dim(`  why: ${reason}\n`));
      for (;;) {
        const answer = await askCatch(`  approve? [y]es / [n]o / [a]lways this tool > `);
        if (answer === "y" || answer === "yes" || answer === "") return true;
        if (answer === "n" || answer === "no") return false;
        if (answer === "a" || answer === "always") {
          sessionApproved.add(tool);
          return true;
        }
      }
    },

    async confirm(question, details) {
      if (opts.yes) return true;
      if (!interactive) return false;
      if (details) process.stdout.write("\n" + details + "\n");
      for (;;) {
        const answer = await askCatch(`\n${question} [y]es / [n]o > `);
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
      }
    },

    close() {
      rl?.close();
      rl = null;
    },
  };
}
