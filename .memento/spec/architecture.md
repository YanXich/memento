# Architecture

How Memento is put together, and why. Kept deliberately small: one package, no build-time code generation, four runtime dependencies.

## Layers

```
cli/          commander wiring only — every command body is a testable function
  └─ workspace.ts assembles config + providers + spec + memory + plugins + tools
kernel/       the agent loop
  ├─ loop.ts     two-layer loop: agent turns → tool batch execution
  ├─ session.ts  append-only JSONL transcript (header/message/usage/note/result)
  └─ events.ts   typed event bus every layer can publish to
spec/         the SDD engine
  ├─ scanner.ts    deterministic repo scan (no LLM)
  ├─ generator.ts  drafts constitution/architecture/features from the scan
  ├─ store.ts      reads/writes `.memento/spec/` as plain Markdown
  ├─ recall.ts     picks spec sections relevant to a task (term overlap + budget)
  └─ verify.ts     deterministic checkers: paths, commands, placeholders
memory/       the self-improvement engine
  ├─ store.ts   lessons.jsonl with confidence dynamics (0.35 / +0.15 / −0.30 / <0.12)
  ├─ reflect.ts post-session pass: transcript → lesson candidates → store ops
  └─ recall.ts  relevance-ranked lesson selection for the system prompt
tools/
  ├─ schema.ts  tool definition helpers
  ├─ guard.ts   fail-safe command classifier: dangerous | mutating | read-only
  └─ builtin/   read, write, edit, ls, grep, glob, bash
llm/
  ├─ registry.ts provider presets (deepseek, openai, anthropic, ollama, moonshot)
  ├─ openai.ts   OpenAI-compatible adapter (streaming SSE, tool calls)
  ├─ anthropic.ts Anthropic Messages adapter
  └─ sse.ts      minimal SSE parser, no dependency
plugins/
  ├─ api.ts    capability seams: tools.register, events.on, spec.registerChecker — all return disposers
  └─ loader.ts jiti-based `.ts` plugin loading with per-plugin isolation
```

## The loop, precisely

One task runs: **recall → spec gate → build → verify → reflect**.

1. **Recall** (`src/spec/recall.ts`, `src/memory/recall.ts`): term-overlap ranking picks spec sections and lessons under a character budget. Injected into the system prompt.
2. **Spec gate**: if the task conflicts with the constitution or an accepted decision, the conflict is surfaced *before* any tool runs (`--spec-gate ask|auto|off`).
3. **Build** (`src/kernel/loop.ts`): the model streams completions; tool calls execute in batches. Every message is appended to the session JSONL as it happens.
4. **Verify** (`src/spec/verify.ts`): deterministic checkers re-run against the tree; failures are reported, not silently accepted.
5. **Reflect** (`src/memory/reflect.ts`): a second model pass reads the transcript and emits lesson candidates with relations (`new` / `reinforce` / `contradict`). The store applies the confidence arithmetic.

## Invariants

- **The session log is append-only.** Crash safety and auditability come from never mutating history.
- **Tools receive an explicit `cwd`.** The workspace root is threaded through `LoopOptions.cwd`; tools never reach for `process.cwd()` themselves.
- **Registration is reversible.** Every plugin seam returns a disposer; unloading restores the previous registry state exactly.
- **Guards are conservative.** `classifyCommand` gates anything it cannot prove read-only; destructive patterns are refused outright.
- **Recall has a budget.** Both spec and memory recall truncate deterministically; a task never blows the context window on recall alone.

## Provider abstraction

`src/llm/types.ts` defines the provider contract (streaming events, tool-call deltas, usage). The registry resolves `provider → config → models`, with credentials read from environment variables only — never stored in config files. Any OpenAI-compatible endpoint can be declared in `.memento/config.json` without code.

## Testing strategy

- Unit tests per module (`tests/kernel.test.ts`, `memory`, `spec`, `plugins`).
- End-to-end tests (`tests/e2e.test.ts`) run the full closed loop against `tests/support/fake-openai.ts` — a real HTTP server speaking the actual OpenAI SSE wire format, so streaming, tool calls, and reflection are exercised without network access.
- The CLI is smoke-tested as a real process against the same fake server.
