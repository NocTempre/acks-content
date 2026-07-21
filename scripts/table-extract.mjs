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
    case "intDash": {
      if (t === "-" || t === "—" || t === "") return null;
      const m = t.match(/[+-]?\d[\d,]*/);
      return m ? parseInt(m[0].replace(/,/g, ""), 10) : null;
    }
    case "diceFormula": {
      // "1d6+15gp" amid prose -> "1d6+15"; "1d3gp" -> "1d3"
      const m = t.match(/\d+d\d+(?:\s*[+x×]\s*\d+)?/);
      return m ? m[0].replace(/\s+/g, "") : null;
    }
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
    let row;
    if (recipe.cellColumns) {
      // X-anchored columns: sparse rows may omit their dash cells entirely
      // (RR cataphract row), so positions lie — bind each run to the nearest
      // declared column x instead. `row: true` entries land on the row.
      const obj = {};
      row = recipe.cellsKey ? { [recipe.cellsKey]: obj } : (row = {});
      const tol = recipe.columnTol ?? 14;
      for (const run of cellRuns) {
        let best = null;
        for (const col of recipe.cellColumns) {
          const d = Math.abs(run.x - col.x);
          if (d <= tol && (!best || d < best.d)) best = { col, d };
        }
        if (!best) continue;
        const v = applyCellPattern(run.str, best.col.pattern ?? recipe.cellPattern ?? "intDash");
        if (v == null && recipe.omitNullCells && !best.col.row) continue;
        if (best.col.row) row[best.col.key] = v;
        else obj[best.col.key] = v;
      }
      if (recipe.cellsKey) row[recipe.cellsKey] = obj;
    } else if (recipe.cellKeys) {
      // Named cells → an object under cellsKey (classPercentages weights,
      // mercenary per-race wages). omitNullCells drops dash cells so sparse
      // race columns emit only the races the book prices.
      const obj = {};
      recipe.cellKeys.forEach((k, i) => {
        const v = applyCellPattern(cells[i] ?? "", recipe.cellPattern ?? "int");
        if (v == null && recipe.omitNullCells) return;
        obj[k] = v;
      });
      row = recipe.cellsKey ? { [recipe.cellsKey]: obj } : obj;
      (recipe.trailing ?? []).forEach((tspec, i) => {
        const raw = cells[recipe.cellKeys.length + i];
        row[tspec.key] = raw == null ? null : applyCellPattern(raw, tspec.pattern ?? "raw");
      });
    } else {
      // Positional cells → an array (market-class grids), plus trailing cols.
      const marketN = recipe.marketCells ?? cells.length - (recipe.trailing?.length ?? 0);
      const market = cells.slice(0, marketN).map((c) => applyCellPattern(c, recipe.cellPattern ?? "dashNull"));
      row = { [recipe.cellsKey ?? "byMarketClass"]: market };
      (recipe.trailing ?? []).forEach((tspec, i) => {
        const raw = cells[marketN + i];
        row[tspec.key] = raw == null ? null : applyCellPattern(raw, tspec.pattern ?? "raw");
      });
    }
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
  // `parts`: independent column bands (side-by-side ladder halves) merged
  // into one keyed object; each part carries its own column + rows.
  if (recipe.parts) {
    const out = {};
    for (const part of recipe.parts) Object.assign(out, extractPairs(items, { ...recipe, ...part, parts: null }));
    return out;
  }
  const { xMin = 0, xMax = Infinity } = recipe.column ?? {};
  const inCol = items.filter((it) => it.x >= xMin && it.x <= xMax);
  const rows = rowsByY(inCol, recipe.rowTol ?? 3);
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

/**
 * `nameList`: a culture's name lists (RR People) — `Male Names:`,
 * `Female Names:`, `Surnames:` each a comma list that wraps across lines. The
 * page is two-column, so `column` bounds the culture's side; each field runs
 * from its label to the next field's label (the last one until the list stops
 * looking like names). Names are DATA and persist; the surrounding appearance
 * PROSE is never touched. A valid name is one capitalized token (accents ok).
 */
const NAME_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*$/;

export function extractNameList(items, recipe) {
  const { xMin = 0, xMax = Infinity } = recipe.column ?? {};
  const inCol = items.filter((it) => it.x >= xMin && it.x <= xMax);
  const rows = rowsByY(inCol, recipe.rowTol ?? 3);
  const fields = recipe.fields.map((f) => ({
    ...f,
    rowIdx: rows.findIndex((r) => r.items.some((it) => it.str.trim().startsWith(f.label))),
  }));
  const out = {};
  fields.forEach((f, fi) => {
    if (f.rowIdx < 0) { out[f.key] = []; return; }
    const nextIdx = fields.slice(fi + 1).map((n) => n.rowIdx).find((i) => i > f.rowIdx);
    const endIdx = nextIdx ?? rows.length;
    let text = "";
    for (let ri = f.rowIdx; ri < endIdx; ri++) {
      let runs = rows[ri].items;
      if (ri === f.rowIdx) {
        const li = runs.findIndex((it) => it.str.trim().startsWith(f.label));
        runs = runs.slice(li);
        runs = runs.map((it, i2) => (i2 === 0 ? { ...it, str: it.str.replace(f.label, "") } : it));
      }
      text += " " + runs.map((r) => r.str).join("");
    }
    const tokens = text.split(",").map((s) => s.trim()).filter(Boolean);
    const names = [];
    for (const t of tokens) {
      if (NAME_RE.test(t)) names.push(t);
      else break; // hit prose (a lowercase or multi-word run) → list ended
    }
    out[f.key] = names;
  });
  return out;
}

const SHAPES = { gridRows: extractGridRows, pairs: extractPairs, nameList: extractNameList };

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
    return { [recipe.emit.container]: recipe.rows.map((s) => (kf ? { [kf]: s.key, ...raw[s.key] } : raw[s.key])) };
  }
  if (recipe.emit?.wrap) return { [recipe.emit.wrap]: raw };
  if (recipe.emit?.wrapCulture) {
    const { cultureId, ...meta } = recipe.emit.wrapCulture;
    return { list: { [cultureId]: { ...meta, ...raw } } };
  }
  return raw;
}
