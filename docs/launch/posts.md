# Launch posts

> Ready-to-post copy. Replace `{N}` markers with live numbers before posting.
> Rules: no "AI revolution" framing, no unlabeled dry-run numbers, no
> competitor bashing. Every technical claim here is visible in the repo.

---

## HN — Show HN (day 1)

**Title:**

```
Show HN: Memento — a coding agent that remembers what it learns
```

**Body:**

```
Coding agents forget. Every session restarts from zero: the convention you
explained yesterday, the pitfall it hit last week — gone.

Memento is a spec-driven terminal agent built around one idea: reflection.
After every session it extracts "lessons" (patterns, constraints, failures)
into a plain JSONL file, each with a confidence score — +0.15 when evidence
confirms it, −0.30 when reality contradicts it, retired below 0.12. Wrong
memories are worse than no memories, so disproof outweighs proof. Before the
next task, the relevant lessons are recalled and injected — the agent gets
measurably better at *your* codebase.

Because memory is the claim, it ships with a benchmark: `memento bench` runs a
family of similar tasks cold (pristine copy, zero memory) vs warm (accumulated
lessons) and reports the saved turns and tokens. The harness is deterministic
end to end — `--dry` runs a scripted zero-network model, so anyone can rerun
it in CI. A leaderboard for community submissions is up at the repo.

Other things that mattered to me:
- Spec gate: `spec verify` uses deterministic checkers (no LLM) — every path
  in the spec must exist, every `npm run x` must be in package.json. The spec
  is consulted before a task and checked after it.
- Four runtime dependencies (commander, jiti, picocolors, zod). Sessions are
  JSONL, specs are Markdown. Every artifact survives the tool.
- MCP both ways: connect any MCP server as tools, and `memento serve-mcp`
  exposes your accumulated lessons to *other* agents (Claude Code, Cline).
- Default-deny security: project plugins/MCP servers are refused until
  explicitly trusted (a cloned repo must not be able to execute code).
- `memento web` opens a local workbench with a Live view — watch a session
  stream while it runs.

Try it: `npm i -g memento-agent`, set DEEPSEEK_API_KEY (or any OpenAI-compat
provider — presets for deepseek, openai, anthropic, ollama, moonshot, glm,
qwen), then `memento run "add rate limiting to the login endpoint"`. No key?
`node scripts/demo.mjs` in the repo runs the full loop against a scripted
local model with zero setup.

The honest caveat: the published benchmark numbers so far are dry-run demos.
The harness is real and open — the first real-model matrix is the launch
moment, and I'd love help filling it.

Feedback on the memory model (confidence dynamics, recall ranking) is the
thing I most want to get right.
```

**Comment playbook:**

- "Why another agent?" → link the benchmark section of the README. One number
  beats a paragraph.
- "How is this different from aider's map?" → repo map exists, but the
  differentiator is persistent confidence-weighted memory + deterministic spec
  verification; the README's "Why" section is the honest version.
- "Security?" → default-deny plugins/MCP, approval gates, loopback-bound web
  server, audit-trail sessions. Point to SECURITY.md.

---

## Reddit — r/programming (day 2)

**Title:**

```
I built a coding agent that measures its own memory: cold vs warm benchmark, deterministic harness, 4 dependencies
```

**Body:**

```
Every coding agent says it learns from mistakes. I wanted one that could
prove it.

memento is a spec-driven terminal agent. After each session it reflects:
what was learned becomes a "lesson" with a confidence score. Reinforcement
+0.15, contradiction −0.30, retired below 0.12. Before the next task, the
relevant lessons get recalled into the prompt.

To test the claim I built a paired benchmark: run a family of similar tasks
cold (pristine copy, zero memory) vs warm (accumulated lessons), and report
saved turns + tokens. The harness is deterministic — `--dry` uses a scripted
zero-network model so the whole pipeline runs anywhere, including CI.

Tech notes people here usually ask about:
- spec verification is deterministic (no LLM): every backticked path in the
  spec must exist, every `npm run x` must be in package.json
- 4 runtime deps; sessions are JSONL; specs are Markdown
- MCP in both directions — consume any MCP server, and `serve-mcp` exposes
  your lessons to other agents
- project plugins are default-deny (cloning a repo can't execute code)
- `memento web` has a Live tab: watch the agent work in real time

Try: npm i -g memento-agent (needs any OpenAI-compat key; deepseek/ollama/
glm/qwen presets included). Repo has a zero-setup scripted demo too.

Repo: https://github.com/memento-agent/memento

Caveat: the published numbers are dry-run demos until the first real-model
run lands — the harness is open for submissions, and I'd genuinely like help
running the matrix.
```

---

## Reddit — r/LocalLLaMA (day 2, afternoon)

**Title:**

```
Local-first coding agent with persistent memory — ollama preset, no key needed, dry-run benchmark in CI
```

**Body:**

```
Posting here because the local angle is first-class, not an afterthought:

- ollama preset built in (http://localhost:11434/v1) — no API key, the
  readiness check treats it as "local server, no key needed"
- `memento bench --dry` is a deterministic scripted-model benchmark — zero
  network, zero key, runs in CI. Good baseline for comparing local models
  later (each model+family pair submits to a leaderboard).
- tool-call streaming is parsed for both OpenAI-compat and Anthropic formats,
  which matters for the smaller local models that get chatty.

The memory system is the interesting part for this crowd: reflection after
each session writes confidence-scored lessons to a JSONL you can read; wrong
memories decay and retire. Context injection is a token cost — the benchmark
exists to show the cold/warm delta, which is exactly the "does memory pay for
its own context" question.

Would love qwen3/llama3.1 runs against the dry-run baseline.

Repo: https://github.com/memento-agent/memento
```

---

## Lobsters (day 3)

**Title:**

```
Memento: confidence-weighted memory for coding agents, with a deterministic benchmark
```

**Body:**

```
Three design decisions that might interest this crowd:

1. Memory is falsifiable arithmetic, not a vector store. Lessons are JSONL
   rows with confidence that moves: +0.15 on reinforcement, −0.30 on
   contradiction, retire < 0.12. A fresh lesson dies on its first
   contradiction. Nothing is ever deleted (auditable).

2. The spec gate is deterministic. `spec verify` checks that every backticked
   path exists and every `npm run x` is declared — no LLM in the loop. Specs
   that can't be checked are wishes.

3. The benchmark is paired and reproducible: same task family cold vs warm,
   `--dry` scripted provider, parallel cold copies with `--jobs`, leaderboard
   submissions via one merge command.

Four runtime dependencies. Sessions JSONL, specs Markdown. MCP both
directions (client + `serve-mcp` exposing lessons to other agents).
Default-deny for project plugins/MCP servers.

https://github.com/memento-agent/memento
```

---

## V2EX — 分享创造 (day 4)

**Title:**

```
分享创造：写了个"真的会记住教训"的终端编程 agent —— 记忆置信度 + 冷热对比基准 + 4 个运行时依赖
```

**Body:**

```
在座的应该都试过让 AI 改代码，最烦的就是：昨天教过的东西今天又忘了，
同一个坑踩两次。所以我做了 memento，核心就一条：每次会话结束做一次
反思，把这次的教训写成 JSONL 里的 lesson，带置信度——

- 新教训 0.35（未经证实）
- 被证实 +0.15
- 被证伪 −0.30
- 低于 0.12 退役（保留在日志里，不再召回）

错记忆比没记忆更糟，所以证伪权重 > 证实。下次任务开始前按相关性召回
top lessons 注入 system prompt，同一个代码库里会越用越熟。

还配了个可以证明这点的基准：`memento bench` 跑一族相似任务，冷（全新
副本零记忆）vs 热（继承记忆）对比省了多少轮和 token。harness 确定性
可复现（`--dry` 零网络脚本模型），还带社区 leaderboard。

其他自认为值得说的事：

- spec gate：`spec verify` 是确定性检查器，不调 LLM——spec 里提到的每个
  路径必须存在、每个 `npm run x` 必须在 package.json 里
- 只有 4 个运行时依赖；会话 JSONL、spec 是 Markdown，不绑定工具
- MCP 双向：可以接任何 MCP server，也能 `memento serve-mcp` 把教训导出
  给 Claude Code/Cline 用
- 安全默认拒绝：克隆下来的仓库里的插件/MCP 不显式信任就不执行
- `memento web` 有 Live 视图，可以开着浏览器看 agent 实时干活
- 国内模型开箱即用：deepseek / moonshot / glm（智谱）/ qwen（阿里）预设，
  还有 ollama 本地预设（零 key）

上手：npm i -g memento-agent，配个 DEEPSEEK_API_KEY 就能跑。没有 key 也
没关系，仓库里 node scripts/demo.mjs 用本地脚本模型零配置跑完整循环。

仓库：https://github.com/memento-agent/memento

诚实声明：目前公开的 benchmark 数字是 dry-run 演示数据，真实模型的
冷/热矩阵是我发布后的第一件事，欢迎一起跑。
```

---

## Blog — memory benchmark (day 5)

Publish `docs/blog/2026-09-22-memory-benchmark.md` once real-model numbers
exist. Replace the dry-run table with the real matrix and add:

- model + provider per row, with the date (models move fast; stale numbers
  are worse than none)
- token prices at run time, so "% tokens saved" reads as money saved
- a "reproduce it" block: the exact `memento bench` invocation + tasks.json

---

## Post-launch FAQ bank (for comments)

- **"Another agent CLI?"** — The differentiator is measurable memory + a
  deterministic spec gate; the benchmark exists so you don't have to take the
  word for it.
- **"Why not a vector DB / embeddings?"** — Lessons are few and high-value
  (constraints, pitfalls), not a corpus. Term-overlap + recency + confidence
  ranking keeps it auditable and cheap; the JSONL is the source of truth.
- **"Is this just prompt engineering?"** — Partly: recall and reflection are
  prompts. The engineering is the confidence dynamics, the deterministic
  verifiers, the approval gates, and the audit-trail loop.
- **"What about security?"** — Default-deny plugins/MCP, approval classifier
  with separator-aware pre-scan, loopback-only web server, session writer
  locks. SECURITY.md has the model.
- **"When hosted/web UI?"** — Non-goals. Terminal-first, embeddable library,
  local workbench. The API surface is exported for people who want to build
  their own.
