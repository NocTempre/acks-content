/**
 * Table extraction — materialize a ruledata TABLE from the seat's own PDF.
 *
 * Doctrine (docs/COOKBOOK.md, docs/RECIPES.md): the recipe ships **geometry
 * and patterns, never values**. A recipe says which book, which page, where
 * the row labels stop and the cells begin, and how to parse each cell — all
 * derived structural metadata that reproduces nothing without the source.
 * The dice, numbers and wages are read live from the reader's book and only
 * ever persist in their world (via the ruledata-import contract).
 *
 * Pure module: no Foundry imports. Runs in the browser (against a connected
 * PDF's pageItems) and in Node (tools/verification against the reference PDFs).
 */

/** Cluster a page's text items into rows by y proximity. */
export function rowsByY(items, tol = 3) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.y - last.y) <= tol) {
      last.items.push(it);
      last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

const joinRuns = (runs) => runs.map((r) => r.str).join("").replace(/\s+/g, " ").trim();

/** Apply a cell pattern to a joined string. Patterns are a fixed library. */
export function applyCellPattern(text, pattern = "raw") {
  const t = text.trim();
  switch (pattern) {
    case "raw":
      return t;
    case "int": {
      const m = t.match(/-?\d[\d,]*/);
      return m ? parseInt(m[0].replace(/,/g, ""), 10) : null;
    }
    case "num": {
      const m = t.match(/-?\d[\d,]*(?:\.\d+)?/);
      return m ? Number(m[0].replace(/,/g, "")) : null;
    }
    case "dashNull":
      return t === "-" || t === "—" || t === "" ? null : t;
    default:
      return t;
  }
}

/**
 * Find the PDF page for a recipe by locating its header text. `readPage(n)`
 * returns that page's `{items}` (the caller wires it to pageItems + the book).
 * Searches a window around the cited printed page first, then the whole book.
 */
export async function findPage(recipe, numPages, readPage) {
  const guess = recipe.pdfPage ?? recipe.printedPage ?? 1;
  const order = [];
  for (let d = 0; d <= (recipe.searchRadius ?? 8); d++) {
    if (guess + d <= numPages) order.push(guess + d);
    if (d && guess - d >= 1) order.push(guess - d);
  }
  const seen = new Set(order);
  for (let p = 1; p <= numPages; p++) if (!seen.has(p)) order.push(p);
  for (const p of order) {
    const { items } = await readPage(p);
    const text = items.map((i) => i.str).join(" ");
    if (text.includes(recipe.locate)) return { page: p, items };
  }
  return null;
}

/**
 * `gridRows`: a label column followed by N market-class cells and optional
 * trailing columns (wage etc.). Runs left of `labelMaxX` form the row label
 * (drop-caps split a label across runs — they all sit in the label band);
 * the remaining runs, in x order, are the cells.
 *
 * Row selection is by ordered label regexes so stray marker runs ("*", "†")
 * between rows are ignored: each spec claims the next row whose joined label
 * matches, scanning downward from the previous claim.
 */
export function extractGridRows(items, recipe) {
  const rows = rowsByY(items, recipe.rowTol ?? 3);
  const out = {};
  let cursor = 0;
  for (const spec of recipe.rows) {
    const re = new RegExp(spec.labelRe, "i");
    let matched = null;
    for (let i = cursor; i < rows.length; i++) {
      const label = joinRuns(rows[i].items.filter((it) => it.x < recipe.labelMaxX));
      if (label && re.test(label)) {
        matched = rows[i];
        cursor = i + 1;
        break;
      }
    }
    if (!matched) {
      out[spec.key] = { __missing: true };
      continue;
    }
    // Footnote markers (*, †, ‡) sit between rows and can y-merge into one;
    // they are never a cell value, so drop lone-marker runs from the band.
    const cellRuns = matched.items.filter((it) => it.x >= recipe.labelMaxX && !/^[*†‡]+$/.test(it.str.trim()));
    const cells = cellRuns.map((r) => r.str.trim());
    const marketN = recipe.marketCells ?? cells.length - (recipe.trailing?.length ?? 0);
    const market = cells.slice(0, marketN).map((c) => applyCellPattern(c, recipe.cellPattern ?? "dashNull"));
    const row = { [recipe.cellsKey ?? "byMarketClass"]: market };
    (recipe.trailing ?? []).forEach((tspec, i) => {
      const raw = cells[marketN + i];
      row[tspec.key] = raw == null ? null : applyCellPattern(raw, tspec.pattern ?? "raw");
    });
    if (spec.set) Object.assign(row, spec.set);
    out[spec.key] = row;
  }
  return out;
}

/**
 * `pairs`: a two-column key→value table (e.g. the Henchmen Monthly Wage
 * ladder: level → gp). Label band left of `labelMaxX`, the single value run
 * to its right.
 */
export function extractPairs(items, recipe) {
  const rows = rowsByY(items, recipe.rowTol ?? 3);
  const out = {};
  let cursor = 0;
  for (const spec of recipe.rows) {
    const re = new RegExp(spec.labelRe, "i");
    for (let i = cursor; i < rows.length; i++) {
      const label = joinRuns(rows[i].items.filter((it) => it.x < recipe.labelMaxX));
      if (label && re.test(label)) {
        const valRuns = rows[i].items.filter((it) => it.x >= recipe.labelMaxX);
        out[spec.key] = applyCellPattern(joinRuns(valRuns), recipe.cellPattern ?? "int");
        cursor = i + 1;
        break;
      }
    }
  }
  return out;
}

const SHAPES = { gridRows: extractGridRows, pairs: extractPairs };

/**
 * Shape the raw keyed extraction into the ruledata table's JSON, per
 * `recipe.emit`: `{container:"rows", keyField}` → `{rows:[{<keyField>, …}]}`
 * (each spec key becomes a row); `{wrap:"byMarketClass"}` → `{byMarketClass:
 * <keyed>}`; absent → the keyed object as-is.
 */
export function extractTable(items, recipe) {
  const fn = SHAPES[recipe.shape];
  if (!fn) throw new Error(`table-extract: unknown shape "${recipe.shape}"`);
  const raw = fn(items, recipe);
  if (recipe.emit?.container) {
    const kf = recipe.emit.keyField;
    return { [recipe.emit.container]: recipe.rows.map((s) => ({ [kf]: s.key, ...raw[s.key] })) };
  }
  if (recipe.emit?.wrap) return { [recipe.emit.wrap]: raw };
  return raw;
}
