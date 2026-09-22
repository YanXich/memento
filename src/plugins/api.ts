/**
 * Plugin API — the extension seam.
 *
 * Everything a plugin registers returns a disposer ("registration is an
 * effect" — borrowed from dsh). The loader calls all disposers on unload,
 * so a plugin can never leave the kernel in a half-patched state.
 */
import type { Tool } from "../tools/types.ts";
import type { SpecChecker } from "../spec/verify.ts";

export type PluginEvent =
  | { type: "session_start"; task: string; cwd: string }
  | { type: "session_end"; status: "done" | "aborted" | "error" | "max_turns"; turns: number }
  | { type: "before_tool"; tool: string; args: Record<string, unknown> }
  | { type: "after_tool"; tool: string; output: string; isError: boolean }
  | { type: "before_llm"; system: string; messageCount: number };

export type PluginEventHandler = (event: PluginEvent) => void | Promise<void>;

/** What a `before_tool` hook may return to influence execution. */
export interface BeforeToolVerdict {
  /** Block the call with this reason. */
  block?: string;
}

/** What a `after_tool` hook may return to rewrite the result. */
export interface AfterToolPatch {
  output?: string;
  isError?: boolean;
}

/** What a `before_llm` hook may return to rewrite the request. */
export interface BeforeLlmPatch {
  system?: string;
}

export interface PluginContext {
  /** Directory the plugin was loaded from. */
  pluginDir: string;
  /** Workspace root. */
  cwd: string;
  /** Named logger prefix. */
  log(message: string): void;
  /**
   * Register a tool. Returns a disposer.
   * Registering an existing tool name throws — replacement must be explicit (see unregister).
   */
  registerTool(tool: Tool): () => void;
  /** Register an extra spec checker used by `memento spec verify`. */
  registerSpecChecker(checker: SpecChecker): () => void;
  /** Subscribe to a lifecycle event. Returns an unsubscribe function. */
  on(event: PluginEvent["type"], handler: PluginEventHandler): () => void;
}

/** A plugin is a named setup function. Export default from `.memento/plugins/*.ts`. */
export interface MementoPlugin {
  name: string;
  setup(ctx: PluginContext): void | Promise<void>;
}

/** Also accepted: a bare setup function (name defaults to the file name). */
export type PluginFactory = (ctx: PluginContext) => void | Promise<void>;

export interface LoadedPlugin {
  name: string;
  file: string;
  disposers: (() => void)[];
  error?: string;
}
