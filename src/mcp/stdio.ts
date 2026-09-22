/**
 * Minimal MCP (Model Context Protocol) server over stdio — no SDK dependency.
 *
 * Speaks the JSON-RPC 2.0 / newline-delimited transport that MCP clients
 * (Claude Code, Cline, Goose, …) use for stdio servers:
 *   initialize          → handshake (protocol version + capabilities)
 *   notifications/*     → no response
 *   tools/list          → tool manifest with JSON schemas
 *   tools/call          → execute one tool
 *
 * stdout carries protocol frames only; human-facing logs go to stderr.
 * Requests are handled in arrival order — stdio is a single duplex pipe,
 * and per-tool handlers are free to do async work while later frames wait.
 */
import readline from "node:readline";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

export interface McpToolHandler {
  (args: Record<string, unknown>, extra: { clientName: string }): Promise<McpToolResult>;
}

export interface McpTool {
  def: McpToolDef;
  handler: McpToolHandler;
}

export interface ServeOptions {
  name: string;
  version: string;
  tools: McpTool[];
  log?: (line: string) => void;
  /** Injectable IO for tests; defaults to process stdio. */
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): void };
}

const SUPPORTED_PROTOCOL_VERSION = "2024-11-05";

interface RpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

export async function serveStdio(opts: ServeOptions): Promise<number> {
  const log = opts.log ?? (() => {});
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const tools = new Map(opts.tools.map((t) => [t.def.name, t]));
  let clientName = "mcp-client";
  let initialized = false;

  const send = (payload: unknown): void => {
    output.write(JSON.stringify(payload) + "\n");
  };

  const respond = (id: string | number | null, result: unknown): void => {
    send({ jsonrpc: "2.0", id, result });
  };

  const fail = (id: string | number | null, code: number, message: string): void => {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const handle = async (req: RpcRequest, isNotification: boolean): Promise<void> => {
    const id = req.id ?? null;
    const method = req.method as string;

    // Notifications never get a response — including errors.
    if (isNotification) return;

    try {
      // Everything except initialize/ping requires the handshake first.
      if (!initialized && method !== "initialize" && method !== "ping") {
        fail(id, -32600, "initialize handshake required first");
        return;
      }

      switch (method) {
        case "initialize": {
          const params = (req.params ?? {}) as { clientInfo?: { name?: string; version?: string } };
          clientName = params.clientInfo?.name ?? clientName;
          initialized = true;
          respond(id, {
            protocolVersion: SUPPORTED_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: opts.name, version: opts.version },
          });
          return;
        }
        case "ping":
          respond(id, {});
          return;
        case "tools/list":
          respond(id, { tools: opts.tools.map((t) => t.def) });
          return;
        case "tools/call": {
          const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
          if (typeof params.name !== "string") {
            fail(id, -32602, "params.name must be a string");
            return;
          }
          const tool = tools.get(params.name);
          if (!tool) {
            fail(id, -32602, `unknown tool: ${params.name}`);
            return;
          }
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const result = await tool.handler(args, { clientName });
          respond(id, {
            content: [{ type: "text", text: result.text }],
            ...(result.isError ? { isError: true } : {}),
          });
          return;
        }
        default:
          fail(id, -32601, `method not found: ${method}`);
          return;
      }
    } catch (err) {
      fail(id, -32603, err instanceof Error ? err.message : String(err));
    }
  };

  log(`memento MCP server v${opts.version} listening on stdio`);
  log(`tools: ${opts.tools.map((t) => t.def.name).join(", ")}`);

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let req: RpcRequest;
      try {
        req = JSON.parse(trimmed) as RpcRequest;
      } catch {
        // JSON-RPC: a parse error is answered with id: null.
        fail(null, -32700, "parse error");
        continue;
      }
      // Legal JSON that is not an object (a bare string, array, …) is an invalid request.
      if (typeof req !== "object" || req === null || Array.isArray(req)) {
        fail(null, -32600, "invalid request");
        continue;
      }
      if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
        if (!("id" in req)) continue; // invalid notification → drop silently
        fail(req.id ?? null, -32600, "invalid request");
        continue;
      }
      await handle(req, !("id" in req));
    }
  } finally {
    rl.close();
  }
  return 0;
}
