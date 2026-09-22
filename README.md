# ◈ Memento

**A coding agent that remembers what it learns, and keeps its specs honest.**

[English](README.md) | [中文](README.zh-CN.md)

Memento is a spec-driven coding agent for the terminal. Every session ends with a reflection pass that turns what happened into *lessons* — stored with confidence scores that rise when evidence confirms them and fall when reality contradicts them. Every task starts by recalling the spec and the lessons that matter, so the agent gets measurably better at *your* codebase over time.

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20.10-brightgreen.svg" />
  <img alt="dependencies" src="https://img.shields.io/badge/runtime%20deps-4-success.svg" />
  <img alt="tests" src="https://img.shields.io/badge/tests-118%20passing-success.svg" />
</p>

```console
$ memento run "add rate limiting to the login endpoint"

◈ memento v0.1.0 · deepseek/deepseek-chat · ~/work/api
task: add rate limiting to the login endpoint
▸ recalled 2 lesson(s) from memory
▸ indexing repository
▸ building

◈ agent started · model deepseek-chat
⏺ read(src/auth/login.ts)  read(src/middleware/index.ts)
── turn 2 ──
⏺ write(src/middleware/rate-limit.ts)  edit(src/auth/login.ts)
⏺ bash(npm test)
  120 passed
◈ agent finished: done

▸ reflecting on the session (self-improvement pass)
  +1 new lesson · [pattern] Login routes chain through middleware/index.ts
suggested commit feat: rate-limit the login endpoint
  (memento never commits for you — paste this into git commit -m)

◈ session s_h8x2kd91mf · done · 3 turn(s) · 8.2k in / 1.1k out
resume: memento resume s_h8x2kd91mf · replay: memento show s_h8x2kd91mf
```

---

## Why another coding agent?

Most terminal agents are brilliant and amnesiac. You configure one, it works well, and then:

- **It forgets.** Every session starts from zero. The convention you explained yesterday, the pitfall it hit last week — gone.
- **Specs rot.** Docs drift away from code until nobody trusts them. A spec that can't be verified is a wish.
- **Extension is a commitment.** Plugins need a build step, a manifest, a version matrix. So people don't write them.
- **Ecosystems are bolted on.** MCP support usually means another config file, another process, another trust question.

Memento is built around four answers.

### 1. Memory with a spine: confidence-weighted lessons

Reflection is not a chat log. After each session the agent extracts **lessons** — constraints, patterns, failures, preferences, discoveries — and stores them in `.memento/memory/lessons.jsonl`, a plain-text, auditable file.

Every lesson carries a confidence score with real dynamics:

| Event | Effect | Rationale |
| --- | --- | --- |
| New lesson | confidence `0.35` | Unproven until something confirms it |
| Reinforced (seen again, confirmed) | `+0.15` | Repetition is evidence |
| Contradicted (reality disagreed) | `−0.30` | Falsification weighs more than confirmation |
| Confidence `< 0.12` | retired | Kept in the log, out of the recall pool |

A fresh lesson dies on its first contradiction (`0.35 − 0.30 = 0.05`). A lesson that earned its stripes once survives one conflict, and only dies on the second. This is deliberate: **wrong memories are worse than no memories**, so disproof outweighs proof. Nothing is deleted — retired lessons stay in the log for auditing.

Recall is relevance-ranked (term overlap with the task + recency + confidence), and only the top lessons are injected into the system prompt. The agent doesn't drown in its own history.

### 2. A spec that answers back

`memento spec init` scans your repository and drafts:

```
.memento/spec/
├── constitution.md      # non-negotiable project rules
├── architecture.md      # how the system is put together
├── features/*.md        # per-feature behavior contracts
└── decisions/NNNN-*.md  # architecture decision records (ADRs)
```

Plain Markdown. Diffable in git. No database.

The difference is `memento spec verify`: **deterministic checkers** (no LLM involved) compare the spec's claims against the actual tree —

- every repo path mentioned in backticks must exist,
- every `npm run x` mentioned must exist in `package.json`,
- unresolved `TODO`/`TBD` markers are surfaced.

Before a task runs, the **spec gate** recalls the relevant spec sections and asks: does this task conflict with the constitution or an accepted decision? You answer once, and the decision is recorded. After the session, verification runs again. The spec is consulted on the way in and checked on the way out — that is what keeps it alive.

### 3. Plugins in ten lines, unloaded cleanly

Drop a `.ts` file into `.memento/plugins/` — no build step, no manifest, no publish. The agent loads it at startup via [jiti](https://github.com/unjs/jiti).

```ts
// .memento/plugins/changelog.ts
import type { MementoPlugin } from "memento-agent";

export default {
  name: "changelog",
  register(api) {
    api.tools.register({
      name: "changelog_add",
      description: "Append a line to CHANGELOG.md",
      parameters: { line: { type: "string", description: "entry text", required: true } },
      async execute({ line }, ctx) { /* ... */ },
    });
    const off = api.events.on("session_end", (e) => console.log("bye", e.sessionId));
    return () => off(); // dispose — registration is reversible
  },
} satisfies MementoPlugin;
```

Every `register` call returns a **disposer**. Unloading a plugin reverses every registration it made — tools, event listeners, spec checkers. Plugins are guests, not residents.

### 4. Ecosystem native: MCP, git, undo, commit hints

Memento speaks the ecosystem's language, in both directions:

- **MCP server** — `memento serve-mcp` exposes your agent's memory to *other* tools. Claude Desktop, Cursor, goose — any MCP client can search `lessons`, add them, and read memory stats over stdio. Your agent's hard-won knowledge stops being locked in a terminal.
- **MCP client** — declare external MCP servers in `~/.memento/config.json` and their tools are bridged into the session as `mcp_<server>_<tool>`. Project-level declarations only load when you set `trustProjectMcp: true` — a repo you `git clone` cannot silently spawn processes on your machine.
- **git, built in** — the agent navigates repo state through read-only `git_status` / `git_diff` / `git_log` tools instead of guessing. After the loop, memento reads the working diff (tracked **and** untracked files) and suggests a conventional commit message. It never runs `git commit` — history stays yours.
- **Undo** — every `write` / `edit` / `apply_patch` snapshots the previous state to `.memento/undo/`. `memento undo` rolls back the last write batch, step by step. Crash containment for the file system.
- **Plan first** — `memento plan` drafts a Plan/Act split before touching anything. Approve the plan, and the agent executes it step by step; decline, and nothing changes.
- **Resume** — `memento resume s_…` continues an interrupted run: the exact transcript is replayed into the model and the loop goes on in the SAME session log, so the audit trail stays one story (verify → reflect → commit hint run again).
- **Benchmark** — `memento bench tasks.json` runs a family of tasks cold (pristine copy, no memory) vs warm (recalled lessons) and prints the learning curve: turns and tokens saved as lessons accumulate. `--dry` swaps in a deterministic zero-network provider, so the memory effect is measurable in CI and demos.

---

## Quick start

```bash
# Requires Node ≥ 20.10
npm install -g memento-agent

# In your repository:
cd your-project
memento init                 # scaffold .memento/
export DEEPSEEK_API_KEY=…    # or OPENAI_API_KEY / ANTHROPIC_API_KEY
memento spec init            # scan the repo, draft constitution + architecture
memento doctor               # verify the wiring
memento run "explain how auth works, then add a /healthz route"
```

Prefer to hack on it?

```bash
git clone <this repo> && cd memento
npm install
npm run check      # typecheck + 118 tests
npm run build      # dist/cli.js, ~160 KB
node dist/cli.js run "…"
```

---

## How a task flows

```
recall ──► spec gate ──► build ──► verify ──► reflect ──► commit hint
  │           │            │          │          │            │
  │           │            │          │          │            └─ diff-aware conventional message (never commits)
  │           │            │          │          └─ extract lessons, update confidence
  │           │            │          └─ deterministic spec checkers run again
  │           │            └─ agent loop: tools execute, every step logged to JSONL
  │           └─ constitutional conflicts surface before any file is touched
  └─ relevant spec sections + top-ranked lessons enter the system prompt
```

Every session is recorded as a JSONL transcript under `.memento/sessions/` — one line per turn, fully replayable:

```bash
memento sessions              # list
memento show s_h8x2kd91mf     # transcript (any unique prefix works)
```

The transcript is the audit trail: what the agent read, wrote, ran, and *why it believes what it now believes*.

---

## Security model

A coding agent runs commands on your machine. Memento's defaults are conservative:

- **Read-only commands run directly.** `ls`, `cat`, `grep`, `git status`, `npm test` — recognized by a fail-safe classifier, executed without interruption.
- **Everything else requires approval.** Writes, redirections (`>`), `sed -i`, package installs, `git commit` — anything not provably read-only is gated. The classifier is fail-safe: unrecognized means gated, not allowed.
- **Non-interactive sessions deny by default.** No TTY means no accidental `--yes`-less mutation.
- **Protected paths.** `.git/`, `node_modules/` and secrets (`.env*`, `id_rsa`, `id_ed25519`) are off-limits to the file tools.
- **Catastrophic patterns are hard-blocked** regardless of approvals: `rm -rf /`, fork bombs, disk writes, credential exfiltration shapes.
- **MCP trust is opt-in.** MCP servers load from your user config (`~/.memento/config.json`), never from a cloned repo — unless you explicitly set `trustProjectMcp: true`. Bridged tools that mutate go through approval and serialize with other writes, same as built-ins.

```jsonc
// .memento/config.json — opt in to auto-approval, per tool
{ "provider": "deepseek", "model": "deepseek-chat", "autoApprove": ["write", "edit"] }
```

---

## CLI reference

| Command | Purpose |
| --- | --- |
| `memento run <task>` | one task through the full loop (`--spec-gate ask\|auto\|off`, `-y`, `--max-turns`, `--no-reflect`, `--no-commit-hint`) |
| `memento plan <task>` | draft a Plan/Act split for review before anything is executed (`-y` approves and runs it) |
| `memento undo` | roll back the last write batch (write/edit/apply_patch snapshots) |
| `memento init` | scaffold `.memento/` |
| `memento doctor` | diagnose runtime / config / providers / spec / memory / plugins |
| `memento spec init` | scan repo, draft constitution + architecture + feature overview (`--scan-only` for the deterministic scan alone) |
| `memento spec verify` | run deterministic checkers against the tree (`--json`) |
| `memento spec status` / `spec show [file]` | what the spec says, when it changed |
| `memento spec decision <title>` | record an ADR stub |
| `memento lessons` | list lessons (`--all`, `--json`), `--reinforce <id>`, `--contradict <id>`, `--retire <id>` |
| `memento remember <text>` | record a lesson by hand — it joins the same confidence machinery |
| `memento sessions` / `show <id>` / `resume <id>` | session history, transcripts, and interruption recovery (any unique prefix works) |
| `memento bench <tasks.json>` | cold vs warm runs over a task family — the memory effect, measured (`--dry`, `--json`, `--no-cold`, `--keep`) |
| `memento serve-mcp` | expose memory as an MCP server over stdio (search/add lessons, stats) — for Claude Desktop, Cursor, goose… |
| `memento web` | open the read-only workbench — spec, memory, and sessions in a browser (`--port`, `--no-open`) |

All commands accept `-C <dir>` to point at a workspace root.

---

## Providers

Built-in presets: **deepseek**, **openai**, **anthropic**, **ollama**, **moonshot** — selected by `--provider` or config, credentials from the standard env vars (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, …). Any OpenAI-compatible endpoint can be declared explicitly:

```jsonc
// .memento/config.json
{
  "provider": "local",
  "model": "qwen2.5-coder",
  "providers": [
    { "id": "local", "type": "openai-compat",
      "baseUrl": "http://localhost:11434/v1",
      "apiKeyEnv": "OLLAMA_API_KEY",
      "models": [{ "id": "qwen2.5-coder", "contextWindow": 32000, "maxOutput": 4000, "supportsTools": true }] }
  ]
}
```

---

## Design principles

- **Zero lock-in.** Four runtime dependencies (`commander`, `jiti`, `picocolors`, `zod`). Plain files everywhere: Markdown specs, JSONL sessions, JSON config. Every artifact survives the tool.
- **Deterministic where it counts.** Spec verification and command classification never call a model. LLMs do judgment; code does checking.
- **Fail-safe by default.** Unrecognized commands are gated; non-interactive mutations are denied; protected paths stay protected; MCP servers need explicit trust.
- **Auditable memory.** Confidence isn't a vibe — it's arithmetic you can read, and every change carries the evidence that caused it.
- **Reversible extension.** Every registration returns a disposer. `memento doctor` shows exactly what each plugin contributed.

**Non-goals:** chat UI, multi-agent orchestration, a hosted service. Memento is a composable engine and a CLI. The `memento-agent` package also exports its full API (kernel, spec, memory, plugins) if you want to embed it.

---

## Project layout

```
src/
├── kernel/     agent loop, session log (JSONL), event bus
├── spec/       scanner, generator, store, deterministic verifiers
├── memory/     lesson store (confidence dynamics), reflection, recall
├── tools/      builtin tools (read/write/edit/ls/grep/glob/bash/git) + undo snapshots + guard classifier
├── llm/        provider registry, OpenAI-compat + Anthropic adapters, SSE parsing
├── plugins/    jiti loader, capability seams, disposer management
├── mcp/        stdio wire layer + memory server (serve-mcp) + client bridge
├── git/        diff-aware commit message suggestions
├── web/        zero-dependency workbench UI + local JSON API
└── cli/        commander wiring, ui, workspace assembly
```

Contributing: `npm run check` must be green (typecheck + tests). Tests drive the real code paths — including a fake OpenAI server speaking real SSE wire format and a real MCP server subprocess, so the full loop (model → tool execution → session log → reflection) is exercised end-to-end without network access.

---

## Credits

Memento stands on two projects we studied, ran, and learned from:

- **[pi](https://github.com/earendil-works/pi)** — for the conviction that an agent kernel can be small and legible: a two-layer loop, truncation safety valves, JSONL session logs, and plugins loaded straight from TypeScript.
- **[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** — for the discipline of capability seams: registrations that return disposers, plugin isolation, and monotonic guards that survive extension.

What Memento adds on top is the closed loop: **specs that are verified, and memory that is earned**. See [docs/COMPARISON.md](docs/COMPARISON.md) for the full honest comparison.

## License

MIT — see [LICENSE](LICENSE).
