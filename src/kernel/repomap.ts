/**
 * Deterministic repository map — a compact, symbol-level sketch of the
 * codebase injected into the system prompt.
 *
 * Why it exists (the aider lesson): agents burn most of their tool budget
 * hunting for where code lives. A static symbol index answers "where is X"
 * before the first turn, for free. No LLM involved here — pure scanning, so
 * it is fast, deterministic, and costs zero tokens to produce.
 *
 * Hard guarantees:
 *  - never reads outside the workspace,
 *  - never emits file *contents* (only signatures — the model must still
 *    read a file before editing it),
 *  - bounded: file count, symbols per file, and total output are all capped.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORE, walkFiles } from "../util/paths.ts";

export interface RepoMapOptions {
  /** Hard cap on files included in the map. */
  maxFiles?: number;
  /** Hard cap on symbols listed per file. */
  maxSymbolsPerFile?: number;
  /** Hard cap on the final string (system-prompt budget). */
  maxOutputChars?: number;
}

interface SymbolHit {
  line: number;
  text: string;
}

interface FileSketch {
  rel: string; // posix-style workspace-relative path
  depth: number;
  symbols: SymbolHit[];
}

/**
 * Per-language signature patterns. Deliberately conservative: they only match
 * declaration lines, so a brace-heavy one-liner never pollutes the map.
 */
const LANG_PATTERNS: { match: RegExp; symbol: RegExp }[] = [
  {
    match: /\.(ts|tsx|js|jsx|mjs|cjs)$/,
    symbol:
      /^(export\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\s+\*?\w+|class\s+\w+|interface\s+\w+|type\s+\w+(\s*=\s*[^;{]+)?|enum\s+\w+|const\s+\w+\s*(:\s*[^=;{]+)?\s*=)/,
  },
  { match: /\.py$/, symbol: /^(async\s+)?(def\s+\w+|class\s+\w+)/ },
  { match: /\.go$/, symbol: /^(func\s+(\([^)]*\)\s+)?\w+|type\s+\w+)/ },
  {
    match: /\.rs$/,
    symbol:
      /^(pub(\s*\([^)]*\))?\s+)?(fn\s+\w+|struct\s+\w+|enum\s+\w+|trait\s+\w+|type\s+\w+|impl(<[^>]+>)?\s+\w+)/,
  },
  {
    match: /\.(java|kt)$/,
    symbol:
      /^(public\s+|private\s+|protected\s+|internal\s+)?(data\s+)?(class\s+\w+|interface\s+\w+|enum\s+\w+|object\s+\w+|fun\s+\w+|suspend\s+fun\s+\w+)/,
  },
  { match: /\.(c|h|cc|cpp|hpp|hxx)$/, symbol: /^(class\s+\w+|struct\s+\w+|enum(\s+class)?\s+\w+)/ },
  { match: /\.rb$/, symbol: /^(class\s+\w+|module\s+\w+|def\s+[\w?!]+)/ },
  { match: /\.(sh|bash|zsh)$/, symbol: /^(function\s+[\w-]+|[\w-]+\(\)\s*\{)/ },
];

const MAP_IGNORE = new Set([...DEFAULT_IGNORE, ".memento", ".agents", "uploads", "_edge_tmp"]);
const MAX_FILE_SIZE = 500_000;

/**
 * Drop initializer literals from variable declarations: names and types are
 * navigational, values are not — and values can hold secrets. Callable
 * values (arrow functions, generators) keep their signature.
 */
function sanitizeSignature(line: string): string {
  const trimmed = line.trim();
  const eq = trimmed.indexOf("=");
  if (eq === -1) return trimmed;
  if (/^(const|let|var)\s+\w+\s*=/.test(trimmed)) {
    const after = trimmed.slice(eq + 1).trim();
    const callable = /^(async\s+)?(function|\()/.test(after) || after.startsWith("<");
    if (!callable) return `${trimmed.slice(0, eq).trim()} = …`;
  }
  return trimmed;
}

export function buildRepoMap(root: string, opts: RepoMapOptions = {}): string {
  const maxFiles = opts.maxFiles ?? 500;
  const maxSymbolsPerFile = opts.maxSymbolsPerFile ?? 40;
  const maxOutputChars = opts.maxOutputChars ?? 12_000;

  const files = walkFiles(root, { ignore: MAP_IGNORE, maxFiles: 2000, maxDepth: 12 });
  const sketches: FileSketch[] = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith(".")) continue;
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_SIZE) continue;
    const lang = LANG_PATTERNS.find((p) => p.match.test(rel));
    const symbols: SymbolHit[] = [];
    if (lang) {
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        text = "";
      }
      if (text && !text.includes("\u0000")) {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && symbols.length < maxSymbolsPerFile; i++) {
          if (lang.symbol.test(lines[i]!)) {
            symbols.push({ line: i + 1, text: sanitizeSignature(lines[i]!).slice(0, 120) });
          }
        }
      }
    }
    sketches.push({ rel, depth: rel.split("/").length, symbols });
  }

  // Rank: files with symbols first (they carry the navigation value), then
  // shallow paths (config at the root matters), then alphabetically.
  sketches.sort((a, b) => {
    const sa = a.symbols.length > 0 ? 1 : 0;
    const sb = b.symbols.length > 0 ? 1 : 0;
    if (sa !== sb) return sb - sa;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.rel.localeCompare(b.rel);
  });
  const selected = sketches.slice(0, maxFiles);

  const head =
    `<repo-map>\nIndexed ${sketches.length} file(s)` +
    (sketches.length > selected.length ? `, showing ${selected.length} most relevant` : "") +
    ". Symbol line numbers drift as you edit — confirm with `read` or `grep` before editing.";

  const tree = renderTree(selected.map((s) => s.rel));
  const symbolLines: string[] = [];
  for (const s of selected) {
    if (s.symbols.length === 0) continue;
    symbolLines.push(`${s.rel}:`);
    for (const hit of s.symbols) symbolLines.push(`  ${hit.line}: ${hit.text}`);
  }
  const symbolText = symbolLines.join("\n");

  let out = `${head}\n\n## Tree\n${tree}\n\n## Key symbols\n${symbolText}</repo-map>`;
  if (out.length > maxOutputChars) {
    // Keep the tree intact (global orientation) and cut symbols (details can
    // be recovered with a targeted grep).
    const budget = Math.max(500, maxOutputChars - head.length - tree.length - 200);
    out = `${head}\n\n## Tree\n${tree}\n\n## Key symbols\n${symbolText.slice(0, budget)}\n… (symbol list truncated)</repo-map>`;
  }
  return out;
}

/** Render posix-style relative paths as a compact indented tree. */
function renderTree(rels: string[]): string {
  type Node = Map<string, Node>;
  const root: Node = new Map();
  for (const rel of rels) {
    let node = root;
    for (const part of rel.split("/")) {
      let child = node.get(part);
      if (!child) {
        child = new Map();
        node.set(part, child);
      }
      node = child;
    }
  }
  const lines: string[] = [];
  const walk = (node: Node, indent: string): void => {
    const names = [...node.keys()].sort();
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      const isDir = node.get(name)!.size > 0;
      const last = i === names.length - 1;
      lines.push(`${indent}${last ? "└─ " : "├─ "}${name}${isDir ? "/" : ""}`);
      if (lines.length >= 80) return;
      walk(node.get(name)!, indent + (last ? "   " : "│  "));
      if (lines.length >= 80) return;
    }
  };
  walk(root, "");
  if (lines.length >= 80) lines.push("… (tree truncated)");
  return lines.join("\n");
}
