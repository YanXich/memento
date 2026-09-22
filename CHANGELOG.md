# Changelog

All notable changes to memento are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project versions with
[SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `memento bench tasks.json -C dir` now resolves the tasks file against the
  workspace root, not the shell cwd.
- `memento doctor` no longer reports "everything checks out" while no provider is
  set (the agent cannot start) — a missing provider is counted as a problem, and
  the doctor exits 1.
- npm tarball no longer drops `examples/starter-template/.gitignore` (npm strips
  dotfiles): the template ships a `gitignore` file to rename after copy, and the
  npm package now includes `examples/` so its README links resolve.
- Session logs now carry an exclusive writer lock (`<session>.lock`): `memento
  resume` (and `chat --session`) refuse to append to a session a live process is
  still writing, so two seq counters can never interleave. Locks left by crashed
  processes are stolen after a pid-liveness check; reads never take the lock.
- `GET /api/sessions/` (empty id) answered with the first session by accident —
  it now 404s. Malformed percent-encoding in a session id answers 400 instead of
  500. The workbench page now sends `X-Frame-Options: DENY`, `nosniff` and
  `Referrer-Policy: no-referrer`.
- One-shot completions (reflection, spec generation) now retry transient
  failures (429/5xx/mid-stream drops) once with a short backoff — previously a
  blipped gateway silently cost the session its lesson. The agent loop's retry
  now backs off 700ms instead of re-hitting a warm 429 instantly.
- The repo map's file walk no longer stops at 2,000 entries before filtering:
  large repos full of assets/docs can no longer starve source files out of the
  map. Source reads stay bounded (3× the selection cap) so monster monorepos
  remain cheap.
- `tools.files` grep refuses pathological regexes (nested quantifiers such as
  `(a+)+`) and over-long patterns before they can hang the process, and
  `find_loose` no longer lets whitespace matches cross newlines, which silently
  widened replacement regions.
- `read` detects binary files (NUL byte) and fails cleanly instead of dumping
  them into context.
- `grep`/`glob`/`walk` skip `.memento/` and `.demo/` so the agent never reads
  its own memories or demo data as project source; secret-file protection now
  catches `.env*` variants, `*.pem`/`*.key`, and bare `id_rsa`/`id_ed25519`/
  `id_dsa`/`id_ecdsa` keys.
- `subagent` reports a clean tool error instead of leaking an exception when
  its session log cannot be created (e.g. a stale `.memento` file).
- Lesson store hardening: `compact` could lose appends written during the
  rename window and concurrent processes could interleave read-modify-write
  on `lessons.jsonl` (lost `reinforce`/`contradict` updates). Both now run
  under a cross-process file lock shared with the session writer; on Windows
  the rename retries through EPERM.
- OpenAI-compatible gateways (DeepSeek/Qwen) that fragment tool-call names,
  send call ids late, or emit argument-less calls no longer produce unnamed
  or dropped tool calls: the parser aggregates name fragments, defers the
  start event until the first arguments chunk, and flushes argument-less
  calls as empty start/end pairs.
- `spec delta` proposals targeting anything outside `.memento/spec/` (or
  exceeding 20 KB) are rejected before approval — the gate can no longer be
  talked into approving edits to arbitrary project files.

### Added

- `memento init --provider <id>` writes a config stub for any built-in provider
  (deepseek | openai | anthropic | ollama | moonshot) with its first model and a
  provider-aware next-steps hint (local ollama gets "ollama serve" instead of an
  env-var export). Unknown ids are rejected with the built-in list.
- First-run error message for a missing model is now actionable: `memento init`,
  `memento doctor`, or direct `--provider/--model` flags.
- `bench --json` now emits machine-readable `provider`/`model` ids so
  `merge-bench` records real identities instead of "unknown".
- `docs/blog/2026-09-22-memory-benchmark.md` — the launch post: cold/warm
  protocol, reproducible-by-design, and the real-model matrix being filled in.
- `memento init` gained a guided wizard (automatic in a terminal, `--no-interactive`
  to opt out): pick provider → model → auto-approve from menus that show which
  API keys are already in your environment. `memento doctor --fix` repairs the
  mechanically fixable problems (missing provider/config) in place and reports
  what remains manual.
- Leaderboard carries a second deterministic run (starter-template greet family,
  from a real `bench --dry` execution).
- `src/util/lock.ts` — a shared cross-process file lock powering both session
  logs and the lesson store, with pid-liveness stale-lock stealing.
- The stream parser emits `toolcall_name_delta` so live tool-call renames
  surface in the workbench UI.

## [0.2.0] — the agent that learns, measured

### Added

- **`memento chat`** — interactive REPL over the same agent loop: one persistent
  session log, per-message memory recall (topics switch cleanly), inline tool
  approvals, one reflection pass at exit that distils the whole conversation into
  memory; `--session <id>` resumes any conversation.
- **Memory benchmark harness** — `memento bench tasks.json` runs a task family cold
  (pristine copy, no memory) vs warm (recalled lessons) and prints the learning
  curve in turns and tokens. `--dry` is a deterministic zero-network provider for
  CI and demos; `--json` feeds automation; `--no-cold` draws the warm curve only.
- **Parallel benchmark schedule** — cold copies fan out over a worker pool
  (`--jobs <n>`) while the warm chain (which must stay sequential — each task
  inherits memory) rides its own worker; parallel and sequential schedules produce
  identical results.
- **`bench --report <path>`** — brand-styled, standalone, no-CDN HTML report with
  the learning-curve chart; commit it to GitHub Pages as-is.
- **Public benchmark leaderboard** — `site/benchmarks/` renders submitted results
  from static JSON; `npm run merge-bench` merges a `--json` run into it. Contributing
  a data point is a PR, nothing else.
- **Memory as code** — `memento memory export` / `import`: commit an export,
  teammates import it into a fresh clone. Idempotent (same id or claim never
  duplicated) with provenance markers on every imported lesson.
- **Subagent explorer** — the built-in `subagent` tool dispatches a read-only
  explorer for one question: it reads/greps the repo in its own mini-loop and
  returns a condensed answer, so long file dumps never bloat the parent context.
  Sub-sessions get their own JSONL transcript linked from the parent log; no
  recursion, no writes.
- **Plugin marketplace** — `memento plugins install owner/repo[#subdir]` (git
  URLs and local paths too) copies a plugin package into `.memento/plugins/`
  with a provenance manifest (source, revision, install time) after listing
  the files and asking once; `plugins list [--json]`, `init`, `remove` round
  it out. The loader gained the package-dir shape (`plugins/<name>/index.ts`).
- **Official starter plugins** — `examples/plugins/`: `todo-guard` (spec
  checker), `session-digest` (lifecycle watcher), `now-tool` (tool
  registration) — each installable straight from this repo.
- **Workbench Plugins tab** — `memento web` gained a Plugins page (`/api/plugins`)
  that inventories installed plugins with provenance (source, revision, install
  time, entry point) from manifests only — plugin code is never executed in the
  browser; a trust banner says honestly when project plugins are installed but
  not loaded, and the overview adds a plugin stat. The inventory shares one
  scanner with the CLI (`scanPluginDir`).
- **Memory evolution visualization** — the web workbench draws a confidence
  sparkline and an event timeline (created/reinforced/contradicted/retired) for
  every lesson; `?evol` deep-links to it.
- **Branded landing page** — animated terminal demo, cold-vs-warm learning-curve
  chart, chat showcase, OG/Twitter cards; static, CDN-free, GitHub Pages ready.
- **Release pipeline** — GitHub Actions: CI matrix (2 OS x 2 Node versions,
  typecheck + tests), then a build job that smoke-tests the shipped bundle
  (CLI boot, plugin inventory, full-loop demo, memory-log concurrency, dry
  bench sequential + parallel); tags publish to npm with provenance. README
  badges for CI and npm.

### Fixed

- **M8** — ToolContext `progress`/`approve` were dead channels inside tools; wired
  to the real event bus and approval loop (subagent progress forwards to the
  parent UI).
- **M12** — the web server re-read sessions on every poll (O(2×N) sync reads);
  replaced with single-pass scanning plus a stamp cache and ETag 304 incremental
  reads.
- **Spec verify dead channel** — `spec verify` never attached plugins, so a
  plugin-registered spec checker silently never ran; it now loads plugins
  asynchronously, and every issue is attributed to its checker automatically.

### Changed

- README restructured around the four-answer positioning (memory / spec / plugins /
  ecosystem-native), with a full CLI table and the security model.
- Landmark test suite grew to **145 tests**: safety regressions, parallel timing,
  MCP dual channel, git/undo, commit hints, resume, chat REPL, memory evolution,
  the parallel bench schedule and the plugin marketplace.

## [0.1.0] — the coding agent that remembers

Initial release.

### Added

- **SDD loop** — RECALL → GATE → BUILD → VERIFY → REFLECT with a deterministic
  spec checker (never calls the LLM) and confidence-weighted memory: +0.15 on
  confirmation, −0.30 on contradiction, retired below 0.12.
- **Durable lessons** — `lessons.jsonl` with O_APPEND single-line atomic writes;
  recall into the system prompt is term-overlap matched.
- **Session log invariant** — everything the model saw is what the log recorded
  (JSONL transcripts); `memento sessions` / `show` / `resume` inspect and continue
  interrupted runs with full transcript replay into the same log.
- **Plugin system** — lifecycle hooks with a tightened API surface (a
  `BeforeLlmPatch` may only edit the system text — it cannot forge message roles).
- **Event bus** — snapshot semantics, exception isolation, circuit breaking.
- **Parallel tool batches** — consecutive read-only tools run in parallel, writes
  stay ordered.
- **MCP client** — stdio transport over a hand-written JSON-RPC 2.0 wire layer;
  trust model: user-level config only unless `trustProjectMcp: true`.
- **`memento serve-mcp`** — expose lessons to other agents
  (`search_lessons` / `add_lesson` / `memory_stats`).
- **Safety rails** — request timeout with one retry (429/5xx/mid-stream), CJK
  token estimation, shell timeout/orphan-process kill (Windows `taskkill /T`,
  POSIX process-group kill), output truncation in O(1) per chunk, approval
  abort signals.
