# Feature: self-improvement loop

**Status:** accepted
**Owners:** maintainers

## Contract

After every `memento run` session (unless `--no-reflect`), the agent extracts lessons from the transcript and applies them to the confidence-weighted memory store. Before every session, relevant lessons are recalled into the system prompt. The loop is closed: what happened in one session affects how the next session behaves.

## Behavior

### Reflection (session end)

- A separate model pass reads the session transcript and emits lesson candidates.
- Each candidate carries: `text`, `kind` (`constraint` | `pattern` | `failure` | `preference` | `discovery`), `evidence`, and `relation` (`new` | `reinforce` | `contradict`).
- Reflection is best-effort: a failed reflection must never fail the session. Failures are reported as a note in the session log and surfaced in `memento doctor`.

### Confidence dynamics

- `new` → confidence 0.35
- `reinforce` → +0.15 (capped at 1.0)
- `contradict` → −0.30
- Below 0.12 → retired (kept in the log, excluded from recall)
- Every transition appends an event line to `.memento/memory/lessons.jsonl` with its evidence.

### Recall (session start)

- Ranking = term overlap with the task + recency + confidence.
- Only lessons above the relevance floor enter the prompt; the injected text respects a character budget.
- Retired lessons never enter recall.

### Manual control

- `memento remember <text>` — inject a lesson by hand.
- `memento lessons --reinforce|--contradict|--retire <id>` — adjust a lesson with evidence.

## Acceptance

- [x] e2e test: a session that writes a file produces an upserted lesson with kind `discovery` and confidence in (0, 0.5).
- [x] Once contradicted, a fresh lesson (0.35) retires immediately: 0.35 − 0.30 < 0.12.
- [x] A reinforced lesson (0.50) survives one contradiction (→ 0.20) and retires on the second.
- [x] Recall ranks by relevance: a lesson about "session cookies" outranks a general one for a cookie-related task.
- [x] Retired lessons remain readable via `memento lessons --all` and never appear in recall.

## Non-goals

- Cross-project memory sharing (memory is per-workspace, in-repo, and committed intentionally).
- Automatic editing of spec files from reflection (reflection may *suggest* spec changes; humans and the spec gate decide).
