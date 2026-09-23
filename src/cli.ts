/**
 * CLI entry — commander wiring only. Every command body lives in
 * `cli/commands/*` so it can be unit-tested without spawning a process.
 */
import { Command } from "commander";
import pc from "picocolors";
import { VERSION } from "./version.ts";
import { runTask } from "./cli/commands/run.ts";
import { planTask } from "./cli/commands/plan.ts";
import { resumeTask } from "./cli/commands/resume.ts";
import { chatTask } from "./cli/commands/chat.ts";
import { benchTask } from "./cli/commands/bench.ts";
import { specDecisionCmd, specInit, specShowCmd, specStatusCmd, specVerifyCmd } from "./cli/commands/spec.ts";
import { lessonsCmd, memoryExportCmd, memoryImportCmd, rememberCmd } from "./cli/commands/memory.ts";
import { sessionShowCmd, sessionsCmd } from "./cli/commands/sessions.ts";
import { doctorCmd, initCmd } from "./cli/commands/doctor.ts";
import { webCmd } from "./cli/commands/web.ts";
import { serveMcp } from "./cli/commands/serve.ts";
import { undoCmd } from "./cli/commands/undo.ts";
import { pluginsTask } from "./cli/commands/plugins.ts";
import { newTask } from "./cli/commands/new.ts";
import { reviewTask } from "./cli/commands/review.ts";

const program = new Command();

program
  .name("memento")
  .description("Spec-driven coding agent with persistent memory. Every session makes it smarter; every spec stays alive.")
  .version(VERSION)
  .enablePositionalOptions();

const cwdOption = ["-C, --cwd <dir>", "workspace root (default: current directory)"] as const;

/** `-C` is optional everywhere — fall back to the process cwd. */
function rootOf(opts: { cwd?: string }): string {
  return opts.cwd ?? process.cwd();
}

program
  .command("run")
  .description("run one task through the full loop: recall → spec gate → build → verify → reflect")
  .argument("<task...>", "the task, in plain words")
  .option(...cwdOption)
  .option("-p, --provider <id>", "provider id (deepseek, openai, anthropic, ollama, moonshot, glm, qwen, …)")
  .option("-m, --model <id>", "model id")
  .option("--max-turns <n>", "hard cap on agent turns", (v) => parseInt(v, 10))
  .option("--temperature <n>", "sampling temperature", (v) => parseFloat(v))
  .option("-y, --yes", "approve all tool calls without asking")
  .option("--spec-gate <mode>", "spec gate behaviour: ask | auto | off", "ask")
  .option("--no-reflect", "skip the post-session reflection pass")
  .option("--no-verify", "skip spec verification after the session")
  .option("--no-commit-hint", "skip the suggested commit message")
  .option("--show-thinking", "print the model's thinking stream")
  .option("--verbose-tools", "print full tool outputs instead of previews")
  .action(async (taskParts: string[], opts) => {
    const gate = opts.specGate as string;
    if (!["ask", "auto", "off"].includes(gate)) {
      process.stderr.write(pc.red(`invalid --spec-gate "${gate}" (use ask | auto | off)\n`));
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runTask({
      task: taskParts.join(" "),
      root: rootOf(opts),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      yes: Boolean(opts.yes),
      specGate: gate as "ask" | "auto" | "off",
      reflect: opts.reflect,
      verify: opts.verify,
      commitHint: opts.commitHint,
      showThinking: Boolean(opts.showThinking),
      verboseTools: Boolean(opts.verboseTools),
    });
  });

program
  .command("plan")
  .description("draft a plan (spec + lessons + repo map), get approval, then execute")
  .argument("<task...>", "the task, in plain words")
  .option(...cwdOption)
  .option("-p, --provider <id>", "provider id")
  .option("-m, --model <id>", "model id")
  .option("-y, --yes", "skip the approval prompt and execute the plan immediately")
  .action(async (taskParts: string[], opts) => {
    process.exitCode = await planTask({
      task: taskParts.join(" "),
      root: rootOf(opts),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      yes: Boolean(opts.yes),
    });
  });

program
  .command("chat")
  .description("interactive session — chat with the agent; each exchange is remembered")
  .option(...cwdOption)
  .option("-p, --provider <id>", "provider id")
  .option("-m, --model <id>", "model id")
  .option("--max-turns <n>", "hard cap on agent turns per message", (v) => parseInt(v, 10))
  .option("--temperature <n>", "sampling temperature", (v) => parseFloat(v))
  .option("-y, --yes", "approve all tool calls without asking")
  .option("--session <id>", "continue an existing session (id or prefix)")
  .option("--show-thinking", "print the model's thinking stream")
  .option("--verbose-tools", "print full tool outputs instead of previews")
  .action(async (opts) => {
    process.exitCode = await chatTask({
      root: rootOf(opts),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.session ? { session: opts.session } : {}),
      yes: Boolean(opts.yes),
      showThinking: Boolean(opts.showThinking),
      verboseTools: Boolean(opts.verboseTools),
    });
  });

program
  .command("bench")
  .description("measure the memory effect: cold (no lessons) vs warm (recalled lessons) runs over a family of tasks")
  .argument("<tasks-file>", "JSON file with { tasks: [{ name, task }] }")
  .option(...cwdOption)
  .option("-p, --provider <id>", "provider id")
  .option("-m, --model <id>", "model id")
  .option("--max-turns <n>", "hard cap on agent turns per run", (v) => parseInt(v, 10))
  .option("--dry", "deterministic mock provider — zero network, for CI and demos")
  .option("--jobs <n>", "parallel cold copies (default: all in --dry, 2 for real providers)", (v) => parseInt(v, 10))
  .option("--no-cold", "skip the cold runs (warm learning curve only)")
  .option("--keep", "keep the run directory for inspection")
  .option("--json", "machine-readable output")
  .option("--report <path>", "write a brand-styled standalone HTML report (commit it, share it)")
  .action(async (file: string, opts) => {
    process.exitCode = await benchTask({
      file,
      root: rootOf(opts),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      dry: Boolean(opts.dry),
      noCold: Boolean(opts.noCold),
      keep: Boolean(opts.keep),
      json: Boolean(opts.json),
      ...(opts.jobs ? { jobs: opts.jobs } : {}),
      ...(opts.report ? { report: opts.report } : {}),
    });
  });

const spec = program.command("spec").description("the specification lifecycle");

spec
  .command("init")
  .description("scan the repo and draft constitution + architecture + feature overview")
  .option(...cwdOption)
  .option("-p, --provider <id>")
  .option("-m, --model <id>")
  .option("--force", "overwrite existing spec files")
  .option("--scan-only", "print the deterministic scan without calling the model")
  .action(async (opts) => {
    process.exitCode = await specInit({
      root: rootOf(opts),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      force: Boolean(opts.force),
      scanOnly: Boolean(opts.scanOnly),
    });
  });

spec
  .command("status")
  .description("what spec exists and when it last changed")
  .option(...cwdOption)
  .action((opts) => {
    process.exitCode = specStatusCmd(rootOf(opts));
  });

spec
  .command("verify")
  .description("check the spec's claims against the tree (no LLM)")
  .option(...cwdOption)
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    process.exitCode = await specVerifyCmd(rootOf(opts), Boolean(opts.json));
  });

spec
  .command("show")
  .description("list spec files, or print one")
  .argument("[file]", "spec file (path or suffix, e.g. constitution.md)")
  .option(...cwdOption)
  .action((file: string | undefined, opts) => {
    process.exitCode = specShowCmd(rootOf(opts), file);
  });

spec
  .command("decision")
  .description("record an architectural decision (ADR stub)")
  .argument("<title...>", "decision title")
  .option(...cwdOption)
  .action((titleParts: string[], opts) => {
    process.exitCode = specDecisionCmd(rootOf(opts), titleParts.join(" "));
  });

program
  .command("remember")
  .description("record a lesson manually (it joins the confidence machinery)")
  .argument("<text...>", "the lesson, one sentence")
  .option(...cwdOption)
  .option("--kind <kind>", "constraint | pattern | failure | preference | discovery", "discovery")
  .option("--evidence <text>", "why you believe it")
  .action((textParts: string[], opts) => {
    process.exitCode = rememberCmd({
      root: rootOf(opts),
      text: textParts.join(" "),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.evidence ? { evidence: opts.evidence } : {}),
    });
  });

program
  .command("lessons")
  .description("list lessons, or adjust one's confidence")
  .option(...cwdOption)
  .option("--all", "include retired lessons and evidence")
  .option("--json", "machine-readable output")
  .option("--reinforce <id>", "raise confidence (+0.15)")
  .option("--contradict <id>", "lower confidence (−0.30, may retire)")
  .option("--retire <id>", "retire a lesson")
  .option("--evidence <text>", "evidence for reinforce/contradict")
  .option("--compact", "fold the append-only history to one record per lesson")
  .action((opts) => {
    process.exitCode = lessonsCmd({
      root: rootOf(opts),
      all: Boolean(opts.all),
      json: Boolean(opts.json),
      ...(opts.reinforce ? { reinforce: opts.reinforce } : {}),
      ...(opts.contradict ? { contradict: opts.contradict } : {}),
      ...(opts.retire ? { retire: opts.retire } : {}),
      ...(opts.evidence ? { evidence: opts.evidence } : {}),
      compact: Boolean(opts.compact),
    });
  });

const memory = program.command("memory").description("memory as code — export and import lessons (team memory)");

memory
  .command("export")
  .description("export lessons as JSON — commit it, share it with the team")
  .option(...cwdOption)
  .option("--out <path>", "write to a file instead of stdout")
  .option("--active-only", "skip retired lessons")
  .action((opts) => {
    process.exitCode = memoryExportCmd({
      root: rootOf(opts),
      ...(opts.out ? { out: opts.out } : {}),
      activeOnly: Boolean(opts.activeOnly),
    });
  });

memory
  .command("import")
  .description("import lessons from a JSON export — the team's memory becomes yours")
  .argument("<file>", "a memento memory export (JSON)")
  .option(...cwdOption)
  .action((file: string, opts) => {
    process.exitCode = memoryImportCmd({ root: rootOf(opts), file });
  });

program
  .command("resume")
  .description("continue an interrupted (or finished) session from its log")
  .argument("<session>", "session id or unique prefix")
  .option(...cwdOption)
  .option("-p, --provider <id>", "provider id (default: the session's original provider)")
  .option("-m, --model <id>", "model id (default: the session's original model)")
  .option("--max-turns <n>", "hard cap on agent turns", (v) => parseInt(v, 10))
  .option("--temperature <n>", "sampling temperature", (v) => parseFloat(v))
  .option("-y, --yes", "approve all tool calls without asking")
  .option("--no-reflect", "skip the post-session reflection pass")
  .option("--no-verify", "skip spec verification after the session")
  .option("--no-commit-hint", "skip the suggested commit message")
  .option("--show-thinking", "print the model's thinking stream")
  .option("--verbose-tools", "print full tool outputs instead of previews")
  .action(async (session: string, opts) => {
    process.exitCode = await resumeTask({
      session,
      root: rootOf(opts),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      yes: Boolean(opts.yes),
      reflect: opts.reflect,
      verify: opts.verify,
      commitHint: opts.commitHint,
      showThinking: Boolean(opts.showThinking),
      verboseTools: Boolean(opts.verboseTools),
    });
  });

program
  .command("sessions")
  .description("list recorded sessions")
  .option(...cwdOption)
  .option("--limit <n>", "how many to show", (v) => parseInt(v, 10), 20)
  .action((opts) => {
    process.exitCode = sessionsCmd(rootOf(opts), opts.limit);
  });

program
  .command("show")
  .description("print a session transcript (by id or id prefix)")
  .argument("<session>", "session id or prefix")
  .option(...cwdOption)
  .option("--full", "print full message bodies")
  .action((session: string, opts) => {
    process.exitCode = sessionShowCmd(rootOf(opts), session, Boolean(opts.full));
  });

program
  .command("undo")
  .description("restore the workspace state from before the most recent tool write")
  .option(...cwdOption)
  .action((opts) => {
    process.exitCode = undoCmd(rootOf(opts));
  });

const plugins = program.command("plugins").description("the plugin marketplace — install, scaffold and inspect plugins");

plugins
  .command("list")
  .description("list installed plugins (project + global) with their origin")
  .option(...cwdOption)
  .option("--global", "only the global scope (~/.memento/plugins)")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    process.exitCode = await pluginsTask({ action: "list", root: rootOf(opts), global: Boolean(opts.global), json: Boolean(opts.json) });
  });

plugins
  .command("install")
  .description("install a plugin: owner/repo, owner/repo#subdir, any git URL, or a local path")
  .argument("<source>", "plugin source")
  .option(...cwdOption)
  .option("--global", "install into ~/.memento/plugins instead of the project")
  .option("-y, --yes", "skip the security confirmation")
  .action(async (source: string, opts) => {
    process.exitCode = await pluginsTask({
      action: "install",
      source,
      root: rootOf(opts),
      global: Boolean(opts.global),
      yes: Boolean(opts.yes),
    });
  });

plugins
  .command("init")
  .description("scaffold a new plugin file")
  .argument("<name>", "plugin name")
  .option(...cwdOption)
  .option("--global", "scaffold into ~/.memento/plugins")
  .action(async (name: string, opts) => {
    process.exitCode = await pluginsTask({ action: "init", name, root: rootOf(opts), global: Boolean(opts.global) });
  });

plugins
  .command("remove")
  .description("remove an installed plugin (by name)")
  .argument("<name>", "plugin name")
  .option(...cwdOption)
  .option("--global", "remove from ~/.memento/plugins")
  .action(async (name: string, opts) => {
    process.exitCode = await pluginsTask({ action: "remove", name, root: rootOf(opts), global: Boolean(opts.global) });
  });

program
  .command("serve-mcp")
  .description("expose this repo's memory to other agents over MCP (stdio)")
  .option(...cwdOption)
  .option("--read-only", "search + stats only; reject add_lesson")
  .action(async (opts) => {
    process.exitCode = await serveMcp({
      root: rootOf(opts),
      readOnly: Boolean(opts.readOnly),
    });
  });

program
  .command("web")
  .description("open the read-only workbench (live · spec · memory · sessions · plugins) in a browser")
  .option(...cwdOption)
  .option("--port <n>", "listen port (default 4173)", (v) => parseInt(v, 10))
  .option("--no-open", "do not open a browser window")
  .action(async (opts) => {
    process.exitCode = await webCmd({
      root: rootOf(opts),
      ...(opts.port ? { port: opts.port } : {}),
      open: opts.open,
    });
  });

program
  .command("doctor")
  .description("diagnose runtime, config, providers, spec, memory, plugins")
  .option(...cwdOption)
  .option("--fix", "repair the mechanically fixable problems (missing provider/config)")
  .action(async (opts) => {
    process.exitCode = await doctorCmd(rootOf(opts), { fix: Boolean(opts.fix) });
  });

program
  .command("init")
  .description("scaffold .memento/ in this repository")
  .option(...cwdOption)
  .option("-p, --provider <id>", "provider for the config stub: deepseek | openai | anthropic | ollama | moonshot | glm | qwen")
  .option("--force", "rewrite .memento/config.json")
  .option("-i, --interactive", "guided prompt: provider → model → auto-approve (default in a terminal)")
  .option("--no-interactive", "skip the guided prompt and use defaults")
  .action(async (opts) => {
    const interactive =
      opts.interactive === true || (opts.interactive !== false && !opts.provider && Boolean(process.stdin.isTTY && process.stdout.isTTY));
    process.exitCode = await initCmd(rootOf(opts), Boolean(opts.force), opts.provider, { interactive });
  });

program
  .command("new")
  .description("scaffold a new project from the bundled starter template (spec + bench tasks + walkthrough)")
  .argument("<dir>", "target directory name ('.' for the current directory)")
  .option(...cwdOption)
  .option("--template <dir>", "use an explicit template directory instead of the bundled one")
  .option("--force", "scaffold over a non-empty target directory")
  .option("--no-git", "skip `git init` in the new project")
  .action((dir: string, opts) => {
    process.exitCode = newTask({
      dir,
      root: rootOf(opts),
      ...(opts.template ? { templateDir: opts.template } : {}),
      force: Boolean(opts.force),
      git: opts.git,
    });
  });

program
  .command("review")
  .description("review the working diff with the project's memory behind it — lessons + spec in, findings out")
  .option(...cwdOption)
  .option("-p, --provider <id>", "provider id")
  .option("-m, --model <id>", "model id")
  .option("--base <ref>", "review `git diff <ref>` instead of the working tree vs HEAD")
  .option("--dry", "deterministic mock provider — zero network, for CI and demos")
  .option("--json", "machine-readable findings; exit 1 when an error-severity finding exists")
  .action(async (opts) => {
    process.exitCode = await reviewTask({
      root: rootOf(opts),
      ...(opts.provider ? { providerId: opts.provider } : {}),
      ...(opts.model ? { modelId: opts.model } : {}),
      ...(opts.base ? { base: opts.base } : {}),
      dry: Boolean(opts.dry),
      json: Boolean(opts.json),
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(pc.red(`\nfatal: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exitCode = 1;
});
