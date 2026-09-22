/**
 * todo-guard — an example memento plugin.
 *
 * Registers a spec checker: every source file that mentions TODO / TBD /
 * FIXME becomes a spec issue, so `memento spec verify` (and the agent's own
 * verify step) keeps "later" visible instead of letting it rot.
 *
 * Try it:
 *   memento plugins install <this-repo>#examples/plugins/todo-guard
 *   memento spec verify
 *
 * Every registration returns a disposer; memento reverses them on unload.
 */
import type { MementoPlugin } from "memento-agent";
import fs from "node:fs";
import path from "node:path";

const MARKERS = /\b(TODO|TBD|FIXME|XXX)\b/;

export default {
  name: "todo-guard",
  setup(ctx) {
    ctx.log("guarding TODO markers");

    ctx.registerSpecChecker({
      name: "todo-markers",
      run(root) {
        // Same walk rules as the built-in checkers: skip node_modules,
        // build output and dot dirs; only look at text-y source files.
        const issues: { path: string; message: string }[] = [];
        const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".memento", "coverage"]);
        const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".mdx", ".py", ".go", ".rs", ".java", ".rb"]);

        const walk = (dir: string): void => {
          let entries: import("node:fs").Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (e.isDirectory()) {
              if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name));
              continue;
            }
            if (!EXTENSIONS.has(path.extname(e.name))) continue;
            const file = path.join(dir, e.name);
            let text: string;
            try {
              text = fs.readFileSync(file, "utf8");
            } catch {
              continue;
            }
            text.split("\n").forEach((line, i) => {
              const m = MARKERS.exec(line);
              if (m) {
                issues.push({
                  severity: "warning",
                  path: path.relative(root, file).replaceAll("\\", "/"),
                  message: `unresolved ${m[1]} at line ${i + 1}: ${line.trim().slice(0, 80)}`,
                });
              }
            });
          }
        };
        walk(root);
        return issues;
      },
    });
  },
} satisfies MementoPlugin;
