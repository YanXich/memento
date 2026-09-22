#!/usr/bin/env node
/**
 * Merge a `memento bench --json` output into the leaderboard data file.
 *
 *   memento bench tasks.json --json > bench-out.json
 *   node scripts/merge-bench.mjs bench-out.json your-handle --report benchmarks/myreport.html
 *
 * The entry is keyed by (submitter, provider, model, taskFamily); re-running
 * with the same key replaces the previous entry instead of appending, so a
 * contributor can refresh their numbers with one command. Zero dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(here, "..", "site", "benchmarks", "results.json");

function fail(msg) {
  process.stderr.write(`merge-bench: ${msg}\n`);
  process.exit(1);
}

function args() {
  const a = process.argv.slice(2);
  const out = { file: null, submitter: null, report: null, resultsFile: DEFAULT_OUT };
  let i = 0;
  while (i < a.length) {
    if (a[i] === "--report") out.report = a[++i];
    else if (a[i] === "--out") out.resultsFile = a[++i];
    else if (out.file === null) out.file = a[i];
    else if (out.submitter === null) out.submitter = a[i];
    else fail(`unexpected argument: ${a[i]}`);
    i += 1;
  }
  if (!out.file) fail("usage: node scripts/merge-bench.mjs <bench-out.json> <submitter> [--report path] [--out results.json]");
  if (!out.submitter) fail("usage: node scripts/merge-bench.mjs <bench-out.json> <submitter> [--report path] [--out results.json]");
  return out;
}

const opts = args();

let raw;
try {
  // PowerShell redirection on Windows writes UTF-8 with a BOM — strip it
  // (and any other leading whitespace) before parsing.
  const text = fs.readFileSync(path.resolve(opts.file), "utf8").replace(/^\uFEFF/, "");
  raw = JSON.parse(text);
} catch (err) {
  fail(`cannot read bench output: ${err.message}`);
}
if (!raw || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
  fail(`${opts.file} does not look like a \`memento bench --json\` output (missing tasks array)`);
}

// Aggregate: turns/tokens saved across tasks that have both a cold and a
// warm run. Cold = memoryless baseline, warm = recalled lessons.
let coldTurns = 0;
let warmTurns = 0;
let coldTokens = 0;
let warmTokens = 0;
const tasks = raw.tasks.map((t) => {
  if (!t.cold || !t.warm) return null;
  coldTurns += t.cold.turns;
  warmTurns += t.warm.turns;
  coldTokens += t.cold.inputTokens;
  warmTokens += t.warm.inputTokens;
  return {
    name: t.name,
    cold: { turns: t.cold.turns, inputTokens: t.cold.inputTokens },
    warm: { turns: t.warm.turns, inputTokens: t.warm.inputTokens },
  };
});
const withCold = tasks.filter(Boolean);
if (withCold.length === 0) fail("no cold/warm pairs in the bench output — run without --noCold");

const pct = (cold, warm) => (cold > 0 ? Math.round(((cold - warm) / cold) * 100) : 0);

const entry = {
  submitter: opts.submitter,
  provider: raw.provider ?? "unknown",
  model: raw.model ?? "unknown",
  date: new Date().toISOString().slice(0, 10),
  dry: Boolean(raw.dry),
  taskFamily: `tasks.json (${withCold.map((t) => t.name).join(", ")})`,
  turnsSavedPct: pct(coldTurns, warmTurns),
  tokensSavedPct: pct(coldTokens, warmTokens),
  ...(opts.report ? { report: opts.report } : {}),
  tasks: withCold,
};

let data;
try {
  data = JSON.parse(fs.readFileSync(opts.resultsFile, "utf8"));
} catch {
  data = { entries: [] };
}
if (!Array.isArray(data.entries)) fail(`${opts.resultsFile} is not a leaderboard data file`);

// Same submitter+provider+model+family → replace, don't stack duplicates.
const key = (e) => `${e.submitter}|${e.provider}|${e.model}|${e.taskFamily}`;
const idx = data.entries.findIndex((e) => key(e) === key(entry));
if (idx >= 0) data.entries[idx] = entry;
else data.entries.push(entry);
// Newest first.
data.entries.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

fs.writeFileSync(opts.resultsFile, JSON.stringify(data, null, 2) + "\n", "utf8");
process.stdout.write(
  `leaderboard updated: ${idx >= 0 ? "replaced" : "added"} "${entry.submitter}" — turns ${entry.turnsSavedPct >= 0 ? `−${entry.turnsSavedPct}%` : `+${-entry.turnsSavedPct}%`}, tokens ${entry.tokensSavedPct >= 0 ? `−${entry.tokensSavedPct}%` : `+${-entry.tokensSavedPct}%`} → ${opts.resultsFile}\n`,
);
