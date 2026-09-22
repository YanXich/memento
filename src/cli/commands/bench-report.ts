/**
 * `memento bench --report <path>` — renders benchmark results as a standalone,
 * brand-styled HTML page. No framework, no CDN: the file is meant to be
 * committed (e.g. into a GitHub Pages repo) and shared as-is.
 *
 * Same design language as the landing page and the workbench:
 * deep ink background, violet → aqua gradient, one ribbon up top.
 */
import type { BenchResult } from "./bench.ts";

export interface ReportMeta {
  provider: string;
  root: string;
  dry: boolean;
  generatedAt: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Percent saved — positive means the warm run was cheaper than the cold one. */
const savedPct = (coldV: number, warmV: number): number | null =>
  coldV > 0 ? Math.round(((coldV - warmV) / coldV) * 100) : null;

const pctCell = (p: number | null): string => {
  if (p === null) return `<td class="dim">—</td>`;
  if (p > 0) return `<td class="good">−${p}%</td>`;
  if (p === 0) return `<td class="dim">±0%</td>`;
  return `<td class="bad">+${Math.abs(p)}%</td>`;
};

/** One SVG polyline with hoverable dots, fit into w×h. */
function sparkline(points: number[], w: number, h: number, color: string): string {
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = Math.max(max - min, 1);
  const stepX = points.length > 1 ? w / (points.length - 1) : 0;
  const coords = points.map((p, i) => [i * stepX, h - 10 - ((p - min) / span) * (h - 30)] as const);
  const poly = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const dots = coords
    .map(
      ([x, y], i) =>
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${color}"><title>task ${i + 1}: ${points[i]}</title></circle>`,
    )
    .join("");
  return `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>${dots}`;
}

export function renderReportHtml(meta: ReportMeta, results: BenchResult[]): string {
  const first = results[0];
  const last = results[results.length - 1];
  const lastWarm = last?.warm;
  const firstWarm = first?.warm;

  // Headline numbers: with cold runs, savings vs memoryless; otherwise the
  // warm learning curve alone (first task → last task).
  const turnsSaved = last?.cold && lastWarm ? savedPct(last.cold.turns, lastWarm.turns) : null;
  const tokensSaved = last?.cold && lastWarm ? savedPct(last.cold.inputTokens, lastWarm.inputTokens) : null;
  const curveStart = firstWarm?.turns ?? 0;
  const curveEnd = lastWarm?.turns ?? 0;
  const lessonsLearned = lastWarm?.lessons ?? 0;
  const curveDelta = curveStart > 0 ? Math.round(((curveStart - curveEnd) / curveStart) * 100) : 0;

  const date = meta.generatedAt.slice(0, 10);

  const rows = results
    .map((r) => {
      const coldTurns = r.cold ? String(r.cold.turns) : "—";
      const coldTokens = r.cold ? k(r.cold.inputTokens) : "—";
      const warmTurns = String(r.warm.turns);
      const warmTokens = k(r.warm.inputTokens);
      const tSaved = r.cold ? savedPct(r.cold.turns, r.warm.turns) : null;
      const kSaved = r.cold ? savedPct(r.cold.inputTokens, r.warm.inputTokens) : null;
      return `<tr>
      <td class="name">${esc(r.name)}</td>
      <td class="mono">${coldTurns}</td><td class="mono">${coldTokens}</td>
      <td class="mono strong">${warmTurns}</td><td class="mono strong">${k(r.warm.inputTokens)}</td>
      ${pctCell(tSaved)}${pctCell(kSaved)}
      <td class="mono dim">${r.warm.lessons}</td>
    </tr>`;
    })
    .join("\n    ");

  // The learning curve: warm turns and warm input tokens per task. Two
  // separate normalisations so both shapes stay visible.
  const curve = (pick: (r: BenchResult) => number, color: string): string => {
    const points = results.map(pick);
    return results.length > 1 ? sparkline(points, 640, 150, color) : "";
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>memento bench — ${results.length} task(s)</title>
<style>
  :root {
    --bg: #0d0c15; --panel: #16141f; --line: #2a2737; --line-soft: #201d2e;
    --ink: #e9e7f2; --sub: #a8a3bd; --faint: #6f6a85;
    --violet: #a78bfa; --aqua: #6fe3d0; --green: #7fd8a4; --red: #e08a8a;
    --grad: linear-gradient(120deg, var(--violet) 0%, var(--aqua) 100%);
    --sans: system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --mono: ui-monospace, "Cascadia Code", Consolas, "SF Mono", monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background:
      radial-gradient(1100px 520px at 80% -10%, rgba(124, 92, 240, 0.16), transparent 62%),
      radial-gradient(900px 420px at -6% 2%, rgba(111, 227, 208, 0.09), transparent 58%),
      var(--bg);
    background-attachment: fixed; color: var(--ink);
    font: 16px/1.6 var(--sans); -webkit-font-smoothing: antialiased;
  }
  .mono { font-family: var(--mono); }
  .dim { color: var(--faint); }
  .grad-text {
    background: var(--grad);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  header {
    border-bottom: 1px solid var(--line-soft); padding: 26px 32px 22px;
    position: relative;
  }
  header::before {
    content: ""; position: absolute; inset: 0 0 auto 0; height: 2px; background: var(--grad); opacity: 0.85;
  }
  header .brand { font-size: 20px; font-weight: 700; letter-spacing: 0.2px; }
  header .meta { color: var(--faint); font: 12.5px var(--mono); margin-top: 4px; }
  main { max-width: 900px; margin: 0 auto; padding: 36px 24px 60px; }
  section { margin-bottom: 44px; }
  h2 { font-size: 20px; margin: 0 0 14px; letter-spacing: -0.3px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    padding: 20px 20px 16px;
  }
  .card .n { font: 700 26px var(--mono); }
  .card .l { color: var(--faint); font-size: 12.5px; margin-top: 2px; }
  .chart {
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    padding: 20px 18px 10px; overflow-x: auto;
  }
  .legend { display: flex; gap: 22px; font-size: 13px; color: var(--sub); margin-bottom: 8px; }
  .legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
  th {
    text-align: left; color: var(--faint); font: 11px var(--mono);
    text-transform: uppercase; letter-spacing: 0.6px;
    padding: 10px 12px; border-bottom: 1px solid var(--line);
  }
  td { padding: 11px 12px; border-bottom: 1px solid var(--line-soft); }
  td.name { color: var(--ink); font-weight: 600; }
  td.strong { color: var(--aqua); }
  td.good { color: var(--green); font-weight: 600; }
  td.bad { color: var(--red); }
  footer {
    border-top: 1px solid var(--line-soft); padding: 26px 24px 40px;
    text-align: center; color: var(--faint); font-size: 13px;
  }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="grad-text">◈ memento</span> · memory benchmark</div>
  <div class="meta">${esc(meta.provider)} · ${results.length} task(s) · ${meta.dry ? "dry run (deterministic)" : esc(meta.root)} · ${date}</div>
</header>
<main>
  <section class="cards">
    <div class="card"><div class="n grad-text">${turnsSaved !== null ? `−${turnsSaved}%` : "—"}</div><div class="l">turns saved vs memoryless</div></div>
    <div class="card"><div class="n grad-text">${tokensSaved !== null ? `−${tokensSaved}%` : "—"}</div><div class="l">input tokens saved vs memoryless</div></div>
    <div class="card"><div class="n grad-text">${lessonsLearned}</div><div class="l">lessons in memory at the end</div></div>
    <div class="card"><div class="n grad-text">${curveStart} → ${curveEnd}</div><div class="l">warm turns, first → last task${curveDelta > 0 ? ` (${curveDelta}% fewer)` : ""}</div></div>
  </section>

  <section>
    <h2>Learning curve</h2>
    <div class="chart">
      <div class="legend"><span><span class="sw" style="background:var(--violet)"></span>warm turns per task</span><span><span class="sw" style="background:var(--aqua)"></span>warm input tokens per task</span></div>
      <svg viewBox="0 0 640 150" width="640" height="150" role="img" aria-label="learning curve">
        ${curve((r) => r.warm.turns, "var(--violet)")}
        ${curve((r) => r.warm.inputTokens, "var(--aqua)")}
      </svg>
    </div>
  </section>

  <section>
    <h2>Per-task comparison</h2>
    <table>
      <thead><tr><th>task</th><th>cold turns</th><th>cold tokens</th><th>warm turns</th><th>warm tokens</th><th>turns saved</th><th>tokens saved</th><th>lessons</th></tr></thead>
      <tbody>
    ${rows}
      </tbody>
    </table>
  </section>
</main>
<footer>
  generated by <span class="mono">memento bench</span> · plain HTML, no CDN — commit it to GitHub Pages and share the link
</footer>
</body>
</html>
`;
}
