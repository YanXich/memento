# 0001 — Confidence dynamics for lesson memory

**Status:** accepted
**Date:** 2026-09

## Context

Memento extracts lessons from every session and injects the most relevant ones into future sessions. A naive store (append and retrieve) has two failure modes:

1. Hallucinated "lessons" from a confused model get equal weight with hard-won, verified knowledge.
2. Erroneous lessons accumulate forever with no path to correction, poisoning recall.

We need a memory model where **being wrong is recoverable** and **being right is rewarded**, with no hidden state a user cannot inspect.

## Decision

Lessons are immutable records in `.memento/memory/lessons.jsonl` with a confidence score and explicit dynamics:

| Event | Delta | Notes |
| --- | --- | --- |
| New lesson | starts at 0.35 | below neutral; unproven |
| Reinforced | +0.15 | repetition is evidence; capped at 1.0 |
| Contradicted | −0.30 | falsification outweighs confirmation |
| Below 0.12 | retired | excluded from recall, never deleted |

Notable consequence: a fresh lesson (0.35) dies on its **first** contradiction (0.35 − 0.30 = 0.05 < 0.12), while a reinforced one (0.50) survives one contradiction (→ 0.20) and dies on the second. First impressions get no benefit of the doubt; proven regularities get one.

Every transition is appended as an event with an `evidence` field. Recall filters out retired lessons and ranks the rest by term overlap + recency + confidence.

## Alternatives considered

- **Store/delete** — no evidence threshold, no correction path. Rejected: it makes the agent worse over time when the model hallucinates.
- **LLM-judge on every recall** — non-deterministic, slow, and unauditable. Rejected: verification must be legible arithmetic.
- **Time decay on top of confidence** — adds a second dynamics that interacts confusingly (stale-but-true vs. fresh-but-untested). Rejected for now; recency is only a ranking signal, not a confidence input.

## Consequences

- Positive: wrong lessons self-heal within one or two contradicting observations; right lessons become effectively permanent; the entire state is a human-readable JSONL a user can `--reinforce` or `--contradict` by hand.
- Negative: the model must correctly classify `reinforce` vs `contradict` during reflection; a systematically over-confident reflector can still retire good lessons. Mitigation: reflection is instructed to prefer `new` when uncertain, and all events carry evidence for auditing.
- The constants (0.35 / 0.15 / 0.30 / 0.12) are deliberately part of the public contract, covered by tests, and documented in the README — changing them is a two-event change, not a silent tuning.
