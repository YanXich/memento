/**
 * `memento plan <task>` — think before acting.
 *
 * RECALL (spec + lessons + repo map) → draft a plan with the model → show it
 * → ask the human → hand the approved plan to the full agent loop.
 *
 * This is the Plan/Act split users of aider and Cline keep asking for: the
 * expensive, irreversible part (code changes) starts only after a human has
 * looked at a map. Non-interactive shells default to "no".
 */
import pc from "picocolors";
import { createWorkspace, resolveLlm } from "../workspace.ts";
import { createApprover } from "../ui.ts";
import { recallSpec } from "../../spec/recall.ts";
import { formatLessons, recallLessons } from "../../memory/recall.ts";
import { buildRepoMap } from "../../kernel/repomap.ts";
import { PLAN_SYSTEM } from "../../prompts.ts";
import { complete } from "../../llm/complete.ts";
import { oneLine } from "../../util/text.ts";
import { runTask } from "./run.ts";

export interface PlanOptions {
  task: string;
  root: string;
  provider?: string;
  model?: string;
  /** Skip the confirmation prompt (CI-friendly). */
  yes?: boolean;
}

export async function planTask(opts: PlanOptions): Promise<number> {
  const ws = createWorkspace(opts.root);
  const llm = resolveLlm(ws, opts.provider, opts.model);
  if ("error" in llm) {
    process.stderr.write(pc.red(`\n${llm.error}\n`));
    return 2;
  }
  const { provider, model, apiKey } = llm;

  process.stdout.write(pc.cyan("\n▸ ") + pc.dim("recalling spec, lessons, and repo map\n"));
  const specContext = recallSpec(ws.spec, opts.task, { budget: 4000 });
  const lessons = recallLessons(ws.lessons, opts.task, { max: 8 });
  const repoMap = buildRepoMap(ws.root, { maxOutputChars: 6000 });

  process.stdout.write(pc.cyan("▸ ") + pc.dim("drafting plan\n"));
  const plan = await complete({
    provider,
    model,
    ...(apiKey ? { apiKey } : {}),
    system: PLAN_SYSTEM,
    user: [
      `## Task\n${opts.task}`,
      specContext.trim() ? `## Relevant spec\n${specContext.trim()}` : null,
      lessons.length ? `## Lessons from memory (binding unless disproven)\n${formatLessons(lessons)}` : null,
      `## Repository map\n${repoMap}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    maxTokens: Math.min(model.maxOutput, 4000),
  });

  if (plan.error || !plan.text.trim()) {
    process.stderr.write(pc.red(`\nplan generation failed: ${plan.error ?? "empty response"}\n`));
    return 2;
  }

  process.stdout.write(pc.magenta(pc.bold("\n◈ memento plan")) + pc.dim(" — ") + oneLine(opts.task, 80) + "\n");
  process.stdout.write(pc.dim("──────────────────────────────────────────\n"));
  process.stdout.write(plan.text.trim() + "\n");
  process.stdout.write(pc.dim("──────────────────────────────────────────\n"));

  const approver = createApprover({ yes: opts.yes });
  try {
    const proceed = await approver.confirm("Proceed with this plan?");
    if (!proceed) {
      process.stdout.write(pc.dim("plan discarded — nothing was changed\n"));
      return 0;
    }
  } finally {
    approver.close();
  }

  process.stdout.write(pc.cyan("\n▸ ") + pc.dim("plan approved — handing it to the agent\n"));
  return runTask({
    task: opts.task,
    root: opts.root,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    yes: opts.yes,
    plan: plan.text.trim(),
  });
}
