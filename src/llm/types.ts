/**
 * Core message model shared by the kernel, providers, and session log.
 *
 * Design note (borrowed from pi): the kernel never speaks provider wire formats.
 * Providers translate `Message[]` into their own protocol at the boundary and
 * translate stream events back into the vocabulary below.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  /** Provider-supplied call id, echoed back with the result. */
  id: string;
  name: string;
  /** Parsed arguments (may be `{}` while streaming is incomplete). */
  args: Record<string, unknown>;
  /** Raw argument JSON as streamed — kept so replays are byte-faithful. */
  rawArgs?: string;
}

export interface ToolResultBlock {
  type: "toolResult";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  ts: number;
  /** Present on assistant messages. */
  stopReason?: StopReason;
  usage?: Usage;
  /** Present on tool messages — links back to the assistant's tool call. */
  toolCallId?: string;
  /** Marks messages injected by the memory/spec layer (shown in transcripts, kept out of some contexts). */
  source?: "user" | "model" | "memory" | "spec" | "system";
}

export type StopReason = "end" | "toolUse" | "length" | "error" | "aborted";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Stream vocabulary — every provider emits exactly this. */
export type StreamEvent =
  | { type: "start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "toolcall_start"; id: string; name: string }
  | { type: "toolcall_delta"; id: string; argsDelta: string }
  | { type: "toolcall_end"; id: string }
  | { type: "done"; stopReason: StopReason; usage: Usage }
  | { type: "error"; error: string; retryable: boolean };

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema (draft-07 subset) generated from the tool's zod schema. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

export interface ModelInfo {
  id: string;
  /** Display name for doctor/status output. */
  label?: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
}

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly models: ModelInfo[];
  /** Resolve a model id (or alias) to concrete model info. */
  resolveModel(model: string): ModelInfo | undefined;
  /**
   * Stream one completion. Implementations MUST translate provider errors
   * into `{type:"error"}` events instead of throwing, so the kernel's event
   * sequence stays complete ("what the model saw ⟺ what was logged").
   */
  stream(req: LlmRequest, opts: { apiKey?: string; baseUrl?: string; signal?: AbortSignal }): AsyncIterable<StreamEvent>;
}

export interface ProviderConfig {
  id: string;
  /** e.g. "openai-compat" | "anthropic" */
  type: "openai-compat" | "anthropic";
  baseUrl?: string;
  apiKeyEnv?: string;
  models?: Partial<ModelInfo>[];
  /** Extra request headers (gateways, proxies). */
  headers?: Record<string, string>;
}

export function textOf(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function toolCallsOf(message: Message): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
}

export function hasToolCalls(message: Message): boolean {
  return message.content.some((b) => b.type === "toolCall");
}
