/**
 * MCP tools exposing Memento's memory to other agents.
 *
 * The pitch: any MCP-speaking agent (Claude Code, Cline, Goose) can read —
 * and contribute to — the same lesson store Memento itself learns from.
 * One memory, shared by every agent on the machine.
 *
 *   search_lessons  read the durable lessons (confidence-weighted)
 *   add_lesson      contribute a new observation (starts at low confidence)
 *   memory_stats    what the store knows and how sure it is
 *
 * Safety: lessons are append-only JSONL inside `.memento/memory/`, the same
 * file Memento uses. Contributed lessons enter the confidence machinery at
 * 0.35 and must survive later confirmation — one bad contribution cannot
 * silently poison the memory.
 */
import type { LessonKind, MemoryStats } from "../memory/types.ts";
import type { LessonStore } from "../memory/store.ts";
import { extractTerms, termOverlap } from "../util/text.ts";
import type { McpTool } from "./stdio.ts";

const KINDS: LessonKind[] = ["constraint", "pattern", "failure", "preference", "discovery"];
const MAX_TEXT = 500;
const MAX_RESULTS = 20;

export function memoryTools(store: LessonStore, opts: { readOnly: boolean }): McpTool[] {
  const defs = {
    search_lessons: {
      name: "search_lessons",
      description:
        "Search Memento's durable memory for lessons learned in this repository. Results are confidence-weighted: lessons confirmed by multiple sessions rank higher. Returns the lesson text, kind, confidence, and how recently it was seen.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you're looking for — keywords, error text, or a concept." },
          kind: { type: "string", enum: KINDS, description: "Restrict to one lesson kind." },
          limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, default: 10, description: "Max results." },
          minConfidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Only return lessons with confidence >= this (0 = all active lessons).",
          },
        },
        required: ["query"],
      },
    },
    add_lesson: {
      name: "add_lesson",
      description:
        "Contribute an observation to this repository's memory. It enters at confidence 0.35 and is reinforced or contradicted by future sessions — it never silently overrides what Memento already knows. Good lessons are falsifiable and specific to this repo or its user, e.g. 'tests run with pnpm test:unit'.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: MAX_TEXT, description: "The lesson, one sentence." },
          kind: {
            type: "string",
            enum: KINDS,
            default: "discovery",
            description: "constraint | pattern | failure | preference | discovery",
          },
          evidence: { type: "string", description: "Why you believe it (short)." },
        },
        required: ["text"],
      },
    },
    memory_stats: {
      name: "memory_stats",
      description:
        "How much this repository's memory knows: active/retired lesson counts, breakdown by kind, average confidence, and the most recent lessons.",
      inputSchema: { type: "object", properties: {} },
    },
  } as const;

  return [
    {
      def: defs.search_lessons as McpTool["def"],
      handler: async (args) => searchLessons(store, args),
    },
    {
      def: defs.add_lesson as McpTool["def"],
      handler: async (args, extra) => addLesson(store, args, extra.clientName, opts.readOnly),
    },
    {
      def: defs.memory_stats as McpTool["def"],
      handler: async () => statsText(store),
    },
  ];
}

function searchLessons(store: LessonStore, args: Record<string, unknown>): { text: string } {
  const query = typeof args.query === "string" ? args.query : "";
  const queryTerms = extractTerms(query);
  const kind = typeof args.kind === "string" ? (args.kind as LessonKind) : undefined;
  const limit = clampInt(args.limit, 1, MAX_RESULTS, 10);
  const minConf = typeof args.minConfidence === "number" ? clamp(args.minConfidence, 0, 1) : 0;

  let pool = store.active();
  if (kind && KINDS.includes(kind)) pool = pool.filter((l) => l.kind === kind);
  if (minConf > 0) pool = pool.filter((l) => l.confidence >= minConf);

  const scored = pool
    .map((lesson) => {
      // Text match dominates; confidence breaks ties. Lessons with zero
      // lexical overlap still surface when the query is empty (browse mode).
      const overlap = queryTerms.length ? termOverlap(queryTerms, lesson.tags) : 0;
      const score = overlap * 0.7 + lesson.confidence * 0.3;
      return { lesson, score };
    })
    .sort((a, b) => b.score - a.score || b.lesson.lastSeen - a.lesson.lastSeen)
    .slice(0, limit);

  if (scored.length === 0) {
    return {
      text: kind
        ? `No active ${kind} lessons found in this repository's memory.`
        : "No active lessons found in this repository's memory yet. Sessions that finish with `--reflect` will start filling it.",
    };
  }

  const lines = scored.map(({ lesson }) => {
    const age = ageText(lesson.lastSeen);
    return [
      `- [${lesson.id}] (${lesson.kind}, conf ${lesson.confidence.toFixed(2)}, seen ${age}) ${lesson.text}`,
      lesson.evidence.length ? `    evidence: ${lesson.evidence.slice(-2).join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return { text: lines.join("\n") };
}

function addLesson(
  store: LessonStore,
  args: Record<string, unknown>,
  clientName: string,
  readOnly: boolean,
): { text: string; isError?: boolean } {
  if (readOnly) {
    return { text: "Server is running in --read-only mode; add_lesson is disabled.", isError: true };
  }
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return { text: "text is required and must not be empty.", isError: true };
  if (text.length > MAX_TEXT) {
    return { text: `text must be at most ${MAX_TEXT} characters (got ${text.length}).`, isError: true };
  }
  const kind = typeof args.kind === "string" && KINDS.includes(args.kind as LessonKind)
    ? (args.kind as LessonKind)
    : "discovery";
  const evidence = typeof args.evidence === "string" && args.evidence.trim()
    ? args.evidence.trim()
    : `contributed by ${clientName} via MCP`;

  const lesson = store.add({ text, kind, evidence, sessionId: `mcp:${clientName}` });
  return {
    text: `Recorded [${lesson.id}] (${kind}, conf ${lesson.confidence.toFixed(2)}). It starts at low confidence and will be reinforced or contradicted by future sessions.`,
  };
}

function statsText(store: LessonStore): { text: string } {
  const stats: MemoryStats = store.stats();
  const recent = store
    .active()
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 5);

  const lines = [
    `Memory: ${stats.active} active lesson(s), ${stats.retired} retired.`,
    `Average confidence: ${stats.avgConfidence.toFixed(2)}.`,
    `By kind: ${Object.entries(stats.byKind)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ") || "—"}`,
  ];
  if (recent.length) {
    lines.push("Most recent:");
    for (const l of recent) lines.push(`- [${l.id}] (conf ${l.confidence.toFixed(2)}) ${l.text}`);
  }
  return { text: lines.join("\n") };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(clamp(value, min, max)) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ageText(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
