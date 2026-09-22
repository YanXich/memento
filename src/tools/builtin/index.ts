/**
 * Built-in tool set assembly.
 * `registerBuiltins` is the single place the default toolbelt is defined;
 * plugins add to (and may replace parts of) it via the same registry API.
 */
import type { Tool, ToolRegistry } from "../types.ts";
import { applyPatchTool, editTool, globTool, grepTool, lsTool, readTool, writeTool } from "./files.ts";
import { bashTool } from "./shell.ts";
import { gitDiffTool, gitLogTool, gitStatusTool } from "./git.ts";
import { subagentTool } from "./subagent.ts";

export const BUILTIN_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  applyPatchTool,
  lsTool,
  grepTool,
  globTool,
  bashTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  subagentTool,
];

export function registerBuiltins(registry: ToolRegistry): void {
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool);
  }
}

export { applyPatchTool, editTool, globTool, grepTool, lsTool, readTool, writeTool, bashTool, gitStatusTool, gitDiffTool, gitLogTool, subagentTool };
