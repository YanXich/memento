/**
 * `memento plugins` command tests — the marketplace plumbing: install
 * (local path + git shorthand), manifest provenance, list/remove/init,
 * and the loader's new package-dir shape.
 */
import fs from "node:fs";
import { rmWithRetry } from "./support/rm.ts";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginsTask } from "../src/cli/commands/plugins.ts";
import { specVerifyCmd } from "../src/cli/commands/spec.ts";
import { loadPlugins } from "../src/plugins/loader.ts";
import type { PluginHost } from "../src/plugins/loader.ts";
import { ToolRegistry } from "../src/tools/types.ts";

let dir: string;
let writes: string[];

function capture(): void {
  writes = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    writes.push(String(c));
    return true;
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-plugin-cmd-"));
  capture();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmWithRetry(dir);
});

function pluginSourceDir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "memento-plugin-src-"));
  const src = path.join(base, "greet");
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(src, "index.ts"),
    `export default { name: "greet", setup(ctx) { ctx.registerTool({ name: "greet_tool", description: "greets", schema: { safeParse: (v) => ({ success: true, data: v }) }, execute: async () => ({ output: "hi" }) }); } };\n`,
  );
  fs.writeFileSync(path.join(src, "README.md"), "a greeting plugin\n");
  return src;
}

describe("plugins install (local path)", () => {
  it("copies the package dir, writes a provenance manifest, and the loader can load it", async () => {
    const src = pluginSourceDir();
    const code = await pluginsTask({ action: "install", source: src, root: dir, yes: true });
    expect(code).toBe(0);

    const pkg = path.join(dir, ".memento/plugins/greet");
    expect(fs.existsSync(path.join(pkg, "index.ts"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, ".memento-plugin.json"), "utf8"));
    expect(manifest.name).toBe("greet");
    expect(manifest.source).toBe(src);
    expect(manifest.installedAt).toBeTruthy();

    // The loader must pick up the package-dir shape.
    const host: PluginHost & { tools: ToolRegistry } = {
      tools: new ToolRegistry(),
      specCheckers: [],
      eventHandlers: new Map(),
      cwd: dir,
      log: () => {},
    };
    const loaded = await loadPlugins(host, { cwd: dir, extraDirs: [] });
    expect(loaded.map((p) => p.name)).toContain("greet");
    expect(host.tools.names()).toContain("greet_tool");
    fs.rmSync(src, { recursive: true, force: true });
  });

  it("refuses to overwrite an installed plugin", async () => {
    const src = pluginSourceDir();
    await pluginsTask({ action: "install", source: src, root: dir, yes: true });
    const code = await pluginsTask({ action: "install", source: src, root: dir, yes: true });
    expect(code).toBe(1);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it("rejects a source with no plugin entry", async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "memento-plugin-empty-"));
    fs.writeFileSync(path.join(src, "notes.txt"), "nothing here");
    const code = await pluginsTask({ action: "install", source: src, root: dir, yes: true });
    expect(code).toBe(1);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it("asks for confirmation and aborts on 'no'", async () => {
    const src = pluginSourceDir();
    const code = await pluginsTask({
      action: "install",
      source: src,
      root: dir,
      confirm: async () => false,
    });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(dir, ".memento/plugins/greet"))).toBe(false);
    fs.rmSync(src, { recursive: true, force: true });
  });
});

describe("plugins install (git shorthand)", () => {
  it("clones owner/repo via git, records the revision, names from the repo", async () => {
    const git = async (args: string[], cwd: string): Promise<string> => {
      if (args[0] === "--version") return "git version 2.40";
      if (args[0] === "clone") {
        const dest = args[args.length - 1]!; // git clone <url> <dest>
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "index.ts"), `export default { name: "starred", setup() {} };\n`);
        return "";
      }
      if (args[0] === "rev-parse") return "deadbeefcafe";
      return "";
    };
    const code = await pluginsTask({ action: "install", source: "octocat/greet-plugin", root: dir, yes: true, git });
    expect(code).toBe(0);

    const pkg = path.join(dir, ".memento/plugins/greet-plugin");
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, ".memento-plugin.json"), "utf8"));
    expect(manifest.source).toBe("https://github.com/octocat/greet-plugin.git");
    expect(manifest.rev).toBe("deadbeefcafe");
    expect(manifest.name).toBe("greet-plugin");
  });

  it("honours owner/repo#subdir and names from the subdir manifest", async () => {
    const git = async (args: string[], cwd: string): Promise<string> => {
      if (args[0] === "--version") return "git version 2.40";
      if (args[0] === "clone") {
        const dest = args[args.length - 1]!;
        fs.mkdirSync(path.join(dest, "plugins", "nested"), { recursive: true });
        fs.writeFileSync(path.join(dest, "plugins", "nested", "index.ts"), `export default { name: "nested", setup() {} };\n`);
        fs.writeFileSync(path.join(dest, "plugins", "nested", ".memento-plugin.json"), JSON.stringify({ name: "from-manifest" }));
        return "";
      }
      if (args[0] === "rev-parse") return "abc1234";
      return "";
    };
    const code = await pluginsTask({ action: "install", source: "octocat/mono#plugins/nested", root: dir, yes: true, git });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, ".memento/plugins/from-manifest/index.ts"))).toBe(true);
  });
});

describe("spec verify sees plugin checkers", () => {
  it("runs a plugin-registered spec checker (install → trust → verify reports the issue)", async () => {
    // A project with a TODO in source, a spec, and todo-guard installed + trusted.
    fs.mkdirSync(path.join(dir, ".memento/spec"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".memento/spec/architecture.md"), "# Architecture\n");
    fs.writeFileSync(path.join(dir, ".memento/config.json"), JSON.stringify({ trustProjectPlugins: true }));
    fs.writeFileSync(path.join(dir, "app.ts"), "const x = 1; // TODO: refactor later\n");

    const src = fs.mkdtempSync(path.join(os.tmpdir(), "memento-todo-src-"));
    fs.mkdirSync(path.join(src, "todo-guard"), { recursive: true });
    fs.writeFileSync(
      path.join(src, "todo-guard", "index.ts"),
      `import fs from "node:fs";
import path from "node:path";
export default {
  name: "todo-guard",
  setup(ctx) {
    ctx.registerSpecChecker({
      name: "todo-markers",
      run(root) {
        const issues = [];
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (e.isFile() && e.name.endsWith(".ts")) {
            const text = fs.readFileSync(path.join(root, e.name), "utf8");
            if (text.includes("TODO")) issues.push({ path: e.name, message: "unresolved TODO in " + e.name });
          }
        }
        return issues;
      },
    });
  },
};
`,
    );
    expect(await pluginsTask({ action: "install", source: path.join(src, "todo-guard"), root: dir, yes: true })).toBe(0);

    writes = [];
    const code = await specVerifyCmd(dir);
    expect(code).toBe(0); // warnings do not fail the gate; errors would
    expect(writes.join("")).toContain("todo-markers");
    expect(writes.join("")).toContain("unresolved TODO");
    fs.rmSync(src, { recursive: true, force: true });
  });
});

describe("plugins list / init / remove", () => {
  it("lists project plugins with their origin and machine-readable JSON", async () => {
    const src = pluginSourceDir();
    await pluginsTask({ action: "install", source: src, root: dir, yes: true });

    writes = [];
    await pluginsTask({ action: "list", root: dir });
    expect(writes.join("")).toContain("greet");

    writes = [];
    await pluginsTask({ action: "list", root: dir, json: true });
    const out = JSON.parse(writes.join(""));
    expect(out.plugins.map((p: { name: string }) => p.name)).toContain("greet");
    expect(out.plugins.find((p: { name: string }) => p.name === "greet").scope).toBe("project");
    expect(out.plugins.find((p: { name: string }) => p.name === "greet").source).toBe(src);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it("init scaffolds a template, remove deletes it", async () => {
    expect(await pluginsTask({ action: "init", name: "my-plugin", root: dir })).toBe(0);
    const file = path.join(dir, ".memento/plugins/my-plugin.ts");
    expect(fs.readFileSync(file, "utf8")).toContain('name: "my-plugin"');

    expect(await pluginsTask({ action: "remove", name: "my-plugin", root: dir })).toBe(0);
    expect(fs.existsSync(file)).toBe(false);

    expect(await pluginsTask({ action: "remove", name: "never-existed", root: dir })).toBe(1);
  });
});
