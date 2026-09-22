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

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-web-"));
  fs.mkdirSync(path.join(dir, ".memento", "spec"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".memento", "memory"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".memento", "sessions"), { recursive: true });

  fs.writeFileSync(path.join(dir, ".memento", "spec", "constitution.md"), "# Constitution\n\n- Keep it small.\n");

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

async function boot(): Promise<WebServer> {
  root = makeFixture();
  server = await startWebServer({ root, port: 0 });
  return server;
}

afterEach(async () => {
  if (server) await server.close();
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("web workbench", () => {
  it("serves the UI document at /", async () => {
    const s = await boot();
    const page = await fetch(`${s.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<!doctype html");
  });

  it("reflects spec, memory, and sessions through the same stores as the CLI", async () => {
    const s = await boot();

    const ov = (await (await fetch(`${s.url}/api/overview`)).json()) as {
      spec: { files: number };
      memory: { active: number };
      sessions: { total: number };
      lessons: { recent: { id: string }[] };
    };
    expect(ov.spec.files).toBe(1);
    expect(ov.memory.active).toBe(1);
    expect(ov.sessions.total).toBe(1);
    expect(ov.lessons.recent[0]?.id).toBe("l_test01");

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
