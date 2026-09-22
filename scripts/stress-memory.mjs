/**
 * Concurrency stress — N parallel `memento remember` processes append to the
 * same lessons.jsonl, then every line must parse and no record may be lost.
 *
 * Verifies the O_APPEND write contract in util/paths.ts on this machine:
 * concurrent processes appending one line each never interleave or drop
 * writes. Run it on a new platform before trusting the claim there.
 *
 *   npm run stress:memory
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ws = path.join(root, ".stress-tmp");
const cli = path.join(root, "dist", "cli.js");
const N = 12;

if (!fs.existsSync(cli)) {
  console.error("dist/cli.js not found — run `npm run build` first.");
  process.exit(1);
}

fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(path.join(ws, ".memento", "memory"), { recursive: true });

const procs = [];
for (let i = 0; i < N; i++) {
  procs.push(
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [cli, "remember", `stress lesson number ${i}`, "-C", ws], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`proc ${i} exited ${code}: ${err.slice(0, 300)}`))));
    }),
  );
}

await Promise.all(procs);

const file = path.join(ws, ".memento", "memory", "lessons.jsonl");
const raw = fs.readFileSync(file, "utf8");
const lines = raw.trim().split("\n");
let bad = 0;
for (const line of lines) {
  try {
    JSON.parse(line);
  } catch {
    bad++;
  }
}
const uniq = new Set(lines.map((l) => JSON.parse(l).lesson.text)).size;
fs.rmSync(ws, { recursive: true, force: true });

console.log(`lines=${lines.length} parseFailures=${bad} uniqueTexts=${uniq} expected=${N}`);
if (bad === 0 && lines.length === N && uniq === N) {
  console.log("STRESS OK — concurrent appends are atomic on this machine");
} else {
  console.error("STRESS FAIL — the O_APPEND contract does not hold here");
  process.exit(1);
}
