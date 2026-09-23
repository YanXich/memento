/**
 * UX regression tests (audit round 6).
 *
 *  - non-interactive approval refusals go to stderr, keeping piped stdout
 *    clean (M19)
 *  - the approval abort listener is removed after each prompt (M18)
 *  - shortId is alphabet-uniform via rejection sampling (M20)
 *  - undo snapshots use isInside, not a string prefix (M17)
 *  - cmd.exe argument quoting doubles % signs (M22)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApprover } from "../src/cli/ui.ts";
import { shortId } from "../src/util/ids.ts";
import { snapshotBeforeWrite, hasUndoSnapshots } from "../src/tools/snapshot.ts";
import { quoteWinArg } from "../src/mcp/client.ts";
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmWithRetry(d);
  dirs = [];
  vi.restoreAllMocks();
});

function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "memento-ux-"));
  dirs.push(d);
  return d;
}

describe("non-interactive approvals (M19)", () => {
  it("refuses on stderr so piped stdout stays clean", async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
      stderr.push(String(c));
      return true;
    }) as never);
    const stdout = vi.spyOn(process.stdout, "write");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const approver = createApprover({});
    const ok = await approver.approve("bash", { command: "rm x" });
    expect(ok).toBe(false);
    expect(stderr.join("")).toContain("requires approval");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("auto-approves without prompting even when non-interactive", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const approver = createApprover({ autoApprove: ["read"] });
    await expect(approver.approve("read", { path: "a.txt" })).resolves.toBe(true);
  });
});

describe("abort listener hygiene (M18)", () => {
  it("removes the abort listener after an answered prompt", async () => {
    // Interactive approval requires a TTY — set it explicitly so a previous
    // test's non-TTY stub can never leak in.
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const controller = new AbortController();
    let listeners = 0;
    const original = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(((...args: unknown[]) => {
      listeners += 1;
      return (original as (...a: unknown[]) => void)(...args);
    }) as never);
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation(((...args: unknown[]) => {
      listeners -= 1;
      return (originalRemove as (...a: unknown[]) => void)(...args);
    }) as never);

    // A fake readline that answers immediately, like the REPL would.
    const rl = {
      question: (_q: string) => Promise.resolve("y"),
      close: () => {},
    } as never;
    const approver = createApprover({ signal: controller.signal, rl });
    const ok = await approver.approve("write", { path: "a.txt" });
    expect(ok).toBe(true);
    expect(listeners).toBe(0); // added then removed — nothing left on the signal
    approver.close();
  });
});

describe("id uniformity (M20)", () => {
  it("produces ids of the right shape from the right alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const id = shortId("s", 10);
      expect(id).toMatch(/^s_[a-z0-9]{10}$/);
    }
  });

  it("spreads characters uniformly (no modulo bias)", () => {
    // 8000 ids × 8 chars = 64k samples. With rejection sampling the count per
    // character hugs the mean tightly; the old `% 36` bias pushed a–d ~13%
    // above the mean — far outside this bound.
    const counts = new Map<string, number>();
    for (let i = 0; i < 8000; i++) {
      for (const ch of shortId("x", 8).slice(2)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    const values = [...counts.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    for (const v of values) {
      expect(v).toBeGreaterThan(mean * 0.85);
      expect(v).toBeLessThan(mean * 1.15);
    }
  });
});

describe("undo snapshot boundary (M17)", () => {
  it("never snapshots a path outside the workspace", () => {
    const root = tmpdir();
    const outside = tmpdir();
    snapshotBeforeWrite(root, path.relative(root, path.join(outside, "secret.txt")));
    expect(hasUndoSnapshots(root)).toBe(false);
    expect(fs.existsSync(path.join(root, ".memento", "undo"))).toBe(false);
  });

  it("still snapshots a workspace-relative write", () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, "a.txt"), "before");
    snapshotBeforeWrite(root, "a.txt");
    expect(hasUndoSnapshots(root)).toBe(true);
  });
});

describe("cmd.exe argument quoting (M22)", () => {
  it("leaves simple args alone", () => {
    expect(quoteWinArg("npx")).toBe("npx");
    expect(quoteWinArg("plain/path")).toBe("plain/path");
  });

  it("doubles % so cmd.exe does not expand env vars", () => {
    expect(quoteWinArg("100%done")).toBe('"100%%done"');
    expect(quoteWinArg("C:\\Users\\A B\\x")).toBe('"C:\\Users\\A B\\x"');
  });
});
