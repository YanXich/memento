/**
 * Commit-message suggestion — the last gift of a session.
 *
 * After the loop finishes, if the working tree has uncommitted changes, one
 * small model call turns "task + diff" into a conventional commit message.
 * Memento never runs `git commit` itself — it hands the user a copy-paste
 * line, keeping the human in control of history.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LlmProvider, ModelInfo } from "../llm/types.ts";
import { complete } from "../llm/complete.ts";

const MAX_DIFF_CHARS = 8_000;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_BYTES = 64 * 1024;

/**
 * Unified diff of uncommitted changes — staged + unstaged + untracked —
 * or null when the tree is clean / not a repo.
 *
 * Untracked files are invisible to `git diff HEAD`, so they are stitched in
 * as synthetic "new file" diffs. We never touch the index (`git add -N`)
 * because the hint must have zero side effects on the user's repo state.
 */
export function workingDiff(root: string): string | null {
  try {
    const stat = execFileSync("git", ["-C", root, "diff", "--stat", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const diff = execFileSync("git", ["-C", root, "diff", "HEAD", "--unified=3"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    const untracked = untrackedFiles(root).slice(0, MAX_UNTRACKED_FILES);
    const extra: string[] = [];
    const statExtra: string[] = [];
    for (const f of untracked) {
      const pseudo = pseudoDiffForNewFile(root, f);
      if (pseudo === null) continue;
      extra.push(pseudo);
      const size = safeSize(path.resolve(root, f));
      statExtra.push(` ${f} (new file${size !== undefined ? `, ${size} bytes` : ""})`);
    }

    const body = [diff.trim(), ...extra].filter(Boolean).join("\n\n");
    if (!body.trim()) return null;
    const statBlock = [stat.trim(), ...statExtra].filter(Boolean).join("\n");
    const head = body.length > MAX_DIFF_CHARS ? body.slice(0, MAX_DIFF_CHARS) + "\n… [diff truncated]" : body;
    return `${statBlock}\n\n${head}`;
  } catch {
    return null; // not a git repo, or git missing — no hint
  }
}

/** Untracked file paths from `git status --porcelain -z` (NUL-separated, quoting-safe). */
function untrackedFiles(root: string): string[] {
  try {
    const buf = execFileSync("git", ["-C", root, "status", "--porcelain", "-z", "--untracked-files=normal"], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files: string[] = [];
    for (const entry of buf.toString("utf8").split("\0")) {
      if (entry.startsWith("?? ")) files.push(entry.slice(3));
    }
    return files;
  } catch {
    return [];
  }
}

/** Synthetic "new file" diff for an untracked text file; null for binary / oversized / non-files. */
function pseudoDiffForNewFile(root: string, rel: string): string | null {
  try {
    const abs = path.resolve(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`;
    if (st.size > MAX_UNTRACKED_BYTES) {
      return `${header}@@ -0,0 +1 @@\n+… [file too large to include in the hint]\n`;
    }
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return `${header}@@ -0,0 +1 @@\n+… [binary file]\n`;
    const lines = buf.toString("utf8").split("\n");
    const hunk = lines.map((l) => `+${l}`).join("\n");
    return `${header}@@ -0,0 +1,${lines.length} @@\n${hunk}\n`;
  } catch {
    return null;
  }
}

function safeSize(abs: string): number | undefined {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

export async function suggestCommitMessage(
  deps: { provider: LlmProvider; model: ModelInfo; apiKey?: string; baseUrl?: string },
  task: string,
  diff: string,
): Promise<string | null> {
  const res = await complete({
    provider: deps.provider,
    model: deps.model,
    ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    system:
      "You write git commit messages. Follow the conventional commits format (feat/fix/refactor/test/docs/chore), one line under 72 chars, no period at the end. Base it on the task and the diff. Return ONLY the message line.",
    user: `Task: ${task}\n\nDiff:\n${diff}`,
    maxTokens: 100,
    temperature: 0.2,
  });
  if (res.error) return null;
  const line = res.text.trim().split("\n")[0]!.trim();
  return line && line.length <= 120 ? line : null;
}
