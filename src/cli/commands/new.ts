/**
 * `memento new` — scaffold a fresh project from the bundled starter template.
 *
 * The template ships inside the npm package (examples/starter-template), so
 * `memento new my-app` works offline, with no git clone involved. The copy
 * renames the template's `gitignore` to `.gitignore` (npm strips dotfiles from
 * packages), stamps the project name into the README title, and — unless told
 * otherwise — initializes a git repository for the new project.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

export interface NewOptions {
  /** Target directory name (or "." for the current directory). */
  dir: string;
  /** Workspace root the target is resolved against (default: process cwd). */
  root?: string;
  /** Explicit template directory — overrides the lookup chain (tests use this). */
  templateDir?: string;
  /** Overwrite into a non-empty target directory. */
  force?: boolean;
  /** Run `git init` in the new project (default: true). */
  git?: boolean;
}

/** Directory names that make a target "empty enough" to scaffold into. */
const IGNORED_TARGET_ENTRIES = new Set([".git", ".DS_Store", "Thumbs.db"]);

/**
 * Resolve the bundled starter template. Lookup chain: explicit override →
 * `<root>/examples/starter-template` (a repo checkout) → `../examples/…`
 * relative to the bundled cli (an npm install).
 */
export function findTemplateDir(root?: string, explicit?: string): string | null {
  // An explicit --template is trusted strictly: if it does not look like the
  // starter template, report failure instead of silently falling back.
  if (explicit) {
    const dir = path.resolve(explicit);
    return fs.existsSync(path.join(dir, "README.md")) && fs.existsSync(path.join(dir, "tasks.json")) ? dir : null;
  }
  const candidates: string[] = [];
  if (root) candidates.push(path.resolve(root, "examples/starter-template"));
  // Dev/CI layout: the repo checkout's examples dir next to the process cwd.
  candidates.push(path.resolve(process.cwd(), "examples/starter-template"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli.js → ../examples (npm package); src/cli/commands → ../../examples (repo checkout).
  candidates.push(path.resolve(here, "../examples/starter-template"));
  candidates.push(path.resolve(here, "../../examples/starter-template"));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "README.md")) && fs.existsSync(path.join(dir, "tasks.json"))) {
      return dir;
    }
  }
  return null;
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Scaffold the template into `dir` and return the process exit code.
 * Errors are reported to stderr in memento's usual "clean, actionable" style.
 */
export function newTask(opts: NewOptions): number {
  const root = opts.root ?? process.cwd();
  const target = path.resolve(root, opts.dir);
  const git = opts.git !== false;

  if (opts.dir.split(/[\\/]/).includes("..")) {
    process.stderr.write(pc.red(`invalid target "${opts.dir}": path traversal is not allowed\n`));
    return 1;
  }

  const template = findTemplateDir(root, opts.templateDir);
  if (!template) {
    process.stderr.write(
      pc.red("starter template not found") +
        " — expected examples/starter-template next to this package.\n" +
        pc.dim("Reinstall memento-agent, or pass --template to point at one.\n"),
    );
    return 1;
  }

  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target).filter((name) => !IGNORED_TARGET_ENTRIES.has(name));
    if (entries.length > 0 && !opts.force) {
      process.stderr.write(
        pc.red(`"${opts.dir}" already exists and is not empty`) +
          ` (${entries.length} entr${entries.length === 1 ? "y" : "ies"})\n` +
          pc.dim(`run with --force to scaffold over it, or pick a fresh name\n`),
      );
      return 1;
    }
  } else {
    fs.mkdirSync(target, { recursive: true });
  }

  copyDir(template, target);

  // npm strips dotfiles from packages; the template ships `gitignore` and the
  // scaffold restores the real name.
  const flat = path.join(target, "gitignore");
  if (fs.existsSync(flat)) {
    const dot = path.join(target, ".gitignore");
    if (fs.existsSync(dot) && !opts.force) {
      // Keep both: the template's file and the pre-existing one.
      fs.appendFileSync(dot, "\n" + fs.readFileSync(flat, "utf8"));
    } else {
      fs.renameSync(flat, dot);
    }
  }

  // Stamp the project name into the README title.
  const projectName = path.basename(target);
  const readme = path.join(target, "README.md");
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, "utf8").replace(/^# .*$/m, `# ${projectName}`);
    fs.writeFileSync(readme, text);
  }

  let gitInitialized = false;
  if (git) {
    const res = spawnSync("git", ["init", "-q"], { cwd: target, stdio: "ignore" });
    gitInitialized = res.status === 0;
  }

  process.stdout.write(
    `\n${pc.magenta("◈")} ${pc.bold("memento")} scaffolded ${pc.cyan(projectName)} into ${pc.dim(target)}\n\n` +
      `  ${pc.bold("Next steps:")}\n` +
      `  ${pc.cyan("cd")} ${opts.dir === "." ? "." : projectName}\n` +
      `  ${pc.cyan("memento init")}                ${pc.dim("pick a provider, write .memento/config.json")}\n` +
      `  ${pc.cyan("memento spec show")}           ${pc.dim("read the constitution + feature specs")}\n` +
      `  ${pc.cyan("memento run")} "implement the sample feature"   ${pc.dim("your first session")}\n` +
      `  ${pc.cyan("memento bench tasks.json --dry")}   ${pc.dim("see the harness without an API key")}\n` +
      (gitInitialized ? "" : pc.dim("\n  (git init skipped — no git on PATH or --no-git)\n")),
  );
  return 0;
}
