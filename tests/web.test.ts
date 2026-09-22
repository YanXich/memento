/**
 * Web workbench — API contract tests.
 *
 * The workbench must stay: read-only, loopback-bound, and faithful to the
 * same stores the CLI reads. The UI document is a static asset and is only
 * checked for delivery, not for rendering (its correctness is visual).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebServer } from "../src/web/server.ts";
import { startWebServer } from "../src/web/server.ts";

let server: WebServer | null = null;
let root: string | null = null;
let home: string | null = null;

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-web-"));
  fs.mkdirSync(path.join(dir, ".memento", "spec"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".memento", "memory"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".memento", "sessions"), { recursive: true });

  fs.writeFileSync(path.join(dir, ".memento", "spec", "constitution.md"), "# Constitution\n\n- Keep it small.\n");

  // A plugin package with a provenance manifest — the Plugins tab inventory.
  fs.mkdirSync(path.join(dir, ".memento", "plugins", "todo-guard"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".memento", "plugins", "todo-guard", "index.ts"), "export default { name: 'todo-guard', setup() {} };\n");
  fs.writeFileSync(
    path.join(dir, ".memento", "plugins", "todo-guard", ".memento-plugin.json"),
    JSON.stringify({
      name: "todo-guard",
      source: "https://github.com/memento/plugins.git",
      rev: "abc1234567890",
      installedAt: "2026-09-01T00:00:00.000Z",
      description: "Guards TODO markers in specs",
    }),
  );

  const now = Date.now();
  const lesson = {
    op: "upsert",
    ts: now,
    lesson: {
      id: "l_test01",
      text: "Tests run with plain node",
      kind: "pattern",
      confidence: 0.35,
      evidence: ["fixture"],
      reinforced: 0,
      contradicted: 0,
      scope: "repo",
      created: now,
      lastSeen: now,
      tags: ["test"],
      status: "active",
    },
  };
  fs.writeFileSync(path.join(dir, ".memento", "memory", "lessons.jsonl"), JSON.stringify(lesson) + "\n");

  const entries = [
    { seq: 1, ts: 1_700_000_000_000, kind: "header", sessionId: "s_test01", cwd: dir, model: "m", provider: "p", task: "do a thing", mementoVersion: "0.1.0" },
    { seq: 2, ts: 1_700_000_000_001, kind: "message", message: { id: "msg1", role: "user", content: [{ type: "text", text: "do a thing" }], ts: 1_700_000_000_001 } },
    { seq: 3, ts: 1_700_000_000_002, kind: "result", status: "done", turns: 1 },
  ];
  fs.writeFileSync(path.join(dir, ".memento", "sessions", "s_test01.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

async function boot(opts: { home?: string } = {}): Promise<WebServer> {
  root = makeFixture();
  // A fake home keeps the global-plugin scan deterministic — tests must never
  // observe the developer's real ~/.memento/plugins.
  home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "memento-web-home-"));
  server = await startWebServer({ root, port: 0, homedir: home });
  return server;
}

afterEach(async () => {
  if (server) await server.close();
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("web workbench", () => {
  it("serves the UI document at /", async () => {
    const s = await boot();
    const page = await fetch(`${s.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    // The workbench page is a browser document — harden the embed surface.
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).toContain("<!doctype html");
  });

  it("returns 404 for an empty session id instead of leaking the first session", async () => {
    const s = await boot();
    expect((await fetch(`${s.url}/api/sessions/`)).status).toBe(404);
  });

  it("returns 400 for malformed percent-encoding in a session id", async () => {
    const s = await boot();
    const res = await fetch(`${s.url}/api/sessions/%zz`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("percent-encoding");
  });

  it("reflects spec, memory, and sessions through the same stores as the CLI", async () => {
    const s = await boot();

    const ov = (await (await fetch(`${s.url}/api/overview`)).json()) as {
      spec: { files: number };
      memory: { active: number };
      sessions: { total: number };
      lessons: { recent: { id: string }[] };
      plugins: { project: number; global: number };
    };
    expect(ov.spec.files).toBe(1);
    expect(ov.memory.active).toBe(1);
    expect(ov.sessions.total).toBe(1);
    expect(ov.lessons.recent[0]?.id).toBe("l_test01");
    expect(ov.plugins.project).toBe(1);
    expect(ov.plugins.global).toBe(0);

    const lessons = (await (await fetch(`${s.url}/api/lessons`)).json()) as { active: { id: string; history: { op: string; confidence: number }[] }[]; retired: unknown[] };
    expect(lessons.active.map((l) => l.id)).toEqual(["l_test01"]);
    expect(lessons.retired).toEqual([]);
    // The evolution arc rides along — the workbench draws the curve from it.
    expect(lessons.active[0]?.history).toHaveLength(1);
    expect(lessons.active[0]?.history[0]).toMatchObject({ op: "upsert", confidence: 0.35 });

    const sessions = (await (await fetch(`${s.url}/api/sessions`)).json()) as { sessions: { id: string; turns: number; status: string }[] };
    expect(sessions.sessions[0]).toMatchObject({ id: "s_test01", turns: 1, status: "done" });

    const detail = (await (await fetch(`${s.url}/api/sessions/s_test01`)).json()) as { status: string; entries: unknown[] };
    expect(detail.status).toBe("done");
    expect(detail.entries).toHaveLength(3);

    const spec = (await (await fetch(`${s.url}/api/spec`)).json()) as { files: { relPath: string; content: string }[] };
    expect(spec.files[0]?.relPath).toContain("constitution.md");
    expect(spec.files[0]?.content).toContain("Keep it small");
  });

  it("is read-only: non-GET methods are refused", async () => {
    const s = await boot();
    const res = await fetch(`${s.url}/api/overview`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("answers 404 on unknown routes and unknown sessions", async () => {
    const s = await boot();
    expect((await fetch(`${s.url}/api/nope`)).status).toBe(404);
    expect((await fetch(`${s.url}/api/sessions/does-not-exist`)).status).toBe(404);
  });

  it("rejects non-loopback Host headers", async () => {
    const s = await boot();
    // fetch() (undici) refuses to send a custom Host header, so use raw http.
    expect(await rawGet(s.url + "/api/overview", "evil.example.com")).toBe(403);
    expect(await rawGet(s.url + "/api/overview", "localhost")).toBe(200);
  });

  it("incremental reads: unchanged stores revalidate as 304 and are never re-read", async () => {
    const s = await boot();
    const first = await fetch(`${s.url}/api/sessions`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("no-cache");

    const again = await fetch(`${s.url}/api/sessions`, { headers: { "if-none-match": etag as string } });
    expect(again.status).toBe(304);

    // A new session file lands → the stamp changes → the body is rebuilt.
    fs.writeFileSync(
      path.join(root as string, ".memento", "sessions", "s_test02.jsonl"),
      [
        JSON.stringify({ seq: 1, ts: 1_700_000_000_100, kind: "header", sessionId: "s_test02", cwd: root, model: "m", provider: "p", task: "t", mementoVersion: "0.1.0" }),
        JSON.stringify({ seq: 2, ts: 1_700_000_000_101, kind: "result", status: "done", turns: 2 }),
      ].join("\n") + "\n",
    );
    const after = await fetch(`${s.url}/api/sessions`, { headers: { "if-none-match": etag as string } });
    expect(after.status).toBe(200);
    const body = (await after.json()) as { sessions: { id: string; turns: number | null }[] };
    expect(body.sessions).toHaveLength(2);
    // The new file's turns ride along without a second read per session.
    expect(body.sessions.find((x) => x.id === "s_test02")?.turns).toBe(2);
  });

  it("incremental reads: a rewritten lesson invalidates the lessons cache", async () => {
    const s = await boot();
    const first = await fetch(`${s.url}/api/lessons`);
    const etag = first.headers.get("etag") as string;

    // Rewrite the log with a second lesson and force a distinct mtime so the
    // stamp cannot alias the previous state on coarse-clock filesystems.
    const file = path.join(root as string, ".memento", "memory", "lessons.jsonl");
    fs.appendFileSync(file, JSON.stringify({ op: "upsert", ts: Date.now() + 1, lesson: { id: "l_test02", text: "Second lesson", kind: "pattern", confidence: 0.35, evidence: ["t"], reinforced: 0, contradicted: 0, scope: "repo", created: Date.now() + 1, lastSeen: Date.now() + 1, tags: [], status: "active" } }) + "\n");
    fs.utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));

    const after = await fetch(`${s.url}/api/lessons`, { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    const body = (await after.json()) as { active: { id: string }[] };
    expect(body.active.map((l) => l.id).sort()).toEqual(["l_test01", "l_test02"]);
  });

  it("inventories installed plugins with provenance, without executing them", async () => {
    const s = await boot();
    const d = (await (await fetch(`${s.url}/api/plugins`)).json()) as {
      plugins: { name: string; scope: string; entry: string; source: string; rev: string; installedAt: string; description: string }[];
      trust: { projectTrusted: boolean };
      enabled: boolean;
    };
    expect(d.enabled).toBe(true);
    // Untrusted by default — the workbench must surface this honestly.
    expect(d.trust.projectTrusted).toBe(false);
    expect(d.plugins).toHaveLength(1);
    expect(d.plugins[0]).toMatchObject({
      name: "todo-guard",
      scope: "project",
      entry: "todo-guard/index.ts",
      source: "https://github.com/memento/plugins.git",
      rev: "abc1234567890",
      description: "Guards TODO markers in specs",
    });
  });

  it("reflects trustProjectPlugins from config in the plugins endpoint", async () => {
    const s = await boot();
    const before = (await (await fetch(`${s.url}/api/plugins`)).json()) as { trust: { projectTrusted: boolean } };
    expect(before.trust.projectTrusted).toBe(false);

    fs.writeFileSync(path.join(root as string, ".memento", "config.json"), JSON.stringify({ trustProjectPlugins: true }));
    const after = (await (await fetch(`${s.url}/api/plugins`)).json()) as { trust: { projectTrusted: boolean } };
    expect(after.trust.projectTrusted).toBe(true);
  });

  it("lists global plugins from the home dir alongside project ones", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "memento-web-home-"));
    fs.mkdirSync(path.join(h, ".memento", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(h, ".memento", "plugins", "now-tool.ts"), "export default { setup() {} };\n");
    const s = await boot({ home: h });
    const d = (await (await fetch(`${s.url}/api/plugins`)).json()) as { plugins: { name: string; scope: string; source: string }[] };
    expect(d.plugins.map((p) => [p.name, p.scope]).sort()).toEqual([
      ["now-tool", "global"],
      ["todo-guard", "project"],
    ]);
    // A loose file has no manifest — provenance falls back to "local".
    expect(d.plugins.find((p) => p.name === "now-tool")?.source).toBe("local");
  });
});

function rawGet(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "GET", headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
