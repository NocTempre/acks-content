/**
 * Gear + clothing PRICE extraction (RR p131 Adventuring Equipment, p132
 * Clothing) → a name→{cost,weight6} map that enriches the gear/clothing
 * cookbook items (which carry names + @PdfText descriptions but no price).
 *
 * These pages are TWO-COLUMN price grids (left Item/Cost/Enc, right
 * Item/Cost/Enc). Same IP posture as the weapon/armour tables: geometry ships,
 * the prices materialize per-seat from the reader's own book. Cost is in gp;
 * the book prints gp/sp/cp (1gp = 10sp = 100cp — verified against core).
 */
import { rowsByY, joinRuns } from "./table-extract.mjs";

/**
 * Drop only footnote marks — NOT the weapon module's stripNoise, which also
 * eats single-letter runs matching the EQUIPMENT side-tab and so would swallow
 * a small-capped first letter ("Target" → "arget"). The running "EQUIPMENT"
 * header sits at the top margin (its own y-row, no price) and is filtered out
 * by the price requirement anyway, so nothing here needs the side-tab strip.
 */
function dropMarks(items) {
  return items.filter((it) => it.str && it.str.trim() && !/^[*†‡]+$/.test(it.str.trim()));
}

/** Column layout for one side of a two-column grid. */
const SIDE = (nameX0, nameX1, costX, encX) => ({ nameX0, nameX1, costX, encX });

export const PRICE_TABLES = Object.freeze({
  gear: {
    page: 131,
    anchors: ["Adventuring Equipment", "Adventurer"],
    rowTol: 3,
    sides: [SIDE(70, 222, 232, 290), SIDE(322, 472, 479, 537)],
  },
  clothing: {
    page: 132,
    anchors: ["Clothing", "Belt"],
    rowTol: 3,
    sides: [SIDE(45, 242, 247, null), SIDE(296, 488, 493, null)],
  },
});

/** Normalise a name to a lookup key (matches the gear entries). */
export function priceKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "") // drop "(1 lb)", "(1 pint)" qualifiers
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Look up a gear/clothing entry's price. Exact key first; then an UNAMBIGUOUS
 * prefix (exactly one priced variant whose key extends the entry's — e.g.
 * "Torch" → "Torches (6)"). A general category with several priced variants
 * ("Army Emblem" → Silver + Gold) returns null: those are not one priced item,
 * and guessing a variant would be wrong. Honest over a fabricated number.
 * @returns {{cost:number|null, weight6:number|null}|null}
 */
export function priceFor(map, name) {
  const k = priceKey(name);
  if (!k) return null;
  if (map.has(k)) return map.get(k);
  const variants = [...map.keys()].filter((gk) => gk.startsWith(k) && gk.length > k.length);
  return variants.length === 1 ? map.get(variants[0]) : null;
}

/** "10gp"→10, "3sp"→0.3, "2cp"→0.02, "5gp/60gp value"→5; "Varies"/blank→null. */
export function parseCost(text) {
  const s = String(text ?? "").trim();
  if (!s || /var/i.test(s)) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(gp|sp|cp)/i);
  if (!m) {
    const bare = s.match(/(\d+(?:\.\d+)?)/);
    return bare ? Number(bare[1]) : null;
  }
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return unit === "sp" ? n / 10 : unit === "cp" ? n / 100 : n;
}

/** Encumbrance (stone) → weight6. "1/6"→1, "2"→12; "-"/blank→null. */
function encToWeight6(enc) {
  const s = String(enc ?? "").trim();
  if (!s || s === "-") return null;
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return Math.round((Number(frac[1]) / Number(frac[2])) * 6);
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 6) : null;
}

/** Nearest run to an x-anchor within tol. */
function nearest(runs, x, tol = 16) {
  let best = null;
  for (const r of runs) {
    const d = Math.abs(r.x - x);
    if (d <= tol && (!best || d < best.d)) best = { d, r };
  }
  return best?.r.str.trim() ?? "";
}

/**
 * Extract every {name, cost, weight6} from a price grid (both columns).
 * @returns {{name:string, cost:number|null, weight6:number|null}[]}
 */
export function extractPrices(items, recipe) {
  const rows = rowsByY(dropMarks(items), recipe.rowTol ?? 3);
  const out = [];
  for (const r of rows) {
    for (const side of recipe.sides) {
      const nameRuns = r.items.filter((it) => it.x >= side.nameX0 && it.x < side.nameX1);
      const name = joinRuns(nameRuns).replace(/\s+/g, " ").trim();
      if (!name || name.length < 2) continue;
      const cost = parseCost(nearest(r.items, side.costX));
      const weight6 = side.encX != null ? encToWeight6(nearest(r.items, side.encX)) : null;
      // A real row must carry a price; header/section rows do not.
      if (cost == null && weight6 == null) continue;
      out.push({ name, cost, weight6 });
    }
  }
  return out;
}

/** True when a page is the given price grid (all anchors present). */
export function isPricePage(items, recipe) {
  const joined = items.map((i) => i.str).join(" ");
  return (recipe.anchors ?? []).every((a) => joined.includes(a));
}

/**
 * Build the combined name→{cost,weight6} price map from the reader's book,
 * across every PRICE_TABLES page. `readPage(doc,n)→{items}` is injected.
 * @returns {Promise<Map<string,{cost:number|null,weight6:number|null}>>}
 */
export async function extractPriceMapFromDoc(doc, readPage) {
  const map = new Map();
  for (const recipe of Object.values(PRICE_TABLES)) {
    const guess = recipe.page ?? 1;
    const order = [];
    for (let d = 0; d <= 14; d++) {
      if (guess + d <= doc.numPages) order.push(guess + d);
      if (d && guess - d >= 1) order.push(guess - d);
    }
    const seen = new Set(order);
    for (let p = 1; p <= doc.numPages; p++) if (!seen.has(p)) order.push(p);
    for (const p of order) {
      const { items } = await readPage(doc, p);
      if (!isPricePage(items, recipe)) continue;
      for (const row of extractPrices(items, recipe)) {
        const key = priceKey(row.name);
        if (key && !map.has(key)) map.set(key, { cost: row.cost, weight6: row.weight6 });
      }
      break; // found this recipe's page
    }
  }
  return map;
}
