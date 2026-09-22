/**
 * `memento serve-mcp` — expose this repo's memory to other agents.
 *
 * Any MCP client (Claude Code, Cline, Goose, …) can point at
 *   `memento serve-mcp --cwd <repo>`
 * and get search_lessons / add_lesson / memory_stats over stdio. The same
 * `.memento/memory/lessons.jsonl` Memento itself learns from becomes the
 * shared memory of every agent on the machine.
 */
import pc from "picocolors";
import { createWorkspace } from "../workspace.ts";
import { memoryTools } from "../../mcp/memory-server.ts";
import { serveStdio } from "../../mcp/stdio.ts";
import { VERSION } from "../../version.ts";

export interface ServeMcpOptions {
  root: string;
  readOnly?: boolean;
}

export async function serveMcp(opts: ServeMcpOptions): Promise<number> {
  const ws = createWorkspace(opts.root);
  const tools = memoryTools(ws.lessons, { readOnly: Boolean(opts.readOnly) });

  const stats = ws.lessons.stats();
  process.stderr.write(
    pc.dim(
      `memory: ${stats.active} active / ${stats.retired} retired lesson(s) in ${ws.root}` +
        (opts.readOnly ? " (read-only)" : "") +
        "\n",
    ),
  );

  return serveStdio({
    name: "memento",
    version: VERSION,
    tools,
    log: (line) => process.stderr.write(pc.dim(line + "\n")),
  });
}
