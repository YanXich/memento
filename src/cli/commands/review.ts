/**
 * `memento review` — a code review with the project's memory behind it.
 *
 * One LLM call: the working diff, the recalled lessons, and the relevant spec
 * sections go in; a structured list of findings comes out. The memory angle is
 * the point — the review flags changes that contradict hard-won lessons
 * ("we fixed that leak twice already") and spec commitments, which a generic
 * reviewer cannot know.
 *
 * The command never writes, never blocks, never merges. It prints suggestions;
 * CI can consume `--json` and a GitHub Actions workflow ships with the repo.
 */
import { execFileSync } from "node:child_process";
import pc from "picocolors";
import type { LlmProvider, ModelInfo, StreamEvent } from "../../llm/types.ts";
import { complete } from "../../llm/complete.ts";
import { createWorkspace, resolveLlm, type Workspace } from "../workspace.ts";
import { recallLessons, formatLessons } from "../../memory/recall.ts";
import { recallSpec } from "../../spec/recall.ts";

const MAX_DIFF_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 6_000;

export interface ReviewOptions {
  root: string;
  providerId?: string;
  modelId?: string;
  base?: string;
  dry?: boolean;
  json?: boolean;
}

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: "error" | "warning" | "nit";
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  notes: string[];
}

const DRY_MODEL: ModelInfo = {
  id: "review-dry",
  label: "review dry-run",
  contextWindow: 32_000,
  maxOutput: 4_000,
  supportsTools: false,
};

/** Deterministic zero-network provider — CI smoke tests and demos. */
function dryProvider(): LlmProvider {
  return {
    id: "review-dry",
    label: "review dry-run",
    models: [DRY_MODEL],
    resolveModel: (id: string) => (id === DRY_MODEL.id ? DRY_MODEL : undefined),
    async *stream(): AsyncIterable<StreamEvent> {
      const findings: ReviewFinding[] = [
        {
          file: "src/auth/login.ts",
          line: 12,
          severity: "warning",
          message: "rate limit lives in middleware now — inline checks duplicate it",
          suggestion: "import the shared middleware instead",
        },
        {
          file: "README.md",
          severity: "nit",
          message: "document the new env var",
        },
      ];
      yield { type: "start" };
      yield { type: "text_delta", text: JSON.stringify({ findings, notes: ["dry run — deterministic demo output"] }) };
      yield { type: "done", stopReason: "end", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

/**
 * The diff under review: `git diff <base>` when --base is given, otherwise
 * the full working-tree diff (staged + unstaged + untracked), or null when
 * there is nothing to review / not a repo.
 */
function reviewDiff(root: string, base?: string): string | null {
  try {
    const args = base ? ["diff", base, "--unified=3"] : ["diff", "HEAD", "--unified=3"];
    const diff = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const body = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n… [diff truncated]" : diff;
    return body || null;
  } catch {
    return null;
  }
}

/** Build the reviewer system prompt from workspace memory + spec (exported for tests). */
export function buildSystemPrompt(ws: Workspace, diff: string): { system: string; notes: string[] } {
  const notes: string[] = [];
  const task = `review these changes:\n${diff.slice(0, 2_000)}`;
  const lessons = recallLessons(ws.lessons, task, { max: 10 });
  const specContext = recallSpec(ws.spec, task, { budget: MAX_CONTEXT_CHARS });
  const lessonsContext = formatLessons(lessons);
  if (lessons.length === 0) notes.push("no lessons recalled for this diff");
  if (!specContext) notes.push("no spec sections matched");

  const system = [
    "You are a rigorous code reviewer for this repository.",
    "Output STRICT JSON only: {\"findings\":[{\"file\":string,\"line\"?:number,\"severity\":\"error\"|\"warning\"|\"nit\",\"message\":string,\"suggestion\"?:string}],\"notes\":[string]}.",
    "Rules:",
    "- severity 'error' only for correctness/security bugs, not style.",
    "- flag changes that contradict the project's hard-won lessons below — the team has fixed these before.",
    "- flag changes that violate the spec commitments below.",
    "- be specific: file paths exactly as they appear in the diff, real line numbers from the new version.",
    "- no praise, no summaries, no markdown fences — only the JSON.",
    "",
    "## Project lessons (recalled for this diff)",
    lessonsContext || "(none)",
    "",
    "## Spec context (recalled for this diff)",
    specContext || "(none)",
  ].join("\n");
  return { system, notes };
}

/** Parse the model's JSON answer; falls back to a single raw note (exported for tests). */
export function parseFindings(raw: string): ReviewResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as { findings?: ReviewFinding[]; notes?: string[] };
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((f) => f && typeof f.file === "string" && f.file.trim().length > 0 && typeof f.message === "string" && f.message.trim().length > 0)
          .map((f) => ({
            file: f.file,
            ...(typeof f.line === "number" ? { line: f.line } : {}),
            severity: (f.severity === "error" || f.severity === "nit" ? f.severity : "warning") as ReviewFinding["severity"],
            message: f.message.slice(0, 500),
            ...(typeof f.suggestion === "string" ? { suggestion: f.suggestion.slice(0, 500) } : {}),
          }))
      : [];
    const notes = Array.isArray(parsed.notes) ? parsed.notes.map(String).slice(0, 10) : [];
    return { findings, notes };
  } catch {
    // The model did not answer in JSON — fall back to a single note so CI
    // never crashes on a parse and the human still sees the raw answer.
    return { findings: [], notes: ["model output was not valid JSON — raw answer below", raw.slice(0, 2_000)] };
  }
}

export async function reviewTask(opts: ReviewOptions): Promise<number> {
  const diff = reviewDiff(opts.root, opts.base);
  if (diff === null) {
    process.stdout.write(pc.dim("nothing to review — the diff is empty (or git is unavailable)\n"));
    return 0;
  }

  const ws = createWorkspace(opts.root);
  const { system, notes } = buildSystemPrompt(ws, diff);

  let provider: LlmProvider;
  let model: ModelInfo;
  let apiKey: string | undefined;
  if (opts.dry) {
    provider = dryProvider();
    model = DRY_MODEL;
  } else {
    const llm = resolveLlm(ws, opts.providerId, opts.modelId);
    if ("error" in llm) {
      process.stderr.write(pc.red(llm.error) + "\n" + pc.dim("memento init, or pass --provider/--model\n"));
      return 1;
    }
    ({ provider, model, apiKey } = llm);
  }

  const result = await complete({
    provider,
    model,
    ...(apiKey ? { apiKey } : {}),
    system,
    user: `Review the following changes:\n\n${diff}`,
    maxTokens: Math.min(model.maxOutput, 4_000),
    temperature: 0.1,
  });

  if (result.error && !result.text) {
    process.stderr.write(pc.red(`review failed: ${result.error}\n`));
    return 1;
  }

  const review = parseFindings(result.text);
  const allNotes = [...notes, ...review.notes];

  if (opts.json) {
    process.stdout.write(JSON.stringify({ findings: review.findings, notes: allNotes, diffChars: diff.length }, null, 2) + "\n");
    return review.findings.some((f) => f.severity === "error") ? 1 : 0;
  }

  const sevColor = { error: pc.red("error"), warning: pc.yellow("warn"), nit: pc.dim("nit") } as const;
  process.stdout.write(`\n${pc.magenta("◈")} ${pc.bold("memento review")} — ${review.findings.length} finding(s)\n`);
  for (const f of review.findings) {
    const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
    process.stdout.write(`\n  ${sevColor[f.severity].padEnd(9)} ${pc.cyan(loc)}\n    ${f.message}\n`);
    if (f.suggestion) process.stdout.write(`    ${pc.dim("→")} ${pc.dim(f.suggestion)}\n`);
  }
  for (const note of allNotes) process.stdout.write(`  ${pc.dim("·")} ${pc.dim(note)}\n`);
  process.stdout.write(
    pc.dim("\nreview is advisory — memento never blocks or merges; it is your call\n"),
  );
  return 0;
}
