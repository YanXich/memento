import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Short, sortable-ish, human-friendly id with a type prefix, e.g. `s_8f3k2ma9`. */
export function shortId(prefix: string, length = 8): string {
  // Rejection sampling keeps the alphabet uniform: 256 is not divisible by
  // 36, so `bytes[i] % 36` would bias the first four letters (~11% more
  // likely). Bytes ≥ 252 (36 × 7) are discarded; the rest map evenly.
  let out = "";
  while (out.length < length) {
    const bytes = randomBytes((length - out.length) * 2); // oversample — rejection discards ~1.5%
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i]! >= 252) continue;
      out += ALPHABET[bytes[i]! % ALPHABET.length];
    }
  }
  return `${prefix}_${out}`;
}

export function sessionId(): string {
  return shortId("s", 10);
}

export function messageId(): string {
  return shortId("m", 10);
}

export function lessonId(): string {
  return shortId("l", 8);
}

export function specDraftId(): string {
  return shortId("d", 8);
}

/** Compact timestamp used in file names: 20260420-193012 */
export function fileStamp(date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}
