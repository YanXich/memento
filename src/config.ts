/**
 * Configuration — `.memento/config.json` (project) merged over
 * `~/.memento/config.json` (user). Project wins on scalar fields.
 *
 * Secrets never live in config files. API keys are read from environment
 * variables only; a provider declares *which* variable holds its key.
 */
import os from "node:os";
import path from "node:path";
import type { ProviderConfig } from "./llm/types.ts";
import type { McpServerConfig } from "./mcp/client.ts";
import { readJsonIfExists } from "./util/paths.ts";
import { BUILTIN_PRESETS } from "./llm/registry.ts";

export interface MementoConfig {
  /** Default provider id (a builtin preset id or a custom provider id). */
  provider?: string;
  /** Default model id — bare ("deepseek-chat") or qualified ("deepseek/deepseek-chat"). */
  model?: string;
  maxTurns?: number;
  temperature?: number;
  /** Fraction of the context window at which compaction triggers (default 0.8). */
  compactAt?: number;
  /** Tool names that never require approval (e.g. ["bash"]). */
  autoApprove?: string[];
  /** Additional providers, or overrides of builtin presets (same id wins). */
  providers?: ProviderConfig[];
  /** Load plugins at all (default true). */
  plugins?: boolean;
  /** Load plugins from the project `.memento/plugins` dir (default false —
   *  project plugins are arbitrary checkout code and require explicit trust). */
  trustProjectPlugins?: boolean;
  /** External MCP servers to bridge into the toolset. For safety these are
   *  loaded from the USER config only — a project can declare them only when
   *  the user sets `trustProjectMcp: true` in their own user config. */
  mcpServers?: McpServerConfig[];
  /** User-level switch: allow the PROJECT config to declare mcpServers. */
  trustProjectMcp?: boolean;
}

export interface LoadedConfig {
  config: MementoConfig;
  /** Files that contributed, user first, project last. */
  sources: string[];
}

export function userConfigPath(): string {
  return path.join(os.homedir(), ".memento", "config.json");
}

export function projectConfigPath(root: string): string {
  return path.join(root, ".memento", "config.json");
}

export function loadConfig(root: string): LoadedConfig {
  const sources: string[] = [];
  const merged: MementoConfig = {};
  for (const file of [userConfigPath(), projectConfigPath(root)]) {
    const part = readJsonIfExists<MementoConfig>(file);
    if (part && typeof part === "object") {
      sources.push(file);
      Object.assign(merged, part);
    }
  }
  return { config: merged, sources };
}

/** Which env var holds the key for this provider (custom providers win). */
export function apiKeyEnvFor(providerId: string, config: MementoConfig): string | undefined {
  const custom = config.providers?.find((p) => p.id === providerId);
  if (custom?.apiKeyEnv) return custom.apiKeyEnv;
  return BUILTIN_PRESETS.find((p) => p.id === providerId)?.apiKeyEnv;
}

export function resolveApiKey(providerId: string, config: MementoConfig): string | undefined {
  const env = apiKeyEnvFor(providerId, config);
  if (!env) return undefined;
  const value = process.env[env];
  return value && value.trim() ? value.trim() : undefined;
}

/** First model of a provider — used when config.model is unset. */
export function defaultModelFor(providerId: string, config: MementoConfig): string | undefined {
  const custom = config.providers?.find((p) => p.id === providerId);
  const preset = BUILTIN_PRESETS.find((p) => p.id === providerId);
  const models = custom?.models ?? preset?.models;
  return models?.[0]?.id;
}

/** All provider ids this config exposes (builtins + customs). */
export function providerIds(config: MementoConfig): string[] {
  const ids = new Set<string>();
  for (const preset of BUILTIN_PRESETS) ids.add(preset.id);
  for (const p of config.providers ?? []) ids.add(p.id);
  return [...ids];
}
