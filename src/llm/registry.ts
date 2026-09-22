/**
 * Provider registry.
 *
 * Built-in presets cover the common endpoints; everything else can be declared
 * in config as `openai-compat` or `anthropic` with a custom baseUrl — that is
 * the whole point of the seam: no provider is privileged.
 */
import type { LlmProvider, ModelInfo, ProviderConfig } from "./types.ts";
import { createOpenAiCompatProvider } from "./openai.ts";
import { createAnthropicProvider } from "./anthropic.ts";

export interface BuiltinPreset {
  id: string;
  label: string;
  type: "openai-compat" | "anthropic";
  baseUrl: string;
  apiKeyEnv: string;
  /** Model id prefix -> context window heuristics; exact entries win. */
  models: ModelInfo[];
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    type: "openai-compat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-chat", contextWindow: 128_000, maxOutput: 8_192, supportsTools: true },
      { id: "deepseek-reasoner", contextWindow: 128_000, maxOutput: 65_536, supportsTools: true },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    type: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [
      { id: "gpt-4o", contextWindow: 128_000, maxOutput: 16_384, supportsTools: true },
      { id: "gpt-4o-mini", contextWindow: 128_000, maxOutput: 16_384, supportsTools: true },
      { id: "gpt-4.1", contextWindow: 1_000_000, maxOutput: 32_768, supportsTools: true },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-sonnet-4-20250514", contextWindow: 200_000, maxOutput: 64_000, supportsTools: true },
      { id: "claude-3-5-haiku-20241022", contextWindow: 200_000, maxOutput: 8_192, supportsTools: true },
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    type: "openai-compat",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY", // usually unset — local server ignores auth
    models: [
      { id: "qwen3:8b", contextWindow: 32_768, maxOutput: 8_192, supportsTools: true },
      { id: "llama3.1:8b", contextWindow: 128_000, maxOutput: 8_192, supportsTools: false },
    ],
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    type: "openai-compat",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    models: [{ id: "kimi-k2-0711-preview", contextWindow: 128_000, maxOutput: 16_384, supportsTools: true }],
  },
];

function buildFromConfig(cfg: ProviderConfig): LlmProvider {
  const preset = BUILTIN_PRESETS.find((p) => p.id === cfg.id);
  const models: ModelInfo[] = (cfg.models ?? preset?.models ?? []).map((m) => ({
    id: m.id ?? "default",
    label: m.label,
    contextWindow: m.contextWindow ?? 32_768,
    maxOutput: m.maxOutput ?? 4_096,
    supportsTools: m.supportsTools ?? true,
  }));
  const baseUrl = cfg.baseUrl ?? preset?.baseUrl ?? "";
  const label = cfg.id;
  if (cfg.type === "anthropic") {
    return createAnthropicProvider({ id: cfg.id, label, baseUrl, models, headers: cfg.headers });
  }
  return createOpenAiCompatProvider({ id: cfg.id, label, baseUrl, models, headers: cfg.headers });
}

export interface RegistryOptions {
  /** User-defined providers from config file. */
  custom?: ProviderConfig[];
  /** Restrict to these provider ids (for doctor/tests). */
  only?: string[];
}

export function createProviderRegistry(opts: RegistryOptions = {}): Map<string, LlmProvider> {
  const map = new Map<string, LlmProvider>();
  const wanted = opts.only ? new Set(opts.only) : undefined;
  for (const preset of BUILTIN_PRESETS) {
    if (wanted && !wanted.has(preset.id)) continue;
    map.set(
      preset.id,
      buildFromConfig({
        id: preset.id,
        type: preset.type,
        baseUrl: preset.baseUrl,
        apiKeyEnv: preset.apiKeyEnv,
        models: preset.models,
      }),
    );
  }
  for (const cfg of opts.custom ?? []) {
    map.set(cfg.id, buildFromConfig(cfg));
  }
  return map;
}

/**
 * Resolve `provider/model` or bare model id against the registry.
 * Returns undefined when nothing matches — callers decide the fallback.
 */
export function resolveProviderModel(
  registry: Map<string, LlmProvider>,
  spec: string,
): { provider: LlmProvider; model: ModelInfo } | undefined {
  if (spec.includes("/")) {
    const [providerId, ...rest] = spec.split("/");
    const provider = registry.get(providerId!);
    const modelId = rest.join("/");
    if (!provider) return undefined;
    const model = provider.resolveModel(modelId) ?? {
      id: modelId,
      contextWindow: 128_000,
      maxOutput: 8_192,
      supportsTools: true,
    };
    return { provider, model };
  }
  // Bare model: search every provider for an exact model match first.
  for (const provider of registry.values()) {
    const exact = provider.models.find((m) => m.id === spec);
    if (exact) return { provider, model: exact };
  }
  // Fall back to the first provider that has any model (single-provider setups).
  for (const provider of registry.values()) {
    if (provider.models.length > 0) {
      return { provider, model: { id: spec, contextWindow: 128_000, maxOutput: 8_192, supportsTools: true } };
    }
  }
  return undefined;
}

export function apiKeyForPreset(providerId: string): { env: string | undefined } {
  const preset = BUILTIN_PRESETS.find((p) => p.id === providerId);
  return { env: preset?.apiKeyEnv };
}
