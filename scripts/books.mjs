/**
 * Book registry: every PDF the streamer can read, with edition fingerprints.
 * Fingerprints use page count + metadata title — NEVER file hashes (DTRPG
 * watermarks each customer's copy, so bytes differ per person).
 *
 * A fake book ("cw", Codex of Whispers) sat here to demonstrate the
 * missing-book path. Removed 2026-07-19: the cookbook now spans three real
 * books and no seat is expected to own all of them, so an unreadable entry is
 * the ordinary case and no longer needs a prop to show it off.
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
  bta: {
    label: "By This Axe: The Cyclopedia of Dwarven Civilization",
    short: "BTA",
    pages: 273,
    titleRe: /By This Axe/i,
  },
  js: {
    label: "ACKS II Judges Screen Inserts",
    short: "JS",
    pages: 24,
    titleRe: /Judges Screen/i,
  },
  mm: {
    label: "ACKS II Monstrous Manual",
    short: "MM",
    pages: 441,
    titleRe: /Monstrous Manual/i,
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
