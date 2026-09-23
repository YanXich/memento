/**
 * Thin wrapper over `memento demo` for repo-local use (`npm run demo`).
 *
 * The real implementation lives in `src/cli/commands/demo.ts` so the
 * zero-key demo ships inside the npm package. This script keeps the repo
 * workflow stable: build, then run the packaged command in `.demo/`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");
const ws = path.join(root, ".demo");

if (!fs.existsSync(cli)) {
  console.error("dist/cli.js not found — run `npm run build` first.");
  process.exit(1);
}

const child = spawn(process.execPath, [cli, "demo", "--workspace", ws], { cwd: root, stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 0));
