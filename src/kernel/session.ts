/**
 * Session log — append-only JSONL, the single source of truth.
 *
 * Invariant ("what the model saw ⟺ what was logged"): before any LlmRequest is
 * dispatched, every message it contains already exists in this log. The context
 * used by the loop is *derived* from the log, so replaying a session file is
 * always faithful to the original run — no hidden state.
 */
import fs from "node:fs";
import path from "node:path";
import type { Message, Usage } from "../llm/types.ts";
import { appendJsonl, ensureDir, readJsonl } from "../util/paths.ts";
import { sessionId as newSessionId } from "../util/ids.ts";

export type SessionEntry =
  | {
      seq: number;
      ts: number;
      kind: "header";
      sessionId: string;
      cwd: string;
      model: string;
      provider: string;
      task: string;
      mementoVersion: string;
    }
  | { seq: number; ts: number; kind: "message"; message: Message }
  | { seq: number; ts: number; kind: "usage"; usage: Usage }
  | { seq: number; ts: number; kind: "compaction"; summary: string; replacedCount: number; tokensSaved: number }
  | { seq: number; ts: number; kind: "note"; text: string; author: "system" | "reflect" }
  | { seq: number; ts: number; kind: "result"; status: "done" | "aborted" | "error" | "max_turns"; turns: number; summary?: string };

export interface SessionHeader {
  sessionId: string;
  cwd: string;
  model: string;
  provider: string;
  task: string;
  mementoVersion: string;
  startedAt: number;
}

export class SessionLog {
  readonly file: string;
  readonly header: SessionHeader;
  private seq = 0;
  private fd: number | null = null;
  private messageCount = 0;
  /** Set while the writer lock is held; touched only by the lock helpers below. */
  lockFile: string | null = null;

  private constructor(file: string, header: SessionHeader) {
    this.file = file;
    this.header = header;
  }

  static create(sessionsDir: string, header: Omit<SessionHeader, "sessionId" | "startedAt">): SessionLog {
    const id = newSessionId();
    const startedAt = Date.now();
    const file = path.join(sessionsDir, `${id}.jsonl`);
    const log = new SessionLog(file, { ...header, sessionId: id, startedAt });
    ensureDir(sessionsDir);
    acquireLock(log);
    log.append({ kind: "header", sessionId: id, cwd: header.cwd, model: header.model, provider: header.provider, task: header.task, mementoVersion: header.mementoVersion });
    return log;
  }

  static open(file: string): SessionLog {
    const entries = readJsonl<SessionEntry>(file);
    const headerEntry = entries.find((e) => e.kind === "header") as Extract<SessionEntry, { kind: "header" }> | undefined;
    if (!headerEntry) throw new Error(`Not a session log (no header): ${file}`);
    const log = new SessionLog(file, {
      sessionId: headerEntry.sessionId,
      cwd: headerEntry.cwd,
      model: headerEntry.model,
      provider: headerEntry.provider,
      task: headerEntry.task,
      mementoVersion: headerEntry.mementoVersion,
      startedAt: headerEntry.ts,
    });
    // Exclusive writer lock — see acquireLock. `open` is the append path
    // (`memento resume`), so it must not race a still-running session.
    acquireLock(log);
    // Resume seq/messageCount from the persisted log.
    let seq = 0;
    let messages = 0;
    for (const entry of entries) {
      seq = Math.max(seq, entry.seq);
      if (entry.kind === "message") messages++;
    }
    log.seq = seq;
    log.messageCount = messages;
    return log;
  }

  private append(entry: Omit<SessionEntry, "seq" | "ts"> & Record<string, unknown>): void {
    this.seq += 1;
    const record = { seq: this.seq, ts: Date.now(), ...entry } as SessionEntry;
    if (this.fd === null) {
      ensureDir(path.dirname(this.file));
      this.fd = fs.openSync(this.file, "a");
    }
    fs.writeSync(this.fd, JSON.stringify(record) + "\n");
    // fsync on every line is too slow; rely on OS buffering. Append-only means a
    // crash can at worst lose the final line (partial lines are skipped on read).
  }

  appendMessage(message: Message): void {
    this.messageCount += 1;
    this.append({ kind: "message", message });
  }

  appendUsage(usage: Usage): void {
    this.append({ kind: "usage", usage });
  }

  appendCompaction(summary: string, replacedCount: number, tokensSaved: number): void {
    this.append({ kind: "compaction", summary, replacedCount, tokensSaved });
  }

  appendNote(text: string, author: "system" | "reflect" = "system"): void {
    this.append({ kind: "note", text, author });
  }

  appendResult(status: "done" | "aborted" | "error" | "max_turns", turns: number, summary?: string): void {
    this.append({ kind: "result", status, turns, ...(summary ? { summary } : {}) });
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    releaseLock(this);
  }

  get currentSeq(): number {
    return this.seq;
  }

  get messages(): number {
    return this.messageCount;
  }
}

/**
 * Exclusive writer lock (the `<session>.lock` file) — the concurrency guard
 * for append paths. Without it, `memento resume` could append to a session
 * that a live process is still writing: two seq counters would interleave
 * and the log would stop being a faithful transcript.
 *
 * Acquisition is atomic (`wx` = create-if-absent). A lock left behind by a
 * crashed process is stolen — the pid inside is checked for liveness first,
 * so a legitimately running writer is never evicted. Reads (loadSession /
 * listSessions) never take the lock: append-only JSONL is safe to read
 * mid-write, partial trailing lines are skipped by design.
 */
function lockPathFor(file: string): string {
  return `${file}.lock`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(log: SessionLog): void {
  const lockFile = lockPathFor(log.file);
  const own = { pid: process.pid, startedAt: Date.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(own), { flag: "wx" });
      log.lockFile = lockFile;
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let owner: { pid?: unknown } | null = null;
      try {
        owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: unknown };
      } catch {
        /* corrupt lock */
      }
      const pid = typeof owner?.pid === "number" ? owner.pid : -1;
      if (pid !== process.pid && pidAlive(pid)) {
        throw new Error(
          `session is being written by another memento process (pid ${pid}) — wait for it to finish or resume it afterwards`,
        );
      }
      // Stale (dead pid, our own re-entry, or corrupt) — steal it.
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        /* raced with another stealer — retry once */
      }
    }
  }
  throw new Error(`could not acquire session lock: ${lockFile}`);
}

function releaseLock(log: SessionLog): void {
  if (!log.lockFile) return;
  try {
    const own = JSON.parse(fs.readFileSync(log.lockFile, "utf8")) as { pid?: unknown };
    // Never unlink a lock that a peer process already owns.
    if (own.pid === process.pid) fs.rmSync(log.lockFile, { force: true });
  } catch {
    /* lock already gone */
  }
  log.lockFile = null;
}

export interface LoadedSession {
  header: SessionHeader;
  entries: SessionEntry[];
  /** Reconstructed conversation — exactly the message stream the model saw. */
  messages: Message[];
  status: Extract<SessionEntry, { kind: "result" }>["status"] | "incomplete";
}

export function loadSession(file: string): LoadedSession {
  const entries = readJsonl<SessionEntry>(file);
  const headerEntry = entries.find((e) => e.kind === "header") as Extract<SessionEntry, { kind: "header" }> | undefined;
  if (!headerEntry) throw new Error(`Not a session log (no header): ${file}`);
  const messages = entries
    .filter((e): e is Extract<SessionEntry, { kind: "message" }> => e.kind === "message")
    .map((e) => e.message);
  const result = [...entries].reverse().find((e): e is Extract<SessionEntry, { kind: "result" }> => e.kind === "result");
  return {
    header: {
      sessionId: headerEntry.sessionId,
      cwd: headerEntry.cwd,
      model: headerEntry.model,
      provider: headerEntry.provider,
      task: headerEntry.task,
      mementoVersion: headerEntry.mementoVersion,
      startedAt: headerEntry.ts,
    },
    entries,
    messages,
    status: result?.status ?? "incomplete",
  };
}

export interface SessionSummary {
  file: string;
  header: SessionHeader;
  status: string;
  messageCount: number;
  /** Turns of the last result entry, if one exists. */
  turns: number | null;
}

export function listSessions(sessionsDir: string): SessionSummary[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    try {
      out.push(scanSession(path.join(sessionsDir, name)));
    } catch {
      // Skip unreadable logs
    }
  }
  out.sort((a, b) => b.header.startedAt - a.header.startedAt);
  return out;
}

/**
 * Light single-pass scan for list views: header + message count + the last
 * result's status/turns. Unlike `loadSession` it never reconstructs the full
 * message stream, so listing N sessions costs exactly one read per file.
 * (The workbench used to read every file twice — once for the list, once for
 * the turn count — O(2×N) before this.)
 */
function scanSession(file: string): SessionSummary {
  let header: SessionHeader | null = null;
  let messageCount = 0;
  let status = "incomplete";
  let turns: number | null = null;
  for (const e of readJsonl<SessionEntry>(file)) {
    if (!header && e.kind === "header") {
      header = {
        sessionId: e.sessionId,
        cwd: e.cwd,
        model: e.model,
        provider: e.provider,
        task: e.task,
        mementoVersion: e.mementoVersion,
        startedAt: e.ts,
      };
    } else if (e.kind === "message") {
      messageCount += 1;
    } else if (e.kind === "result") {
      status = e.status;
      turns = e.turns;
    }
  }
  if (!header) throw new Error(`Not a session log (no header): ${file}`);
  return { file, header, status, messageCount, turns };
}
