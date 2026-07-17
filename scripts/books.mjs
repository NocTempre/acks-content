/**
 * Book registry: every PDF the streamer can read, with edition fingerprints.
 * Fingerprints use page count + metadata title — NEVER file hashes (DTRPG
 * watermarks each customer's copy, so bytes differ per person).
 *
 * "cw" is INTENTIONALLY FAKE — no such book exists. It demonstrates the
 * missing-book path: its recipes can never resolve, so their stubs are what
 * every seat sees, forever.
 */

export const BOOKS = {
  rr: {
    label: "ACKS II Revised Rulebook",
    short: "RR",
    pages: 553,
    titleRe: /Revised Rulebook/i,
  },
  jj: {
    label: "ACKS II Judges Journal",
    short: "JJ",
    pages: 489,
    titleRe: /Judges Journal/i,
  },
  mm: {
    label: "ACKS II Monstrous Manual",
    short: "MM",
    pages: 441,
    titleRe: /Monstrous Manual/i,
  },
  cw: {
    label: "ACKS II Codex of Whispers (FAKE — missing-book demo)",
    short: "CW",
    pages: 999,
    titleRe: /Codex of Whispers/i,
    fake: true,
  },
};


/** Human-readable fingerprint check; returns null when OK, else a warning. */
export function fingerprintWarning(bookId, numPages, title) {
  const book = BOOKS[bookId];
  if (!book) return `unknown book id "${bookId}"`;
  const problems = [];
  if (numPages !== book.pages) problems.push(`page count ${numPages} (expected ${book.pages})`);
  if (title && !book.titleRe.test(title)) problems.push(`title "${title}"`);
  return problems.length ? `${book.label}: ${problems.join(", ")} — different edition/printing? Extraction may miss.` : null;
}
