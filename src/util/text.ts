/** Rough token estimate — 4 chars/token for latin, ~1.6 for CJK-heavy text. Good enough for budgeting. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
      (code >= 0x3040 && code <= 0x30ff) || // kana
      (code >= 0xac00 && code <= 0xd7af) // hangul
    ) {
      cjk++;
    }
  }
  const other = text.length - cjk;
  return Math.ceil(other / 4 + (cjk * 10) / 16);
}

export function truncate(text: string, maxChars: number, note = "… [truncated]"): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n${note} (${text.length - maxChars} chars omitted)`;
}

/** Keep the head and the tail of long text — usually the most informative parts. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2) - 40;
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return `${head}\n… [${text.length - half * 2} chars omitted] …\n${tail}`;
}

/** Normalize text for fuzzy keyword matching: lowercase, strip punctuation, collapse ws. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was", "be", "been",
  "this", "that", "it", "with", "as", "at", "by", "from", "we", "you", "i", "it's", "don't",
  "请", "把", "的", "了", "和", "与", "在", "是", "有", "我", "你", "他", "她", "它", "这", "那",
]);

/**
 * Light morphological variants — keyword recall needs "migration" and
 * "migrations" to match, without a full stemmer. Recall-biased: extra
 * variants only widen the term set, they never remove the original.
 */
function addWordVariants(terms: Set<string>, word: string): void {
  terms.add(word);
  if (word.length <= 4) return;
  if (word.endsWith("s") && !word.endsWith("ss")) {
    terms.add(word.slice(0, -1)); // migrations → migration
    if (word.endsWith("ies")) terms.add(word.slice(0, -3) + "y"); // policies → policy
  }
}

/** Extract searchable terms (latin words + CJK bigrams) without a full tokenizer. */
export function extractTerms(text: string): string[] {
  const norm = normalizeForMatch(text);
  const terms = new Set<string>();
  for (const word of norm.split(" ")) {
    if (word.length >= 2 && !STOPWORDS.has(word)) addWordVariants(terms, word);
  }
  // CJK bigrams: "登录页面" -> 登录/录页/页面 (captures contiguous Chinese phrases without a segmenter)
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.slice(i, i + 2);
      if (!STOPWORDS.has(bigram)) terms.add(bigram);
    }
    if (run.length <= 6) terms.add(run);
  }
  return [...terms];
}

/** Jaccard-like overlap score between two term lists. */
export function termOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** One-line summary of potentially multi-line text. */
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
