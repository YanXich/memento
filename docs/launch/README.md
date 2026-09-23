# Launch plan — memento

> The 100k-star goal is the natural result of developers finding memento
> *useful*. This folder is the execution layer: what to post, where, when,
> and what must be true before each post goes out.

Every claim in every post is backed by an artifact that already exists in the
repo (tests, the benchmark harness, the workbench, the demo). Posts that
promise more than the repo can show are worse than no post: one HN commenter
running the claim into the ground costs more than the launch gains.

---

## 1. Positioning (the one-liner)

**Memento is a coding agent that remembers what it learns — and can prove it
with a benchmark.**

Audience ladder, in order:

1. **People burned by amnesiac agents** — every session restarts from zero,
   they re-explain the same convention, the same pitfall is hit twice. The
   memory pitch lands first.
2. **People who want deterministic guardrails** — spec verification without
   LLMs, approval gates, audit-trail sessions. The trust pitch lands second.
3. **Builders** — MCP dual-channel (client + `serve-mcp`), a plugin API that
   is ten lines, four runtime dependencies. The hackability pitch lands third.

Do not lead with benchmarks. Benchmarks close the deal; memory opens the door.

## 2. What must be true before the first post

- [ ] Repo exists at `github.com/memento-agent/memento`, CI green on the
      default branch (the badge in the README must not show "failing").
- [ ] `v0.3.0` tag pushed; `npm publish --provenance` done; `npm i -g
      memento-agent` works from a clean machine (test once).
- [ ] README renders correctly (badges, demo.svg, anchors); `README.zh-CN.md`
      is in sync (same features, same commands).
- [ ] `npx memento-agent run "..."` (or global install) reaches a *helpful*
      error in under 10 seconds when no API key is set — that is most
      visitors' first run; it must point to `platform.deepseek.com` and
      suggest `memento doctor`.
- [ ] One real-model benchmark run exists (see `docs/blog/2026-09-22-
      memory-benchmark.md`). If it does not yet, the launch post says "the
      harness is deterministic (`--dry`) and open for submissions" — never
      publish dry-run numbers without the dry-run label.
- [ ] `site/` demo page and the workbench (`memento web`) have been opened in
      a real browser once (they are the second impression).
- [ ] Issue templates, CONTRIBUTING, SECURITY exist (they signal "a project,
      not a toy" before anyone asks).

## 3. Launch sequence (one week, one platform per day)

| Day | Platform | Goal | What to post |
| --- | --- | --- | --- |
| 0 | Repo + npm + tag | make "try it" possible | nothing yet — green CI first |
| 1 | Hacker News | awareness + feedback | `posts.md` §HN |
| 2 | r/programming + r/LocalLLaMA | community credibility | `posts.md` §Reddit |
| 3 | Lobsters | engineering audience | `posts.md` §Lobsters |
| 4 | V2EX / 中文技术社区 | CN audience (deepseek/glm/qwen presets are a native fit) | `posts.md` §V2EX |
| 5 | Blog post | long-tail SEO (memory benchmark) | `docs/blog/2026-09-22-memory-benchmark.md` (with real numbers) |
| 7 | Recap + first real benchmark PR | loop back | leaderboard submission guide |

Rules that apply every day:

- **Respond to everything for the first 48 hours.** Launch traffic converts
  on responsiveness, not on votes.
- **Never argue about "yet another coding agent".** The answer is the
  benchmark: "yes, and here is the number memory changes."
- **Do not promise a roadmap.** Promise the next benchmark run.

## 4. The first 48 hours (playbook)

- Watch issues: tag `good-first-issue` immediately; fix trivial bugs the same
  day. A merged PR from a stranger on launch day is the single best signal.
- Watch the npm download graph: a launch-day spike that decays is normal; the
  KPI is the *second* week's floor, not the spike.
- Collect every "I ran it and it did X" comment into a `docs/launch/feedback`
  note — these are the seeds of the next release notes and the next post.

## 5. The 30-day loop

1. One real-model benchmark run per week, merged into
   `site/benchmarks/results.json` (the leaderboard is the compounding asset).
2. One plugin/MCP example per fortnight (`examples/plugins/`, MCP recipes) —
   ecosystem contributions carry their own marketing.
3. One post per fortnight: numbers first, features second.

## 6. What NOT to do

- No "AI is changing the world" framing. Developers smell it instantly.
- No benchmark claims without the dry-run label unless a real run exists.
- No comparison tables against named competitors in the launch posts (save
  comparisons for the docs, where they are factual and dated).
- No paid promotion. If it doesn't spread, the product is not ready — fix the
  product, not the ads.
