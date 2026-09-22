# Constitution

Non-negotiable rules for this repository. Every change — human or agent — must comply.

## 1. Zero lock-in

- Runtime dependencies are capped at four: `commander`, `jiti`, `picocolors`, `zod`.
- Adding a runtime dependency requires an ADR in `.memento/spec/decisions/` explaining why the standard library or existing dependencies cannot do the job.
- All persistent state is plain files: Markdown specs, JSONL logs, JSON objects. No database, no binary formats.

## 2. Deterministic where it counts

- Command classification (`src/tools/guard.ts`) and spec verification (`src/spec/verify.ts`) never call a model. LLMs make judgments; code makes checks.
- The command classifier is fail-safe: a command that cannot be proven read-only requires approval. Plugins may not weaken this.

## 3. Safety defaults

- Non-interactive sessions deny mutating tool calls unless `--yes` or `autoApprove` is configured.
- The `.git` directory, `node_modules/`, and secret files (`.env*`, `id_rsa`, `id_ed25519`) are never writable through file tools.
- Catastrophic patterns are hard-blocked regardless of approval flags.

## 4. Memory is earned, never assumed

- Lessons enter at confidence 0.35, gain +0.15 when reinforced, lose 0.30 when contradicted, and retire below 0.12.
- Retired lessons stay in the log. Nothing is deleted; recall filters.
- Every confidence change records its evidence.

## 5. Extension is reversible

- Every plugin registration returns a disposer. If a registration cannot be undone, the API is wrong.
- A crashing plugin must not take down the host process; errors surface in `memento doctor`.

## 6. Testing

- `npm run check` (typecheck + tests) must pass before any change is considered done.
- The end-to-end path is tested against a local server speaking the real OpenAI SSE wire format. No test requires network access or API keys.
