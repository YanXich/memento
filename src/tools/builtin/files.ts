/**
 * Built-in file tools: read, write, edit, ls, grep, glob.
 *
 * House style for every tool:
 *  - deterministic output (useful for model + tests),
 *  - hard size caps with explicit truncation notes,
 *  - mutating tools declare `mutating: true` so the kernel gates them.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.ts";
import { displayPath, resolveInWorkspace, walkFiles, DEFAULT_IGNORE } from "../../util/paths.ts";
import { truncate, truncateMiddle, formatBytes } from "../../util/text.ts";
import { guardReadPath, guardWritePath, isSecretFileName } from "../guard.ts";
import { snapshotBeforeWrite } from "../snapshot.ts";

const MAX_READ_CHARS = 100_000;
const MAX_TOOL_OUTPUT = 30_000;
const MAX_EDIT_FILE = 2_000_000;

export const readTool: Tool = {
  name: "read",
  description:
    "Read a text file from the workspace. Returns numbered lines. Use offset/limit for large files. Always read a file before editing it.",
  schema: z.object({
    path: z.string().describe("Workspace-relative file path"),
    offset: z.number().int().min(1).optional().describe("1-based first line to read"),
    limit: z.number().int().min(1).max(5000).optional().describe("Max lines to read (default 2000)"),
  }),
  async execute(args: { path: string; offset?: number; limit?: number }, ctx: ToolContext) {
    const abs = resolveInWorkspace(ctx.cwd, args.path);
    const guard = guardReadPath(ctx.cwd, abs);
    if (!guard.allowed) {
      if (guard.secret) {
        // Secrets are readable only with an explicit human (or policy) yes —
        // a headless run denies by default so nothing sensitive leaves the machine.
        const approved = await ctx.approve({
          tool: "read",
          description: `read protected file ${args.path} (${guard.reason})`,
          args: { path: args.path },
        });
        if (!approved) return { output: `Refused: ${guard.reason} — approval required`, isError: true };
      } else {
        return { output: `Refused: ${guard.reason}`, isError: true };
      }
    }
    let raw: string;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return { output: `Not a file: ${args.path}`, isError: true };
      if (stat.size > 5_000_000) {
        return { output: `File too large to read (${formatBytes(stat.size)}): ${args.path}`, isError: true };
      }
      raw = fs.readFileSync(abs, "utf8");
    } catch {
      return { output: `File not found: ${args.path}`, isError: true };
    }
    if (raw.includes("\u0000")) {
      return {
        output: `Binary file (NUL bytes detected): ${args.path} — inspect it with shell tools instead.`,
        isError: true,
      };
    }

    const allLines = raw.split("\n");
    const offset = args.offset ?? 1;
    const limit = args.limit ?? 2000;
    const sliced = allLines.slice(offset - 1, offset - 1 + limit);
    if (sliced.length === 0) {
      return { output: `${args.path} has ${allLines.length} lines; offset ${offset} is past the end.` };
    }
    const numbered = sliced.map((line, i) => `${offset + i}\t${line}`).join("\n");
    let out = numbered;
    if (offset - 1 + sliced.length < allLines.length) {
      out += `\n… (${allLines.length - (offset - 1 + sliced.length)} more lines; use offset=${offset + sliced.length} to continue)`;
    }
    out = truncate(out, MAX_READ_CHARS);
    return {
      output: out,
      details: { path: args.path, lines: allLines.length, shown: sliced.length },
    };
  },
};

export const writeTool: Tool = {
  name: "write",
  description:
    "Write (create or overwrite) a text file in the workspace. For existing files, prefer `edit` unless a full rewrite is intended. Parent directories are created automatically.",
  mutating: true,
  schema: z.object({
    path: z.string().describe("Workspace-relative file path"),
    content: z.string().describe("Full file content"),
  }),
  async execute(args: { path: string; content: string }, ctx: ToolContext) {
    const abs = resolveInWorkspace(ctx.cwd, args.path);
    const guard = guardWritePath(ctx.cwd, abs);
    if (!guard.allowed) return { output: `Refused: ${guard.reason}`, isError: true };

    let existed = false;
    try {
      existed = fs.statSync(abs).isFile();
    } catch {
      /* new file */
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    snapshotBeforeWrite(ctx.cwd, displayPath(ctx.cwd, abs));
    fs.writeFileSync(abs, args.content, "utf8");
    const lines = args.content.split("\n").length;
    return {
      output: `${existed ? "Overwrote" : "Created"} ${args.path} (${lines} lines, ${formatBytes(Buffer.byteLength(args.content))})`,
      details: { path: args.path, existed, lines },
    };
  },
};

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in a file. `old_string` must match exactly once (include surrounding context to disambiguate) unless replace_all is true. Never include line-number prefixes from `read` output in old_string.",
  mutating: true,
  schema: z.object({
    path: z.string(),
    old_string: z.string().describe("Exact text to replace (must be unique unless replace_all)"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence"),
  }),
  async execute(args: { path: string; old_string: string; new_string: string; replace_all?: boolean }, ctx: ToolContext) {
    const abs = resolveInWorkspace(ctx.cwd, args.path);
    const guard = guardWritePath(ctx.cwd, abs);
    if (!guard.allowed) return { output: `Refused: ${guard.reason}`, isError: true };

    let content: string;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_EDIT_FILE) {
        return { output: `File too large to edit safely (${formatBytes(stat.size)}). Use write for full rewrites.`, isError: true };
      }
      content = fs.readFileSync(abs, "utf8");
    } catch {
      return { output: `File not found: ${args.path}`, isError: true };
    }

    const count = countOccurrences(content, args.old_string);
    if (count === 0) {
      return {
        output: `old_string not found in ${args.path}. Read the file first and copy the exact text (without line numbers).`,
        isError: true,
      };
    }
    if (count > 1 && !args.replace_all) {
      return {
        output: `old_string appears ${count} times in ${args.path}. Add more surrounding context to make it unique, or set replace_all: true.`,
        isError: true,
      };
    }
    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string);
    snapshotBeforeWrite(ctx.cwd, displayPath(ctx.cwd, abs));
    fs.writeFileSync(abs, updated, "utf8");
    return {
      output: `Edited ${args.path} (${count} replacement${count === 1 ? "" : "s"})`,
      details: { path: args.path, occurrences: count },
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * apply_patch — many edits, one file, all-or-nothing.
 *
 * The `edit` tool is one-hunk-per-call; a multi-site change then costs a
 * round trip per hunk and can leave the file half-edited if the model stops
 * early. apply_patch validates every hunk up front and only then writes,
 * so a failed hunk leaves the file byte-for-byte untouched (the model gets a
 * per-hunk report and can retry without fear of a corrupted state).
 *
 * Matching is exact first; if that misses, a whitespace-tolerant pass
 * (indentation drift from copy-paste is the top cause of edit failures)
 * kicks in. Either way the match must be unique.
 */
export const applyPatchTool: Tool = {
  name: "apply_patch",
  description:
    "Apply multiple edits to one file atomically. Every hunk is validated before anything is written: if any hunk fails to match uniquely, NOTHING is written and you get a per-hunk report. `old` must be the exact text (whitespace differences tolerated). Prefer this over repeated `edit` calls for multi-site changes to the same file.",
  mutating: true,
  schema: z.object({
    path: z.string(),
    hunks: z
      .array(
        z.object({
          old: z.string().describe("Exact existing text to find (must be unique in the file)"),
          new: z.string().describe("Replacement text"),
        }),
      )
      .min(1)
      .max(20),
  }),
  async execute(args: { path: string; hunks: { old: string; new: string }[] }, ctx: ToolContext) {
    const abs = resolveInWorkspace(ctx.cwd, args.path);
    const guard = guardWritePath(ctx.cwd, abs);
    if (!guard.allowed) return { output: `Refused: ${guard.reason}`, isError: true };

    let content: string;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_EDIT_FILE) {
        return { output: `File too large to edit safely (${formatBytes(stat.size)}). Use write for full rewrites.`, isError: true };
      }
      content = fs.readFileSync(abs, "utf8");
    } catch {
      return { output: `File not found: ${args.path}`, isError: true };
    }

    // Phase 1 — validate every hunk against the ORIGINAL content. Nothing
    // is written until all hunks pass; failed hunks get a precise report.
    const resolved: { start: number; end: number; mode: "exact" | "loose"; new: string }[] = [];
    const failures: string[] = [];
    for (const [i, hunk] of args.hunks.entries()) {
      if (!hunk.old) {
        failures.push(`hunk ${i + 1}: \`old\` is empty — nothing to find.`);
        continue;
      }
      const exact = findAll(content, hunk.old);
      if (exact.length === 1) {
        resolved.push({ ...exact[0]!, mode: "exact", new: hunk.new });
      } else if (exact.length > 1) {
        failures.push(
          `hunk ${i + 1}: matches ${exact.length} times — add more surrounding context to make it unique.`,
        );
      } else {
        const loose = findLoose(content, hunk.old);
        if (loose.length === 1) {
          resolved.push({ ...loose[0]!, mode: "loose", new: hunk.new });
        } else if (loose.length > 1) {
          failures.push(
            `hunk ${i + 1}: whitespace-tolerantly matches ${loose.length} times — add more surrounding context.`,
          );
        } else {
          failures.push(`hunk ${i + 1}: \`old\` not found. Read the file and copy the exact text (no line-number prefixes).`);
        }
      }
    }
    if (failures.length > 0) {
      return {
        output: `apply_patch refused to write ${args.path} — ${failures.length}/${args.hunks.length} hunk(s) failed and the file is unchanged:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
        isError: true,
      };
    }

    // Overlap check: two hunks that overlap make the result order-dependent.
    const sorted = [...resolved].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.start < sorted[i - 1]!.end) {
        return {
          output: `apply_patch refused to write ${args.path} — hunks overlap each other. Merge them into one hunk.`,
          isError: true,
        };
      }
    }

    // Phase 2 — apply back-to-front so earlier indices stay valid.
    let updated = content;
    for (const hunk of [...resolved].sort((a, b) => b.start - a.start)) {
      updated = updated.slice(0, hunk.start) + hunk.new + updated.slice(hunk.end);
    }
    snapshotBeforeWrite(ctx.cwd, displayPath(ctx.cwd, abs));
    fs.writeFileSync(abs, updated, "utf8");
    const loose = resolved.filter((r) => r.mode === "loose").length;
    return {
      output: `Applied ${resolved.length} hunk(s) to ${args.path}${loose ? ` (${loose} via whitespace-tolerant match)` : ""}`,
      details: { path: args.path, hunks: resolved.length, loose },
    };
  },
};

function findAll(haystack: string, needle: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push({ start: idx, end: idx + needle.length });
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
}

/** Whitespace-tolerant find: each line's whitespace runs match any run. */
function findLoose(haystack: string, needle: string): { start: number; end: number }[] {
  const pattern = needle
    .split("\n")
    .map((line) => {
      const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Tolerate only spaces/tabs within a line — `\s` would also swallow
      // newlines and let one needle line match across unrelated source lines.
      return escaped.replace(/[ \t]+/g, "[ \\t]+");
    })
    .join("\\s*\\n\\s*");
  let re: RegExp;
  try {
    re = new RegExp(pattern, "g");
  } catch {
    return [];
  }
  const out: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++; // guard against zero-width loops
  }
  return out;
}

/**
 * Heuristic rejection of catastrophic-backtracking shapes. Refuses, never runs:
 *  - a quantified group containing a quantifier ((a+)+) or alternation ((a|b)*)
 *  - adjacent identical quantified atoms (a*a*, [^x]*[^x]*) — the ambiguous
 *    NFA splits that make matching quadratic in the line length
 *  - a quantified alternation where one alternative is a prefix of another
 *    ((a|aa)*, (ab|abc)+)
 * Fail-safe: a false positive costs a rewrite; a miss can hang the process
 * on a minified one-line file.
 */
function isReDoSSuspect(pattern: string): boolean {
  if (/\([^()]*[*+][^()]*\)[*+{]/s.test(pattern)) return true;
  if (/\([^()]*\|[^()]*\)[*+{]/s.test(pattern)) return true;
  // Adjacent identical quantified atoms.
  const atoms = pattern.match(/(?:\[[^\]]*\]|\\.|.)[*+](?:\{\d+(?:,\d*)?\})?/g) ?? [];
  for (let i = 1; i < atoms.length; i++) {
    if (atoms[i] === atoms[i - 1]) return true;
  }
  // Quantified alternation with a prefix-member: (a|aa)*, (abc|abcd)+.
  for (const m of pattern.matchAll(/\(([^()|]+(?:\|[^()|]+)+)\)[*+{]/g)) {
    const alts = m[1]!.split("|");
    for (let i = 0; i < alts.length; i++) {
      for (let j = 0; j < alts.length; j++) {
        if (i !== j && alts[i] && alts[j] && alts[i]!.length < alts[j]!.length && alts[j]!.startsWith(alts[i]!)) return true;
      }
    }
  }
  return false;
}

export const lsTool: Tool = {
  name: "ls",
  description: "List directory contents (files and subdirectories) with sizes.",
  schema: z.object({
    path: z.string().optional().describe("Workspace-relative directory (default: workspace root)"),
  }),
  async execute(args: { path?: string }, ctx: ToolContext) {
    const abs = resolveInWorkspace(ctx.cwd, args.path ?? ".");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return { output: `Directory not found: ${args.path ?? "."}`, isError: true };
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const lines = entries.slice(0, 500).map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      try {
        const size = fs.statSync(path.join(abs, entry.name)).size;
        return `${entry.name}  (${formatBytes(size)})`;
      } catch {
        return entry.name;
      }
    });
    const header = `${args.path ?? "."}:`;
    const more = entries.length > 500 ? `\n… and ${entries.length - 500} more` : "";
    return { output: [header, ...lines].join("\n") + more, details: { entries: entries.length } };
  },
};

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search workspace file contents with a JavaScript regular expression. Returns matching lines with file:line prefixes. Use `glob` to limit which files are searched.",
  schema: z.object({
    pattern: z.string().describe("JS regular expression, e.g. 'TODO|FIXME'"),
    path: z.string().optional().describe("Directory to search (default: whole workspace)"),
    glob: z.string().optional().describe("File filter glob, e.g. '*.ts' or 'src/**'"),
    case_sensitive: z.boolean().optional(),
    max_results: z.number().int().min(1).max(500).optional(),
  }),
  async execute(
    args: { pattern: string; path?: string; glob?: string; case_sensitive?: boolean; max_results?: number },
    ctx: ToolContext,
  ) {
    if (args.pattern.length > 2000) {
      return { output: `Pattern too long (${args.pattern.length} chars); keep it under 2000.`, isError: true };
    }
    if (isReDoSSuspect(args.pattern)) {
      return {
        output:
          "Pattern rejected: nested quantifiers like (a+)+ or (a|b)* can hang the search on long lines (catastrophic backtracking). Rewrite it without quantifying a group that contains a quantifier or alternation.",
        isError: true,
      };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.case_sensitive ? "" : "i");
    } catch (err) {
      return { output: `Invalid regex: ${(err as Error).message}`, isError: true };
    }
    const root = resolveInWorkspace(ctx.cwd, args.path ?? ".");
    const maxResults = args.max_results ?? 100;
    const fileFilter = args.glob ? globToRegExp(args.glob) : null;
    const files = walkFiles(root, { maxFiles: 4000 });
    const results: string[] = [];
    let scanned = 0;

    for (const file of files) {
      if (results.length >= maxResults) break;
      const rel = displayPath(ctx.cwd, file);
      if (fileFilter && !fileFilter.test(rel)) continue;
      // Never search secret files — a match line from .env would exfiltrate
      // the secret itself into the context and the session log.
      if (isSecretFileName(path.basename(file))) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.size > 1_500_000) continue; // skip huge / binary-ish files
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // binary
      scanned++;
      const lines = text.split("\n");
      let skippedLong = 0;
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        const line = lines[i]!;
        // ReDoS defence in depth: even a well-shaped regex can blow up on a
        // multi-hundred-KB minified line. Skip overlong lines rather than
        // betting the event loop on them.
        if (line.length > 20_000) {
          skippedLong++;
          continue;
        }
        if (regex.test(line)) {
          results.push(`${rel}:${i + 1}: ${truncate(line.trim(), 240, "…")}`);
        }
      }
      if (skippedLong > 0) {
        results.push(`${rel}: … (${skippedLong} overlong line${skippedLong === 1 ? "" : "s"} skipped — read the file directly)`);
      }
    }
    if (results.length === 0) {
      return { output: `No matches for /${args.pattern}/ (scanned ${scanned} files)` };
    }
    const capped = results.length >= maxResults ? `\n… (capped at ${maxResults} results)` : "";
    return {
      output: truncate(results.join("\n") + capped, MAX_TOOL_OUTPUT),
      details: { matches: results.length, scanned },
    };
  },
};

export const globTool: Tool = {
  name: "glob",
  description: "Find files by glob pattern, e.g. 'src/**/*.ts' or '**/*.test.ts'. Newest first is not guaranteed; results are alphabetical.",
  schema: z.object({
    pattern: z.string().describe("Glob pattern, supports *, **, ?"),
    path: z.string().optional().describe("Base directory (default: workspace root)"),
    max_results: z.number().int().min(1).max(1000).optional(),
  }),
  async execute(args: { pattern: string; path?: string; max_results?: number }, ctx: ToolContext) {
    const root = resolveInWorkspace(ctx.cwd, args.path ?? ".");
    const regex = globToRegExp(args.pattern);
    const max = args.max_results ?? 200;
    const files = walkFiles(root, { maxFiles: 10_000 });
    const out: string[] = [];
    for (const file of files) {
      if (out.length >= max) break;
      const rel = displayPath(ctx.cwd, file);
      // Match against the path relative to the search root so patterns like src/** work naturally.
      const relToRoot = path.relative(root, file).split(path.sep).join("/");
      if (regex.test(relToRoot) || regex.test(rel)) out.push(relToRoot);
    }
    if (out.length === 0) return { output: `No files match ${args.pattern}` };
    const capped = out.length >= max ? `\n… (capped at ${max})` : "";
    return { output: truncate(out.join("\n") + capped, MAX_TOOL_OUTPUT), details: { files: out.length } };
  },
};

/** Convert a glob ( *, **, ? ) to a RegExp. ** crosses directories, * does not. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  const p = pattern.split(path.sep).join("/");
  while (i < p.length) {
    const ch = p[i]!;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // ** — any depth
        re += ".*";
        i += 2;
        if (p[i] === "/") i++; // consume optional slash after **
        continue;
      }
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
    i++;
  }
  return new RegExp(`^${re}$`);
}

export const BUILTIN_FILES_DEFAULT_IGNORE = DEFAULT_IGNORE;
export { truncateMiddle };
