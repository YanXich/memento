/**
 * `memento demo` — end-to-end: the packaged CLI drives the full
 * recall → gate → build → verify → reflect loop against a scripted model.
 *
 * Needs a build (`dist/cli.js`) — skipped when running from a clean checkout
 * before `npm run build`; the CI demo smoke covers the built artifact too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { demoTask } from "../src/cli/commands/demo.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCli = path.join(repoRoot, "dist", "cli.js");
const hasDist = fs.existsSync(distCli);

const workspaces: string[] = [];
afterEach(() => {
  for (const w of workspaces) fs.rmSync(w, { recursive: true, force: true });
  workspaces.length = 0;
});

describe.skipIf(!hasDist)("memento demo (e2e, built CLI)", () => {
  it("runs the full loop zero-key and leaves real artifacts", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "memento-demo-test-"));
    workspaces.push(ws);

    const code = await demoTask({ workspace: ws, cliEntry: distCli });
    expect(code).toBe(0);

    // The scripted model localized the greeting and shipped a test.
    expect(fs.readFileSync(path.join(ws, "greet.js"), "utf8")).toContain("你好");
    expect(fs.readFileSync(path.join(ws, "greet.test.js"), "utf8")).toContain("greet.test.js passed");

    // Reflection wrote a new lesson on top of the seeded one.
    const lessons = fs.readFileSync(path.join(ws, ".memento", "memory", "lessons.jsonl"), "utf8").trim().split("\n");
    expect(lessons.length).toBe(2);

    // The audit trail exists and ended cleanly.
    const sessions = fs.readdirSync(path.join(ws, ".memento", "sessions")).filter((n) => n.endsWith(".jsonl"));
    expect(sessions.length).toBe(1);
    const log = fs.readFileSync(path.join(ws, ".memento", "sessions", sessions[0]!), "utf8");
    expect(log).toContain('"status":"done"');
  }, 60_000);
});
