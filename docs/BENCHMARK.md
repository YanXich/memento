# The Memory Benchmark

> The benchmark only memento can produce: **does an agent get measurably cheaper as it learns?**
> Every other coding agent forgets between sessions, so "memory" is marketing there. Memento's
> lessons are a hard feature — and hard features deserve numbers.

Live leaderboard: [`site/benchmarks/`](https://github.com/earendil-works/memento/tree/main/site/benchmarks) (GitHub Pages: `/benchmarks/`). Sample report: [`demo.html`](../site/benchmarks/demo.html).

---

## What it measures

Run a family of *similar* tasks twice:

| run | memory | meaning |
| --- | --- | --- |
| **cold** | none — pristine copy of the repo, recall and reflection disabled | the memoryless baseline: what any agent costs |
| **warm** | everything earlier tasks taught, recalled into the system prompt; reflection on afterwards | what memento actually costs |

The delta between the two curves — in **turns** and **input tokens** — is the product thesis
with numbers. Lessons accumulate across the warm run; the benchmark draws the learning curve:
the first task pays the discovery cost, every later task in the family reuses it.

## Why it's honest

1. **Cold runs are quarantined.** Each cold run gets a fresh copy of the repo and runs with
   recall/reflection disabled, so it can never see warm-run memory.
2. **Dry mode is deterministic.** `--dry` swaps in a scripted provider (zero network): identical
   results on every machine, so the harness itself runs in CI and demos reproducibly.
3. **Real-model runs record their configuration.** Provider, model, task family and the `dry` flag
   travel with every submitted entry — no magic numbers.

## Run it

```sh
# deterministic, zero network — great for CI and a first taste
memento bench tasks.json --dry

# real model (uses your configured provider, or pass --provider/--model)
memento bench tasks.json

# machine-readable output (feeds the leaderboard merge script)
memento bench tasks.json --json > bench-out.json

# shareable standalone HTML report (brand-styled, no CDN)
memento bench tasks.json --report bench-report.html

# parallel schedule: cold copies fan out over a worker pool, the warm
# chain (which must stay sequential — each task inherits memory) rides
# its own worker; --jobs 1 restores the fully sequential schedule
memento bench tasks.json --jobs 4
```

`tasks.json` is a family of similar tasks — the more alike, the steeper the learning curve:

```json
{ "tasks": [
  { "name": "add rate limiting",  "task": "Add per-route rate limiting to the API" },
  { "name": "add idempotency",    "task": "Add idempotency keys to the API" },
  { "name": "add request logging","task": "Add structured request logging to the API" }
] }
```

Output is a cold/warm comparison table plus the warm learning curve, ending with the headline:
*"memory reduced turns by N% from the first to the last task"*.

## Submit a run to the leaderboard

The leaderboard is static JSON — contributing is a PR, nothing else:

```sh
memento bench tasks.json --json > bench-out.json
node scripts/merge-bench.mjs bench-out.json your-handle --report benchmarks/your-report.html
```

Then open a PR with `site/benchmarks/results.json` (and the report file if you generated one).
Re-running with the same submitter + provider + model + task family replaces your previous entry —
refreshed numbers, no duplicates.

## The number to watch

`tokensSavedPct` across the warm curve. A single-family run will typically show 40–60% once the
first task has taught the others — but the *compound* effect (families learning across weeks of
real work) is the honest long-term claim, and it only shows up when the same repo keeps its
`.memento/` directory. That's the point: **memory compounds where other agents restart.**
