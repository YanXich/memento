/**
 * session-digest — an example memento plugin.
 *
 * Watches the lifecycle: at `session_start` it remembers what the task was,
 * and at `session_end` it appends one Markdown line to
 * `.memento/session-digest.md` — a plain-text history of agent work that
 * survives the terminal and diffs nicely in git.
 *
 * Try it:
 *   memento plugins install <this-repo>#examples/plugins/session-digest
 *   memento run "rename getCwd to currentDirectory"
 *
 * Every registration returns a disposer; memento reverses them on unload.
 */
import type { MementoPlugin } from "memento-agent";
import fs from "node:fs";
import path from "node:path";

export default {
  name: "session-digest",
  setup(ctx) {
    let task = "(unknown task)";

    ctx.on("session_start", (e) => {
      if (e.type !== "session_start") return;
      task = e.task;
      ctx.log(`recording session: ${task.slice(0, 60)}`);
    });

    ctx.on("session_end", (e) => {
      if (e.type !== "session_end") return;
      const file = path.join(ctx.cwd, ".memento", "session-digest.md");
      const line = `- ${new Date().toISOString().slice(0, 19).replace("T", " ")} · ${task.slice(0, 80)} · ${e.status} (${e.turns} turns)\n`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line);
        ctx.log("digest appended");
      } catch (err) {
        ctx.log(`digest write failed: ${(err as Error).message}`);
      }
    });
  },
} satisfies MementoPlugin;
