/**
 * SSE (Server-Sent Events) line parser.
 * Handles chunks that split lines mid-stream, which is the norm in practice.
 */
export async function* sseLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  /** Runs exactly once when the stream ends (normal, aborted, or broken). */
  onClose?: () => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  // Propagate the abort reason so callers can tell a user abort (AbortError)
  // apart from a timeout (TimeoutError) or a network drop.
  const abortErr = (): Error => {
    const reason = (signal as { reason?: unknown } | undefined)?.reason;
    return reason instanceof Error ? reason : new Error("aborted");
  };
  try {
    while (true) {
      if (signal?.aborted) throw abortErr();
      // A hung TCP connection must not hold the session hostage: race the
      // pending read against the abort signal, then cancel the stream so the
      // underlying socket is released.
      let done: boolean;
      let value: Uint8Array | undefined;
      if (signal) {
        let onAbort: () => void;
        const abort = new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          if (signal.aborted) return resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const outcome = await Promise.race([
          reader.read().then((r) => ({ kind: "read" as const, r })),
          abort.then(() => ({ kind: "aborted" as const })),
        ]);
        signal.removeEventListener("abort", onAbort!);
        if (outcome.kind === "aborted") throw abortErr();
        ({ done, value } = outcome.r);
      } else {
        ({ done, value } = await reader.read());
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        yield line;
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield buffer.replace(/\r$/, "");
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
    reader.releaseLock();
    onClose?.();
  }
}

/**
 * Map provider-specific HTTP failures to concise, actionable messages.
 * Status-aware so retry logic and humans can both act on it.
 */
export function describeHttpError(status: number, bodyText: string): { message: string; retryable: boolean } {
  const detail = bodyText.slice(0, 400);
  const retryable = status === 429 || status === 408 || (status >= 500 && status < 600);
  switch (status) {
    case 401:
    case 403:
      return { message: `Auth failed (${status}). Check your API key. ${detail}`, retryable: false };
    case 404:
      return { message: `Endpoint or model not found (404). Check baseUrl/model. ${detail}`, retryable: false };
    case 429:
      return { message: `Rate limited (429). ${detail}`, retryable: true };
    default:
      return { message: `HTTP ${status}: ${detail}`, retryable };
  }
}

/**
 * Combine an optional caller signal with a hard timeout. A hung gateway must
 * not hang the agent forever. The timeout fires a TimeoutError, which callers
 * distinguish from a user abort (AbortError).
 *
 * Cleanup is two-phase by design: the caller must call `clearTimeout` once the
 * fetch resolves (the HTTP request can no longer time out), but keep the
 * signal alive through stream reading — `dispose` detaches the abort listener
 * only when the whole response is consumed. Calling the old single `cancel`
 * after fetch silently disabled aborting mid-stream, which is exactly when
 * users hit Ctrl-C on a slow generation.
 */
export function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clearTimeout: () => void; dispose: () => void } {
  const controller = new AbortController();
  let onAbort: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) {
      controller.abort();
      return { signal: controller.signal, clearTimeout: () => {}, dispose: () => {} };
    }
    onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    try {
      controller.abort(new DOMException("request timeout", "TimeoutError"));
    } catch {
      controller.abort();
    }
  }, timeoutMs);
  return {
    signal: controller.signal,
    clearTimeout: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** True when an error is a user abort (distinct from a timeout/network drop). */
export function isAbortError(err: unknown): boolean {
  return (err as Error)?.name === "AbortError" && !/timeout/i.test((err as Error)?.message ?? "");
}
