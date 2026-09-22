/**
 * `memento web` — the local read-only workbench server.
 *
 * Front/back separation at CLI scale: this module owns the JSON API and one
 * static document (`ui.html`); the UI is a dependency-free page that talks to
 * the API with fetch. No framework, no bundler, no CDN — same zero-lock-in
 * policy as the rest of the project, and it works air-gapped.
 *
 * Safety posture (mirrors the tool guard's defaults):
 *   - binds 127.0.0.1 only, never 0.0.0.0
 *   - answers GET exclusively; the workbench cannot mutate the workspace
 *   - rejects non-loopback Host headers (DNS-rebinding defence)
 *   - reads through the same stores the CLI uses — nothing re-implemented,
 *     and no project plugins are loaded or executed
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { listSessions, loadSession } from "../kernel/session.ts";
import { LessonStore } from "../memory/store.ts";
import type { Lesson } from "../memory/types.ts";
import { loadSpecBundle } from "../spec/store.ts";
import { VERSION } from "../version.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface WebServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startWebServer(opts: { root: string; port?: number }): Promise<WebServer> {
  const root = path.resolve(opts.root);
  const ui = readUi();
  const server = http.createServer((req, res) => {
    void handle(req, res, root, ui).catch((err: unknown) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4173, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** ui.html ships next to this module in dist/ (copied by tsup onSuccess). */
function readUi(): string {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui.html");
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`workbench assets missing: ${file} (broken install — reinstall memento-agent)`);
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, root: string, ui: string): Promise<void> {
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOOPBACK.has(host)) {
    return json(res, 403, { error: `forbidden host "${host}" — the workbench only answers loopback requests` });
  }
  if (req.method !== "GET") {
    return json(res, 405, { error: "read-only: the workbench answers GET only" });
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = url.pathname;
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(ui);
    return;
  }
  if (p === "/api/overview") return json(res, 200, overview(root));
  if (p === "/api/sessions") return json(res, 200, sessionList(root));
  if (p.startsWith("/api/sessions/")) return sessionDetail(res, root, decodeURIComponent(p.slice("/api/sessions/".length)));
  if (p === "/api/lessons") return json(res, 200, lessons(root));
  if (p === "/api/spec") return json(res, 200, spec(root));
  return json(res, 404, { error: `no route: ${p}` });
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function sessionsDir(root: string): string {
  return path.join(root, ".memento", "sessions");
}

function overview(root: string): Record<string, unknown> {
  const { config } = loadConfig(root);
  const bundle = loadSpecBundle(root);
  const store = LessonStore.load(root);
  const stats = store.stats();
  const all = listSessions(sessionsDir(root));
  const active = [...store.active()].sort((a, b) => b.lastSeen - a.lastSeen);
  return {
    version: VERSION,
    root,
    model: { provider: config.provider ?? null, model: config.model ?? null },
    spec: { files: bundle.all.length, features: bundle.features.length, decisions: bundle.decisions.length },
    memory: { active: stats.active, retired: stats.retired, avgConfidence: stats.avgConfidence },
    sessions: {
      total: all.length,
      recent: all.slice(0, 5).map((s) => ({
        id: s.header.sessionId,
        status: s.status,
        task: s.header.task,
        startedAt: s.header.startedAt,
      })),
    },
    lessons: {
      recent: active.slice(0, 5).map((l) => ({ id: l.id, text: l.text, confidence: l.confidence })),
    },
  };
}

function sessionList(root: string): Record<string, unknown> {
  const all = listSessions(sessionsDir(root));
  return {
    sessions: all.map((s) => ({
      id: s.header.sessionId,
      status: s.status,
      task: s.header.task,
      provider: s.header.provider,
      model: s.header.model,
      startedAt: s.header.startedAt,
      messages: s.messageCount,
      turns: turnsOf(s.file),
    })),
  };
}

/** The result entry carries the turn count; the list API surfaces it too. */
function turnsOf(file: string): number | null {
  try {
    const loaded = loadSession(file);
    for (let i = loaded.entries.length - 1; i >= 0; i -= 1) {
      const e = loaded.entries[i];
      if (e && e.kind === "result") return e.turns;
    }
    return null;
  } catch {
    return null;
  }
}

function sessionDetail(res: http.ServerResponse, root: string, id: string): void {
  const dir = sessionsDir(root);
  let file: string | null = null;
  try {
    // Match against directory entries only — `id` never becomes a path itself,
    // so traversal attempts (`../../…`) simply fail to match.
    const names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    const match = names.find((n) => n === id || n.startsWith(id));
    if (match) file = path.join(dir, match);
  } catch {
    /* no sessions dir */
  }
  if (!file) return json(res, 404, { error: `session not found: ${id}` });
  const loaded = loadSession(file);
  json(res, 200, { header: loaded.header, status: loaded.status, messages: loaded.messages.length, entries: loaded.entries });
}

function lessons(root: string): Record<string, unknown> {
  const store = LessonStore.load(root);
  const all = store.all();
  const byConfidence = (a: Lesson, b: Lesson): number => b.confidence - a.confidence || b.lastSeen - a.lastSeen;
  const active = all.filter((l) => l.status === "active").sort(byConfidence);
  const retired = all.filter((l) => l.status === "retired").sort((a, b) => b.lastSeen - a.lastSeen);
  return { active, retired, stats: store.stats() };
}

function spec(root: string): Record<string, unknown> {
  const bundle = loadSpecBundle(root);
  return {
    files: bundle.all.map((f) => ({
      relPath: f.relPath,
      kind: f.kind,
      slug: f.slug,
      updatedAt: f.updatedAt,
      content: f.content,
    })),
  };
}
