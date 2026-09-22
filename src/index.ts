/**
 * Memento — spec-driven coding agent with persistent memory.
 *
 * Library entry point. The CLI is one consumer of this API; you can embed the
 * kernel, spec engine, memory, and plugin layer into your own tooling.
 *
 *   import { createWorkspace, attachPlugins, resolveLlm, runLoop, SessionLog } from "memento-agent";
 */
export { VERSION } from "./version.ts";

// --- configuration + workspace assembly
export { loadConfig, resolveApiKey, apiKeyEnvFor, userConfigPath, projectConfigPath } from "./config.ts";
export type { MementoConfig, LoadedConfig } from "./config.ts";
export { attachPlugins, createWorkspace, llmReadiness, resolveLlm } from "./cli/workspace.ts";
export type { Workspace, ResolvedLlm } from "./cli/workspace.ts";

// --- kernel
export { runLoop } from "./kernel/loop.ts";
export type { LoopHooks, LoopOptions, LoopResult } from "./kernel/loop.ts";
export { SessionLog, listSessions, loadSession } from "./kernel/session.ts";
export type { SessionEntry, SessionHeader, LoadedSession } from "./kernel/session.ts";
export { EventBus } from "./kernel/events.ts";
export type { AgentEvent, AgentEventHandler } from "./kernel/events.ts";

// --- llm
export { BUILTIN_PRESETS, createProviderRegistry, resolveProviderModel } from "./llm/registry.ts";
export { createAnthropicProvider } from "./llm/anthropic.ts";
export { createOpenAiCompatProvider } from "./llm/openai.ts";
export { complete, extractFence, parseJsonLoose } from "./llm/complete.ts";
export type { CompleteOptions, CompleteResult } from "./llm/complete.ts";
export type {
  ContentBlock,
  LlmProvider,
  LlmRequest,
  Message,
  ModelInfo,
  ProviderConfig,
  Role,
  StopReason,
  StreamEvent,
  ToolCallBlock,
  ToolSchema,
  Usage,
} from "./llm/types.ts";
export { hasToolCalls, textOf, toolCallsOf } from "./llm/types.ts";

// --- tools
export { ToolRegistry } from "./tools/types.ts";
export type { Tool, ToolContext, ToolResult } from "./tools/types.ts";
export { BUILTIN_TOOLS, registerBuiltins } from "./tools/builtin/index.ts";
export { classifyCommand, guardWritePath } from "./tools/guard.ts";

// --- spec engine
export {
  ARCHITECTURE_FILE,
  CONSTITUTION_FILE,
  SPEC_DIR,
  loadSpecBundle,
  nextDecisionNumber,
  readSpec,
  specDir,
  specStatus,
  writeSpec,
} from "./spec/store.ts";
export { scanRepo } from "./spec/scanner.ts";
export { decisionPath, generateInitialSpec, proposeSpecDelta } from "./spec/generator.ts";
export { recallSpec } from "./spec/recall.ts";
export { verifySpec } from "./spec/verify.ts";
export type { SpecChecker } from "./spec/verify.ts";
export type { RepoScan, SpecBundle, SpecDelta, SpecFile, SpecIssue, SpecKind, SpecStatus, VerifyReport } from "./spec/types.ts";

// --- memory
export { LessonStore, memoryFileExists } from "./memory/store.ts";
export { reflect } from "./memory/reflect.ts";
export type { ReflectDeps, ReflectInput } from "./memory/reflect.ts";
export { formatLessons, recallLessons } from "./memory/recall.ts";
export type { Lesson, LessonKind, MemoryStats, ReflectionOutcome, ReflectionResult, SpecSuggestion } from "./memory/types.ts";

// --- plugins
export { loadPlugins, pluginDirs, unloadAll } from "./plugins/loader.ts";
export type { LoadedPlugin, PluginHost, LoadPluginsOptions } from "./plugins/loader.ts";
export type { MementoPlugin, PluginContext, PluginEvent, PluginEventHandler } from "./plugins/api.ts";

// --- prompts + cli ui (reusable renderer)
export { buildSystemPrompt, COMPACT_SYSTEM } from "./prompts.ts";
export type { PromptContext } from "./prompts.ts";
export { SessionRenderer } from "./cli/ui.ts";

// --- command entry points (programmatic use)
export { runTask } from "./cli/commands/run.ts";
export type { RunOptions } from "./cli/commands/run.ts";
export { resumeTask } from "./cli/commands/resume.ts";
export type { ResumeOptions } from "./cli/commands/resume.ts";
export { benchTask } from "./cli/commands/bench.ts";
export type { BenchOptions, BenchResult, BenchRun, BenchTask } from "./cli/commands/bench.ts";
export { buildLoopHooks } from "./cli/hooks.ts";
export type { HooksLlm } from "./cli/hooks.ts";
export { runAftermath, printSummary } from "./cli/aftermath.ts";
export type { AftermathOptions } from "./cli/aftermath.ts";
