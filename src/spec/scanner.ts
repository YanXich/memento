/**
 * Repository scanner — cheap, deterministic, no LLM.
 * Its output feeds the spec generator; keeping scan and inference separate
 * means spec generation is reproducible from the scan alone.
 */
import fs from "node:fs";
import path from "node:path";
import type { RepoScan } from "./types.ts";
import { walkFiles } from "../util/paths.ts";

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".rb": "Ruby",
  ".php": "PHP", ".cs": "C#", ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++", ".swift": "Swift",
  ".sh": "Shell", ".ps1": "PowerShell", ".sql": "SQL", ".md": "Markdown", ".yml": "YAML", ".yaml": "YAML",
  ".json": "JSON", ".html": "HTML", ".css": "CSS", ".vue": "Vue", ".svelte": "Svelte", ".lua": "Lua",
};

const MANIFEST_FILES = [
  "package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml",
  "pom.xml", "build.gradle", "Gemfile", "composer.json", "*.csproj",
];

export function scanRepo(root: string): RepoScan {
  const files = walkFiles(root, { maxFiles: 8000, maxDepth: 14 });
  let totalBytes = 0;
  const langCount = new Map<string, number>();
  const topLevelSet = new Set<string>();
  const testDirs = new Set<string>();
  const entryHints: string[] = [];
  const sampledFiles: string[] = [];

  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const top = rel.split("/")[0]!;
    topLevelSet.add(rel.includes("/") ? top + "/" : top);

    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue;
    }
    totalBytes += size;

    const ext = path.extname(abs).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (lang && ext !== ".md" && ext !== ".json") {
      langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
    }

    const segments = rel.split("/");
    const testIdx = segments.findIndex((s) => /^(tests?|__tests__|spec)$/.test(s));
    if (testIdx >= 0) {
      testDirs.add(segments.slice(0, testIdx + 1).join("/"));
    }

    const base = path.basename(rel);
    if (
      /^(index|main|app|cli|server|entry)\.(ts|tsx|js|mjs|py|go|rs)$/.test(base) ||
      base === "package.json" ||
      base === "pyproject.toml" ||
      base === "go.mod" ||
      base === "Cargo.toml"
    ) {
      if (entryHints.length < 24) entryHints.push(rel);
    }

    // Sample source files (small, in common dirs) for the architecture prompt.
    if (sampledFiles.length < 40 && /\.(ts|js|py|go|rs|java)$/.test(ext) && size < 60_000) {
      if (/^(src|lib|app|packages|internal|core)\//.test(rel) || !rel.includes("/")) {
        sampledFiles.push(rel);
      }
    }
  }

  const languages = [...langCount.entries()]
    .map(([name, count]) => ({ name, files: count }))
    .sort((a, b) => b.files - a.files);

  return {
    root,
    fileCount: files.length,
    totalBytes,
    languages,
    topLevel: [...topLevelSet].sort().slice(0, 40),
    packageManifest: readManifest(root),
    readmeExcerpt: readReadme(root),
    testDirs: [...testDirs].slice(0, 8),
    entryHints: entryHints.sort(),
    sampledFiles: sampledFiles.sort(),
  };
}

function readManifest(root: string): string | null {
  for (const name of MANIFEST_FILES) {
    if (name.includes("*")) continue;
    const abs = path.join(root, name);
    try {
      const body = fs.readFileSync(abs, "utf8");
      return `${name}:\n${body.slice(0, 3000)}`;
    } catch {
      continue;
    }
  }
  return null;
}

function readReadme(root: string): string | null {
  for (const name of ["README.md", "readme.md", "README.rst", "README.txt"]) {
    const abs = path.join(root, name);
    try {
      return fs.readFileSync(abs, "utf8").slice(0, 4000);
    } catch {
      continue;
    }
  }
  return null;
}
