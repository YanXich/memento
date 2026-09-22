/**
 * Memory types.
 *
 * A Lesson is a falsifiable claim about how to work in this repo, with
 * evidence and a confidence score. Confidence rises when a later session
 * confirms the lesson and falls when one contradicts it — that is the whole
 * "the agent gets smarter" mechanism, kept honest by evidence links.
 */
export type LessonKind = "constraint" | "pattern" | "failure" | "preference" | "discovery";

export interface Lesson {
  id: string;
  /** The claim, one sentence, imperative or declarative. */
  text: string;
  kind: LessonKind;
  /** 0..1 — starts low on first sight, grows with confirmation. */
  confidence: number;
  /** Session ids where this was observed. */
  evidence: string[];
  reinforced: number;
  contradicted: number;
  scope: "repo" | "user";
  created: number;
  lastSeen: number;
  /** Terms for recall matching. */
  tags: string[];
  status: "active" | "retired";
}

/** What the reflection LLM returns per observation. */
export interface ReflectionObservation {
  text: string;
  kind: LessonKind;
  /** Short evidence quote/paraphrase from the session. */
  evidence: string;
  /** Existing lesson id this relates to (when reinforcing/contradicting). */
  relatesTo?: string | null;
  relation: "new" | "reinforce" | "contradict";
}

export interface SpecSuggestion {
  target: string;
  rationale: string;
  priority: "high" | "medium" | "low";
}

export interface ReflectionResult {
  observations: ReflectionObservation[];
  specSuggestions: SpecSuggestion[];
  summary: string;
}

export interface ReflectionOutcome {
  added: Lesson[];
  reinforced: Lesson[];
  contradicted: Lesson[];
  retired: Lesson[];
  /** Suggestions that were not applied (for the user to review). */
  suggestions: SpecSuggestion[];
  summary: string;
  /** Set when the reflection itself failed — sessions must not break because of this. */
  error?: string;
}

export interface MemoryStats {
  active: number;
  retired: number;
  byKind: Record<LessonKind, number>;
  avgConfidence: number;
}

/**
 * One point on a lesson's evolution arc, folded from the append-only store.
 * The workbench draws the confidence curve from these — the visible proof
 * that the agent gets measurably smarter (or honestly retires what it got
 * wrong) session after session.
 */
export interface LessonEvent {
  op: "upsert" | "retire";
  ts: number;
  confidence: number;
  reinforced: number;
  contradicted: number;
  status: "active" | "retired";
}
