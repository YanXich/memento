# todo-guard

An example memento plugin — a **spec checker** that turns unresolved
`TODO` / `TBD` / `FIXME` / `XXX` markers in source files into spec issues,
so `memento spec verify` (and the agent's post-session verify step) keeps
"later" visible instead of letting it rot.

## Install

```sh
memento plugins install <this-repo>#examples/plugins/todo-guard
```

Then run `memento spec verify` — every marker shows up as an issue with its
file, line and text.

## What it demonstrates

- `ctx.registerSpecChecker` — extend the deterministic verifier surface
  (never calls an LLM; runs on `spec verify` and after agent sessions)
- the walk/skip discipline (no `node_modules`, no build output, dot-dirs
  ignored) every checker should follow
- a disposer-returning registration: unloading reverses it cleanly

The plugin API: `ctx.registerTool`, `ctx.registerSpecChecker`,
`ctx.on("session_start" | "session_end" | "before_tool" | "after_tool" |
"before_llm", handler)` — every registration returns a disposer.
