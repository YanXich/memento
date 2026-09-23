/**
 * Safety guard — the "monotonic guard" seam, simplified.
 *
 * Two duties:
 *  1. Classify shell commands as dangerous (needs approval) or safe.
 *  2. Enforce path boundaries for mutating operations.
 *
 * Classification is fail-safe and explainable: a command is gated unless it
 * is *recognizably* read-only. Every rule has a human-readable reason so the
 * approval prompt can say WHY.
 */
import path from "node:path";
import { PROTECTED_DIRS, PROTECTED_FILES, isInside } from "../util/paths.ts";

export interface DangerVerdict {
  /** Catastrophic or irreversible — always gated, with a specific reason. */
  dangerous: boolean;
  /** Not recognizably read-only — gated by default. */
  mutating: boolean;
  reason?: string;
}

const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/i, reason: "recursive/forced file deletion (rm -rf)" },
  { pattern: /\brm\s+(-[a-zA-Z]+\s+)*[\\/](\s|$)/, reason: "deletion targeting filesystem root" },
  { pattern: /\b(del|rmdir|rd)\s+\/[sq]/i, reason: "Windows forced/quiet deletion" },
  { pattern: /\bformat\s+[a-z]:/i, reason: "disk format" },
  { pattern: /\bmkfs\b/i, reason: "filesystem creation" },
  { pattern: /\bdd\s+.*of=/i, reason: "raw disk write (dd)" },
  { pattern: /\bgit\s+push\s+.*(--force|-f)\b/i, reason: "force push rewrites remote history" },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, reason: "destructive git operation (hard reset / clean)" },
  { pattern: /\bgit\s+checkout\s+--\s+\./, reason: "discards all local changes" },
  { pattern: /(curl|wget|iwr|Invoke-WebRequest)[^|;]*\|\s*(sh|bash|zsh|pwsh|powershell|iex|Invoke-Expression)/i, reason: "piping remote content into a shell" },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/, reason: "publishing a package" },
  { pattern: /\bsudo\b|\brunas\b|Start-Process\s+.*-Verb\s+RunAs/i, reason: "privilege escalation" },
  { pattern: /\b(chmod|chown)\s+(-R\s+)?777\b/, reason: "world-writable permissions" },
  { pattern: />\s*\/dev\/(sd|nvme|hd)/i, reason: "writing to raw block device" },
  { pattern: /\bshutdown\b|\breboot\b|Stop-Computer|Restart-Computer/i, reason: "system power control" },
  { pattern: /\bkill\s+-9\s+1\b|killall\b/, reason: "force-killing processes" },
  { pattern: /taskkill\s+\/f\s+\/im\s+(explorer|winlogon|lsass)/i, reason: "killing critical Windows processes" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: "fork bomb" },
];

/**
 * Write indicators — commands that cannot be assumed read-only. Checked
 * before the read-only allowlist so `echo hi > f` gates on the redirect
 * even though `echo` alone is safe.
 */
const MUTATING_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\s)tee\s+\S/i, reason: "tee writes its input to a file" },
  { pattern: /\bsed\s+(-i|--in-place)\b|\btruncate\s+/i, reason: "in-place file edit" },
  { pattern: /\b(Set-Content|Add-Content|Set-Item|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Out-File|Tee-Object)\b/i, reason: "PowerShell write cmdlet" },
  { pattern: /(^|\s|\|)(touch|mkdir|rmdir|rm|del|mv|move|cp|copy|ln|chmod|chown|unlink)\s/i, reason: "filesystem modification" },
  { pattern: /\|\s*(sh|bash|zsh|pwsh|powershell|iex|Invoke-Expression)\b/i, reason: "piping into a shell" },
  { pattern: /\bgit\s+(add|commit|checkout|switch|restore|reset|stash|merge|rebase|pull|push|clean|cherry-pick|revert|apply|am|init|tag|remote|config|gc|prune|fetch|worktree)\b/i, reason: "git operation that changes repository state" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|rm|uninstall|update|upgrade|link|dedupe|publish)\b/i, reason: "package manager run that changes dependencies" },
  { pattern: /\bpip3?\s+(install|uninstall)\b|\b(apt|apt-get|dnf|yum|brew|scoop|choco|winget)\s+(install|uninstall|upgrade|remove)\b|\b(cargo|go)\s+(add|install|get)\b/i, reason: "system/global package installation" },
];

/** Strip single- and double-quoted sections so metacharacters inside quotes don't gate. */
function stripQuoted(cmd: string): string {
  return cmd.replace(/"[^"]*"|'[^']*'/g, "");
}

/** First tokens that are recognizably read-only. Anything else is gated. */
const READONLY_TOKENS = new Set([
  "ls", "dir", "pwd", "whoami", "hostname", "date", "cat", "type", "head", "tail", "wc", "find", "file",
  "stat", "du", "df", "tree", "echo", "printf", "uname", "which", "where", "whereis", "printenv", "env",
  "man", "help", "nproc", "sleep", "true", "false", "basename", "dirname", "realpath", "readlink", "id",
  "uptime", "locale", "diff", "cmp", "sort", "uniq", "cut", "tr", "jq", "yq", "rg", "grep", "awk", "cd",
  // NOTE: `sed` is deliberately absent — GNU sed has an `e` command (and s///e)
  // that executes shell code, and the payload hides inside quotes where the
  // read-only check can't see it. Fail-safe: sed always needs approval.
  // PowerShell read cmdlets (aliases like ls/dir/cat are covered above)
  "get-childitem", "gci", "get-content", "get-location", "gl", "get-item", "gi", "select-string", "measure-object",
  "test-path", "resolve-path", "get-command", "get-help", "get-date", "sort-object", "select-object", "where-object",
  "convertto-json", "compare-object",
]);

/** `git <sub>` commands that only inspect. */
const GIT_READONLY = new Set(["status", "log", "diff", "show", "blame", "describe", "rev-parse", "ls-files", "shortlog", "count-objects"]);

/** `tool --version` style probes. */
const VERSION_CMD = /^(node|python3?|deno|go|cargo|rustc|java|dotnet|tsc|npm|pnpm|yarn|bun)\s+(--version|-v|-V)$/i;

/** Test/lint runners are read-only by convention — don't make users approve `npm test`. */
const RUNNER_CMD = /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check|format:check)(:\S+)?$/i;

function isSegmentReadonly(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return true;
  // Danger syntax first — a "read-only" head token (ls, echo, cat…) does not
  // make a segment safe when it smuggles redirection or command substitution.
  // Quoted sections are stripped before matching so `grep "a > b" f` stays safe.
  const unquoted = stripQuoted(trimmed);
  if (/\$\(|\$\{|\$`|`[^`]*`|Invoke-Expression|iex\b/i.test(unquoted)) return false;
  if (/[<>]/.test(unquoted)) return false; // redirection, even unspaced `echo hi>f`
  const parts = trimmed.split(/\s+/);
  const head = (parts[0] ?? "").toLowerCase().replace(/^["']+|["']+$/g, "");
  if (!head) return true;
  if (VERSION_CMD.test(trimmed) || RUNNER_CMD.test(trimmed)) return true;
  if (head === "git") return parts[1] !== undefined && GIT_READONLY.has(parts[1].toLowerCase());
  if (head === "find") {
    // `find` can delete or run arbitrary commands; those subcommands sit
    // outside quotes, so the unquoted form sees them.
    if (/(^|\s)-(delete|exec|execdir|ok|okdir)(\s|=|$)/i.test(unquoted)) return false;
  }
  if (head === "awk") {
    // awk can spawn shells via system() or piped getline — the payload hides
    // inside quotes, so inspect the ORIGINAL segment, not the stripped one.
    if (/\bsystem\s*\(|getline\s*[<&]|cmd\s*\|/i.test(trimmed)) return false;
  }
  return READONLY_TOKENS.has(head);
}

export function classifyCommand(command: string): DangerVerdict {
  const cmd = command.trim();
  if (!cmd) return { dangerous: false, mutating: false };
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) return { dangerous: true, mutating: true, reason };
  }
  for (const { pattern, reason } of MUTATING_PATTERNS) {
    if (pattern.test(cmd)) return { dangerous: false, mutating: true, reason };
  }
  // Unquoted redirection — covers `echo hi > f`, `echo hi>f` and `2>&1`,
  // while `grep "a > b" f` stays read-only. Any unquoted `<`/`>` in a shell
  // command is redirection by definition (PowerShell uses -gt/-lt, not <>).
  if (/[<>]/.test(stripQuoted(cmd))) {
    return { dangerous: false, mutating: true, reason: "output/input redirection (writes a file)" };
  }
  // Fail-safe: every pipeline/chain segment must be recognizably read-only,
  // otherwise the whole command needs approval. Unknown commands gate.
  // Split on every chain separator: pipes, &&/||, ;, background &, and
  // newlines (PowerShell line continuations, embedded scripts).
  for (const segment of cmd.split(/\|\||&&|;|\||\n|&/)) {
    if (!isSegmentReadonly(segment)) {
      return { dangerous: false, mutating: true, reason: "not a recognized read-only command" };
    }
  }
  return { dangerous: false, mutating: false };
}

/**
 * Secret-file matching — exact known names plus common variants
 * (.env.*, *.pem, *.key, id_* keys). Fail-safe: when in doubt, block.
 */
export function isSecretFileName(base: string): boolean {
  if (PROTECTED_FILES.has(base)) return true;
  if (base.startsWith(".env")) return true;
  if (base.endsWith(".pem") || base.endsWith(".key")) return true;
  return /^id_(rsa|ed25519|dsa|ecdsa)(\.pub)?$/.test(base);
}

/**
 * Does a shell command reference a file whose name marks it a secret?
 * `cat .env` and `type id_rsa` are classified read-only, but they exfiltrate
 * secrets into the context and the session log — so the shell tool gates
 * them behind approval just like a write would be gated.
 */
export function commandTouchesSecrets(command: string): boolean {
  const tokens = command.split(/[\s'"\\/]+/).filter(Boolean);
  return tokens.some((t) => isSecretFileName(path.basename(t)));
}

/**
 * Read-side path guard. Reads never leave the workspace, and secret files
 * (.env, *.pem, id_rsa, …) require approval — headless policies deny by
 * default, so secrets stay on the machine unless a human opts in.
 */
export function guardReadPath(root: string, absPath: string): { allowed: boolean; secret: boolean; reason?: string } {
  if (!isInside(root, absPath)) {
    return { allowed: false, secret: false, reason: `path escapes the workspace (${absPath})` };
  }
  const base = path.basename(absPath);
  if (isSecretFileName(base)) {
    return { allowed: false, secret: true, reason: `reading ${base} is protected — secrets never leave the machine` };
  }
  return { allowed: true, secret: false };
}

/** Paths (relative to workspace root) that mutating tools refuse to touch. */
export function guardWritePath(root: string, absPath: string): { allowed: boolean; reason?: string } {
  if (!isInside(root, absPath)) {
    return { allowed: false, reason: `path escapes the workspace (${absPath})` };
  }
  const rel = path.relative(root, absPath);
  const parts = rel.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    if (PROTECTED_DIRS.has(part)) {
      return { allowed: false, reason: `writes inside ${part}/ are protected` };
    }
  }
  const base = parts[parts.length - 1] ?? "";
  if (isSecretFileName(base)) {
    return { allowed: false, reason: `writing to ${base} is protected (secrets)` };
  }
  if (base === "package-lock.json" || base === "pnpm-lock.yaml") {
    // Not forbidden — lockfiles may legitimately be regenerated — but surfaced.
    return { allowed: true, reason: "lockfile write" };
  }
  return { allowed: true };
}
