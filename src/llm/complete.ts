/**
 * One-shot completion helper built on the provider stream seam.
 * Used by the spec generator and the reflection engine — anywhere we need
 * "ask the model, get text" without the full agent loop.
 */
import type { LlmProvider, Message, ModelInfo, Usage } from "./types.ts";

export interface CompleteOptions {
  provider: LlmProvider;
  model: ModelInfo;
  apiKey?: string;
  baseUrl?: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
  error?: string;
}

export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  const message: Message = {
    id: "m_complete",
    role: "user",
    content: [{ type: "text", text: opts.user }],
    ts: Date.now(),
  };
  let text = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let error: string | undefined;

  // Same retry policy as the agent loop: one retry with a short backoff for
  // clean, retryable failures before any output arrived. Reflection and spec
  // generation are one-shot "ask the model" calls — a blipped 429 must not
  // silently cost the session its lesson.
  for (let attempt = 0; attempt < 2; attempt++) {
    text = "";
    usage = { inputTokens: 0, outputTokens: 0 };
    error = undefined;
    let retryable = false;
    try {
      for await (const event of opts.provider.stream(
        {
          model: opts.model.id,
          system: opts.system,
          messages: [message],
          tools: [],
          maxTokens: opts.maxTokens ?? Math.min(opts.model.maxOutput, 8192),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        },
        {
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      )) {
        if (event.type === "text_delta") text += event.text;
        else if (event.type === "done") usage = event.usage;
        else if (event.type === "error") {
          error = event.error;
          retryable = event.retryable;
        }
      }
    } catch (err) {
      error = (err as Error).message;
      retryable = !(opts.signal?.aborted ?? false); // a mid-stream drop is worth one retry
    }
    if (attempt === 0 && error && retryable && !text && !opts.signal?.aborted) {
      await sleep(700, opts.signal);
      if (opts.signal?.aborted) break;
      continue;
    }
    break;
  }

  return { text, usage, ...(error ? { error } : {}) };
}

/** Abort-aware sleep for the retry backoff. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Extract the first fenced code block (```json ... ```) or raw text — LLM output hygiene. */
export function extractFence(text: string, lang?: string): string {
  const pattern = lang
    ? new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "i")
    : /```[a-zA-Z]*\s*\n([\s\S]*?)```/;
  const match = text.match(pattern);
  if (match?.[1]) return match[1].trim();
  return text.trim();
}

/** Parse JSON from model output tolerating fences and leading prose. */
export function parseJsonLoose<T>(text: string): T | null {
  const candidates = [text.trim(), extractFence(text, "json"), extractFence(text)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try to slice from first { or [ to matching last } or ]
      const start = Math.min(
        ...[candidate.indexOf("{"), candidate.indexOf("[")].filter((i) => i >= 0).concat([Number.MAX_SAFE_INTEGER]),
      );
      if (start === Number.MAX_SAFE_INTEGER) continue;
      const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
      if (end <= start) continue;
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as T;
      } catch {
        continue;
      }
    }
  }
  return null;
}
