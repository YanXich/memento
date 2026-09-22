# session-digest

An example memento plugin — a **lifecycle watcher** that appends one
Markdown line per finished session to `.memento/session-digest.md`, so the
agent's work leaves a plain-text, git-friendly trail behind the terminal.

## Install

```sh
memento plugins install <this-repo>#examples/plugins/session-digest
```

Run any task (`memento run "…"`, `memento plan`, `memento chat`) and check
`.memento/session-digest.md` afterwards — one line per session, with the
task, status and turn count.

## What it demonstrates

- `ctx.on("session_start" | "session_end", handler)` — lifecycle events with
  typed payloads
- state kept between events inside the plugin closure
- writes that stay inside `.memento/` (the same trust envelope as the rest
  of the project's memory)
