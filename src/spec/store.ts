/**
 * Spec store — read/write `.memento/spec/`.
 * Deliberately boring: plain Markdown files, no database, no lock-in.
 * Everything here is diffable in git, which is the point.
 */
import fs from "node:fs";
import path from "node:path";
import type { SpecBundle, SpecFile, SpecKind, SpecStatus } from "./types.ts";
import { ensureDir, walkFiles } from "../util/paths.ts";

export const SPEC_DIR = ".memento/spec";
export const CONSTITUTION_FILE = `${SPEC_DIR}/constitution.md`;
export const ARCHITECTURE_FILE = `${SPEC_DIR}/architecture.md`;

export function specDir(root: string): string {
  return path.join(root, SPEC_DIR);
}

export function loadSpecBundle(root: string): SpecBundle {
  const dir = specDir(root);
  const files: SpecFile[] = [];
  if (fs.existsSync(dir)) {
    for (const abs of walkFiles(dir, { maxDepth: 4 })) {
      if (!abs.endsWith(".md")) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const content = fs.readFileSync(abs, "utf8");
      const kind = classify(rel);
      files.push({
        relPath: rel,
        kind,
        slug: slugOf(rel),
        content,
        updatedAt: safeMtime(abs),
      });
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    constitution: files.find((f) => f.kind === "constitution") ?? null,
    architecture: files.find((f) => f.kind === "architecture") ?? null,
    features: files.filter((f) => f.kind === "feature"),
    decisions: files.filter((f) => f.kind === "decision"),
    all: files,
  };
}

function classify(rel: string): SpecKind {
  const posix = rel.split(path.sep).join("/");
  if (posix.endsWith("constitution.md")) return "constitution";
  if (posix.endsWith("architecture.md")) return "architecture";
  if (posix.includes("/features/")) return "feature";
  if (posix.includes("/decisions/")) return "decision";
  return "other";
}

function slugOf(rel: string): string {
  const posix = rel.split(path.sep).join("/");
  const base = posix.slice(posix.lastIndexOf("/") + 1).replace(/\.md$/, "");
  // decision files are often "0001-use-sqlite" — keep the readable part
  return base.replace(/^\d+[-_]/, "");
}

function safeMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function writeSpec(root: string, relPath: string, content: string): void {
  // The relPath comes from the model via the spec tool — never trust it.
  // Accept workspace-relative paths (like the read side) but reject absolute
  // paths, `..` segments and anything that resolves outside `.memento/spec/`,
  // so a hostile or buggy model cannot overwrite arbitrary files (e.g.
  // package.json, ~/.ssh/authorized_keys) through this seam.
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new Error(`Spec path must be relative to the workspace: ${relPath}`);
  }
  const abs = path.resolve(root, relPath);
  const specRoot = path.resolve(root, SPEC_DIR);
  const rel = path.relative(specRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Spec path escapes .memento/spec/: ${relPath}`);
  }
  if (!abs.toLowerCase().endsWith(".md")) {
    throw new Error(`Spec files must be markdown: ${relPath}`);
  }
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, content.endsWith("\n") ? content : content + "\n", "utf8");
}

export function readSpec(root: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(root, relPath), "utf8");
  } catch {
    return null;
  }
}

export function specStatus(root: string): SpecStatus {
  const bundle = loadSpecBundle(root);
  const counts: Record<SpecKind, number> = { constitution: 0, architecture: 0, feature: 0, decision: 0, other: 0 };
  const lastUpdated: Record<SpecKind, number> = { constitution: 0, architecture: 0, feature: 0, decision: 0, other: 0 };
  for (const file of bundle.all) {
    counts[file.kind] += 1;
    lastUpdated[file.kind] = Math.max(lastUpdated[file.kind], file.updatedAt);
  }
  return {
    initialized: bundle.all.length > 0,
    counts,
    lastUpdated,
    staleHint: null,
  };
}

/** Next ADR number for decisions/NNNN-slug.md. */
export function nextDecisionNumber(root: string): number {
  const dir = path.join(root, SPEC_DIR, "decisions");
  let max = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = name.match(/^(\d{1,4})-/);
      if (match) max = Math.max(max, Number(match[1]));
    }
  } catch {
    /* no decisions yet */
  }
  return max + 1;
}
