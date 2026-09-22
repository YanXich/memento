/**
 * Cross-process file lock — the shared concurrency guard for append-and-fold
 * data files (session logs, the lesson store).
 *
 * Semantics (generalized from the session writer lock):
 *  - Acquisition is atomic: `wx` = create-if-absent.
 *  - A lock whose pid is alive belongs to a peer → wait (bounded retries) or
 *    throw, never evict a legitimately running writer.
 *  - A lock whose pid is dead, corrupt, or our own is stolen — a crashed
 *    process never wedges the repository.
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
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = lockOwnerPid(lockFile);
      if (pid !== process.pid && pidAlive(pid)) {
        if (attempt < retries) {
          sleepSync(retryDelayMs);
          continue;
        }
        throw new Error(`file is locked by another memento process (pid ${pid}): ${file}`);
      }
      // Stale (dead pid), corrupt, or our own re-entry — steal it and retry.
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
    if (lockOwnerPid(`${file}.lock`) === ownPid) fs.rmSync(`${file}.lock`, { force: true });
  } catch {
    /* lock already gone */
  }
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

function lockOwnerPid(lockFile: string): number {
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: unknown };
    return typeof owner?.pid === "number" ? owner.pid : -1;
  } catch {
    return -1; // corrupt lock → stealable
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
