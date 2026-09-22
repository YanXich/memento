/**
 * `memento bench` — the memory benchmark.
 *
 * Runs a family of similar tasks in sequence and measures whether the agent
 * gets measurably faster as memory accumulates. For every task two runs are
 * compared:
 *
 *   COLD — a pristine copy of the repo, no lessons recalled, no reflection.
 *          "What would a memoryless agent cost?"
 *   WARM — the shared run directory, recalling everything earlier tasks
 *          taught and reflecting afterwards. "What does memento cost?"
 *
 * The delta between the two curves is the whole product thesis with numbers:
 * lessons make the next task cheaper. `--dry` swaps in a deterministic mock
 * provider (zero network) so the harness itself is testable and demoable.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import type { Workspace } from "../workspace.ts";
import { attachMcpServers, attachPlugins, createWorkspace, resolveLlm } from "../workspace.ts";
import { SessionLog } from "../../kernel/session.ts";
import { runLoop } from "../../kernel/loop.ts";
import { buildLoopHooks } from "../hooks.ts";
import { runAftermath } from "../aftermath.ts";
import { recallSpec } from "../../spec/recall.ts";
import { formatLessons, recallLessons } from "../../memory/recall.ts";
import { buildSystemPrompt } from "../../prompts.ts";
import { buildRepoMap } from "../../kernel/repomap.ts";
import { messageId } from "../../util/ids.ts";
import { oneLine } from "../../util/text.ts";
import { renderReportHtml } from "./bench-report.ts";
import { VERSION } from "../../version.ts";
import type { LlmProvider, LlmRequest, ModelInfo, StreamEvent } from "../../llm/types.ts";
import type { Message } from "../../llm/types.ts";
import { textOf } from "../../llm/types.ts";

export interface BenchTask {
  name: string;
  task: string;
}

export interface BenchOptions {
  /** JSON file: `{ "tasks": [{ "name": ..., "task": ... }] }` or a bare array. */
  file: string;
  root: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  /** Deterministic mock provider — zero network, for CI and demos. */
  dry?: boolean;
  /** Keep the run directory for inspection. */
  keep?: boolean;
  /** Machine-readable output. */
  json?: boolean;
  /** Write a brand-styled standalone HTML report to this path. */
  report?: string;
  /** Skip the cold runs (warm learning curve only). */
  noCold?: boolean;
  /**
   * Parallelism: cold copies are independent and run on a worker pool while
   * the warm chain (which must stay sequential — each task inherits the
   * previous one's memory) advances on its own worker.
   * Default: all tasks in parallel for --dry (no rate limits), 2 for real
   * providers. `1` restores the fully sequential schedule.
   */
  jobs?: number;
}

export interface BenchRun {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  lessons: number;
  status: string;
}

export interface BenchResult {
  name: string;
  task: string;
  cold: BenchRun | null;
  warm: BenchRun;
}

/** Directories never copied into bench sandboxes — copies stay fast. */
const COPY_EXCLUDES = new Set(["node_modules", ".git", ".memento", "dist", "site", "_shots", ".demo"]);

const DRY_MODEL: ModelInfo = { id: "bench-dry", contextWindow: 100_000, maxOutput: 4_096, supportsTools: true };

/**
 * Deterministic stand-in for a real provider. Three scripted behaviours,
 * selected by what the request carries:
 *
 *   1. reflect pass (system mentions "reflection engine") → one fresh lesson,
 *      so the warm run accumulates memory exactly like a real session.
 *   2. lessons recalled (system carries "Lessons from previous sessions") →
 *      answer at once: the task costs one turn.
 *   3. no memory → fumble one orienting tool call first, then answer: two
 *      turns. The fumble is stateful — without it the loop would spin forever.
 *
 * Everything is scripted so the harness is reproducible in CI and demos.
 */
function dryProvider(): LlmProvider {
  return {
    id: "bench-dry",
    label: "bench dry-run",
    models: [DRY_MODEL],
    resolveModel: (id: string) => (id === DRY_MODEL.id ? DRY_MODEL : undefined),
    async *stream(req: LlmRequest): AsyncIterable<StreamEvent> {
      const system = req.system ?? "";
      const isReflect = system.includes("reflection engine");
      const hasLessons = system.includes("Lessons from previous sessions");
      const fumbled = req.messages.some(
        (m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall"),
      );
      yield { type: "start" };
      if (isReflect) {
        // Reflection: emit one durable lesson per task so the warm curve grows.
        // The lesson quotes the task verbatim — recall's term-overlap matcher
        // then finds it for the next task in the family.
        const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
        const raw = lastUser ? textOf(lastUser) : "this task";
        const taskMatch = raw.match(/task:\s*(.+)/);
        const taskText = oneLine(taskMatch?.[1] ?? raw, 48);
        const lesson = {
          observations: [
            {
              text: `dry lesson: "${taskText}" is covered by recalled memory`,
              kind: "discovery",
              evidence: "bench dry reflect",
              relation: "new",
            },
          ],
          specSuggestions: [],
          summary: "dry bench reflect pass",
        };
        yield { type: "text_delta", text: JSON.stringify(lesson) };
        yield { type: "done", stopReason: "end", usage: { inputTokens: 900, outputTokens: 80 } };
        return;
      }
      if (hasLessons) {
        // Lessons recalled: straight to the answer.
        yield { type: "text_delta", text: "Done — the recalled lessons cover this task; no changes needed." };
        yield { type: "done", stopReason: "end", usage: { inputTokens: 1_400, outputTokens: 40 } };
        return;
      }
      if (fumbled) {
        // Second turn after the orienting fumble: now finish.
        yield { type: "text_delta", text: "Done." };
        yield { type: "done", stopReason: "end", usage: { inputTokens: 1_300, outputTokens: 30 } };
        return;
      }
      // Memoryless first turn: waste it orienting.
      const id = "call_1";
      yield { type: "toolcall_start", id, name: "bash" };
      yield { type: "toolcall_delta", id, argsDelta: JSON.stringify({ command: "pwd", purpose: "orient" }) };
      yield { type: "toolcall_end", id };
      yield { type: "done", stopReason: "toolUse", usage: { inputTokens: 1_200, outputTokens: 60 } };
    },
  };
}

export async function benchTask(opts: BenchOptions): Promise<number> {
  let tasks: BenchTask[];
  try {
    // The tasks file is relative to the workspace root (-C), not the shell cwd.
    const raw = JSON.parse(fs.readFileSync(path.resolve(opts.root, opts.file), "utf8")) as BenchTask[] | { tasks: BenchTask[] };
    tasks = Array.isArray(raw) ? raw : (raw.tasks ?? []);
  } catch (err) {
    process.stderr.write(pc.red(`cannot read bench tasks: ${(err as Error).message}\n`));
    return 1;
  }
  if (tasks.length === 0) {
    process.stderr.write(pc.red(`no tasks in ${opts.file} — expected {"tasks":[{"name":"…","task":"…"}]}\n`));
    return 1;
  }

  // The shared warm directory accumulates memory across tasks; cold runs get
  // pristine copies so they can never see it.
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-bench-"));
  copyRepo(opts.root, runDir);

  // JSON mode owns stdout: silence everything the loop prints (tool progress,
  // reflection, hints) so stdout stays machine-readable. stderr is untouched.
  const realWrite = opts.json ? process.stdout.write : null;
  if (realWrite) process.stdout.write = (() => true) as typeof process.stdout.write;

  const providerLabel = opts.dry ? "bench-dry" : opts.provider ? `${opts.provider}/${opts.model ?? "?"}` : "configured provider";
  if (!opts.json) {
    process.stdout.write(
      pc.magenta(pc.bold("◈ memento bench")) +
        pc.dim(` v${VERSION} · ${tasks.length} task(s) · `) +
        pc.cyan(providerLabel) +
        pc.dim(` · ${opts.root}\n\n`),
    );
  }

  const results: BenchResult[] = [];
  try {
    const jobs = Math.max(1, Math.min(opts.jobs ?? (opts.dry ? tasks.length : 2), tasks.length));
    if (jobs === 1) {
      for (const [i, task] of tasks.entries()) {
        if (!opts.json) {
          process.stdout.write(pc.dim(`task ${i + 1}/${tasks.length}: ${task.name}\n`));
        }
        let cold: BenchRun | null = null;
        if (!opts.noCold) {
          const coldDir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-bench-cold-"));
          copyRepo(opts.root, coldDir);
          cold = await runOnce(coldDir, task.task, opts, { recall: false, reflect: false });
          fs.rmSync(coldDir, { recursive: true, force: true });
        }
        const warm = await runOnce(runDir, task.task, opts, { recall: true, reflect: true });
        results.push({ name: task.name, task: task.task, cold, warm });
      }
    } else {
      await runParallel(tasks, runDir, opts, jobs, results);
    }
  } finally {
    // Whatever happened, stdout must be sane again before the report runs.
    if (realWrite) process.stdout.write = realWrite;
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          // Machine-readable ids for the leaderboard merge; providerLabel stays
          // in the human report only. Explicit --provider/--model flags win;
          // otherwise the resolved config lives inside each run, so the JSON
          // degrades to "configured" rather than guessing.
          provider: opts.dry ? "bench-dry" : opts.provider ?? "configured",
          model: opts.dry ? DRY_MODEL.id : opts.model ?? "configured",
          root: opts.root,
          dry: Boolean(opts.dry),
          tasks: results,
          runDir: opts.keep ? runDir : undefined,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    printReport(results);
  }

  if (opts.report) {
    const html = renderReportHtml(
      {
        provider: providerLabel,
        root: opts.root,
        dry: Boolean(opts.dry),
        generatedAt: new Date().toISOString(),
      },
      results,
    );
    const target = path.resolve(opts.report);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, html, "utf8");
    if (!opts.json) process.stdout.write(pc.green(`\nreport → ${opts.report} (plain HTML, share-ready)\n`));
  }

  if (!opts.keep) fs.rmSync(runDir, { recursive: true, force: true });
  else if (!opts.json) process.stdout.write(pc.dim(`\nrun dir kept at ${runDir}\n`));
  return 0;
}

/**
 * Parallel schedule for the benchmark.
 *
 * Cold copies are independent by construction — each task gets its own
 * pristine sandbox — so they fan out over `jobs - 1` workers. The warm chain
 * is the opposite: every warm run accumulates lessons for the next one, so it
 * stays strictly sequential and rides its own worker, starting immediately
 * and overlapping with the cold pool. Result slots are written by task index,
 * so the output array keeps task order no matter how workers interleave.
 */
async function runParallel(tasks: BenchTask[], runDir: string, opts: BenchOptions, jobs: number, results: BenchResult[]): Promise<void> {
  // Slots keep task order; `warm` is guaranteed filled before this returns.
  for (const t of tasks) {
    results.push({ name: t.name, task: t.task, cold: null, warm: null as unknown as BenchRun });
  }
  // Cold runs live here as promises while workers claim them; a defined slot
  // marks a claimed task, so workers never double-book.
  const coldPromises: Array<Promise<BenchRun> | undefined> = new Array(tasks.length);
  const progress = (i: number, label: string): void => {
    if (!opts.json) process.stdout.write(pc.dim(`task ${i + 1}/${tasks.length}: ${tasks[i]!.name} · ${label}\n`));
  };

  const coldPool = opts.noCold
    ? []
    : Array.from({ length: Math.max(1, jobs - 1) }, async () => {
        for (let i = 0; i < tasks.length; i++) {
          if (coldPromises[i]) continue; // already claimed by a peer worker
          coldPromises[i] = (async () => {
            const coldDir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-bench-cold-"));
            copyRepo(opts.root, coldDir);
            try {
              return await runOnce(coldDir, tasks[i]!.task, opts, { recall: false, reflect: false });
            } finally {
              fs.rmSync(coldDir, { recursive: true, force: true });
            }
          })();
          progress(i, "cold");
        }
      });

  const warmChain = (async () => {
    for (let i = 0; i < tasks.length; i++) {
      progress(i, "warm");
      results[i]!.warm = await runOnce(runDir, tasks[i]!.task, opts, { recall: true, reflect: true });
    }
  })();

  await Promise.all([...coldPool, warmChain]);
  // Array.from (not .map) — the slot array is sparse and .map skips holes.
  const colds = await Promise.all(Array.from(coldPromises, (p) => p ?? Promise.resolve(null)));
  colds.forEach((cold, i) => {
    results[i]!.cold = cold;
  });
}

/** One benchmark run: build the loop, run it, optionally reflect. */
async function runOnce(
  dir: string,
  task: string,
  opts: BenchOptions,
  mode: { recall: boolean; reflect: boolean },
): Promise<BenchRun> {
  const ws = createWorkspace(dir);
  let provider: LlmProvider;
  let model: ModelInfo;
  let apiKey: string | undefined;
  if (opts.dry) {
    provider = dryProvider();
    model = DRY_MODEL;
  } else {
    const llm = resolveLlm(ws, opts.provider, opts.model);
    if ("error" in llm) throw new Error(llm.error);
    ({ provider, model, apiKey } = llm);
  }
  await attachPlugins(ws);
  await attachMcpServers(ws);

  const session = SessionLog.create(path.join(dir, ".memento", "sessions"), {
    cwd: dir,
    model: model.id,
    provider: provider.id,
    task,
    mementoVersion: VERSION,
  });

  try {
    const specContext = mode.recall ? recallSpec(ws.spec, task, { budget: 6000 }) : "";
    const lessons = mode.recall ? recallLessons(ws.lessons, task, { max: 12 }) : [];
    const repoMap = buildRepoMap(dir);
    const system = buildSystemPrompt({
      cwd: dir,
      specContext,
      lessonsContext: formatLessons(lessons),
      repoMap,
    });

    const llmRef = { provider, model, ...(apiKey ? { apiKey } : {}) };
    const hooks = buildLoopHooks(ws, llmRef);

    const userMsg: Message = {
      id: messageId(),
      role: "user",
      content: [{ type: "text", text: task }],
      ts: Date.now(),
      source: "user",
    };
    session.appendMessage(userMsg);

    const result = await runLoop(
      {
        provider,
        model,
        ...(apiKey ? { apiKey } : {}),
        system,
        cwd: dir,
        registry: ws.tools,
        session,
        bus: ws.bus,
        hooks,
        maxTurns: opts.maxTurns ?? 40,
        compactAt: ws.config.compactAt ?? 0.8,
        approve: async () => true,
      },
      [userMsg],
    ).catch(async (err) => {
      session.appendNote(`bench run crashed: ${(err as Error).message}`, "system");
      session.appendResult("error", 0);
      return {
        status: "error" as const,
        turns: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [],
        error: (err as Error).message,
      };
    });

    if (mode.reflect && result.status !== "aborted") {
      await runAftermath(ws, llmRef, session, result, task, undefined, {
        verify: false,
        reflect: true,
        commitHint: false,
      });
    }

    const stats = ws.lessons.stats();
    return {
      turns: result.turns,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      lessons: stats.active,
      status: result.status,
    };
  } finally {
    session.close();
    await ws.close();
  }
}

/** Copy a repo into a bench sandbox, skipping directories that only slow it down. */
function copyRepo(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dst, entry.name), { recursive: true });
  }
}

function printReport(results: BenchResult[]): void {
  const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  process.stdout.write("\n" + pc.bold("results") + pc.dim(" — cold = pristine copy, no memory · warm = recalled lessons\n\n"));
  const rows = results.map((r) => {
    const saved = (coldV: number, warmV: number): string => {
      if (!coldV) return "—";
      const pct = Math.round(((coldV - warmV) / coldV) * 100);
      return pct > 0 ? pc.green(`−${pct}%`) : pct === 0 ? pc.dim("±0%") : pc.red(`+${Math.abs(pct)}%`);
    };
    const coldCol = r.cold
      ? `${String(r.cold.turns).padStart(5)}  ${String(k(r.cold.inputTokens)).padStart(7)}`
      : "    —        —";
    const warmCol = `${String(r.warm.turns).padStart(5)}  ${String(k(r.warm.inputTokens)).padStart(7)}`;
    const savedCol = r.cold
      ? `${saved(r.cold.turns, r.warm.turns)}   ${saved(r.cold.inputTokens, r.warm.inputTokens)}`
      : pc.dim("—");
    return `  ${pc.cyan(r.name.padEnd(24))}${coldCol}    ${warmCol}    ${savedCol}    ${pc.dim(`${r.warm.lessons} lessons`)}`;
  });
  process.stdout.write(
    pc.dim("  ") + pc.dim(pc.bold("task")) + pc.dim("                    cold(turns  tokens)  warm(turns  tokens)  saved(turns  tokens)  memory\n") + rows.join("\n") + "\n",
  );

  // The warm learning curve — does the agent get faster as memory grows?
  const maxTurns = Math.max(...results.map((r) => r.warm.turns), 1);
  process.stdout.write("\n" + pc.bold("memory curve") + pc.dim(" — warm turns per task as lessons accumulate\n\n"));
  for (const r of results) {
    const bar = "█".repeat(Math.max(1, Math.round((r.warm.turns / maxTurns) * 14)));
    process.stdout.write(`  ${pc.cyan(r.name.padEnd(24))}${pc.magenta(bar.padEnd(14))} ${r.warm.turns}\n`);
  }
  const first = results[0];
  const last = results[results.length - 1];
  if (results.length > 1 && first && last && first.warm.turns > 0) {
    const pct = Math.round(((first.warm.turns - last.warm.turns) / first.warm.turns) * 100);
    process.stdout.write(
      pct > 0
        ? `\n  ${pc.green(`✓ memory reduced turns by ${pct}% from the first to the last task`)}\n`
        : `\n  ${pc.dim("no turn reduction measured — try a family of more similar tasks")}\n`,
    );
  }
  process.stdout.write(pc.dim(`\n  tip: families of similar tasks (e.g. "${oneLine(first?.task ?? "", 50)}") learn fastest\n`));
}
