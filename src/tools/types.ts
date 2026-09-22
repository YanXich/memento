/**
 * Tool contract + registry.
 *
 * A tool is data, not behavior-coupled magic: schema, description, and an
 * execute function. The registry is where "everything is a plugin" starts —
 * built-in tools, plugin tools, and future MCP bridges all land here.
 */
import { z } from "zod";
import type { ToolSchema } from "../llm/types.ts";
import { zodToJsonSchema } from "./schema.ts";

export interface ToolResult {
  /** Text shown to the model. */
  output: string;
  isError?: boolean;
  /** Structured metadata for UI/logs (not sent to the model). */
  details?: Record<string, unknown>;
}

export interface ApprovalRequest {
  tool: string;
  description: string;
  args: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Stream a progress line to the UI (not the model). */
  progress: (line: string) => void;
  /** Ask the user (or policy) to approve a mutating/risky call. */
  approve: (req: ApprovalRequest) => Promise<boolean>;
}

export interface Tool<A = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  /** Mutating tools are gated by approval + run sequentially. */
  mutating?: boolean;
  /** Return true to require approval even when not mutating. */
  requiresApproval?: (args: A) => boolean;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): () => void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return () => {
      this.tools.delete(tool.name);
    };
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  toSchemas(): ToolSchema[] {
    return this.all().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema),
    }));
  }

  /** Validate args against a tool's schema; returns parsed args or an error string. */
  validate(name: string, args: unknown): { ok: true; args: unknown } | { ok: false; error: string } {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: `Invalid arguments for ${name}: ${issues}` };
    }
    return { ok: true, args: parsed.data };
  }
}
