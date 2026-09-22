import path from "node:path";
import fs from "node:fs";

/** Canonical absolute path with forward-ish normalization for comparisons. */
export function normalize(p: string): string {
  return path.resolve(p);
}

/** True when `child` is inside `parent` (or equals it). Prevents path escape. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(realpathish(parent), realpathish(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve symlinks for paths that exist; for not-yet-existing paths (the
 * write tool targets new files), resolve the deepest existing ancestor so a
 * symlinked directory can't smuggle writes outside the workspace.
 */
function realpathish(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    let existing = p;
    while (!fs.existsSync(existing)) {
      const up = path.dirname(existing);
      if (up === existing) return normalize(p);
      existing = up;
    }
    try {
      return path.join(fs.realpathSync(existing), path.relative(existing, p));
    } catch {
      return normalize(p);
    }
  }
}

/**
 * Resolve a user/model supplied path against the workspace root.
 * Throws when the result escapes the workspace unless `allowOutside` is set.
 */
export function resolveInWorkspace(root: string, input: string, allowOutside = false): string {
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!allowOutside && !isInside(root, abs)) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
  return abs;
}

/** Workspace-relative display path (posix separators). */
export function displayPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return (rel === "" ? "." : rel).split(path.sep).join("/");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsonIfExists<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Append a single JSON line, creating parent dirs as needed.
 *
 * Concurrency contract: one `writeSync` on an O_APPEND fd. On POSIX (and on
 * NTFS for single writes) O_APPEND positions the write at EOF atomically, so
 * concurrent processes appending one line each never interleave or lose
 * lines. This is what makes the memory log safe across parallel agents.
 */
export function appendJsonl(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const line = JSON.stringify(data) + "\n";
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, line, null, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonl<T>(file: string): T[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as T);
      } catch {
        // Skip corrupt lines — logs are append-only and partially written lines are expected on crash.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Walk files under `dir`, skipping heavy or irrelevant directories. */
export function walkFiles(
  dir: string,
  opts: { ignore?: Set<string>; maxFiles?: number; maxDepth?: number } = {},
): string[] {
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const maxFiles = opts.maxFiles ?? 5000;
  const maxDepth = opts.maxDepth ?? 12;
  const out: string[] = [];

  const visit = (current: string, depth: number) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (ignore.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };

  visit(dir, 0);
  return out;
}

export const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".idea",
  ".vscode",
  // Memento's own state — the agent's memory, session logs and undo
  // snapshots must never pollute grep/glob results.
  ".memento",
  // Bench sandboxes created by `memento bench`.
  ".demo",
]);

/** Directories that mutating tools must never touch (unless explicitly allowed). */
export const PROTECTED_DIRS = new Set([".git", "node_modules"]);

/** File names that mutating tools must never write (unless explicitly allowed). */
export const PROTECTED_FILES = new Set([
  ".env", ".env.local", ".env.production", ".env.development", ".env.test", ".env.example",
  "id_rsa", "id_ed25519", "id_rsa.pub", "id_ed25519.pub", "id_dsa", "id_ecdsa",
  ".npmrc", ".pypirc", ".netrc",
  "credentials", "credentials.json", "credentials.yml", "credentials.yaml",
]);
