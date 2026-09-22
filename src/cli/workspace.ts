/**
 * Workspace assembly — the one place where the layers are wired together.
 *
 * The CLI commands are thin on top of this: open a workspace, resolve the
 * model, run. Keeping assembly here means the library entry point
 * (`src/index.ts`) and the CLI share exactly the same object graph.
 */
import fs from "node:fs";
import path from "node:path";
import type { MementoConfig } from "../config.ts";
import { apiKeyEnvFor, loadConfig, projectConfigPath, resolveApiKey, userConfigPath } from "../config.ts";
import type { LlmProvider, ModelInfo } from "../llm/types.ts";
import { createProviderRegistry, resolveProviderModel } from "../llm/registry.ts";
import type { SpecBundle } from "../spec/types.ts";
import { loadSpecBundle } from "../spec/store.ts";
import type { SpecChecker } from "../spec/verify.ts";
import { LessonStore } from "../memory/store.ts";
import { ToolRegistry } from "../tools/types.ts";
import { registerBuiltins } from "../tools/builtin/index.ts";
import { EventBus } from "../kernel/events.ts";
import type { LoadedPlugin, PluginHost } from "../plugins/loader.ts";
import { loadPlugins } from "../plugins/loader.ts";
import { jsonSchemaToZod } from "../tools/schema.ts";
import type { McpClient, McpServerConfig } from "../mcp/client.ts";
import { readJsonIfExists } from "../util/paths.ts";

export interface Workspace {
  root: string;
  config: MementoConfig;
  /** Config files that contributed (user first). */
  configSources: string[];
  providers: Map<string, LlmProvider>;
  spec: SpecBundle;
  lessons: LessonStore;
  tools: ToolRegistry;
  bus: EventBus;
  specCheckers: SpecChecker[];
  pluginHost: PluginHost;
  plugins: LoadedPlugin[];
  /** Connected MCP servers, bridged into `tools` as mcp_<server>_<tool>. */
  mcpClients: McpClient[];
  /** Reverse plugin registrations, LIFO. Never throws. */
  close(): Promise<void>;
}

export function createWorkspace(root: string): Workspace {
  const absRoot = path.resolve(root);
  const { config, sources } = loadConfig(absRoot);
  const providers = createProviderRegistry({ custom: config.providers });
  const spec = loadSpecBundle(absRoot);
  const lessons = LessonStore.load(absRoot);
  const tools = new ToolRegistry();
  registerBuiltins(tools);
  const bus = new EventBus();
  const specCheckers: SpecChecker[] = [];
  const pluginHost: PluginHost = {
    tools,
    specCheckers,
    eventHandlers: new Map(),
    cwd: absRoot,
    log: (plugin, message) => process.stderr.write(`[plugin:${plugin}] ${message}\n`),
  };

  return {
    root: absRoot,
    config,
    configSources: sources,
    providers,
    spec,
    lessons,
    tools,
    bus,
    specCheckers,
    pluginHost,
    plugins: [],
    mcpClients: [],
    async close() {
      for (const client of this.mcpClients) client.close();
      this.mcpClients = [];
      const { unloadAll } = await import("../plugins/loader.ts");
      await unloadAll(this.plugins);
    },
  };
}

/**
 * Third phase: bridge configured MCP servers into the toolset.
 *
 * Supply-chain safety: servers come from the USER config only. A project's
 * `.memento/config.json` may declare servers only when the user has set
 * `trustProjectMcp: true` in their own config — the same trust rule as
 * project plugins. A failed connection is loud but non-fatal: the session
 * runs without that server's tools.
 */
export async function attachMcpServers(ws: Workspace): Promise<void> {
  const user = readJsonIfExists<MementoConfig>(userConfigPath());
  const trustProject = user?.trustProjectMcp === true;
  const project = trustProject ? readJsonIfExists<MementoConfig>(projectConfigPath(ws.root)) : undefined;

  const servers: McpServerConfig[] = [];
  for (const cfg of [...(user?.mcpServers ?? []), ...(project?.mcpServers ?? [])]) {
    if (cfg?.disabled || !cfg?.name || !cfg?.command) continue;
    servers.push(cfg);
  }

  for (const cfg of servers) {
    const client = await connectAndBridge(ws, cfg);
    if (client) ws.mcpClients.push(client);
  }
}

async function connectAndBridge(ws: Workspace, cfg: McpServerConfig): Promise<McpClient | null> {
  try {
    const { McpClient } = await import("../mcp/client.ts");
    const client = await McpClient.connect(cfg, (line) => ws.pluginHost.log(cfg.name, line));
    const trusted = new Set(cfg.trustedTools ?? []);

    for (const info of client.tools()) {
      const bridgeName = `mcp_${cfg.name}_${info.name}`;
      if (ws.tools.names().includes(bridgeName)) {
        ws.pluginHost.log(cfg.name, `skipping ${info.name}: name ${bridgeName} already registered`);
        continue;
      }
      ws.tools.register({
        name: bridgeName,
        description: `[MCP server "${cfg.name}"] ${info.description || "External tool."}`,
        schema: jsonSchemaToZod(info.inputSchema),
        // External tools are unknown side effects: mutating unless the user
        // explicitly whitelisted the name as a read-only tool they trust.
        mutating: !trusted.has(info.name),
        async execute(args) {
          const res = await client.callTool(info.name, args as Record<string, unknown>);
          return { output: res.text, ...(res.isError ? { isError: true } : {}) };
        },
      });
    }
    return client;
  } catch (err) {
    ws.pluginHost.log(cfg.name, `failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Second phase: plugin loading is async (dynamic imports), so it is separate. */
export async function attachPlugins(ws: Workspace): Promise<LoadedPlugin[]> {
  if (ws.config.plugins === false) return [];
  // Supply-chain safety: project plugins are arbitrary code shipped in the
  // checkout (`git clone` → `memento run` must NOT execute them). They only
  // load after an explicit `trustProjectPlugins: true` in config.
  const trust = ws.config.trustProjectPlugins === true;
  const projectDir = path.join(ws.root, ".memento", "plugins");
  if (fs.existsSync(projectDir)) {
    ws.pluginHost.log(
      "memento",
      trust
        ? `trustProjectPlugins is enabled — executing project plugins from ${projectDir}`
        : `project plugins found in .memento/plugins but NOT loaded (untrusted checkout). Set "trustProjectPlugins": true in .memento/config.json to enable them.`,
    );
  }
  const loaded = await loadPlugins(ws.pluginHost, {
    cwd: ws.root,
    skipProject: !trust,
    log: (plugin, message) => ws.pluginHost.log(plugin, message),
  });
  // Failures must be loud — a silently skipped plugin breaks the user's
  // workflow with no explanation.
  for (const p of loaded) {
    if (p.error) ws.pluginHost.log(p.name, `failed to load: ${p.error}`);
  }
  ws.plugins = loaded;
  return loaded;
}

export interface ResolvedLlm {
  provider: LlmProvider;
  model: ModelInfo;
  apiKey?: string;
}

export function resolveLlm(ws: Workspace, providerId?: string, modelId?: string): ResolvedLlm | { error: string } {
  const wantProvider = providerId ?? ws.config.provider;
  const wantModel = modelId ?? ws.config.model;

  let resolved: { provider: LlmProvider; model: ModelInfo } | undefined;

  if (wantProvider) {
    const provider = ws.providers.get(wantProvider);
    if (!provider) {
      return { error: `Unknown provider "${wantProvider}". Available: ${[...ws.providers.keys()].join(", ")}` };
    }
    if (wantModel) {
      const bare = wantModel.includes("/") ? wantModel.split("/").slice(1).join("/") : wantModel;
      const model = provider.resolveModel(bare) ?? {
        id: bare,
        contextWindow: 128_000,
        maxOutput: 8_192,
        supportsTools: true,
      };
      resolved = { provider, model };
    } else {
      const first = provider.models[0];
      if (!first) {
        return { error: `Provider "${wantProvider}" declares no models. Set one in .memento/config.json.` };
      }
      resolved = { provider, model: first };
    }
  } else if (wantModel) {
    resolved = resolveProviderModel(ws.providers, wantModel);
    if (!resolved) return { error: `Cannot resolve model "${wantModel}" against any configured provider.` };
  } else {
    return {
      error:
        "No model configured. Pass --provider/--model, or set them in .memento/config.json (see `memento doctor`).",
    };
  }

  const apiKey = resolveApiKey(resolved.provider.id, ws.config);
  return { provider: resolved.provider, model: resolved.model, ...(apiKey ? { apiKey } : {}) };
}

/** Human-readable readiness check for a provider (used by run + doctor). */
export function llmReadiness(ws: Workspace, providerId: string): { ok: boolean; detail: string } {
  const provider = ws.providers.get(providerId);
  if (!provider) return { ok: false, detail: `unknown provider "${providerId}"` };
  const env = apiKeyEnvFor(providerId, ws.config);
  const key = resolveApiKey(providerId, ws.config);
  if (providerId === "ollama") {
    return { ok: true, detail: "local server — no API key needed" };
  }
  if (!env) return { ok: true, detail: "no API key env declared (custom gateway?)" };
  if (!key) return { ok: false, detail: `missing environment variable ${env}` };
  return { ok: true, detail: `${env} is set` };
}
