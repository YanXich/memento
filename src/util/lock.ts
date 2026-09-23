/**
 * Cross-process file lock — the shared concurrency guard for append-and-fold
 * data files (session logs, the lesson store).
 *
 * Semantics (generalized from the session writer lock):
 *  - Acquisition is atomic: `wx` = create-if-absent.
 *  - A lock whose pid is alive belongs to a peer → wait (bounded retries) or
 *    throw, never evict a legitimately running writer.
 *  - A lock whose pid is dead, corrupt, our own, or absurdly old (pid reuse
 *    after a crash) is stolen — a crashed process never wedges the repository.
 *  - Release only unlinks locks we still own; never a peer's.
 *
 * All operations are synchronous on purpose: the call sites are hot append
 * paths, and a sync critical section is the simplest thing that cannot
 * interleave. Locked sections are tiny (one append / one rename), so even a
 * waiting peer blocks for milliseconds.
 */
import fs from "node:fs";

export interface FileLockOptions {
  /** Wait-retries when a live peer holds the lock (e.g. compaction windows). */
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Locks are never legitimately held this long: critical sections are one
 * append or one rename. A lock older than this with a *live* pid means the
 * pid was recycled by the OS — the original owner is gone, so steal it.
 * Sessions keep their lock for a whole run (hours), so this must stay well
 * above any plausible session length.
 */
export const STALE_LOCK_MS = 24 * 60 * 60 * 1000;

/** Synchronous sleep — Atomics.wait is the standard Node way without busy-spin. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the lock for `file` (creates `<file>.lock`). Throws when a live
 * peer holds it after `retries` waits; steals stale locks.
 */
export function acquireFileLock(file: string, opts: FileLockOptions = {}): void {
  const lockFile = `${file}.lock`;
  const own = { pid: process.pid, startedAt: Date.now() };
  const retries = opts.retries ?? 0;
  const retryDelayMs = opts.retryDelayMs ?? 100;

  let steals = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(own), { flag: "wx" });
      // A stealer may have raced our write (it read our half-written lock as
      // corrupt, deleted it, and re-created its own). Verify ownership after
      // the write; if we lost the race, back off and retry.
      if (lockOwner(lockFile).pid === process.pid) return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = lockOwner(lockFile);
      if (owner.pid !== process.pid && pidAlive(owner.pid) && !isStale(owner.startedAt)) {
        if (attempt < retries) {
          sleepSync(retryDelayMs);
          continue;
        }
        throw new Error(`file is locked by another memento process (pid ${owner.pid}): ${file}`);
      }
      // Stale (dead or recycled pid), corrupt, or our own re-entry — steal it and retry.
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        /* raced with another stealer — retry */
      }
      if (++steals > 2) throw new Error(`could not acquire file lock: ${lockFile}`);
    }
  }
}

/** Release the lock, but only if this process still owns it. */
export function releaseFileLock(file: string, ownPid: number): void {
  try {
    if (lockOwner(`${file}.lock`).pid === ownPid) fs.rmSync(`${file}.lock`, { force: true });
  } catch {
    /* lock already gone */
  }
}

/**
 * Is `lockFile` held by a live, non-stale owner? Read-only check for
 * observers (the web workbench uses it to show "running"): a leftover lock
 * from a crashed process must not light up the UI forever.
 */
export function lockIsFresh(lockFile: string): boolean {
  const owner = lockOwner(lockFile);
  if (owner.pid <= 0) return false;
  return pidAlive(owner.pid) && !isStale(owner.startedAt);
}

/** Run `fn` while holding the lock — the common critical-section shape. */
export function withFileLock<T>(file: string, fn: () => T, opts: FileLockOptions = {}): T {
  acquireFileLock(file, opts);
  try {
    return fn();
  } finally {
    releaseFileLock(file, process.pid);
  }
}

function lockOwner(lockFile: string): { pid: number; startedAt: number } {
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: unknown; startedAt?: unknown };
    return {
      pid: typeof owner?.pid === "number" ? owner.pid : -1,
      startedAt: typeof owner?.startedAt === "number" ? owner.startedAt : 0,
    };
  } catch {
    return { pid: -1, startedAt: 0 }; // corrupt lock → stealable
  }
}

function isStale(startedAt: number): boolean {
  return startedAt > 0 && Date.now() - startedAt > STALE_LOCK_MS;
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission — alive, not dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
