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
    case "refListLower": {
      // "Crusader, Mage, Thief, Venturer" -> ["crusader","mage",...]
      return t.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    }
    case "rollBand": {
      // "11-16" | "10 or lower" | "19–20" -> {min?, max?}
      const range = t.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (range) {
        let min = +range[1], max = +range[2];
        if (max < min) max += 100; // d100 bands print "91–00" for 91–100
        return { min, max };
      }
      const lower = t.match(/(\d+)\s*or lower/i);
      if (lower) return { max: +lower[1] };
      const higher = t.match(/(\d+)\s*(?:\+|or higher)/i);
      if (higher) return { min: +higher[1] };
      const single = t.match(/^(\d+)$/);
      return single ? { min: +single[1], max: +single[1] } : null;
    }
    case "wagePeriod": {
      const m = t.match(/day|week|month|year/i);
      return m ? m[0].toLowerCase() : null;
    }
    case "gpPerUnit": {
      // "250gp/month" | "2sp/page" | "1gp/day/patient" -> {wage, wageUnit}
      const m = t.match(/([\d,.]+)\s*(gp|sp)\s*\/\s*(.+)/i);
      if (!m) return null;
      const wage = Number(m[1].replace(/,/g, "")) * (m[2].toLowerCase() === "sp" ? 0.1 : 1);
      return { wage, wageUnit: m[3].trim().replace(/\s+/g, "") };
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
  const { xMin = 0, xMax = Infinity } = recipe.column ?? {};
  items = items.filter((it) => it.x >= xMin && it.x <= xMax);
  const rows = rowsByY(items, recipe.rowTol ?? 3);
  const out = {};
  let cursor = 0;
  for (const spec of recipe.rows) {
    const re = new RegExp(spec.labelRe, "i");
    let matched = null;
    for (let i = cursor; i < rows.length; i++) {
      const label = joinRuns(rows[i].items.filter((it) => it.x < recipe.labelMaxX));
      if (label && re.test(label)) {
        // minCells: a prose line can echo a row label (JJ repeats tier names
        // in running text) — a real grid row must actually carry its cells.
        if (recipe.minCells) {
          const n = rows[i].items.filter((it) => it.x >= recipe.labelMaxX && !/^[*†‡]+$/.test(it.str.trim())).length;
          if (n < recipe.minCells) continue;
        }
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
        const v = raw == null ? null : applyCellPattern(raw, tspec.pattern ?? "raw");
        if (tspec.expand && v && typeof v === "object") Object.assign(row, v);
        else row[tspec.key] = v;
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
  // startAfter: skip everything above the marker row (a page may stack an
  // identically-labeled table above this one — the JS screen does).
  let cursor = 0;
  if (recipe.startAfter) {
    const idx = rows.findIndex((r) => r.items.some((it) => it.str.includes(recipe.startAfter)));
    if (idx >= 0) cursor = idx + 1;
  }
  for (const spec of recipe.rows) {
    const re = new RegExp(spec.labelRe, "i");
    for (let i = cursor; i < rows.length; i++) {
      const label = joinRuns(rows[i].items.filter((it) => it.x < recipe.labelMaxX));
      if (label && re.test(label)) {
        const valRuns = rows[i].items.filter((it) => it.x >= recipe.labelMaxX);
        const value = applyCellPattern(joinRuns(valRuns), recipe.cellPattern ?? "int");
        // labelPattern: the label itself carries data (a roll band); the
        // value lands under valueKey beside it.
        out[spec.key] = spec.labelPattern
          ? { ...applyCellPattern(label, spec.labelPattern), [recipe.valueKey ?? "value"]: value }
          : value;
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
// Full Unicode letters: the books print Buǧra, Mătine, Tϋlay — extraction
// keeps them as printed (the seat's book is authoritative over any
// hand-typed transliteration).
const NAME_RE = /^[\p{L}][\p{L}'’-]*$/u;

export function extractNameList(items, recipe) {
  const { xMin = 0, xMax = Infinity } = recipe.column ?? {};
  const inCol = items.filter((it) => it.x >= xMin && it.x <= xMax);
  const rows = rowsByY(inCol, recipe.rowTol ?? 3);
  // Labels match on the ROW's joined text (drop-caps split "M ale Names:"
  // across runs; joining repairs it), searching below an optional anchor so
  // stacked culture blocks in one column pick the right one.
  const rowText = (r) => r.items.map((it) => it.str).join("").replace(/\s+/g, " ").trim();
  let from = 0;
  if (recipe.startAfter) {
    const idx = rows.findIndex((r) => rowText(r).includes(recipe.startAfter));
    if (idx >= 0) from = idx;
  }
  const fields = recipe.fields.map((f) => {
    const labelBare = f.label.replace(/\s+/g, "");
    const rowIdx = rows.findIndex((r, i) => i >= from && rowText(r).replace(/\s+/g, "").startsWith(labelBare));
    return { ...f, rowIdx };
  });
  const out = {};
  fields.forEach((f, fi) => {
    if (f.rowIdx < 0) { out[f.key] = []; return; }
    const nextIdx = fields.slice(fi + 1).map((n) => n.rowIdx).find((i) => i > f.rowIdx);
    const endIdx = nextIdx ?? rows.length;
    // Tokenize PER ROW: the list's last line and the following prose join
    // without a comma, so a text-level split would glue the final name into
    // a prose token and lose it. A row contributes its valid name prefix;
    // the first invalid token ends the whole list.
    const names = [];
    let done = false;
    let openComma = false;
    for (let ri = f.rowIdx; ri < endIdx && !done; ri++) {
      // A display-size row is the next culture's heading — the list is over
      // (a lone capitalized heading would otherwise pass as a name).
      if (ri > f.rowIdx && rows[ri].items.some((it) => it.h >= 11)) break;
      // Cross into a stitched continuation page only when the previous line
      // ended mid-list (trailing comma) — else the list was complete and the
      // next page's margin furniture must not append.
      if (rows[ri].items.some((it) => it._p2) && !openComma) break;
      let line = rowText(rows[ri]);
      openComma = line.trim().endsWith(",");
      if (ri === f.rowIdx) {
        let li = 0, bi = 0;
        const bare = f.label.replace(/\s+/g, "");
        while (li < line.length && bi < bare.length) {
          if (line[li] !== " ") bi++;
          li++;
        }
        line = line.slice(li);
      }
      for (const raw of line.split(",").map((s) => s.trim()).filter(Boolean)) {
        // Drop-cap repair: a line-initial name splits as "U nnhild" — fuse
        // the lone letter back on (uppercased; the glyph extracts lowercase).
        const t = /^[\p{L}]\s[\p{Ll}'’-]/u.test(raw) ? raw[0].toUpperCase() + raw.slice(2) : raw;
        if (NAME_RE.test(t)) names.push(t);
        else { done = true; break; }
      }
    }
    out[f.key] = names;
  });
  return out;
}

/**
 * `bandGrid`: the JS-screen double-d100 class grid — a header row of bucket
 * d100 bands over columns, and body rows whose LABEL is the second-d100 band.
 * Both band sets and every class token are read from the page; `classMap` is
 * a token→key assist table (short print names → registry class keys).
 * Emits the reference `classDistribution` shape: buckets[{id,min,max,rows}].
 */
export function extractBandGrid(items, recipe) {
  const { xMin = 0, xMax = Infinity } = recipe.column ?? {};
  const inCol = items.filter((it) => it.x >= xMin && it.x <= xMax);
  const rows = rowsByY(inCol, recipe.rowTol ?? 4);
  const tol = recipe.columnTol ?? 20;
  const colOfRun = (run) => {
    let best = null;
    for (const col of recipe.cellColumns) {
      const d = Math.abs(run.x - col.x);
      if (d <= tol && (!best || d < best.d)) best = { col, d };
    }
    return best?.col ?? null;
  };
  // header row: the bucket bands, one per column
  const headIdx = rows.findIndex((r) => r.items.some((it) => it.str.includes(recipe.headerMark)));
  const bands = {};
  if (headIdx >= 0) {
    const byCol = {};
    for (const run of rows[headIdx].items) {
      const col = colOfRun(run);
      if (col) (byCol[col.key] ||= []).push(run);
    }
    for (const [key, runs] of Object.entries(byCol)) {
      bands[key] = applyCellPattern(runs.map((r) => r.str).join(""), "rollBand");
    }
  }
  // body rows: band label + one class token per column
  const buckets = recipe.cellColumns.map((c) => ({ id: c.key, ...(bands[c.key] ?? {}), rows: [] }));
  let cursor = headIdx + 1;
  for (const spec of recipe.rows) {
    const re = new RegExp(spec.labelRe, "i");
    for (let i = cursor; i < rows.length; i++) {
      const label = joinRuns(rows[i].items.filter((it) => it.x < recipe.labelMaxX));
      if (label && re.test(label)) {
        const range = applyCellPattern(label, "rollBand") ?? {};
        const byCol = {};
        for (const run of rows[i].items.filter((it) => it.x >= recipe.labelMaxX)) {
          const col = colOfRun(run);
          if (col) byCol[col.key] = (byCol[col.key] ?? "") + run.str;
        }
        for (const bucket of buckets) {
          const token = (byCol[bucket.id] ?? "").trim();
          if (!token) continue;
          const key = recipe.classMap?.[token] ?? token.toLowerCase();
          bucket.rows.push({ ...range, class: key });
        }
        cursor = i + 1;
        break;
      }
    }
  }
  return { buckets };
}

/**
 * `harvestPairs`: label→text rows harvested structurally rather than by an
 * enumerated spec — used where the row KEYS are themselves page content (the
 * JJ occupation→proficiency packages, ~100 rows over four pages). A row with
 * a label starts an entry; a row with only value-band runs continues the
 * previous entry's wrapped list; a label-only row (section heading) closes
 * the entry. Values split on commas into tokens, keeping parentheticals
 * ("Craft (scribe)").
 */
export function extractHarvestPairs(items, recipe) {
  const { xMin = 0, xMax = Infinity } = recipe.column ?? {};
  const inCol = items.filter((it) => it.x >= xMin && it.x <= xMax);
  const rows = rowsByY(inCol, recipe.rowTol ?? 3);
  const out = {};
  let openKey = null;
  const push = (key, text) => {
    if (!key) return;
    out[key] = ((out[key] ?? "") + " " + text).trim();
  };
  for (const row of rows) {
    const labelRuns = row.items.filter((it) => it.x < recipe.labelMaxX);
    const valueRuns = row.items.filter((it) => it.x >= recipe.labelMaxX);
    const label = joinRuns(labelRuns);
    const value = valueRuns.map((r) => r.str).join("").replace(/\s+/g, " ").trim();
    if (label && value) {
      openKey = label.toLowerCase();
      push(openKey, value);
    } else if (!label && value && openKey) {
      push(openKey, value); // wrapped continuation of the open entry
    } else {
      openKey = null; // heading or blank: close the entry
    }
  }
  const packs = {};
  for (const [key, text] of Object.entries(out)) {
    // Junk guards: a real occupation label is short and sentence-free —
    // prose pages interleave the table and must not mint entries.
    if (key.split(/\s+/).length > (recipe.maxKeyWords ?? 3)) continue;
    if (/[.:;!?]/.test(key)) continue;
    // Split on commas OUTSIDE parentheses: "Weapon Proficiency (axes,
    // bludgeons)" is one token.
    const tokens = [];
    let depth = 0, buf = "";
    for (const ch of text) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) { tokens.push(buf.trim()); buf = ""; }
      else buf += ch;
    }
    if (buf.trim()) tokens.push(buf.trim());
    const clean = tokens.filter(Boolean);
    if (clean.some((t) => t.split(/\s+/).length > 7 || /\./.test(t))) continue; // prose, not a token list
    if (clean.length >= (recipe.minTokens ?? 1)) packs[key] = clean;
  }
  return packs;
}

const SHAPES = { gridRows: extractGridRows, pairs: extractPairs, nameList: extractNameList, bandGrid: extractBandGrid, harvestPairs: extractHarvestPairs };

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
  if (recipe.emit?.path) {
    // Nest the keyed result at a path, deep-merging any static structure
    // (module labels etc. — structure, never book values).
    let out = raw;
    for (const key of [...recipe.emit.path].reverse()) out = { [key]: out };
    const merge = (a, b) => {
      for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a[k] ?? {}, v) : v;
      return a;
    };
    return recipe.emit.merge ? merge(out, recipe.emit.merge) : out;
  }
  if (recipe.emit?.wrapCulture) {
    const { cultureId, ...meta } = recipe.emit.wrapCulture;
    return { list: { [cultureId]: { ...meta, ...raw } } };
  }
  return raw;
}
