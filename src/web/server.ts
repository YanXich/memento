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
 *     and no project plugins are loaded or executed. The Plugins tab only
 *     inventories plugin dirs and parses manifests statically.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig, userConfigPath, projectConfigPath } from "../config.ts";
import { listSessions, loadSession, resolveSessionFile } from "../kernel/session.ts";
import { LessonStore } from "../memory/store.ts";
import type { Lesson } from "../memory/types.ts";
import { scanPluginDir } from "../plugins/loader.ts";
import { loadSpecBundle } from "../spec/store.ts";
import { walkFiles } from "../util/paths.ts";
import { VERSION } from "../version.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface WebServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startWebServer(opts: { root: string; port?: number; homedir?: string }): Promise<WebServer> {
  const root = path.resolve(opts.root);
  // `homedir` is a test hook: production uses the real home for the global
  // plugins inventory. It never affects config loading (which uses its own
  // paths) — it only redirects the global plugin scan.
  const home = opts.homedir ?? os.homedir();
  const ui = readUi();
  const server = http.createServer((req, res) => {
    void handle(req, res, root, ui, home).catch((err: unknown) => {
      // The response may already be streaming (headers sent); writing again
      // would throw ERR_HTTP_HEADERS_SENT and surface as an unhandled
      // rejection. Tear the socket down instead.
      if (res.headersSent) {
        res.destroy();
        return;
      }
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

async function handle(req: http.IncomingMessage, res: http.ServerResponse, root: string, ui: string, home: string): Promise<void> {
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
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
    res.end(ui);
    return;
  }
  if (p === "/api/overview") return respondJson(req, res, p, [stampDir(sessionsDir(root)), stampDir(memoryDir(root)), stampTree(specDir(root)), stampFile(projectConfigPath(root)), stampFile(userConfigPath()), stampTree(pluginsDir(root)), stampTree(globalPluginsDir(home))], () => overview(root, home));
  if (p === "/api/sessions") return respondJson(req, res, p, [stampDir(sessionsDir(root))], () => sessionList(root));
  if (p.startsWith("/api/sessions/")) {
    let id: string;
    try {
      id = decodeURIComponent(p.slice("/api/sessions/".length));
    } catch {
      // Malformed percent-encoding is a client bug, not a server error.
      return json(res, 400, { error: "malformed session id (bad percent-encoding)" });
    }
    if (!id) return json(res, 404, { error: "no session id in path — list sessions via /api/sessions" });
    return sessionDetail(req, res, root, id);
  }
  if (p === "/api/lessons") return respondJson(req, res, p, [stampDir(memoryDir(root))], () => lessons(root));
  if (p === "/api/spec") return respondJson(req, res, p, [stampTree(specDir(root))], () => spec(root));
  // trust/enabled ride on config, so config files are part of the stamp too.
  if (p === "/api/plugins") return respondJson(req, res, p, [stampTree(pluginsDir(root)), stampTree(globalPluginsDir(home)), stampFile(projectConfigPath(root)), stampFile(userConfigPath())], () => pluginsList(root, home));
  return json(res, 404, { error: `no route: ${p}` });
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Incremental reads. Every API response is keyed by the file stamps it was
// built from (name:mtime:size of the stores underneath). A repeated request
// revalidates with stat() only and answers 304 Not Modified when nothing
// changed — stores are re-read exclusively on real change. (M12)
// ---------------------------------------------------------------------------

interface CacheEntry {
  stamp: string;
  body: string;
}

const cache = new Map<string, CacheEntry>();

// Long-running workbenches see one entry per session id (plus per id spelling
// before normalization); without a cap the cache grows without bound. Map
// iteration order is insertion order, so evicting the head is FIFO — simple,
// deterministic, and plenty for a local workbench.
const CACHE_MAX = 256;

function respondJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  key: string,
  stamps: string[],
  build: () => unknown,
): void {
  const stamp = stamps.join("\u0000");
  const etag = `W/"${Buffer.from(stamp, "utf8").toString("base64")}"`;
  const entry = cache.get(key);
  if (entry && entry.stamp === stamp) {
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": "no-cache" });
      res.end();
      return;
    }
    res.writeHead(200, jsonHeaders(etag));
    res.end(entry.body);
    return;
  }
  const body = JSON.stringify(build());
  cache.set(key, { stamp, body });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  res.writeHead(200, jsonHeaders(etag));
  res.end(body);
}

function jsonHeaders(etag: string): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache",
    etag,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

/** `name:mtime:size` per file in a flat dir — cheap, deterministic, changes
 *  exactly when a file is added, removed or rewritten. The dir itself is part
 *  of the stamp so two workspaces can never alias the same cache entry. */
function stampDir(dir: string): string {
  try {
    return (
      dir +
      "|" +
      fs
        .readdirSync(dir)
        .sort()
        .map((n) => {
          const st = fs.statSync(path.join(dir, n));
          return `${n}:${Math.trunc(st.mtimeMs)}:${st.size}`;
        })
        .join("|")
    );
  } catch {
    return `${dir}|missing`;
  }
}

/** Recursive stamp for the spec tree (features/ and decisions/ subdirs). */
function stampTree(dir: string): string {
  try {
    return (
      dir +
      "|" +
      walkFiles(dir, { maxDepth: 4 })
        .map((f) => {
          const st = fs.statSync(f);
          return `${f}:${Math.trunc(st.mtimeMs)}:${st.size}`;
        })
        .join("|")
    );
  } catch {
    return `${dir}|missing`;
  }
}

function stampFile(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${file}:${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return `${file}|missing`;
  }
}

function sessionsDir(root: string): string {
  return path.join(root, ".memento", "sessions");
}

function memoryDir(root: string): string {
  return path.join(root, ".memento", "memory");
}

function specDir(root: string): string {
  return path.join(root, ".memento", "spec");
}

function pluginsDir(root: string): string {
  return path.join(root, ".memento", "plugins");
}

function globalPluginsDir(home: string): string {
  return path.join(home, ".memento", "plugins");
}

function overview(root: string, home: string): Record<string, unknown> {
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
    plugins: {
      project: scanPluginDir(pluginsDir(root)).length,
      global: scanPluginDir(globalPluginsDir(home)).length,
    },
  };
}

/**
 * Installed-plugin inventory for the workbench Plugins tab. Purely static:
 * manifests are parsed, no plugin module is ever imported here.
 */
function pluginsList(root: string, home: string): Record<string, unknown> {
  const { config } = loadConfig(root);
  const scopes: { dir: string; scope: "project" | "global" }[] = [
    { dir: pluginsDir(root), scope: "project" },
    { dir: globalPluginsDir(home), scope: "global" },
  ];
  const all = scopes.flatMap(({ dir, scope }) =>
    scanPluginDir(dir).map((p) => ({
      name: p.name,
      scope,
      entry: p.entry,
      source: p.manifest?.source ?? "local",
      description: p.manifest?.description ?? null,
      rev: p.manifest?.rev ?? null,
      installedAt: p.manifest?.installedAt ?? null,
    })),
  );
  return {
    plugins: all,
    trust: { projectTrusted: config.trustProjectPlugins === true },
    enabled: config.plugins !== false,
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
      turns: s.turns,
    })),
  };
}

function sessionDetail(req: http.IncomingMessage, res: http.ServerResponse, root: string, id: string): void {
  const dir = sessionsDir(root);
  const resolved = resolveSessionFile(dir, id);
  if (resolved === null) return json(res, 404, { error: `session not found: ${id}` });
  if ("ambiguous" in resolved) {
    return json(res, 400, {
      error: `session id prefix is ambiguous (${resolved.ambiguous.length} matches) — use a longer prefix`,
      candidates: resolved.ambiguous.map((n) => n.replace(/\.jsonl$/, "")),
    });
  }
  const file = resolved.file;
  // A session being written changes its stamp on every append, so a stale
  // cache can never mask live progress. The cache key is the canonical file
  // id (not the raw path segment), so prefix and percent-encoded spellings
  // of the same session share one entry.
  const canonicalId = path.basename(file, ".jsonl");
  respondJson(req, res, `/api/sessions/${canonicalId}`, [stampFile(file)], () => {
    const loaded = loadSession(file);
    return { header: loaded.header, status: loaded.status, messages: loaded.messages.length, entries: loaded.entries };
  });
}

function lessons(root: string): Record<string, unknown> {
  const store = LessonStore.load(root);
  const all = store.all();
  const byConfidence = (a: Lesson, b: Lesson): number => b.confidence - a.confidence || b.lastSeen - a.lastSeen;
  const active = all.filter((l) => l.status === "active").sort(byConfidence);
  const retired = all.filter((l) => l.status === "retired").sort((a, b) => b.lastSeen - a.lastSeen);
  // One pass over the raw log gives every lesson its evolution arc — the
  // workbench draws the confidence curve from this (the visible "it learns").
  const histories = store.histories();
  const withHistory = (l: Lesson) => ({ ...l, history: histories.get(l.id) ?? [] });
  return { active: active.map(withHistory), retired: retired.map(withHistory), stats: store.stats() };
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
