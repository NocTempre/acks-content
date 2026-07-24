/**
 * Book registry: every PDF the streamer can read, with edition fingerprints.
 * Fingerprints use page count + metadata title — NEVER file hashes (DTRPG
 * watermarks each customer's copy, so bytes differ per person).
 *
 * A fake book ("cw", Codex of Whispers) sat here to demonstrate the
 * missing-book path. Removed 2026-07-19: the cookbook now spans three real
 * books and no seat is expected to own all of them, so an unreadable entry is
 * the ordinary case and no longer needs a prop to show it off.
 *
 * The Judge's Screen inserts ("js") were listed too, because four hiring
 * tables were read off them. Removed 2026-07-24: every one of those tables is
 * printed in a book the reader already needs — three in the JJ, the signing
 * bonus in the RR — so the screen only ever added a fifth PDF to connect for
 * content the seat could already read. A book id is a promise that connecting
 * that PDF unlocks something; the cheatsheet no longer unlocks anything.
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
  mm: {
    label: "ACKS II Monstrous Manual",
    short: "MM",
    pages: 441,
    titleRe: /Monstrous Manual/i,
  },
  // ACKS I adventures (AX line). Metadata titles are EMPTY in these printings,
  // so the fingerprint gates on page count alone; titleRe stays for printings
  // that do carry one. printedOffset: printed folio = PDF page - offset, used
  // for citations (register pages/instructions always use PDF pages).
  ax2: {
    label: "AX2 Secrets of the Nethercity",
    short: "AX2",
    pages: 186,
    titleRe: /Secrets of the Nethercity/i,
    printedOffset: 2,
  },
  ax3: {
    label: "AX3 Capital of the Borderlands",
    short: "AX3",
    pages: 226,
    titleRe: /Capital of the Borderlands/i,
    printedOffset: 2,
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
