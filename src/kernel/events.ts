/**
 * Kernel event vocabulary + a minimal push-based event stream.
 *
 * The loop emits events; the CLI renders them; plugins observe them; the
 * session log persists the *messages* they carry. Events are the only way the
 * outside world learns what the agent is doing.
 */
import type { Message, ToolCallBlock, Usage } from "../llm/types.ts";

export type AgentEvent =
  | { type: "agent_start"; model: string }
  | { type: "turn_start"; turn: number }
  | { type: "message_start"; message: Message }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "message_end"; message: Message }
  | { type: "tool_start"; call: ToolCallBlock }
  | { type: "tool_progress"; tool: string; line: string }
  | { type: "tool_end"; call: ToolCallBlock; result: Message }
  | { type: "tools_blocked"; reason: string; calls: ToolCallBlock[] }
  | { type: "context_compacted"; replacedTokens: number; summaryTokens: number }
  | { type: "turn_end"; turn: number; message: Message; usage: Usage }
  | { type: "agent_end"; messages: Message[]; reason: "done" | "aborted" | "error" | "max_turns" };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

/**
 * Fan-out dispatcher. Handlers run sequentially so ordering is deterministic.
 *
 * Two hard guarantees for the agent loop:
 *  1. Snapshot semantics — registering/unregistering during a dispatch never
 *     affects the in-flight dispatch.
 *  2. Isolation — one broken handler (a renderer, a plugin) cannot kill the
 *     kernel: errors are caught, reported once, and the dispatch continues.
 */
export class EventBus {
  private handlers: AgentEventHandler[] = [];
  private broken = new WeakSet<AgentEventHandler>();

  on(handler: AgentEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      if (this.broken.has(handler)) continue;
      try {
        await handler(event);
      } catch (err) {
        // Report once, then quarantine — a noisy renderer must not spam or
        // take the whole agent down.
        this.broken.add(handler);
        console.error(`[events] handler error on ${event.type}: ${(err as Error).message}`);
      }
    }
  }
}
