# memento-starter

A ready-to-ride project for **memento** — the coding agent that remembers.
Clone it, run one command, and watch the whole loop work: spec gating,
memory learning, and a benchmark that proves both.

```
git clone https://github.com/YanXich/memento.git my-project
cd my-project
memento init          # scaffold .memento/ (if you deleted it)
memento spec show     # read the constitution + feature specs
memento run "implement the sample feature"   # your first session
memento bench tasks.json --dry               # see the harness without an API key
memento web           # watch sessions, memory, spec and plugins in a browser
```

No git yet? The same template ships inside the npm package — `memento new`
scaffolds it without a clone:

```bash
memento new my-project
cd my-project
```

`memento new` restores the template's `.gitignore` (npm strips dotfiles from
packages, so the template stores it as `gitignore`), stamps the project name
into this README, and runs `git init` for you (`--no-git` to skip).

## What is in here

| Path | Purpose |
| --- | --- |
| `.memento/spec/constitution.md` | Rules the agent gates every action against |
| `.memento/spec/features/*.md` | Feature specs — checkable statements, not prose |
| `tasks.json` | A bench task family for measuring the memory effect |
| `README.md` | You are here |

## The first 15 minutes

1. **Install memento**: `npm install -g memento-agent` (or run via `npx`).
2. **Set a provider**: `memento init` writes `.memento/config.json`; point it at
   your provider (deepseek, openai-compatible, anthropic) and put the API key in
   the env var the provider declares (`memento doctor` checks all of this).
3. **Run the sample task**: `memento run "implement the sample feature"`. The
   agent recalls the spec, plans, executes, verifies — then reflects and stores
   lessons.
4. **Watch it learn**: `memento bench tasks.json --dry` draws a cold-vs-warm
   learning curve with a deterministic zero-network provider. Swap `--dry` for a
   real provider to measure your own model.
5. **Look inside**: `memento web` opens the read-only workbench — sessions,
   memory evolution, spec, and installed plugins.

## Growing it

- **Your rules**: extend `.memento/spec/constitution.md`. The agent enforces it
  deterministically on every session (`memento spec verify`).
- **Your plugins**: `memento plugins init my-checker` scaffolds a plugin right
  in this project; `memento plugins install owner/repo` pulls one from GitHub.
- **Team memory**: `memento memory export` commits memory as code — teammates
  `memento memory import` it into a fresh clone.

This directory is the source of the `memento-starter` repository; push it to a
new repo when you want to share your own starter.
