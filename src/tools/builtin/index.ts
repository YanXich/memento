/**
 * Built-in tool set assembly.
 * `registerBuiltins` is the single place the default toolbelt is defined;
 * plugins add to (and may replace parts of) it via the same registry API.
 */
import type { ToolRegistry } from "../types.ts";
import { applyPatchTool, editTool, globTool, grepTool, lsTool, readTool, writeTool } from "./files.ts";
import { bashTool } from "./shell.ts";
import { gitDiffTool, gitLogTool, gitStatusTool } from "./git.ts";

export const BUILTIN_TOOLS = [
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
];

export function registerBuiltins(registry: ToolRegistry): void {
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool);
  }
}

export { applyPatchTool, editTool, globTool, grepTool, lsTool, readTool, writeTool, bashTool, gitStatusTool, gitDiffTool, gitLogTool };
