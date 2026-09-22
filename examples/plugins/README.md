# Example plugins

Official starter plugins — each one is a real, installable package and a
walk-through of one plugin-API surface. Install any of them straight from
this repo:

```sh
# a spec checker: TODO markers become spec issues
memento plugins install <this-repo>#examples/plugins/todo-guard

# a lifecycle watcher: one Markdown line per finished session
memento plugins install <this-repo>#examples/plugins/session-digest

# a tool: the `now` tool, because models have no clock
memento plugins install <this-repo>#examples/plugins/now-tool
```

| plugin | API surface | what it does |
| --- | --- | --- |
| [todo-guard](todo-guard/) | `registerSpecChecker` | unresolved TODO/TBD/FIXME become `spec verify` issues |
| [session-digest](session-digest/) | `on("session_start"/"session_end")` | appends one line per session to `.memento/session-digest.md` |
| [now-tool](now-tool/) | `registerTool` | adds a `now` tool (ISO 8601 + epoch) |

## Anatomy of a plugin package

A package is a directory with an entry (`index.ts`) plus an optional
`.memento-plugin.json` manifest — exactly the shape `memento plugins install`
copies into `.memento/plugins/<name>/`:

```
examples/plugins/todo-guard/
├── index.ts                  # default export: { name, setup(ctx) }
├── .memento-plugin.json      # name + description (install uses these)
└── README.md
```

## Write your own

```sh
memento plugins init my-plugin      # scaffolds .memento/plugins/my-plugin.ts
```

Every registration — `ctx.registerTool`, `ctx.registerSpecChecker`,
`ctx.on(...)` — returns a disposer, and memento reverses them all on
unload. Plugins are guests, not residents.
