/**
 * Doctor + init — the first-run funnel.
 *
 * `memento doctor` must never say "everything checks out" while the agent
 * cannot start, `memento init` must scaffold a working config stub for any
 * built-in provider, `doctor --fix` repairs what can be repaired, and the
 * interactive wizard maps menu answers to a config.
 */
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as readlinePromises from "node:readline/promises";
import { doctorCmd, initCmd } from "../src/cli/commands/doctor.ts";

// The wizard is the only consumer of readline — script its answers so the
// prompt flow is testable without a TTY.
vi.mock("node:readline/promises", () => {
  const question = vi.fn();
  return {
    createInterface: () => ({ question, close: vi.fn() }),
    __question: question,
  };
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-doctor-"));
});

afterEach(() => {
  rmWithRetry(dir);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function wizardQuestion(): ReturnType<typeof vi.fn> {
  const mock = readlinePromises as unknown as { __question: ReturnType<typeof vi.fn> };
  return mock.__question;
}

describe("memento init", () => {
  it("scaffolds a deepseek config stub by default and points at its env var", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await initCmd(dir)).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8"));
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.model).toBe("deepseek-chat");
    expect(out.mock.calls.join("\n")).toContain("DEEPSEEK_API_KEY");
  });

  it("writes the first model of the requested built-in provider", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await initCmd(dir, false, "ollama")).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8"));
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("qwen3:8b");
  });

  it("rejects unknown providers with the built-in list and writes nothing", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await initCmd(dir, false, "bogus")).toBe(1);
    expect(err.mock.calls.join("\n")).toContain("deepseek");
    expect(fs.existsSync(path.join(dir, ".memento/config.json"))).toBe(false);
  });

  it("does not overwrite an existing config without --force", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await initCmd(dir)).toBe(0);
    const before = fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8");
    out.mockClear();
    expect(await initCmd(dir, false, "openai")).toBe(0);
    expect(fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8")).toBe(before);
  });

  it("wizard: menu answers map to provider, model, and auto-approve", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const q = wizardQuestion();
    q.mockResolvedValueOnce("2") // provider → openai
      .mockResolvedValueOnce("2") // model → gpt-4o-mini
      .mockResolvedValueOnce("y"); // auto-approve yes
    expect(await initCmd(dir, false, undefined, { interactive: true })).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8"));
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.autoApprove).toEqual(["write", "edit"]);
  });

  it("wizard: declining auto-approve writes an empty list", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const q = wizardQuestion();
    q.mockResolvedValueOnce("") // provider → default (deepseek)
      .mockResolvedValueOnce("") // model → default
      .mockResolvedValueOnce("n"); // auto-approve no
    expect(await initCmd(dir, false, undefined, { interactive: true })).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8"));
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.autoApprove).toEqual([]);
  });
});

describe("memento doctor", () => {
  it("counts a missing provider as a problem instead of 'everything checks out'", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await doctorCmd(dir)).toBe(1);
    const text = out.mock.calls.join("\n");
    expect(text).toContain("provider");
    expect(text).toContain("not set");
    expect(text).not.toContain("everything checks out");
  });

  it("--fix writes a working config and exits 0", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await doctorCmd(dir, { fix: true })).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8"));
    expect(["deepseek", "openai", "anthropic", "ollama", "moonshot"]).toContain(cfg.provider);
    expect(cfg.model).toBeTruthy();
    expect(out.mock.calls.join("\n")).toContain("fixing");
  });
});
