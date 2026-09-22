/**
 * Spec engine types.
 *
 * The spec directory is the project's living constitution:
 *
 *   .memento/spec/
 *   ├── constitution.md      — non-negotiables (human-approved; agent may propose, never auto-edit)
 *   ├── architecture.md      — how the system is structured
 *   ├── features/*.md        — capability-level specs, updated as work lands
 *   └── decisions/*.md       — ADRs: context / decision / consequences
 */
export interface SpecFile {
  /** Path relative to workspace root, posix separators. */
  relPath: string;
  /** "constitution" | "architecture" | "feature" | "decision" | "other" */
  kind: SpecKind;
  /** Feature/decision slug derived from the file name (e.g. "auth"). */
  slug: string;
  content: string;
  updatedAt: number;
}

export type SpecKind = "constitution" | "architecture" | "feature" | "decision" | "other";

export interface SpecBundle {
  constitution: SpecFile | null;
  architecture: SpecFile | null;
  features: SpecFile[];
  decisions: SpecFile[];
  all: SpecFile[];
}

export interface SpecStatus {
  initialized: boolean;
  counts: Record<SpecKind, number>;
  /** Most recent update timestamps per kind (0 when absent). */
  lastUpdated: Record<SpecKind, number>;
  /** Working tree changed since last `spec sync`? (best-effort via git) */
  staleHint: string | null;
}

export interface RepoScan {
  root: string;
  fileCount: number;
  totalBytes: number;
  languages: { name: string; files: number }[];
  topLevel: string[];
  packageManifest: string | null;
  readmeExcerpt: string | null;
  testDirs: string[];
  entryHints: string[];
  sampledFiles: string[];
}

export interface SpecIssue {
  severity: "error" | "warning" | "info";
  checker: string;
  message: string;
  file?: string;
}

export interface VerifyReport {
  passed: boolean;
  checked: number;
  issues: SpecIssue[];
}

export interface SpecDelta {
  /** Target spec file (workspace-relative), e.g. ".memento/spec/features/auth.md". */
  target: string;
  /** Why this change is needed (from the task). */
  rationale: string;
  /** Full proposed new content for the file (create or replace). */
  content: string;
  /** "create" | "update" */
  action: "create" | "update";
}
