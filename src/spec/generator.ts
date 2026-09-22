/**
 * Spec generator — turns a repo scan into a living spec, and turns a task
 * description into a spec delta proposal (the SDD "spec first" step).
 *
 * Philosophy: the model proposes, the human (or an explicit --auto flag)
 * approves, the result is plain Markdown in the repo. No hidden state.
 */
import type { RepoScan, SpecBundle, SpecDelta } from "./types.ts";
import fs from "node:fs";
import path from "node:path";
import type { LlmProvider, ModelInfo } from "../llm/types.ts";
import { complete, parseJsonLoose } from "../llm/complete.ts";
import { ARCHITECTURE_FILE, CONSTITUTION_FILE, nextDecisionNumber, writeSpec } from "./store.ts";

export interface GeneratorDeps {
  provider: LlmProvider;
  model: ModelInfo;
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

const SPEC_SYSTEM = `You are Memento's spec author. You write precise, terse, senior-engineer-grade project specs in Markdown.
Rules:
- Ground every statement in the provided repository scan. Never invent directories, commands, or dependencies that are not evidenced.
- Prefer concrete, checkable statements over vague prose ("tests live in tests/ and run with \`npm test\`" beats "the project is well tested").
- Keep specs short enough to stay true: no filler, no marketing language.
- Respond with the requested content ONLY — no preamble, no explanation.`;

function scanDigest(scan: RepoScan): string {
  const langs = scan.languages.slice(0, 6).map((l) => `${l.name} (${l.files} files)`).join(", ");
  return [
    `File count: ${scan.fileCount}, total size: ${Math.round(scan.totalBytes / 1024)} KB`,
    `Languages: ${langs || "unknown"}`,
    `Top-level entries: ${scan.topLevel.join(", ")}`,
    `Likely test dirs: ${scan.testDirs.join(", ") || "none detected"}`,
    `Entry/manifest hints: ${scan.entryHints.slice(0, 12).join(", ") || "none"}`,
    scan.packageManifest ? `--- manifest ---\n${scan.packageManifest}` : "",
    scan.readmeExcerpt ? `--- README excerpt ---\n${scan.readmeExcerpt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateConstitution(deps: GeneratorDeps, scan: RepoScan): Promise<string> {
  deps.onProgress?.("Drafting constitution (project discipline)…");
  const res = await complete({
    provider: deps.provider,
    model: deps.model,
    ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    system: SPEC_SYSTEM,
    user: `Write the project constitution for this repository.

Format (Markdown, keep this structure):

# Constitution — {project name}

> Non-negotiables. Memento may propose changes to this file but never auto-edits it. Humans approve.

## Mission
(1-3 sentences: what this project is, who it serves — infer from README/manifest)

## Technical discipline
- Runtime & language (with versions when evidenced)
- Package manager & dependency policy
- Test policy (where tests live, how to run them — use real commands from the manifest)

## Quality gates
(Bullet list of concrete commands a change must pass before it is "done". Only commands evidenced by the manifest or standard for the detected stack.)

## Forbidden
(Practices clearly ruled out — e.g. committing secrets, editing lockfiles by hand, mixing package managers. Infer cautiously; only list things that are safely universal or evidenced.)

Repository scan:
${scanDigest(scan)}`,
  });
  if (res.error || !res.text.trim()) {
    throw new Error(`Constitution generation failed: ${res.error ?? "empty response"}`);
  }
  return res.text.trim() + "\n";
}

export async function generateArchitecture(deps: GeneratorDeps, scan: RepoScan): Promise<string> {
  deps.onProgress?.("Drafting architecture spec…");
  const res = await complete({
    provider: deps.provider,
    model: deps.model,
    ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    system: SPEC_SYSTEM,
    user: `Write the architecture spec for this repository.

Format (Markdown, keep this structure):

# Architecture — {project name}

## Overview
(2-4 sentences on the system's shape)

## Modules
(For each significant top-level module/directory: name, responsibility, key files. Base this on the scan; mark uncertain inferences with "(inferred)".)

## Data flow
(How a typical request/operation moves through the system. If not determinable, state the most likely flow and mark it as inferred.)

## Key dependencies
(Notable libraries/frameworks and what they are used for.)

## Extension points
(Where new code typically plugs in: plugin dirs, registries, config files.)

Repository scan:
${scanDigest(scan)}`,
  });
  if (res.error || !res.text.trim()) {
    throw new Error(`Architecture generation failed: ${res.error ?? "empty response"}`);
  }
  return res.text.trim() + "\n";
}

export async function generateFeatureOverview(deps: GeneratorDeps, scan: RepoScan): Promise<string> {
  deps.onProgress?.("Drafting feature overview…");
  const res = await complete({
    provider: deps.provider,
    model: deps.model,
    ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    system: SPEC_SYSTEM,
    user: `Write a capability-level feature overview for this repository as feature specs.

Format (Markdown):

# Features — {project name}

For each capability you can evidence (3-8 features), a section:

## {Feature name}
- **Status**: implemented | partial | planned (inferred from code evidence)
- **Entry points**: files/dirs implementing it
- **Behavior**: 2-4 bullet points of externally observable behavior
- **Open questions**: what a newcomer would still need to ask

Repository scan:
${scanDigest(scan)}
Sampled source files: ${scan.sampledFiles.slice(0, 20).join(", ") || "none"}`,
  });
  if (res.error || !res.text.trim()) {
    throw new Error(`Feature overview generation failed: ${res.error ?? "empty response"}`);
  }
  return res.text.trim() + "\n";
}

export interface InitSpecOptions extends GeneratorDeps {
  root: string;
  scan: RepoScan;
  /** Overwrite existing files when true. */
  force?: boolean;
}

export interface InitSpecResult {
  written: string[];
  skipped: string[];
}

export async function generateInitialSpec(opts: InitSpecOptions): Promise<InitSpecResult> {
  const { root, scan, force } = opts;
  const written: string[] = [];
  const skipped: string[] = [];

  const targets: { file: string; gen: () => Promise<string> }[] = [
    { file: CONSTITUTION_FILE, gen: () => generateConstitution(opts, scan) },
    { file: ARCHITECTURE_FILE, gen: () => generateArchitecture(opts, scan) },
    { file: ".memento/spec/features/overview.md", gen: () => generateFeatureOverview(opts, scan) },
  ];

  for (const target of targets) {
    // Fresh start: no force and file exists → skip
    if (!force && fs.existsSync(path.join(root, target.file))) {
      skipped.push(target.file);
      continue;
    }
    const content = await target.gen();
    writeSpec(root, target.file, content);
    written.push(target.file);
  }
  return { written, skipped };
}

/**
 * Propose a spec delta for a task — the "spec first" gate of every run.
 * Returns null when the task needs no spec change (pure bugfix, formatting…).
 */
export async function proposeSpecDelta(
  deps: GeneratorDeps,
  task: string,
  bundle: SpecBundle,
  relevant: string,
): Promise<SpecDelta | null> {
  deps.onProgress?.("Checking whether the task changes the spec…");
  const featureList = bundle.features.map((f) => f.relPath).join(", ") || "(none yet)";
  const res = await complete({
    provider: deps.provider,
    model: deps.model,
    ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    system: `You are Memento's spec gatekeeper. Given a task and the current spec, decide whether the task changes the project's specification.
A spec change is required when the task: adds/changes/removes externally visible behavior, changes architecture, or overrides a constitution rule.
No spec change is required for: pure bugfixes that restore documented behavior, formatting, dependency bumps, refactors with identical behavior.

Respond with JSON only:
{"needsSpecChange": true|false, "target": ".memento/spec/features/<slug>.md", "rationale": "one sentence", "action": "create"|"update", "content": "full proposed markdown for the spec file"}
When needsSpecChange is false, omit all other fields except "rationale" (explain why no change is needed).`,
    user: `Task: ${task}

Existing feature specs: ${featureList}

Relevant spec excerpts:
${relevant || "(none)"}

Write the full proposed content for the target spec file. Requirements:
- Match the existing spec style (like the excerpts above).
- Include: purpose, behavior contract (bullets), edge cases, and an "Acceptance" section with checkable items.
- Terse, senior-engineer tone. No fluff.`,
    maxTokens: Math.min(deps.model.maxOutput, 6000),
  });

  if (res.error || !res.text.trim()) return null;
  const parsed = parseJsonLoose<{
    needsSpecChange: boolean;
    target?: string;
    rationale?: string;
    action?: "create" | "update";
    content?: string;
  }>(res.text);
  if (!parsed) return null;
  if (!parsed.needsSpecChange) return null;
  if (!parsed.target || !parsed.content) return null;
  // The spec gate may only ever touch spec files. A model suggesting a
  // target outside .memento/spec/ (README.md, package.json, a source file…)
  // is rejected outright — the gate must never become a way to edit
  // arbitrary files through user approval. Same rule as reflect's
  // sanitizeSuggestions.
  if (!parsed.target.startsWith(".memento/spec/")) return null;
  if (parsed.content.length > 20_000) return null;
  const action = parsed.action ?? (bundle.all.some((f) => f.relPath === parsed.target) ? "update" : "create");
  return {
    target: parsed.target,
    rationale: parsed.rationale ?? "",
    content: parsed.content,
    action,
  };
}

export function decisionPath(root: string, title: string): string {
  const n = nextDecisionNumber(root);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `.memento/spec/decisions/${String(n).padStart(4, "0")}-${slug || "decision"}.md`;
}
