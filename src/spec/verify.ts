/**
 * Spec verifiers — the "answers back" part of a living spec.
 *
 * A spec that cannot be checked is a wish, not a spec. These checkers are
 * deterministic (no LLM): they compare spec claims against the filesystem.
 * Plugin checkers run through the same interface via the spec seam.
 */
import fs from "node:fs";
import path from "node:path";
import type { SpecBundle, SpecIssue, VerifyReport } from "./types.ts";

export interface SpecChecker {
  name: string;
  run(root: string, bundle: SpecBundle): SpecIssue[];
}

/** Paths mentioned in backticks that look like repo paths must exist. */
const pathChecker: SpecChecker = {
  name: "paths",
  run(root, bundle) {
    const issues: SpecIssue[] = [];
    for (const file of bundle.all) {
      for (const candidate of extractBacktickPaths(file.content)) {
        // Only check plausible repo-relative paths (skip URLs, globs to nowhere, node modules)
        if (/^(https?:|npm:|node:|git\+)/.test(candidate)) continue;
        if (/[*{}<>]/.test(candidate)) continue;
        if (candidate.startsWith("http")) continue;
        const cleaned = candidate.replace(/[:#].*$/, "").replace(/[.,;)]+$/, "");
        if (!cleaned || cleaned.length < 3 || cleaned.length > 160) continue;
        const looksLikePath =
          /[\\/]/.test(cleaned) &&
          (/\.\w{1,8}$/.test(cleaned) || cleaned.endsWith("/") || cleaned.includes("/src") || cleaned.includes("/packages"));
        if (!looksLikePath) continue;
        const target = path.join(root, cleaned);
        const relForDots = cleaned.replace(/[\\/]+$/, "");
        if (relForDots.includes("..")) continue;
        if (!fs.existsSync(target)) {
          issues.push({
            severity: "warning",
            checker: "paths",
            file: file.relPath,
            message: `references \`${cleaned}\` which does not exist`,
          });
        }
      }
    }
    return dedupe(issues);
  },
};

/** `npm run x` style commands in specs must exist in package.json. */
const commandChecker: SpecChecker = {
  name: "commands",
  run(root, bundle) {
    const manifestPath = path.join(root, "package.json");
    if (!fs.existsSync(manifestPath)) return [];
    let scripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { scripts?: Record<string, string> };
      scripts = pkg.scripts ?? {};
    } catch {
      return [];
    }
    const issues: SpecIssue[] = [];
    const commandRe = /\b(?:npm run|pnpm run|pnpm|yarn|npm test)\s+([a-zA-Z0-9:_-]+)/g;
    for (const file of bundle.all) {
      const text = file.content;
      for (const match of text.matchAll(commandRe)) {
        const script = match[1]!;
        if (script === "run") continue;
        if (script === "test" && "test" in scripts) continue;
        // `pnpm install` / `pnpm build` where build exists is fine; only flag unknown script names.
        if (["install", "i", "add", "remove", "exec", "dlx", "why", "list", "up", "update"].includes(script)) continue;
        if (!(script in scripts)) {
          issues.push({
            severity: "warning",
            checker: "commands",
            file: file.relPath,
            message: `references command \`${match[0]}\` but package.json has no script "${script}"`,
          });
        }
      }
    }
    return dedupe(issues);
  },
};

/** Specs should not silently carry unresolved placeholders. */
const placeholderChecker: SpecChecker = {
  name: "placeholders",
  run(_root, bundle) {
    const issues: SpecIssue[] = [];
    for (const file of bundle.all) {
      if (file.kind === "constitution") continue;
      const lines = file.content.split("\n");
      lines.forEach((line, i) => {
        if (/\b(TODO|TBD|FIXME|XXX)\b/i.test(line)) {
          issues.push({
            severity: "info",
            checker: "placeholders",
            file: file.relPath,
            message: `line ${i + 1}: unresolved placeholder — ${line.trim().slice(0, 90)}`,
          });
        }
      });
    }
    return issues.slice(0, 30);
  },
};

const BUILTIN_CHECKERS: SpecChecker[] = [pathChecker, commandChecker, placeholderChecker];

export function verifySpec(root: string, bundle: SpecBundle, extra: SpecChecker[] = []): VerifyReport {
  if (bundle.all.length === 0) {
    return {
      passed: false,
      checked: 0,
      issues: [{ severity: "error", checker: "init", message: "No spec found. Run `memento spec init` first." }],
    };
  }
  const checkers = [...BUILTIN_CHECKERS, ...extra];
  const issues: SpecIssue[] = [];
  for (const checker of checkers) {
    try {
      const found = checker.run(root, bundle);
      // The runner owns the checker attribution — plugin authors return
      // issues with path/message only and must not remember to tag each one.
      issues.push(...found.map((i) => (i.checker ? i : { ...i, checker: checker.name })));
    } catch (err) {
      issues.push({ severity: "warning", checker: checker.name, message: `checker crashed: ${(err as Error).message}` });
    }
  }
  const sorted = issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return {
    passed: !sorted.some((i) => i.severity === "error"),
    checked: bundle.all.length,
    issues: sorted,
  };
}

function severityRank(s: SpecIssue["severity"]): number {
  return s === "error" ? 0 : s === "warning" ? 1 : 2;
}

/** Extract path-looking tokens from inline code spans. */
function extractBacktickPaths(md: string): string[] {
  const out: string[] = [];
  for (const match of md.matchAll(/`([^`\n]{3,160})`/g)) {
    out.push(match[1]!.trim());
  }
  return out;
}

function dedupe(issues: SpecIssue[]): SpecIssue[] {
  const seen = new Set<string>();
  const out: SpecIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.file ?? ""}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out.slice(0, 60);
}
