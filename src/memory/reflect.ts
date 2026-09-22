/**
 * Reflection engine — the self-improvement loop.
 *
 * After a session ends, one focused LLM call reads the session transcript and
 * returns structured observations against the existing lesson list:
 *   new        → add (low confidence)
 *   reinforce  → confidence +0.15
 *   contradict → confidence −0.30 (may retire)
 *
 * Design rules:
 *  - Reflection NEVER edits code or spec files directly. It proposes; the
 *    CLI (or `--auto`) applies spec suggestions through the normal gate.
 *  - A failed reflection is a non-event: the session already succeeded.
 *  - Evidence is mandatory; a claim without evidence is rejected outright.
 */
import type { Message, ModelInfo, LlmProvider } from "../llm/types.ts";
import { complete, parseJsonLoose } from "../llm/complete.ts";
import type { LessonStore } from "./store.ts";
import type { ReflectionObservation, ReflectionOutcome, ReflectionResult, SpecSuggestion } from "./types.ts";
import { textOf, toolCallsOf } from "../llm/types.ts";
import { oneLine } from "../util/text.ts";

export interface ReflectDeps {
  provider: LlmProvider;
  model: ModelInfo;
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

const REFLECT_SYSTEM = `You are Memento's reflection engine. You read a coding session transcript and extract DURABLE lessons — things worth remembering for future sessions in this repository.

Rules:
- A lesson must be falsifiable and specific to THIS repository or THIS user's expressed preferences. "Write clean code" is not a lesson. "Tests run with \`pnpm test:unit\`" is a lesson.
- Every observation MUST quote its evidence from the transcript (short paraphrase ok).
- If a new observation says the same thing as an existing lesson, use relation "reinforce" and point relatesTo at that lesson id.
- If the session contradicts an existing lesson, use relation "contradict".
- At most 5 observations. Quality over quantity — an empty list is a valid answer for a routine session.
- NEVER record secrets, tokens, or credentials.

Respond with JSON only:
{
  "observations": [
    {"text": "...", "kind": "constraint|pattern|failure|preference|discovery", "evidence": "...", "relation": "new|reinforce|contradict", "relatesTo": "l_xxxx" (required for reinforce/contradict)}
  ],
  "specSuggestions": [
    {"target": ".memento/spec/...", "rationale": "...", "priority": "high|medium|low"}
  ],
  "summary": "one sentence: what this session achieved"
}`;

export interface ReflectInput {
  sessionId: string;
  task: string;
  status: "done" | "aborted" | "error" | "max_turns";
  messages: Message[];
  store: LessonStore;
}

export async function reflect(deps: ReflectDeps, input: ReflectInput): Promise<ReflectionOutcome> {
  const empty: ReflectionOutcome = { added: [], reinforced: [], contradicted: [], retired: [], suggestions: [], summary: "" };

  const existing = input.store.active();
  // Cap the lesson list we send: highest confidence + most recent (stable order).
  const existingForPrompt = [...existing]
    .sort((a, b) => b.confidence - a.confidence || b.lastSeen - a.lastSeen)
    .slice(0, 40)
    .map((l) => `- ${l.id} [${l.kind}, conf ${l.confidence.toFixed(2)}] ${l.text}`)
    .join("\n");

  const transcript = condenseTranscript(input.messages);

  deps.onProgress?.("Reflecting on the session…");
  const res = await complete({
    provider: deps.provider,
    model: deps.model,
    ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    system: REFLECT_SYSTEM,
    user: `Session ${input.sessionId} — task: ${input.task}
Outcome: ${input.status}

Existing lessons in this repo:
${existingForPrompt || "(none yet)"}

Session transcript (user/assistant turns and tool calls, condensed):
${transcript}`,
    maxTokens: Math.min(deps.model.maxOutput, 3000),
    temperature: 0.2,
  });

  if (res.error) {
    return { ...empty, error: res.error };
  }
  const parsed = parseJsonLoose<ReflectionResult>(res.text);
  if (!parsed) {
    return { ...empty, error: "reflection returned unparseable output" };
  }

  // --- Apply observations through the confidence machinery ---
  const outcome: ReflectionOutcome = {
    added: [],
    reinforced: [],
    contradicted: [],
    retired: [],
    suggestions: sanitizeSuggestions(parsed.specSuggestions ?? []),
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };

  for (const obs of (parsed.observations ?? []).slice(0, 5)) {
    if (!isValidObservation(obs)) continue;
    const evidence = oneLine(obs.evidence, 300);
    if (obs.relation === "reinforce" && obs.relatesTo) {
      const updated = input.store.reinforce(obs.relatesTo, evidence, input.sessionId);
      if (updated) outcome.reinforced.push(updated);
      continue;
    }
    if (obs.relation === "contradict" && obs.relatesTo) {
      const updated = input.store.contradict(obs.relatesTo, evidence, input.sessionId);
      if (updated) {
        outcome.contradicted.push(updated);
        if (updated.status === "retired") outcome.retired.push(updated);
      }
      continue;
    }
    // Deduplicate near-identical new lessons before adding.
    const duplicate = existing.find((l) => nearDuplicate(l.text, obs.text));
    if (duplicate) {
      const updated = input.store.reinforce(duplicate.id, evidence, input.sessionId);
      if (updated) outcome.reinforced.push(updated);
      continue;
    }
    const added = input.store.add({
      text: obs.text,
      kind: obs.kind,
      evidence,
      sessionId: input.sessionId,
    });
    outcome.added.push(added);
  }

  return outcome;
}

function isValidObservation(obs: ReflectionObservation): boolean {
  if (!obs?.text || typeof obs.text !== "string") return false;
  if (obs.text.length < 8 || obs.text.length > 400) return false;
  if (!obs.evidence || typeof obs.evidence !== "string") return false; // evidence is mandatory
  if (!["constraint", "pattern", "failure", "preference", "discovery"].includes(obs.kind)) return false;
  if (!["new", "reinforce", "contradict"].includes(obs.relation)) return false;
  if ((obs.relation === "reinforce" || obs.relation === "contradict") && !obs.relatesTo) return false;
  // Reject secret-looking content outright.
  if (/(api[_-]?key|secret|token|password|bearer\s+[a-z0-9])/i.test(obs.text) && /[:=]\s*\S{8,}/.test(obs.text)) return false;
  return true;
}

function sanitizeSuggestions(suggestions: SpecSuggestion[]): SpecSuggestion[] {
  return suggestions
    .filter((s) => s && typeof s.target === "string" && s.target.startsWith(".memento/spec/"))
    .slice(0, 3)
    .map((s) => ({
      target: s.target,
      rationale: String(s.rationale ?? "").slice(0, 300),
      priority: ["high", "medium", "low"].includes(s.priority) ? s.priority : "low",
    }));
}

/** Cheap near-duplicate check: normalized prefix + high term overlap. */
function nearDuplicate(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (na === nb) return true;
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  if (shorter.length > 20 && longer.startsWith(shorter.slice(0, Math.floor(shorter.length * 0.8)))) return true;
  return false;
}

/** Condense a session transcript to fit a reflection prompt (~8k chars). */
function condenseTranscript(messages: Message[]): string {
  const parts: string[] = [];
  let budget = 8000;
  for (const msg of messages) {
    if (budget <= 0) break;
    let line: string | null = null;
    if (msg.role === "user") {
      line = `USER: ${oneLine(textOf(msg), 400)}`;
    } else if (msg.role === "assistant") {
      const text = oneLine(textOf(msg), 300);
      const calls = toolCallsOf(msg).map((c) => `${c.name}(${oneLine(JSON.stringify(c.args), 120)})`);
      line = [
        text ? `ASSISTANT: ${text}` : "",
        calls.length ? `TOOLS: ${calls.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
    } else if (msg.role === "tool") {
      const result = msg.content.find((b) => b.type === "toolResult") as { content: string; isError?: boolean } | undefined;
      if (result) {
        line = `RESULT${result.isError ? "(error)" : ""}: ${oneLine(result.content, 200)}`;
      }
    }
    if (line) {
      parts.push(line);
      budget -= line.length;
    }
  }
  return parts.join("\n");
}
