/**
 * `memento doctor` — one command that answers "why doesn't it work".
 *
 * Checks, in the order problems usually appear: runtime, config files,
 * provider credentials, spec presence, memory state, and plugins.
 */
import pc from "picocolors";
import { createWorkspace, attachPlugins, llmReadiness } from "../workspace.ts";
import { userConfigPath } from "../../config.ts";
import { listSessions } from "../../kernel/session.ts";
import { pluginDirs } from "../../plugins/loader.ts";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../../version.ts";

export async function doctorCmd(root: string): Promise<number> {
  const ws = createWorkspace(root);
  const lines: string[] = [];
  let problems = 0;

  const check = (ok: boolean, label: string, detail: string) => {
    const mark = ok ? pc.green("✓") : pc.red("✗");
    if (!ok) problems += 1;
    lines.push(`  ${mark} ${label.padEnd(24)} ${pc.dim(detail)}`);
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
    info("provider", "not set — pass --provider or set it in config");
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

  process.stdout.write(pc.bold(`\nmemento doctor — ${ws.root}\n\n`) + lines.join("\n") + "\n\n");
  if (problems === 0) {
    process.stdout.write(pc.green("  everything checks out.\n"));
    return 0;
  }
  process.stdout.write(pc.red(`  ${problems} problem(s) found — fix the ✗ items above.\n`));
  return 1;
}

/**
 * `memento init` — scaffold `.memento/` (config stub + dirs + gitignore hint).
 * Spec generation itself is `memento spec init`; this only lays out the tree
 * so the two commands stay single-purpose.
 */
export function initCmd(root: string, force = false): number {
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
          provider: "deepseek",
          model: "deepseek-chat",
          autoApprove: ["write", "edit"],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    created.push(".memento/config.json (edit provider/model)");
  }

  process.stdout.write(pc.bold(`\nmemento init — ${root}\n\n`));
  for (const c of created) process.stdout.write(pc.green(`  + ${c}\n`));
  if (created.length === 0) process.stdout.write(pc.dim("  already initialized\n"));

  process.stdout.write(
    "\n" +
      pc.dim("next steps:\n") +
      pc.dim("  1. set your API key:      export DEEPSEEK_API_KEY=…  (PowerShell: $env:DEEPSEEK_API_KEY=\"…\")\n") +
      pc.dim("  2. draft the spec:        memento spec init\n") +
      pc.dim("  3. check the wiring:      memento doctor\n") +
      pc.dim("  4. run a task:            memento run \"add a --json flag to the CLI\"\n"),
  );
  gitignoreHint(root);
  return 0;
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
