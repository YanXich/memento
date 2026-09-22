/**
 * now-tool — an example memento plugin.
 *
 * Gives the agent a `now` tool: models have no clock, and "what changed
 * since yesterday" tasks need one. Uses zod for the (empty) input schema,
 * the same library the built-in tools use.
 *
 * Try it:
 *   memento plugins install <this-repo>#examples/plugins/now-tool
 *   memento run "tell me the current time" --spec-gate off
 *
 * Every registration returns a disposer; memento reverses them on unload.
 */
import type { MementoPlugin } from "memento-agent";
import { z } from "zod";

export default {
  name: "now-tool",
  setup(ctx) {
    ctx.registerTool({
      name: "now",
      description: "Current date and time (ISO 8601 + epoch) — the model's only clock",
      schema: z.object({}),
      execute: async () => {
        const d = new Date();
        return { output: `${d.toISOString()} (${Math.floor(d.getTime() / 1000)})` };
      },
    });
  },
} satisfies MementoPlugin;
