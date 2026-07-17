/**
 * PDF text extraction engine (pdf.js) — column-first reconstruction validated
 * against the real ACKS II PDFs in a Node harness before shipping.
 *
 * Runs identically in the browser (Foundry client) and Node (tools/test
 * harness): the worker is only wired up when the module boots in Foundry
 * (setWorker below); under Node pdf.js falls back to its fake worker.
 *
 * Nothing here persists — callers receive plain strings and decide caching.
 */
import { getDocument, GlobalWorkerOptions } from "../vendor/pdf.mjs";

const HEADING_MIN_H = 12; // display headings are >=14pt; body is 9-10pt
const FOOTER_BAND = 32; // pt from page bottom: folios + DTRPG watermark line

export function setWorker(url) {
  GlobalWorkerOptions.workerSrc = url;
}

export async function openBook(data) {
  const doc = await getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const meta = await doc.getMetadata().catch(() => null);
  return { doc, numPages: doc.numPages, title: meta?.info?.Title ?? "" };
}

/** All positioned text items of a page (top-origin y), footers filtered. */
export async function pageItems(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items
    .filter((it) => typeof it.str === "string" && it.str.trim())
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: vp.height - it.transform[5],
      h: it.height,
      alias: it.fontName,
    }))
    .filter((it) => it.y < vp.height - FOOTER_BAND && !/Order #\d+/.test(it.str));
  return { items, width: vp.width, height: vp.height };
}

/** Column left edges from a histogram of body-item x origins (1-3 columns). */
function detectColumns(items) {
  const body = items.filter((it) => it.h < HEADING_MIN_H);
  const bins = {};
  for (const it of body) {
    const bin = Math.round(it.x / 10) * 10;
    bins[bin] = (bins[bin] || 0) + 1;
  }
  const peaks = Object.entries(bins)
    .map(([x, n]) => ({ x: +x, n }))
    .filter((b) => b.n > body.length * 0.08)
    .sort((a, b) => a.x - b.x);
  const cols = [];
  for (const p of peaks) {
    if (cols.length && p.x - cols[cols.length - 1] < 40) continue;
    cols.push(p.x);
  }
  return cols.length ? cols : [0];
}

const colOf = (x, cols) => {
  let best = 0;
  for (let i = 0; i < cols.length; i++) if (x >= cols[i] - 5) best = i;
  return best;
};

const joinProse = (items) =>
  items
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((it) => it.str)
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Display-heading mode: anchor on a large heading, collect same-column body
 * text until the next large heading in that column (or page end).
 */
export function extractDisplay({ items, height }, heading) {
  const cols = detectColumns(items);
  // Reconstruct heading lines from large items (a heading may span items).
  const big = items.filter((it) => it.h >= HEADING_MIN_H).map((it) => ({ ...it, col: colOf(it.x, cols) }));
  const lines = {};
  for (const it of big) (lines[`${it.col}:${Math.round(it.y / 3)}`] ||= []).push(it);
  const heads = Object.values(lines)
    .map((arr) => arr.sort((a, b) => a.x - b.x))
    .map((arr) => ({ text: arr.map((a) => a.str).join("").replace(/\s+/g, " ").trim(), y: arr[0].y, col: arr[0].col }))
    .filter((h) => h.text.length > 2);
  const anchor = heads.find((h) => h.text.toLowerCase().startsWith(heading.toLowerCase()));
  if (!anchor) return null;
  const next = heads
    .filter((h) => h.col === anchor.col && h.y > anchor.y + 2)
    .sort((a, b) => a.y - b.y)[0];
  const yMax = next ? next.y : height;
  const body = items.filter(
    (it) => it.h < HEADING_MIN_H && colOf(it.x, cols) === anchor.col && it.y > anchor.y && it.y < yMax,
  );
  const prose = joinProse(body);
  return prose.length > 20 ? prose : null;
}

/**
 * Run-in mode: the entry heading is body-size bold ("Grappling Hook:"). Find
 * it by text, learn the bold font's alias FROM the match (self-calibrating —
 * pdf.js aliases are per-document, so nothing is hardcoded), then collect
 * until the next line-initial item with that same alias (= next entry).
 */
export function extractRunin({ items, height }, heading) {
  const cols = detectColumns(items);
  const anchor = items.find((it) => it.str.trim().startsWith(heading));
  if (!anchor) return null;
  const col = colOf(anchor.x, cols);
  const stop = items
    .filter(
      (it) =>
        it !== anchor &&
        it.alias === anchor.alias &&
        colOf(it.x, cols) === col &&
        it.y > anchor.y + 2 &&
        Math.abs(it.x - cols[col]) < 15,
    )
    .sort((a, b) => a.y - b.y)[0];
  const yMax = stop ? stop.y : height;
  const body = items.filter((it) => {
    if (it === anchor || colOf(it.x, cols) !== col) return false;
    const sameLineAfter = Math.abs(it.y - anchor.y) <= 2 && it.x > anchor.x;
    return sameLineAfter || (it.y > anchor.y + 2 && it.y < yMax);
  });
  const prose = joinProse(body);
  return prose.length > 20 ? prose : null;
}

/** Run one recipe against an open document. Returns prose string or null. */
export async function extractRecipe(doc, recipe) {
  if (recipe.page < 1 || recipe.page > doc.numPages) return null;
  const page = await pageItems(doc, recipe.page);
  return recipe.mode === "runin" ? extractRunin(page, recipe.heading) : extractDisplay(page, recipe.heading);
}
