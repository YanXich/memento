/**
 * Plugin loader — discovers and loads `.memento/plugins/*.{ts,mjs,js}` (project)
 * and `~/.memento/plugins/*` (global), TS handled by jiti without a build step.
 *
 * Load order: global → project (project wins on name collisions).
 * Every registration a plugin makes is tracked as a disposer; `unloadAll`
 * reverses them in LIFO order.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginContext, MementoPlugin, LoadedPlugin, PluginEvent, PluginEventHandler } from "./api.ts";
import type { Tool } from "../tools/types.ts";
import type { SpecChecker } from "../spec/verify.ts";

export type { PluginContext, MementoPlugin, LoadedPlugin, PluginEvent, PluginEventHandler } from "./api.ts";

export interface PluginHost {
  tools: { register(tool: Tool): () => void };
  specCheckers: SpecChecker[];
  eventHandlers: Map<PluginEvent["type"], PluginEventHandler[]>;
  cwd: string;
  log: (plugin: string, message: string) => void;
}

export interface LoadPluginsOptions {
  cwd: string;
  /** Disable project-level plugins (untrusted checkout). */
  skipProject?: boolean;
  log?: (plugin: string, message: string) => void;
  /** Extra directories to scan. */
  extraDirs?: string[];
}

export function pluginDirs(cwd: string, opts: Partial<LoadPluginsOptions> = {}): { dir: string; scope: "global" | "project" }[] {
  const dirs: { dir: string; scope: "global" | "project" }[] = [
    { dir: path.join(os.homedir(), ".memento", "plugins"), scope: "global" },
  ];
  if (!opts.skipProject) {
    dirs.push({ dir: path.join(cwd, ".memento", "plugins"), scope: "project" });
  }
  for (const extra of opts.extraDirs ?? []) {
    dirs.push({ dir: extra, scope: "project" });
  }
  return dirs;
}

export async function loadPlugins(
  host: PluginHost,
  opts: LoadPluginsOptions,
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  const seen = new Set<string>();

  for (const { dir } of pluginDirs(opts.cwd, opts)) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.endsWith(".d.ts"));
    } catch {
      continue;
    }
    // Project dir loads after global — same name from project overrides global.
    entries.sort();

    for (const entry of entries) {
      const file = path.join(dir, entry);
      const fallbackName = entry.replace(/\.(ts|mjs|js)$/, "");
      if (seen.has(fallbackName)) continue;
      const result = await loadOne(file, fallbackName, host, opts);
      loaded.push(result);
      if (!result.error) seen.add(fallbackName);
    }
  }
  return loaded;
}

async function loadOne(
  file: string,
  fallbackName: string,
  host: PluginHost,
  opts: LoadPluginsOptions,
): Promise<LoadedPlugin> {
  const disposers: (() => void)[] = [];
  const log = (msg: string) => (opts.log ?? (() => {}))(fallbackName, msg);
  const result: LoadedPlugin = { name: fallbackName, file, disposers };

  try {
    const { createJiti } = await import("jiti");
    const jiti = createJiti(file, { interopDefault: true });
    const mod = (await jiti.import(file)) as { default?: unknown } & Record<string, unknown>;

    const exported = (mod.default ?? mod) as MementoPlugin | ((ctx: PluginContext) => unknown) | undefined;
    if (!exported) {
      result.error = "no default export";
      return result;
    }

    const ctx: PluginContext = {
      pluginDir: path.dirname(file),
      cwd: host.cwd,
      log,
      registerTool(tool) {
        const dispose = host.tools.register(tool);
        disposers.push(dispose);
        log(`registered tool: ${tool.name}`);
        return dispose;
      },
      registerSpecChecker(checker) {
        host.specCheckers.push(checker);
        const dispose = () => {
          const i = host.specCheckers.indexOf(checker);
          if (i >= 0) host.specCheckers.splice(i, 1);
        };
        disposers.push(dispose);
        return dispose;
      },
      on(event, handler) {
        let handlers = host.eventHandlers.get(event);
        if (!handlers) {
          handlers = [];
          host.eventHandlers.set(event, handlers);
        }
        handlers.push(handler);
        const dispose = () => {
          const i = handlers!.indexOf(handler);
          if (i >= 0) handlers!.splice(i, 1);
        };
        disposers.push(dispose);
        return dispose;
      },
    };

    if (typeof exported === "function") {
      await (exported as (ctx: PluginContext) => unknown)(ctx);
    } else if (typeof exported === "object" && typeof (exported as MementoPlugin).setup === "function") {
      const plugin = exported as MementoPlugin;
      if (typeof plugin.name === "string" && plugin.name) result.name = plugin.name;
      await plugin.setup(ctx);
    } else {
      result.error = "default export must be a function or { name, setup } object";
    }
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

/** Reverse every registration, LIFO. Never throws. */
export async function unloadAll(plugins: LoadedPlugin[]): Promise<void> {
  for (const plugin of [...plugins].reverse()) {
    for (const dispose of [...plugin.disposers].reverse()) {
      try {
        dispose();
      } catch {
        /* a broken disposer must not block the rest */
      }
    }
    plugin.disposers = [];
  }
}

/** Dispatch an event to plugin handlers; before_* hooks may return patches. */
export async function dispatchPluginEvent(
  host: PluginHost,
  event: PluginEvent,
): Promise<unknown[]> {
  const handlers = host.eventHandlers.get(event.type) ?? [];
  const patches: unknown[] = [];
  for (const handler of handlers) {
    try {
      const out = await handler(event);
      if (out !== undefined && out !== null) patches.push(out);
    } catch {
      /* plugin handler errors are isolated */
    }
  }
  return patches;
}
