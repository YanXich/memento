/**
 * `memento spec …` — the specification lifecycle, minus the ceremony.
 *
 *   init     scan the repo, draft constitution + architecture + features
 *   status   what spec exists, when it changed last
 *   verify   run checkers against the tree (deterministic, no LLM)
 *   show     print the spec (or one file of it)
 *   decision record an ADR stub (context / decision / consequences)
 */
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { createWorkspace, attachPlugins, resolveLlm } from "../workspace.ts";
import { scanRepo } from "../../spec/scanner.ts";
import { decisionPath, generateInitialSpec } from "../../spec/generator.ts";
import { loadSpecBundle, specStatus, writeSpec } from "../../spec/store.ts";
import { verifySpec } from "../../spec/verify.ts";
import { formatBytes } from "../../util/text.ts";

export interface SpecInitOptions {
  root: string;
  provider?: string;
  model?: string;
  force?: boolean;
  /** Skip LLM calls — only print the deterministic scan. */
  scanOnly?: boolean;
}

export async function specInit(opts: SpecInitOptions): Promise<number> {
  const ws = createWorkspace(opts.root);
  process.stdout.write(pc.dim(`scanning ${ws.root} …\n`));
  const scan = scanRepo(ws.root);
  process.stdout.write(
    `  ${scan.fileCount} files, ${formatBytes(scan.totalBytes)}, ` +
      `languages: ${scan.languages.slice(0, 4).map((l) => `${l.name} (${l.files})`).join(", ") || "none detected"}\n`,
  );
  if (scan.testDirs.length) process.stdout.write(`  test dirs: ${scan.testDirs.join(", ")}\n`);
  if (scan.entryHints.length) process.stdout.write(`  entry hints: ${scan.entryHints.slice(0, 8).join(", ")}\n`);

  if (opts.scanOnly) {
    process.stdout.write(pc.dim("\n--scan-only: no spec written. Drop the flag to generate the spec with the model.\n"));
    return 0;
  }

  const llm = resolveLlm(ws, opts.provider, opts.model);
  if ("error" in llm) {
    process.stderr.write(pc.red(`\n${llm.error}\n`));
    return 2;
  }

  process.stdout.write(pc.dim(`\ndrafting spec with ${llm.provider.id}/${llm.model.id} (3 focused calls)…\n`));
  const result = await generateInitialSpec({
    ...opts,
    provider: llm.provider,
    model: llm.model,
    ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
    onProgress: (line) => process.stdout.write(pc.dim(`  ${line}\n`)),
    root: ws.root,
    scan,
  });

  for (const file of result.written) process.stdout.write(pc.green(`✓ ${file}\n`));
  for (const file of result.skipped) process.stdout.write(pc.dim(`= ${file} (exists — use --force to overwrite)\n`));
  process.stdout.write(pc.dim("\nReview the drafts — the constitution is a human contract, edit it freely.\n"));
  return 0;
}

export function specStatusCmd(root: string): number {
  const status = specStatus(root);
  const ws = createWorkspace(root);
  process.stdout.write(pc.bold(`\nspec status — ${ws.root}\n`));
  if (!status.initialized) {
    process.stdout.write(pc.yellow("  no spec found. Run `memento spec init` to draft one.\n"));
    return 1;
  }
  const row = (label: string, count: number, last: number) => {
    const when = last ? new Date(last).toISOString().slice(0, 10) : "—";
    process.stdout.write(`  ${label.padEnd(16)} ${String(count).padStart(2)} file(s)  last change: ${when}\n`);
  };
  const c = status.counts;
  row("constitution", c.constitution, status.lastUpdated.constitution);
  row("architecture", c.architecture, status.lastUpdated.architecture);
  row("features", c.feature, status.lastUpdated.feature);
  row("decisions", c.decision, status.lastUpdated.decision);
  process.stdout.write(pc.dim("\n  next: `memento spec verify` to check claims against the tree\n"));
  return 0;
}

export async function specVerifyCmd(root: string, asJson = false): Promise<number> {
  const ws = createWorkspace(root);
  try {
    // Plugin spec checkers load asynchronously (jiti) — verify must see them,
    // otherwise a checker a plugin registered would silently never run.
    await attachPlugins(ws);
    const bundle = loadSpecBundle(ws.root);
    const report = verifySpec(ws.root, bundle, ws.specCheckers);
    if (asJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return report.passed ? 0 : 1;
    }
    process.stdout.write(
      `\nspec verify — ${report.passed ? pc.green("passed") : pc.red("failed")} · ${report.checked} file(s) · ${report.issues.length} issue(s)\n`,
    );
    for (const issue of report.issues) {
      const tag = issue.severity === "error" ? pc.red("error") : issue.severity === "warning" ? pc.yellow("warn ") : pc.dim("info ");
      process.stdout.write(`  ${tag} [${issue.checker}] ${issue.file ? issue.file + ": " : ""}${issue.message}\n`);
    }
    if (report.issues.length === 0) process.stdout.write(pc.dim("  every checkable claim in the spec holds\n"));
    return report.passed ? 0 : 1;
  } finally {
    await ws.close();
  }
}

export function specShowCmd(root: string, file?: string): number {
  const ws = createWorkspace(root);
  if (!file) {
    if (ws.spec.all.length === 0) {
      process.stdout.write(pc.yellow("no spec found — run `memento spec init`\n"));
      return 1;
    }
    for (const f of ws.spec.all) {
      const age = new Date(f.updatedAt).toISOString().slice(0, 10);
      process.stdout.write(`${f.relPath}  ${pc.dim(`(${f.kind}, updated ${age})`)}\n`);
    }
    return 0;
  }
  const target = ws.spec.all.find((f) => f.relPath === file || f.relPath.endsWith("/" + file));
  if (!target) {
    process.stderr.write(pc.red(`spec file not found: ${file}\n`));
    return 1;
  }
  process.stdout.write(target.content);
  return 0;
}

export function specDecisionCmd(root: string, title: string): number {
  const ws = createWorkspace(root);
  const rel = decisionPath(ws.root, title);
  if (fs.existsSync(path.join(ws.root, rel))) {
    process.stderr.write(pc.red(`already exists: ${rel}\n`));
    return 1;
  }
  const today = new Date().toISOString().slice(0, 10);
  const content = `# ${title}

- **Status**: proposed
- **Date**: ${today}

## Context

(What forces are at play? What makes this decision necessary now?)

## Decision

(What we decided to do — one paragraph, present tense.)

## Consequences

(What becomes easier, what becomes harder, what we accept as a cost.)
`;
  writeSpec(ws.root, rel, content);
  process.stdout.write(pc.green(`✓ ${rel}\n`) + pc.dim("fill in the sections before committing — an empty ADR is a claim with no evidence.\n"));
  return 0;
}
