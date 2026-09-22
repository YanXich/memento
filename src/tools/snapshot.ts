/**
 * Write snapshot — powers `memento undo`.
 *
 * Every mutating file tool (write / edit / apply_patch) records the file's
 * pre-write state into `.memento/undo/<batch>/<relpath>` before touching it.
 * One tool call = one batch, so `memento undo` restores exactly the previous
 * step, even across sessions (the snapshots live on disk).
 *
 * A file that did not exist is recorded as a tombstone marker; undo deletes
 * it again. Snapshots are pruned to the most recent N batches to keep the
 * directory from growing without bound.
 */
import fs from "node:fs";
import path from "node:path";

const UNDO_DIR = ".memento/undo";
const TOMBSTONE = "__memento_absent__";
const MAX_BATCHES = 20;

let batchCounter = 0;

/** Record one file's pre-write state. Called by file tools right before writing. */
export function snapshotBeforeWrite(root: string, relPath: string): void {
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(path.resolve(root))) return; // defensive: never snapshot outside the workspace
  const batch = `${Date.now()}-${process.pid}-${++batchCounter}`;
  const dir = path.join(root, UNDO_DIR, batch);
  fs.mkdirSync(path.dirname(path.join(dir, relPath)), { recursive: true });
  if (fs.existsSync(abs)) {
    fs.copyFileSync(abs, path.join(dir, relPath));
  } else {
    fs.mkdirSync(path.dirname(path.join(dir, relPath)), { recursive: true });
    fs.writeFileSync(path.join(dir, relPath), TOMBSTONE, "utf8");
  }
  prune(root);
}

export interface UndoResult {
  restored: string[];
  removed: string[];
}

/** Restore the most recent batch; returns what changed. */
export function undoLatest(root: string): UndoResult | { error: string } {
  const undoRoot = path.join(root, UNDO_DIR);
  if (!fs.existsSync(undoRoot)) return { error: "nothing to undo — no write snapshots exist" };

  const batches = fs
    .readdirSync(undoRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  if (batches.length === 0) return { error: "nothing to undo — no write snapshots exist" };

  const batchDir = path.join(undoRoot, batches[0]!);
  const files = listFiles(batchDir);
  const restored: string[] = [];
  const removed: string[] = [];

  for (const rel of files) {
    const snapshot = path.join(batchDir, rel);
    const target = path.resolve(root, rel);
    if (!target.startsWith(path.resolve(root))) continue; // corrupted snapshot — skip
    const content = fs.readFileSync(snapshot, "utf8");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (content === TOMBSTONE) {
      fs.rmSync(target, { force: true });
      removed.push(rel);
    } else {
      fs.writeFileSync(target, content, "utf8");
      restored.push(rel);
    }
  }
  fs.rmSync(batchDir, { recursive: true, force: true });
  return { restored, removed };
}

/** Whether there is anything to undo (for CLI messaging). */
export function hasUndoSnapshots(root: string): boolean {
  try {
    return (
      fs.existsSync(path.join(root, UNDO_DIR)) &&
      fs.readdirSync(path.join(root, UNDO_DIR)).some((d) => fs.statSync(path.join(root, UNDO_DIR, d)).isDirectory())
    );
  } catch {
    return false;
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string, rel: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) visit(full, childRel);
      else out.push(childRel);
    }
  };
  visit(dir, "");
  return out;
}

function prune(root: string): void {
  const undoRoot = path.join(root, UNDO_DIR);
  let batches: string[];
  try {
    batches = fs.readdirSync(undoRoot).filter((d) => fs.statSync(path.join(undoRoot, d)).isDirectory()).sort();
  } catch {
    return;
  }
  while (batches.length > MAX_BATCHES) {
    fs.rmSync(path.join(undoRoot, batches.shift()!), { recursive: true, force: true });
  }
}
