/**
 * Spec engine tests — the spec must be checkable, and recall must be useful
 * without an LLM. These tests hold the "a spec that cannot be checked is a
 * wish" line.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSpecBundle, nextDecisionNumber, specStatus, writeSpec } from "../src/spec/store.ts";
import { scanRepo } from "../src/spec/scanner.ts";
import { verifySpec } from "../src/spec/verify.ts";
import { recallSpec } from "../src/spec/recall.ts";
import { decisionPath } from "../src/spec/generator.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-spec-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "vitest run", build: "tsup" } }, null, 2),
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/index.ts"), "export const x = 1;\n");
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests/app.test.ts"), "// test\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Fixture\n\nA tiny repo for spec tests.\n");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanner", () => {
  it("detects languages, test dirs, manifests, and entry hints", () => {
    const scan = scanRepo(dir);
    expect(scan.fileCount).toBeGreaterThanOrEqual(4);
    expect(scan.languages.some((l) => l.name === "TypeScript")).toBe(true);
    expect(scan.testDirs).toContain("tests");
    expect(scan.packageManifest).toContain("fixture");
    expect(scan.readmeExcerpt).toContain("A tiny repo");
    expect(scan.entryHints).toContain("src/index.ts");
  });
});

describe("store", () => {
  it("round-trips spec files and classifies kinds", () => {
    writeSpec(dir, ".memento/spec/constitution.md", "# Constitution\n\n- rule one\n");
    writeSpec(dir, ".memento/spec/features/auth.md", "# Auth\n\n## Behavior\n- login works\n");
    writeSpec(dir, ".memento/spec/decisions/0001-use-sqlite.md", "# Use SQLite\n");
    const bundle = loadSpecBundle(dir);
    expect(bundle.constitution?.relPath).toBe(".memento/spec/constitution.md");
    expect(bundle.features).toHaveLength(1);
    expect(bundle.features[0]!.slug).toBe("auth");
    expect(bundle.decisions[0]!.slug).toBe("use-sqlite");
    const status = specStatus(dir);
    expect(status.initialized).toBe(true);
    expect(status.counts.feature).toBe(1);
  });

  it("numbers decisions monotonically", () => {
    expect(nextDecisionNumber(dir)).toBe(1);
    writeSpec(dir, ".memento/spec/decisions/0003-something.md", "# x\n");
    expect(nextDecisionNumber(dir)).toBe(4);
    expect(decisionPath(dir, "Use SQLite for storage")).toMatch(/decisions\/0004-use-sqlite-for-storage\.md$/);
  });
});

describe("verify", () => {
  it("flags referenced paths that do not exist and stale npm scripts", () => {
    writeSpec(
      dir,
      ".memento/spec/features/app.md",
      [
        "# App",
        "",
        "Entry point: `src/index.ts` (exists) and `src/missing.ts` (does not).",
        "",
        "Run with `npm run deploy` (no such script).",
        "",
        "TODO: document the flags",
      ].join("\n"),
    );
    const report = verifySpec(dir, loadSpecBundle(dir));
    const messages = report.issues.map((i) => i.message).join("\n");
    expect(messages).toContain("src/missing.ts");
    expect(messages).not.toContain("src/index.ts` which does not exist");
    expect(messages).toContain("deploy");
    expect(messages).toContain("TODO");
    expect(report.passed).toBe(true); // warnings/info only — no errors
  });

  it("passes with a clean spec and counts checked files", () => {
    writeSpec(dir, ".memento/spec/constitution.md", "# Constitution\n\n- be honest\n");
    const report = verifySpec(dir, loadSpecBundle(dir));
    expect(report.passed).toBe(true);
    expect(report.checked).toBe(1);
  });

  it("accepts extra plugin checkers and reports their crashes as warnings", () => {
    writeSpec(dir, ".memento/spec/constitution.md", "# Constitution\n");
    const report = verifySpec(dir, loadSpecBundle(dir), [
      { name: "boom", run: () => { throw new Error("checker exploded"); } },
    ]);
    expect(report.issues.some((i) => i.message.includes("checker exploded"))).toBe(true);
  });
});

describe("recallSpec", () => {
  it("always injects the constitution and ranks matching features first", () => {
    writeSpec(dir, ".memento/spec/constitution.md", "# Constitution\n\n## Forbidden\n- no hand-edited lockfiles\n");
    writeSpec(dir, ".memento/spec/features/billing.md", "# Billing\n\n## Behavior\n- invoices are generated monthly\n");
    writeSpec(dir, ".memento/spec/features/auth.md", "# Auth\n\n## Behavior\n- session cookies expire after 24h\n");
    const bundle = loadSpecBundle(dir);

    // Matches auth (session, cookies) more strongly than billing (invoice).
    const context = recallSpec(bundle, "change session cookies for the invoice export");
    expect(context).toContain("constitution.md");
    expect(context).toContain("auth.md");
    expect(context).toContain("billing.md");
    expect(context.indexOf("auth.md")).toBeLessThan(context.indexOf("billing.md"));
  });

  it("returns only constitution+architecture when nothing matches", () => {
    writeSpec(dir, ".memento/spec/constitution.md", "# Constitution\n");
    writeSpec(dir, ".memento/spec/features/billing.md", "# Billing\n\n- invoices monthly\n");
    const context = recallSpec(loadSpecBundle(dir), "zzz unrelated topic qqq");
    expect(context).toContain("constitution.md");
    expect(context).not.toContain("billing.md");
  });
});
