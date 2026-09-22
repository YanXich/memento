# now-tool

An example memento plugin — a **tool registration** that gives the agent a
`now` tool: models have no clock, and "what changed since yesterday" tasks
need one.

## Install

```sh
memento plugins install <this-repo>#examples/plugins/now-tool
```

## What it demonstrates

- `ctx.registerTool({ name, description, schema, execute })` — the same
  Tool shape as the built-ins, zod for the schema
- the disposer contract: registering a name that already exists throws, and
  unloading removes the tool cleanly
