/**
 * Spec recall — pick the spec excerpts relevant to a task.
 *
 * Keyword-overlap ranking with a confidence boost for the constitution and
 * architecture (always injected in compressed form). No embeddings in v1:
 * deterministic, zero-dependency, good enough at repo scale. The seam allows
 * a smarter scorer later without touching callers.
 */
import type { SpecBundle, SpecFile } from "./types.ts";
import { extractTerms, termOverlap, truncateMiddle } from "../util/text.ts";

export interface RecallOptions {
  /** Max characters of spec context to return. */
  budget?: number;
  /** Include constitution + architecture headers even when they don't match. */
  alwaysIncludeCore?: boolean;
}

export function recallSpec(bundle: SpecBundle, task: string, opts: RecallOptions = {}): string {
  const budget = opts.budget ?? 6000;
  const taskTerms = extractTerms(task);
  const scored: { file: SpecFile; score: number }[] = [];

  for (const file of bundle.all) {
    const title = file.relPath + " " + firstHeading(file.content);
    const score = termOverlap(taskTerms, extractTerms(title + " " + stripMarkup(file.content))) +
      termOverlap(taskTerms, extractTerms(file.slug.replace(/-/g, " "))) * 0.5;
    scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const sections: string[] = [];
  let used = 0;

  const pushSection = (title: string, body: string) => {
    const chunk = `### ${title}\n${body}`;
    if (used + chunk.length > budget) {
      const remaining = budget - used;
      if (remaining > 400) {
        sections.push(`### ${title}\n${truncateMiddle(body, remaining)}`);
        used = budget;
      }
      return false;
    }
    sections.push(chunk);
    used += chunk.length;
    return true;
  };

  if (opts.alwaysIncludeCore !== false) {
    // Constitution rules are the highest-priority context — compress to the bullet lines.
    if (bundle.constitution) {
      pushSection(bundle.constitution.relPath, condense(bundle.constitution.content, 1600));
    }
    if (bundle.architecture) {
      pushSection(bundle.architecture.relPath, condense(bundle.architecture.content, 1600));
    }
  }

  for (const { file, score } of scored) {
    if (file.kind === "constitution" || file.kind === "architecture") continue;
    if (score <= 0.01) continue;
    if (used >= budget) break;
    pushSection(file.relPath, condense(file.content, file.kind === "feature" ? 2200 : 1200));
  }

  return sections.join("\n\n");
}

function firstHeading(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

/** Drop fenced code blocks and tables for scoring purposes (keep prose). */
function stripMarkup(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\|.*\|/g, " ")
    .replace(/^>.*$/gm, " ");
}

/** Keep headings + bullets + first paragraph — the skeleton of a spec. */
function condense(content: string, max: number): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    const isNoise = /^```/.test(line.trim());
    const isSignal = /^(#{1,4}\s|[-*]\s|\d+\.\s|\*\*)/.test(line.trim()) || line.trim().length === 0;
    if (isNoise && !kept.length) continue;
    if (isSignal || kept.length < 12) {
      kept.push(line);
      chars += line.length;
      if (chars > max) break;
    }
  }
  return truncateMiddle(kept.join("\n").trim(), max);
}
