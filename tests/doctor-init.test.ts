/**
 * Doctor + init — the first-run funnel.
 *
 * `memento doctor` must never say "everything checks out" while the agent
 * cannot start, and `memento init` must scaffold a working config stub for
 * any built-in provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCmd, initCmd } from "../src/cli/commands/doctor.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-doctor-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("memento init", () => {
  it("scaffolds a deepseek config stub by default and points at its env var", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(initCmd(dir)).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8"));
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.model).toBe("deepseek-chat");
    expect(out.mock.calls.join("\n")).toContain("DEEPSEEK_API_KEY");
  });

  it("writes the first model of the requested built-in provider", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(initCmd(dir, false, "ollama")).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8"));
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("qwen3:8b");
  });

  it("rejects unknown providers with the built-in list and writes nothing", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(initCmd(dir, false, "bogus")).toBe(1);
    expect(err.mock.calls.join("\n")).toContain("deepseek");
    expect(fs.existsSync(path.join(dir, ".memento/config.json"))).toBe(false);
  });

  it("does not overwrite an existing config without --force", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(initCmd(dir)).toBe(0);
    const before = fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8");
    out.mockClear();
    expect(initCmd(dir, false, "openai")).toBe(0);
    expect(fs.readFileSync(path.join(dir, ".memento/config.json"), "utf8")).toBe(before);
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
});
