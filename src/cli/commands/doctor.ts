/**
 * `memento doctor` — one command that answers "why doesn't it work".
 *
 * Checks, in the order problems usually appear: runtime, config files,
 * provider credentials, spec presence, memory state, and plugins.
 * With `--fix`, the mechanically fixable problems (missing provider/config)
 * are repaired in place and reported — everything else stays manual.
 */
import pc from "picocolors";
import { createWorkspace, attachPlugins, llmReadiness } from "../workspace.ts";
import { userConfigPath } from "../../config.ts";
import { listSessions } from "../../kernel/session.ts";
import { pluginDirs } from "../../plugins/loader.ts";
import { BUILTIN_PRESETS } from "../../llm/registry.ts";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { VERSION } from "../../version.ts";

interface FixAction {
  describe: string;
  apply: () => void;
}

export async function doctorCmd(root: string, opts: { fix?: boolean } = {}): Promise<number> {
  const ws = createWorkspace(root);
  const lines: string[] = [];
  let problems = 0;
  const fixable: FixAction[] = [];

  const check = (ok: boolean, label: string, detail: string, fix?: FixAction) => {
    const mark = ok ? pc.green("✓") : pc.red("✗");
    if (!ok) {
      problems += 1;
      if (fix) fixable.push(fix);
    }
    lines.push(`  ${mark} ${label.padEnd(24)} ${pc.dim(detail)}${fix ? pc.cyan("  [fixable]") : ""}`);
  };
  const info = (label: string, detail: string) => {
    lines.push(`  ${pc.dim("·")} ${label.padEnd(24)} ${pc.dim(detail)}`);
  };

  // --- runtime
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 20, "node >= 20.10", `v${process.versions.node}`);
  info("memento version", VERSION);

  // --- config
  const userCfg = userConfigPath();
  const projectCfg = path.join(ws.root, ".memento", "config.json");
  info("user config", fs.existsSync(userCfg) ? userCfg : "(none — fine)");
  info("project config", fs.existsSync(projectCfg) ? projectCfg : "(none — fine)");

  // --- model
  const wantProvider = ws.config.provider;
  if (wantProvider) {
    const ready = llmReadiness(ws, wantProvider);
    check(ready.ok, `provider "${wantProvider}"`, ready.detail);
    const model = ws.config.model ?? ws.providers.get(wantProvider)?.models[0]?.id ?? "(none)";
    info("model", model);
  } else {
    // No provider means `memento run` cannot start at all — this is a real
    // problem, not informational: the doctor must not say "everything checks
    // out" while the agent is unusable.
    check(false, "provider", "not set — run `memento init`, or pass --provider", {
      describe: "write .memento/config.json with the best available provider",
      apply: () => {
        // Prefer a provider whose credentials are already present; otherwise
        // fall back to the deepseek default and let the user fill in the key.
        const fallback = [...ws.providers.keys()].find((id) => llmReadiness(ws, id).ok);
        initCmd(ws.root, false, fallback, { quiet: true });
      },
    });
  }
  const available = [...ws.providers.keys()];
  for (const id of available) {
    if (id === wantProvider) continue;
    const ready = llmReadiness(ws, id);
    if (ready.ok && !ready.detail.includes("no API key env")) {
      info(`provider "${id}"`, `ready (${ready.detail})`);
    }
  }

  // --- spec
  const specCount = ws.spec.all.length;
  if (specCount > 0) {
    info(
      "spec",
      `${specCount} file(s): ${ws.spec.constitution ? "constitution " : ""}${ws.spec.architecture ? "architecture " : ""}${ws.spec.features.length ? `${ws.spec.features.length} feature(s) ` : ""}${ws.spec.decisions.length ? `${ws.spec.decisions.length} decision(s)` : ""}`.trim(),
    );
  } else {
    info("spec", "not initialized — run `memento spec init`");
  }

  // --- memory
  const stats = ws.lessons.stats();
  info("memory", `${stats.active} active lesson(s), ${stats.retired} retired, avg confidence ${stats.avgConfidence.toFixed(2)}`);

  // --- sessions
  const sessions = listSessions(path.join(ws.root, ".memento", "sessions"));
  info("sessions", `${sessions.length} recorded`);

  // --- plugins
  const loaded = await attachPlugins(ws);
  if (ws.config.plugins === false) {
    info("plugins", "disabled by config");
  } else if (loaded.length === 0) {
    const dirs = pluginDirs(ws.root, {})
      .map((d) => d.dir)
      .join(", ");
    info("plugins", `none found (searched: ${dirs})`);
  } else {
    for (const p of loaded) {
      if (p.error) check(false, `plugin ${p.name}`, `failed to load: ${p.error}`);
      else info(`plugin ${p.name}`, `${p.disposers.length} registration(s) from ${p.file}`);
    }
  }
  await ws.close();

  process.stdout.write(pc.bold(`\nmemento doctor — ${ws.root}\n\n`) + lines.join("\n") + "\n");

  if (opts.fix && fixable.length > 0) {
    let fixed = 0;
    process.stdout.write(pc.bold("\nfixing:\n"));
    for (const f of fixable) {
      f.apply();
      fixed += 1;
      process.stdout.write(pc.green(`  → ${f.describe}\n`));
    }
    problems -= fixed;
    if (problems > 0) process.stdout.write(pc.red(`\n  ${problems} problem(s) remain — the rest need manual action.\n`));
  }

  if (problems === 0) {
    process.stdout.write(pc.green("  everything checks out.\n"));
    return 0;
  }
  process.stdout.write(pc.red(`  ${problems} problem(s) found — fix the ✗ items above` + (opts.fix ? "" : " (or re-run with --fix)") + `.\n`));
  return 1;
}

/**
 * `memento init` — scaffold `.memento/` (config stub + dirs + gitignore hint).
 * Spec generation itself is `memento spec init`; this only lays out the tree
 * so the two commands stay single-purpose.
 *
 * Interactive mode: when running in a terminal without `--provider`, a guided
 * prompt walks through provider → model → auto-approve (and shows which API
 * keys are already present in the environment). Non-interactive callers get
 * the deepseek default stub, as before.
 */
export async function initCmd(
  root: string,
  force = false,
  providerId?: string,
  opts: { interactive?: boolean; quiet?: boolean } = {},
): Promise<number> {
  let provider = "deepseek";
  let model = "deepseek-chat";
  let autoApprove: string[] | undefined = ["write", "edit"];

  if (providerId) {
    const preset = BUILTIN_PRESETS.find((p) => p.id === providerId);
    if (!preset) {
      process.stderr.write(
        pc.red(`unknown provider "${providerId}". Built-in: ${BUILTIN_PRESETS.map((p) => p.id).join(", ")}\n`) +
          pc.dim("custom endpoints go in .memento/config.json as openai-compat providers.\n"),
      );
      return 1;
    }
    provider = preset.id;
    model = preset.models[0]?.id ?? "";
  } else if (opts.interactive ?? (process.stdin.isTTY && process.stdout.isTTY)) {
    const picked = await runInitWizard();
    if (!picked) return 1;
    provider = picked.provider;
    model = picked.model;
    autoApprove = picked.autoApprove ? ["write", "edit"] : [];
  }

  const preset = BUILTIN_PRESETS.find((p) => p.id === provider);
  const dir = path.join(root, ".memento");
  const created: string[] = [];
  for (const sub of ["spec/features", "spec/decisions", "memory", "sessions", "plugins"]) {
    const abs = path.join(dir, sub);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      created.push(`.memento/${sub}/`);
    }
  }
  const cfgPath = path.join(dir, "config.json");
  if (!fs.existsSync(cfgPath) || force) {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          provider,
          model,
          autoApprove,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    created.push(".memento/config.json (edit provider/model)");
  }

  if (!opts.quiet) {
    process.stdout.write(pc.bold(`\nmemento init — ${root}\n\n`));
    for (const c of created) process.stdout.write(pc.green(`  + ${c}\n`));
    if (created.length === 0) process.stdout.write(pc.dim("  already initialized\n"));

    const keyStep =
      provider === "ollama"
        ? "  1. start the local server:  ollama serve          (no API key needed)\n"
        : `  1. set your API key:      export ${preset?.apiKeyEnv ?? "DEEPSEEK_API_KEY"}=…  (PowerShell: $env:${preset?.apiKeyEnv ?? "DEEPSEEK_API_KEY"}=\"…\")\n`;
    process.stdout.write(
      "\n" +
        pc.dim("next steps:\n") +
        pc.dim(keyStep) +
        pc.dim("  2. draft the spec:        memento spec init\n") +
        pc.dim("  3. check the wiring:      memento doctor\n") +
        pc.dim('  4. run a task:            memento run "add a --json flag to the CLI"\n'),
    );
    gitignoreHint(root);
  }
  return 0;
}

/**
 * The guided first-run wizard: provider → model → auto-approve. Shows live
 * key status per provider so a user with `OPENAI_API_KEY` already exported
 * picks OpenAI in one glance instead of guessing.
 */
async function runInitWizard(): Promise<{ provider: string; model: string; autoApprove: boolean } | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(pc.bold("\n◈ memento init — choose your provider\n\n"));
    BUILTIN_PRESETS.forEach((p, i) => {
      const keyStatus =
        p.id === "ollama" ? pc.dim("no key needed") : process.env[p.apiKeyEnv] ? pc.green("key set ✓") : pc.dim("no key yet");
      process.stdout.write(`  ${pc.cyan(String(i + 1))}. ${pc.bold(p.label.padEnd(16))} ${pc.dim(`(${p.id})`)}  ${keyStatus}\n`);
    });
    const pAnswer = (await rl.question("\nprovider [1]: ")).trim();
    const preset = pickFromList(pAnswer, BUILTIN_PRESETS, 0);
    if (!preset) {
      process.stderr.write(pc.red("unrecognized provider — aborting (built-in ids: " + BUILTIN_PRESETS.map((p) => p.id).join(", ") + ")\n"));
      return null;
    }

    process.stdout.write(pc.bold(`\nmodels for ${preset.label}:\n`));
    preset.models.forEach((m, i) => {
      process.stdout.write(`  ${pc.cyan(String(i + 1))}. ${m.id.padEnd(28)} ${pc.dim(`context ${m.contextWindow.toLocaleString()}`)}\n`);
    });
    const mAnswer = (await rl.question("\nmodel [1]: ")).trim();
    const model = pickFromList(mAnswer, preset.models, 0)?.id ?? preset.models[0]?.id ?? "";

    const aAnswer = (await rl.question("\nauto-approve write/edit tools without asking? [y/N]: ")).trim().toLowerCase();
    const autoApprove = aAnswer === "y" || aAnswer === "yes";
    return { provider: preset.id, model, autoApprove };
  } finally {
    rl.close();
  }
}

/** Accept a menu number, an id, or empty (default index). */
function pickFromList<T extends { id: string }>(answer: string, list: T[], defaultIndex: number): T | undefined {
  if (!answer) return list[defaultIndex];
  const num = Number(answer);
  if (Number.isInteger(num) && num >= 1 && num <= list.length) return list[num - 1];
  return list.find((x) => x.id === answer);
}

function gitignoreHint(root: string): void {
  const gi = path.join(root, ".gitignore");
  try {
    const body = fs.readFileSync(gi, "utf8");
    if (!body.includes(".memento/sessions")) {
      process.stdout.write(pc.dim("\ntip: add `.memento/sessions/` to .gitignore — session logs are local, lessons and spec are not.\n"));
    }
  } catch {
    /* no .gitignore — fine */
  }
}
