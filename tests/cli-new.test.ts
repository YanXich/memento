import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";
import { newTask, findTemplateDir } from "../src/cli/commands/new.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-new-"));
});

afterEach(() => {
  rmWithRetry(dir);
});

describe("memento new", () => {
  it("scaffolds the starter template: spec, bench tasks, restored .gitignore", () => {
    const code = newTask({ dir: "my-app", root: dir, git: false });
    expect(code).toBe(0);
    const root = path.join(dir, "my-app");
    expect(fs.existsSync(path.join(root, ".memento/spec/constitution.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "tasks.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(root, "gitignore"))).toBe(false);
    const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".memento/");
  });

  it("stamps the project name into the README title", () => {
    newTask({ dir: "cool-app", root: dir, git: false });
    const readme = fs.readFileSync(path.join(dir, "cool-app", "README.md"), "utf8");
    expect(readme).toMatch(/^# cool-app$/m);
  });

  it("scaffolds into '.' for the current directory", () => {
    const empty = fs.mkdtempSync(path.join(dir, "empty-"));
    const code = newTask({ dir: ".", root: empty, git: false });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(empty, "tasks.json"))).toBe(true);
    const readme = fs.readFileSync(path.join(empty, "README.md"), "utf8");
    expect(readme.startsWith(`# ${path.basename(empty)}`)).toBe(true);
  });

  it("refuses a non-empty target without --force, scaffolds with it", () => {
    const target = path.join(dir, "busy");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "keep.txt"), "precious\n");
    expect(newTask({ dir: "busy", root: dir, git: false })).toBe(1);
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("precious\n");
    expect(fs.existsSync(path.join(target, "tasks.json"))).toBe(false);

    expect(newTask({ dir: "busy", root: dir, git: false, force: true })).toBe(0);
    expect(fs.existsSync(path.join(target, "tasks.json"))).toBe(true);
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("precious\n");
  });

  it("rejects path traversal targets", () => {
    expect(newTask({ dir: "../escape", root: dir, git: false })).toBe(1);
    expect(newTask({ dir: "a/../../escape", root: dir, git: false })).toBe(1);
    expect(fs.existsSync(path.join(os.tmpdir(), "escape"))).toBe(false);
  });

  it("accepts an absolute target path", () => {
    const abs = path.join(dir, "abs-app");
    expect(newTask({ dir: abs, root: dir, git: false })).toBe(0);
    expect(fs.existsSync(path.join(abs, "tasks.json"))).toBe(true);
    const readme = fs.readFileSync(path.join(abs, "README.md"), "utf8");
    expect(readme.startsWith("# abs-app")).toBe(true);
  });

  it("reports a clean error when an explicit --template does not look like a template", () => {
    const bogus = fs.mkdtempSync(path.join(dir, "bogus-"));
    fs.writeFileSync(path.join(bogus, "README.md"), "not a template\n");
    const code = newTask({ dir: "x", root: dir, templateDir: bogus, git: false });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(dir, "x"))).toBe(false);
  });

  it("runs git init in the new project when git is available", () => {
    newTask({ dir: "gitted", root: dir });
    expect(fs.existsSync(path.join(dir, "gitted", ".git"))).toBe(true);
  });

  it("resolves the template from a repo checkout layout", () => {
    // The repo root has examples/starter-template — the dev-mode lookup chain.
    const template = findTemplateDir(process.cwd());
    expect(template).not.toBeNull();
    expect(fs.existsSync(path.join(template!, "tasks.json"))).toBe(true);
  });
});
