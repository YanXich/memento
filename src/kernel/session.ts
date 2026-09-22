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
  }

  get currentSeq(): number {
    return this.seq;
  }

  get messages(): number {
    return this.messageCount;
  }
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

export function listSessions(sessionsDir: string): { file: string; header: SessionHeader; status: string; messageCount: number }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: { file: string; header: SessionHeader; status: string; messageCount: number }[] = [];
  for (const name of names) {
    const file = path.join(sessionsDir, name);
    try {
      const loaded = loadSession(file);
      out.push({ file, header: loaded.header, status: loaded.status, messageCount: loaded.messages.length });
    } catch {
      // Skip unreadable logs
    }
  }
  out.sort((a, b) => b.header.startedAt - a.header.startedAt);
  return out;
}
