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
import { getDocument, GlobalWorkerOptions, OPS } from "../vendor/pdf.mjs";

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

/** Reconstruct display-heading lines from large items (headings span items). */
function displayHeadings(items, cols) {
  const big = items.filter((it) => it.h >= HEADING_MIN_H).map((it) => ({ ...it, col: colOf(it.x, cols) }));
  const lines = {};
  for (const it of big) (lines[`${it.col}:${Math.round(it.y / 3)}`] ||= []).push(it);
  return Object.values(lines)
    .map((arr) => arr.sort((a, b) => a.x - b.x))
    .map((arr) => ({ text: arr.map((a) => a.str).join("").replace(/\s+/g, " ").trim(), y: arr[0].y, col: arr[0].col }))
    .filter((h) => h.text.length > 2);
}

/**
 * Every extraction anchor detected on a page, for interactive browsing:
 * display headings plus run-in candidates (line-initial "Name:" body items).
 * Returned in column/reading order with the mode each anchor needs.
 */
export function listHeadings({ items }) {
  const cols = detectColumns(items);
  const displays = displayHeadings(items, cols).map((h) => ({ text: h.text, mode: "display", col: h.col, y: h.y }));
  const runins = items
    .filter(
      (it) =>
        it.h < HEADING_MIN_H &&
        /^[A-Z][^:]{1,38}:\s*$/.test(it.str.trim()) &&
        cols.some((c) => Math.abs(it.x - c) < 15),
    )
    .map((it) => ({ text: it.str.trim(), mode: "runin", col: colOf(it.x, cols), y: it.y }));
  return [...displays, ...runins].sort((a, b) => a.col - b.col || a.y - b.y);
}

/**
 * Display-heading mode: anchor on a large heading, collect same-column body
 * text until the next large heading in that column (or page end).
 */
export function extractDisplay({ items, height }, heading) {
  const cols = detectColumns(items);
  const heads = displayHeadings(items, cols);
  const anchor = heads.find((h) => h.text.toLowerCase().startsWith(heading.toLowerCase()));
  if (!anchor) return null;
  // Collect same-column segments; a parent heading (e.g. "STATUE, ANIMATED"
  // directly over its variant "BRONZE") may own almost no prose of its own, so
  // keep extending past sub-headings until enough text accumulates.
  const later = heads
    .filter((h) => h.col === anchor.col && h.y > anchor.y + 2)
    .sort((a, b) => a.y - b.y);
  const bounds = [...later.map((h) => h.y), height];
  let prose = "";
  let from = anchor.y;
  for (const yMax of bounds) {
    const body = items.filter(
      (it) => it.h < HEADING_MIN_H && colOf(it.x, cols) === anchor.col && it.y > from && it.y < yMax,
    );
    prose = `${prose} ${joinProse(body)}`.trim();
    if (prose.length >= 60) break;
    from = yMax;
  }
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


/**
 * Spoils subsection: a bold run-in "Spoils" header followed by component
 * bullets like "beak (2 3/6 st, 150gp, sharpness, striking, swift sword)".
 * Self-calibrating like extractRunin. Returns [{name, weight6, cost, effects}].
 */
export function extractSpoils({ items, height }) {
  const cols = detectColumns(items);
  const anchor = items.find((it) => it.h < HEADING_MIN_H && it.str.trim() === "Spoils");
  if (!anchor) return [];
  const col = colOf(anchor.x, cols);
  const stop = items
    .filter(
      (it) =>
        it !== anchor &&
        it.y > anchor.y + 2 &&
        colOf(it.x, cols) === col &&
        (it.h >= HEADING_MIN_H || (it.alias === anchor.alias && Math.abs(it.x - cols[col]) < 15)),
    )
    .sort((a, b) => a.y - b.y)[0];
  const yMax = stop ? stop.y : height;
  const text = joinProse(items.filter((it) => colOf(it.x, cols) === col && it.y > anchor.y && it.y < yMax));
  const spoils = [];
  for (const m of text.matchAll(/([A-Za-z][A-Za-z' -]*?)\s*\((\d+)(?:\s*(\d)\/6)?\s*st,\s*([\d,]+)\s*gp(?:,\s*([^)]+))?\)/g)) {
    const stone = parseInt(m[2], 10); // book weights are authoritative as printed
    spoils.push({
      name: m[1].trim(),
      weight6: stone * 6 + (m[3] ? parseInt(m[3], 10) : 0),
      cost: parseInt(m[4].replace(/,/g, ""), 10),
      effects: (m[5] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    });
  }
  return spoils;
}


/* -------------------------------------------- */
/*  Page artwork                                */
/* -------------------------------------------- */

/** Image XObjects painted on a page: [{ name, width, height, kind, bitmap }]. */
export async function pageArtInfo(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const ops = await page.getOperatorList();
  const names = new Set();
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === OPS.paintImageXObject) names.add(ops.argsArray[i][0]);
  }
  const out = [];
  for (const name of names) {
    // Timeout-guarded: Node's fake pdf.js worker can stall object delivery on
    // pages after the first (the browser's real worker resolves normally) —
    // never hang, just report the image as unavailable.
    const img = await new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (!done) {
          done = true;
          resolve(value ?? null);
        }
      };
      try {
        page.objs.get(name, finish);
      } catch {
        try {
          page.commonObjs.get(name, finish);
        } catch {
          finish(null);
        }
      }
      setTimeout(() => finish(null), 3000);
    });
    if (img) out.push({ name, width: img.width, height: img.height, kind: img.kind, img });
  }
  return out;
}

/**
 * Pick the page's illustration: exclude page-background rasters (very wide)
 * and ornament strips (extreme aspect), take the largest remainder above a
 * minimum size. Returns the info entry or null.
 */
export function pickArt(infos) {
  return (
    infos
      .filter((i) => i.width >= 200 && i.height >= 200 && i.width < 1500)
      .filter((i) => i.width / i.height < 3 && i.height / i.width < 3)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null
  );
}

/**
 * Extract the page illustration as a PNG blob (browser only — needs canvas).
 * Handles pdf.js bitmap images and raw RGB/RGBA/gray data.
 */
export async function extractPageArt(doc, pageNo) {
  if (typeof document === "undefined") return null;
  const chosen = pickArt(await pageArtInfo(doc, pageNo));
  if (!chosen) return null;
  const { img, width, height } = chosen;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0, width, height);
  } else if (img.data) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const d = img.data;
    if (img.kind === 3) {
      rgba.set(d.subarray(0, rgba.length));
    } else if (img.kind === 2) {
      for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
        rgba[j] = d[i];
        rgba[j + 1] = d[i + 1];
        rgba[j + 2] = d[i + 2];
        rgba[j + 3] = 255;
      }
    } else {
      return null; // exotic formats: recipe-direction territory
    }
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  } else {
    return null;
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? { blob, width, height } : null;
}

/** Run one recipe against an open document. Returns prose string or null. */
export async function extractRecipe(doc, recipe) {
  if (recipe.page < 1 || recipe.page > doc.numPages) return null;
  const page = await pageItems(doc, recipe.page);
  return recipe.mode === "runin" ? extractRunin(page, recipe.heading) : extractDisplay(page, recipe.heading);
}
