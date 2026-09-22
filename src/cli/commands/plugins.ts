/**
 * `memento plugins` — a minimal plugin marketplace.
 *
 * Install shapes:
 *   memento plugins install owner/repo            GitHub shorthand
 *   memento plugins install owner/repo#subdir     repo subdirectory plugin
 *   memento plugins install https://host/x.git    any git URL
 *   memento plugins install ../my-plugin          local directory
 *
 * Every install lands as a plugin *package* (a directory with an index
 * entry) carrying a `.memento-plugin.json` manifest — source, revision,
 * install time — so `plugins list` can always answer "where did this code
 * come from?".
 *
 * Safety: a plugin is arbitrary code. The command lists the files it is
 * about to copy and asks for confirmation unless `--yes`; project installs
 * (the default) stay in `.memento/plugins` where the checkout's own trust
 * rules already apply.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { hasPluginFiles } from "../../plugins/loader.ts";

const execFileAsync = promisify(execFile);

const MANIFEST = ".memento-plugin.json";

export interface PluginsOptions {
  action: "list" | "install" | "init" | "remove";
  root: string;
  /** install: where to get the plugin from. */
  source?: string;
  /** init/remove: plugin name. */
  name?: string;
  /** install into ~/.memento/plugins instead of the project. */
  global?: boolean;
  /** skip the security confirmation. */
  yes?: boolean;
  /** list: machine-readable output. */
  json?: boolean;
  /** test hook: confirmation strategy (defaults to stdin). */
  confirm?: (prompt: string) => Promise<boolean>;
  /** test hook: shell runner (defaults to real git). */
  git?: (args: string[], cwd: string) => Promise<string>;
}

export interface InstalledPlugin {
  name: string;
  scope: "global" | "project";
  source: string;
  rev?: string;
  installedAt?: string;
}

export interface PluginManifest {
  name?: string;
  source?: string;
  installedAt?: string;
  rev?: string;
  description?: string;
}

function pluginRoot(opts: Pick<PluginsOptions, "global" | "root">): { dir: string; scope: "global" | "project" } {
  return opts.global
    ? { dir: path.join(os.homedir(), ".memento", "plugins"), scope: "global" }
    : { dir: path.join(opts.root, ".memento", "plugins"), scope: "project" };
}

function readManifest(dir: string): PluginManifest | null {
  const file = path.join(dir, MANIFEST);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PluginManifest;
  } catch {
    return null;
  }
}

/** A plugin package is a dir with an index entry; a loose file is a plugin file. */
function scanDir(dir: string): { name: string; manifest: PluginManifest | null }[] {
  if (!fs.existsSync(dir)) return [];
  const found: { name: string; manifest: PluginManifest | null }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && /\.(ts|mjs|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      found.push({ name: e.name.replace(/\.(ts|mjs|js)$/, ""), manifest: null });
    } else if (e.isDirectory() && !e.name.startsWith(".")) {
      const hasIndex = ["index.ts", "index.mjs", "index.js"].some((f) => fs.existsSync(path.join(dir, e.name, f)));
      if (hasIndex) found.push({ name: e.name, manifest: readManifest(path.join(dir, e.name)) });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function realGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

/** Parse `owner/repo[#subdir]`, git URLs, and local paths. */
function parseSource(source: string): { kind: "git" | "local"; url?: string; dir?: string; subdir?: string; fallbackName: string } {
  const hash = source.lastIndexOf("#");
  const base = hash >= 0 ? source.slice(0, hash) : source;
  const subdir = hash >= 0 ? source.slice(hash + 1).replace(/^\/+|\/+$/g, "") : undefined;
  if (/^[\w.-]+\/[\w.-]+$/.test(base) && !base.includes("://") && !fs.existsSync(source)) {
    return { kind: "git", url: `https://github.com/${base}.git`, subdir, fallbackName: base.split("/")[1]! };
  }
  if (/^(https?|git|ssh):/.test(base) || base.startsWith("git@")) {
    const name = path.basename(base.replace(/\.git$/, ""));
    return { kind: "git", url: base, subdir, fallbackName: name };
  }
  return { kind: "local", dir: path.resolve(base), subdir, fallbackName: path.basename(path.resolve(base), path.extname(path.resolve(base))) };
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      out.push(...listFiles(path.join(dir, e.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

async function askConfirm(opts: PluginsOptions, prompt: string): Promise<boolean> {
  if (opts.confirm) return opts.confirm(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function pluginsTask(opts: PluginsOptions): Promise<number> {
  switch (opts.action) {
    case "list":
      return listPlugins(opts);
    case "install":
      return installPlugin(opts);
    case "init":
      return initPlugin(opts);
    case "remove":
      return removePlugin(opts);
  }
}

async function listPlugins(opts: PluginsOptions): Promise<number> {
  const scopes: { dir: string; scope: "global" | "project" }[] = opts.global
    ? [pluginRoot({ global: true, root: opts.root })]
    : [{ dir: path.join(opts.root, ".memento", "plugins"), scope: "project" }, pluginRoot({ global: true, root: opts.root })];

  const all: InstalledPlugin[] = [];
  for (const { dir, scope } of scopes) {
    for (const p of scanDir(dir)) {
      all.push({
        name: p.name,
        scope,
        source: p.manifest?.source ?? "local",
        rev: p.manifest?.rev,
        installedAt: p.manifest?.installedAt,
      });
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ plugins: all }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(pc.magenta(pc.bold("◈ memento plugins")) + pc.dim("\n"));
  if (all.length === 0) {
    process.stdout.write(pc.dim("no plugins installed — try `memento plugins install owner/repo`\n"));
    return 0;
  }
  let lastScope = "";
  for (const p of all) {
    if (p.scope !== lastScope) {
      lastScope = p.scope;
      process.stdout.write(pc.cyan(`${p.scope}:` + (p.scope === "global" ? " ~/.memento/plugins" : " .memento/plugins")) + "\n");
    }
    const rev = p.rev ? pc.dim(` @${p.rev.slice(0, 7)}`) : "";
    process.stdout.write(`  ${pc.bold(p.name)}  ${pc.dim(p.source)}${rev}\n`);
  }
  return 0;
}

async function installPlugin(opts: PluginsOptions): Promise<number> {
  const source = opts.source?.trim();
  if (!source) {
    process.stderr.write(pc.red("install needs a source: `memento plugins install owner/repo`\n"));
    return 1;
  }
  const parsed = parseSource(source);
  const { dir: pluginsDir, scope } = pluginRoot(opts);

  // Stage the plugin content in a temp dir (git clone or local copy).
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "memento-plugin-"));
  try {
    if (parsed.kind === "git") {
      const git = opts.git ?? realGit;
      try {
        await git(["--version"], stage);
      } catch {
        process.stderr.write(pc.red("git is required to install from a repository — pass a local path instead\n"));
        return 1;
      }
      try {
        await git(["clone", "--depth", "1", "--single-branch", parsed.url!, stage], process.cwd());
      } catch (err) {
        process.stderr.write(pc.red(`clone failed: ${(err as Error).message}\n`));
        return 1;
      }
    } else {
      // A loose plugin file is staged as itself (not as a dir) so the file
      // shape survives to the target.
      if (fs.statSync(parsed.dir!).isFile()) {
        fs.copyFileSync(parsed.dir!, path.join(stage, path.basename(parsed.dir!)));
      } else {
        fs.cpSync(parsed.dir!, stage, { recursive: true, filter: (src) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(src) });
      }
    }

    // The plugin lives at the repo root, or at `#subdir` when given.
    let srcDir = parsed.subdir ? path.join(stage, ...parsed.subdir.split("/")) : stage;
    // A loose local plugin file was staged as stage/<basename> — point at it.
    if (parsed.kind === "local" && !parsed.subdir && fs.statSync(parsed.dir!).isFile()) {
      srcDir = path.join(stage, path.basename(parsed.dir!));
    }
    const srcIsFile = fs.existsSync(srcDir) && fs.statSync(srcDir).isFile();
    const okEntry = srcIsFile ? /\.(ts|mjs|js)$/.test(srcDir) && !srcDir.endsWith(".d.ts") : hasPluginFiles(srcDir);
    if (!okEntry) {
      process.stderr.write(pc.red(`no plugin found at ${parsed.subdir ? `#${parsed.subdir}` : "the source root"} — expected an index.ts or a plugin file\n`));
      return 1;
    }

    const manifest = srcIsFile ? null : readManifest(srcDir);
    const name = (manifest?.name ?? parsed.fallbackName).replace(/[^\w.-]+/g, "-");
    const target = srcIsFile ? path.join(pluginsDir, `${name}.ts`) : path.join(pluginsDir, name);
    if (fs.existsSync(target)) {
      process.stderr.write(pc.red(`plugin "${name}" already installed — `) + pc.dim(`\`memento plugins remove ${name}\` first, or re-install after removal\n`));
      return 1;
    }

    if (!opts.yes) {
      const files = listFiles(srcDir).slice(0, 12);
      process.stdout.write(pc.yellow(pc.bold(`install "${name}" → ${scope} plugins?`)) + pc.dim(` (${path.relative(process.cwd(), target)})\n`));
      for (const f of files) process.stdout.write(pc.dim(`  ${f}\n`));
      if (listFiles(srcDir).length > files.length) process.stdout.write(pc.dim(`  … and ${listFiles(srcDir).length - files.length} more\n`));
      process.stdout.write(
        pc.yellow("a plugin is arbitrary code that runs inside your agent sessions — ") +
          pc.dim("install only from sources you trust (project installs stay in .memento/plugins, covered by trustProjectPlugins)\n"),
      );
      if (!(await askConfirm(opts, pc.bold("proceed? [y/N] ")))) {
        process.stdout.write(pc.dim("aborted\n"));
        return 1;
      }
    }

    let rev: string | undefined;
    if (parsed.kind === "git") {
      try {
        rev = await (opts.git ?? realGit)(["rev-parse", "HEAD"], stage);
      } catch {
        /* shallow clones on old git may lack rev-parse; the manifest just omits it */
      }
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (srcIsFile) {
      // A loose plugin file keeps its file shape — no manifest dir to attach one to.
      fs.copyFileSync(srcDir, target);
    } else {
      fs.cpSync(srcDir, target, { recursive: true, filter: (s) => !/(^|[\\/])\.git([\\/]|$)/.test(s) });
      const finalManifest: PluginManifest = {
        ...manifest,
        name,
        source: parsed.kind === "git" ? parsed.url : source,
        installedAt: new Date().toISOString(),
        ...(rev ? { rev } : {}),
      };
      fs.writeFileSync(path.join(target, MANIFEST), JSON.stringify(finalManifest, null, 2) + "\n");
    }

    process.stdout.write(pc.green(`installed ${name} → ${path.relative(process.cwd(), target)}\n`));
    if (scope === "project") {
      process.stdout.write(pc.dim('note: project plugins load only when "trustProjectPlugins": true (untrusted-checkout protection)\n'));
    }
    return 0;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function initPlugin(opts: PluginsOptions): Promise<number> {
  const name = (opts.name ?? "").replace(/[^\w.-]+/g, "-");
  if (!name) {
    process.stderr.write(pc.red("init needs a name: `memento plugins init my-plugin`\n"));
    return 1;
  }
  const { dir } = pluginRoot(opts);
  const file = path.join(dir, `${name}.ts`);
  if (fs.existsSync(file)) {
    process.stderr.write(pc.red(`plugin "${name}" already exists at ${path.relative(process.cwd(), file)}\n`));
    return 1;
  }
  fs.mkdirSync(dir, { recursive: true });
  const template = `/**
 * ${name} — a memento plugin.
 *
 * Loaded with jiti (no build step). Every registration returns a disposer;
 * memento reverses them all on unload.
 */
export default {
  name: "${name}",
  setup(ctx) {
    ctx.log("hello from ${name}");

    // ctx.registerTool({ name, description, schema, execute });
    // ctx.registerSpecChecker({ name, run });
    // ctx.on("session_end", (event) => {});
  },
};
`;
  fs.writeFileSync(file, template);
  process.stdout.write(pc.green(`created ${path.relative(process.cwd(), file)}\n`));
  process.stdout.write(pc.dim("plugin API: see the README plugins section; tools/spec checkers/lifecycle hooks\n"));
  return 0;
}

async function removePlugin(opts: PluginsOptions): Promise<number> {
  const name = (opts.name ?? "").replace(/[^\w.-]+/g, "-");
  if (!name) {
    process.stderr.write(pc.red("remove needs a name: `memento plugins remove my-plugin`\n"));
    return 1;
  }
  const { dir } = pluginRoot(opts);
  const candidates = [path.join(dir, name), path.join(dir, `${name}.ts`), path.join(dir, `${name}.mjs`), path.join(dir, `${name}.js`)];
  const target = candidates.find((c) => fs.existsSync(c));
  if (!target) {
    process.stderr.write(pc.red(`plugin "${name}" not found in ${path.relative(process.cwd(), dir)}\n`));
    return 1;
  }
  fs.rmSync(target, { recursive: true, force: true });
  process.stdout.write(pc.green(`removed ${path.relative(process.cwd(), target)}\n`));
  return 0;
}
