# Contributing to Memento

First of all — thank you. A coding agent that *remembers* is only as good as the
community that teaches it. Every contribution counts, from a typo fix to a new
built-in tool.

## Ground rules

- **Tests drive the real code paths.** Prefer tests that exercise behavior over
  tests that assert implementation details. A fake OpenAI server speaking real
  SSE wire format and a real MCP server subprocess already exist in
  `tests/support/` — reuse them.
- **`npm run check` must be green** before you push: typecheck + the full test
  suite (120 tests as of v0.1.0).
- **Deterministic where it counts.** Spec verification, command classification,
  and undo snapshots never call a model. Keep it that way — LLMs do judgment,
  code does checking.
- **Fail-safe by default.** Anything that touches the user's machine (new
  tools, new shell paths, new MCP handling) must default to *deny*, never
  *allow*. Unrecognized means gated.
- **No new runtime dependencies without a fight.** We carry four
  (`commander`, `jiti`, `picocolors`, `zod`) and that is a feature, not an
  accident. If you think you need a fifth, open an issue first and make the
  case.

## Getting set up

```bash
git clone <this repo> && cd memento
npm install
npm run check      # typecheck + tests
npm run build      # dist/cli.js
node dist/cli.js doctor
```

Node ≥ 20.10, no other toolchain required.

## Project map

```
src/
├── kernel/     agent loop, session log (JSONL), event bus
├── spec/       scanner, generator, store, deterministic verifiers
├── memory/     lesson store (confidence dynamics), reflection, recall
├── tools/      builtin tools + undo snapshots + guard classifier
├── llm/        provider registry, OpenAI-compat + Anthropic adapters, SSE
├── plugins/    jiti loader, capability seams, disposer management
├── mcp/        stdio wire layer, memory server, client bridge
├── git/        diff-aware commit message suggestions
├── web/        zero-dependency workbench UI + local JSON API
└── cli/        commander wiring, ui, workspace assembly
```

Architecture notes:

- **The event bus is the seam.** The terminal UI renders the kernel's event
  stream; swapping the renderer never changes agent behavior. Keep UI out of
  kernel logic.
- **Tools are data.** A tool is `{ name, description, schema, execute }` and a
  `mutating` flag. New tools land in `src/tools/builtin/` and register in
  `index.ts`.
- **Lessons are append-only.** Never edit `lessons.jsonl` history in place;
  every change is a new line (upsert/retire op), so the audit trail survives.
- **Everything a session does is logged.** If your feature changes agent
  behavior, extend the JSONL session log and the workbench UI together, or the
  audit trail lies.

## Adding a built-in tool

1. Create it in `src/tools/builtin/` following the shape in `files.ts`.
2. Mark `mutating: true` if it writes anything anywhere.
3. Register it in `src/tools/builtin/index.ts`.
4. Add tests that run the tool for real in a temp dir — not mocks.
5. If it can be abused, extend the guard classifier (fail-safe).

## Testing

```bash
npm test                          # full suite
npx vitest run tests/e2e.test.ts  # just the end-to-end loop
```

The test suite exercises: the full SDD loop against a fake OpenAI wire-format
server, git tools against real `git init` repos, undo snapshots, the MCP wire
layer against a real subprocess, plugin loading, the confidence dynamics, and
the guard classifier.

## Commit messages

Conventional commits, one line under 72 chars (`feat:`, `fix:`, `refactor:`,
`test:`, `docs:`, `chore:`). Fun fact: `memento run` will suggest one for you —
it reads the diff it just produced. It will not commit it for you, and neither
should a PR hide unrelated changes in one commit.

## Pull requests

1. Keep them small and focused — one idea per PR.
2. Reference the issue it closes (`Closes #123`).
3. Include the test that would have caught the bug / proves the feature.
4. Screenshots welcome for anything touching `src/web/`.

## Code of conduct

Be kind. Assume good faith. Agents learn from us — including how we treat
each other.
