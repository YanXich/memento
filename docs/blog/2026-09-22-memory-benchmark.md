# Measuring memory: a benchmark for agents that learn

> Draft post — the numbers below are deterministic dry-run demos. The real-model
> matrix is the launch hook: every cell is one `memento bench` command away.

Every coding agent claims to "learn from mistakes". Almost none of them measure
it. **memento** is built around persistent, confidence-weighted memory, so it
needs a benchmark that answers one question with numbers:

> Given the same family of tasks, how much cheaper does the second one get?

That question is testable, reproducible, and — because tokens cost money —
immediately interesting to anyone who runs an agent.

## The cold/warm protocol

A memory benchmark is not a pass/fail scorecard. It is a paired experiment:

1. **Cold** — a pristine copy of the project with **zero memory**. The agent
   solves the task exactly as a fresh install would: re-reading docs, re-finding
   the right file, re-making the mistakes.
2. **Warm** — the same agent, the same task, **with its accumulated lessons**
   recalled from previous sessions in the same project.
3. **Saved** — the relative drop in turns and input tokens between cold and warm.

One family of tasks, two runs, one number per axis:

```
turnsSavedPct  = (coldTurns  − warmTurns)  / coldTurns
tokensSavedPct = (coldTokens − warmTokens) / coldTokens
```

The unit of measure is *the same agent doing the same kind of work*, which is
exactly the claim memory makes: not "we are smarter", but "**we do not pay twice
for the same lesson**".

## Reproducible by design

Benchmarks nobody can rerun are marketing, not science. So the harness is
deterministic end to end:

- `memento bench tasks.json` runs a *family* of similar tasks (e.g. "implement
  greet", "implement bye in the same style", "implement hello-again in the same
  style") so the warm curve shows **accumulation**, not a single lucky recall.
- `--dry` swaps in a scripted zero-network provider. No API key, no flakiness —
  the whole pipeline is exercised and the demo numbers below are exactly
  reproducible by anyone in CI or on a laptop.
- `--jobs N` fans the independent cold copies out over a worker pool; the warm
  chain stays strictly serial because each task inherits the previous one's
  memory. Same results as sequential, in parallel.
- `--json` + `scripts/merge-bench.mjs` append your run to the
  [leaderboard](https://github.com/memento-agent/memento/tree/main/site/benchmarks)
  in one command. Same submitter+model+family re-submits as an update.

## Demo numbers (deterministic dry-run)

| Task family | Cold | Warm | Turns saved | Tokens saved |
| --- | --- | --- | --- | --- |
| web-api hardening (rate-limit, idempotency, logging, cors, cache) | 2 turns / 2500 tok per task | 1–2 turns / 1400–2500 tok | **−50%** | **−44%** |
| starter-template greet family (greet, bye, hello-again) | 2 turns / 2500 tok per task | 1–2 turns / 1400–2500 tok | **−33%** | **−29%** |

These are mock-provider runs, clearly labeled as such on the leaderboard — they
exist to prove the pipeline and set the shape of the table, not to claim real
savings.

## The real matrix (the launch hook)

The interesting table is real models on real task families. Every cell is one
command on a machine with an API key:

```bash
memento bench tasks.json --provider deepseek --model deepseek-chat
memento bench tasks.json --provider deepseek --model deepseek-reasoner
memento bench tasks.json --provider openai --model gpt-4o-mini
memento bench tasks.json --provider anthropic --model claude-3-5-haiku-20241022
memento bench tasks.json --provider ollama --model qwen3:8b   # local, free
```

| Provider / model | Family | Turns saved | Tokens saved | Submitted by |
| --- | --- | --- | --- | --- |
| _your model here_ | _your family here_ | ? | ? | _you_ |

Two predictions we are testing:

1. **Cheap models benefit more.** Memory substitutes for re-derived context, and
   re-derived context is proportionally more expensive for small models.
2. **Savings compound per family, not per task.** The third task in a family
   should save more than the second — if the curve flattens, retrieval is
   failing and that is a bug we want reported.

## Why this matters

Aider won its mindshare with a leaderboard of *capability*. The open question in
2026 is *economics*: agents are cheap to run once and expensive to run at scale.
A benchmark that measures **the cost of forgetting** is the missing number in
every "should we keep using an agent on this repo" decision.

Run your numbers, open a PR to the leaderboard, and let the curve do the talking.

— the memento team
