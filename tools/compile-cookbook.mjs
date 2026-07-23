/**
 * Cookbook compiler — the OFFLINE smart side (see docs/RECIPES.md stage 4,
 * docs/COOKBOOK.md for the output schema). Resolves every register entry
 * against the LOCAL reference PDFs into explicit, geometry-addressed
 * instructions the dumb executor replays: claim boxes, paragraph breaks,
 * per-stat value boxes, attack segments, glyph-color picks, art criteria.
 *
 * ALL judgment lives here (column detection, anchor search, paragraph
 * segmentation, name stemming, color-run matching) — none of it ships as
 * code, only as data. Requires C:\Proj\acks-reference; never CI.
 *
 * Usage: node tools/compile-cookbook.mjs [book] [--out <dir>]
 *        (default: all books with entries, written into cookbook/)
 * Emits: <out>/<book>.json + <out>/registers.json; report to stderr.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBook, pageItems, listHeadings, detectColumns, colOf, glyphColorRuns } from "../scripts/extract.mjs";
import { runsIn, joinRuns, attackModel } from "../scripts/executor.mjs";
import { BOOKS, fingerprintWarning } from "../scripts/books.mjs";
import { FILES } from "./reference-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTER = path.join(HERE, "..", "register");

/**
 * Args: an optional book id to compile alone, and `--out <dir>` to redirect
 * every write. The output dir is read back as well as written (prior compiles
 * are folded in, and index.json is built from the directory listing), so it is
 * one dir, not a write-only sink: pointing it at an empty scratch dir yields a
 * from-scratch compile, which is exactly what tools/check-cookbook-drift.mjs
 * needs to diff against what is committed.
 */
const argv = process.argv.slice(2);
const positional = [];
let outArg = null; // null = no --out; undefined = --out with nothing after it
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--out") outArg = argv[++i];
  else if (a.startsWith("--out=")) outArg = a.slice("--out=".length);
  else positional.push(a);
}
// Never silently fall back to cookbook/ on a malformed --out: a caller that
// asked for a scratch dir and got the real one would overwrite the very files
// it meant to compare against.
if (outArg === undefined || outArg === "") {
  console.error("compile-cookbook: --out needs a directory");
  process.exit(2);
}
const COOKBOOK = outArg ? path.resolve(outArg) : path.join(HERE, "..", "cookbook");

const HEADING_MIN_H = 12; // mirrors extract.mjs
// Definition bodies are 9pt prose (+ ~5pt superscript ordinals). Italic
// pull-quote/maxim blocks between entries print at ~10.5pt and are NOT part of
// the entry, so definition body collection caps below them.
const DEF_BODY_MAX_H = 10;
// Body text starts below the running head; definition blocks are COLUMN-FLOWED,
// so one that reaches the bottom of its column continues at the top of the next.
const DEF_TOP_BAND = 60;

/**
 * The continuation of a column-flowed definition block: everything in the NEXT
 * column above the first anchor there. Returns [] when the block ended normally
 * (a stop anchor was found in its own column) or there is no next column.
 * `isAnchor` identifies the heading style that ends a block in this kind.
 */
function columnFlow(pd, cols, col, stopFound, isAnchor) {
  if (stopFound || col + 1 >= cols.length) return [];
  const next = col + 1;
  const firstAnchor = pd.items
    .filter((it) => colOf(it.x, cols) === next && it.y > DEF_TOP_BAND && isAnchor(it))
    .sort((a, b) => a.y - b.y)[0];
  const yMax = firstAnchor ? firstAnchor.y - 4 : pd.height;
  return pd.items.filter(
    (it) => it.h < DEF_BODY_MAX_H && colOf(it.x, cols) === next && it.y > DEF_TOP_BAND && it.y < yMax,
  );
}

/**
 * The overleaf continuation: a block that reaches the bottom of the LAST column
 * resumes in the first column of the next page. Returns null when there is
 * nothing to continue onto.
 */
async function pageFlow(doc, page, isAnchor) {
  if (page + 1 > doc.numPages) return null;
  const pd2 = await pageItems(doc, page + 1);
  const cols2 = detectColumns(pd2.items);
  const first = pd2.items
    .filter((it) => colOf(it.x, cols2) === 0 && it.y > DEF_TOP_BAND && isAnchor(it))
    .sort((a, b) => a.y - b.y)[0];
  const yMax = first ? first.y - 4 : pd2.height;
  const items = pd2.items.filter(
    (it) => it.h < DEF_BODY_MAX_H && colOf(it.x, cols2) === 0 && it.y > DEF_TOP_BAND && it.y < yMax,
  );
  return { pd: pd2, cols: cols2, items, page: page + 1 };
}
const LABEL_RE = /^[A-Z][A-Za-z ()'/]{0,28}:$/;
const DICE_RE = /\d*d\d+(?:[×xX]\d+)?(?:[+-]\d+)?/; // mirrors scripts/executor.mjs
const cleanSeg = (s) => (s ?? "").replace(/[-′″]/g, "").replace(/\s+/g, " ").trim();
// A real damage segment: dice, a flat number, or a "by weapon" placeholder
// (mirror of executor.isDamageSeg — must stay identical so segment COUNT
// matches at runtime and color picks line up).
const isDamageSeg = (s) => {
  const c = cleanSeg(s);
  return DICE_RE.test(c) || /^\d+$/.test(c) || /weapon/i.test(c);
};
const inBoxRaw = (it, box) => it.x >= box.x0 && it.x <= box.x1 && it.y >= box.y0 && it.y <= box.y1;

const warns = [];
const warn = (s) => {
  warns.push(s);
  console.error(`WARN ${s}`);
};

/* -------------------------------------------- */
/*  Register loading                            */
/* -------------------------------------------- */

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function loadRegister() {
  const entries = [];
  const kinds = {};
  const refs = {};
  for (const dirent of fs.readdirSync(REGISTER, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith("_")) continue;
    for (const f of fs.readdirSync(path.join(REGISTER, dirent.name)).sort()) {
      if (!f.endsWith(".json")) continue;
      for (const e of readJson(path.join(REGISTER, dirent.name, f))) entries.push(e);
    }
  }
  const kindsDir = path.join(REGISTER, "_kinds");
  if (fs.existsSync(kindsDir)) {
    for (const f of fs.readdirSync(kindsDir).sort()) {
      if (!f.endsWith(".json")) continue;
      const k = readJson(path.join(kindsDir, f));
      kinds[k.id] = k;
    }
  }
  const refsDir = path.join(REGISTER, "_refs");
  if (fs.existsSync(refsDir)) {
    for (const f of fs.readdirSync(refsDir).sort()) {
      if (!f.endsWith(".json")) continue;
      const r = readJson(path.join(refsDir, f));
      refs[r.registry] = r;
    }
  }
  return { entries, kinds, refs };
}

/** register/_refs -> cookbook registers.json (tables + nodes). */
function compileRegisters(refs) {
  const tables = {};
  const nodes = {};
  for (const [name, reg] of Object.entries(refs)) {
    if (reg.shape === "table") {
      tables[name] = reg.table;
      continue;
    }
    const table = {};
    for (const [token, row] of Object.entries(reg.tokens ?? {})) {
      const key = reg.tokenEncoding === "puaHex" ? String.fromCodePoint(parseInt(token, 16)) : token;
      table[key] = row;
    }
    tables[name] = table;
    const role = reg.shape === "keyword" ? "keyword" : "definition";
    for (const [id, node] of Object.entries(reg.nodes ?? {})) {
      if (nodes[id]) warn(`duplicate node ${id} (registry ${name})`);
      nodes[id] = { role, ...node };
    }
  }
  return { schema: "acks-cookbook/1", tables, nodes, derive: DERIVE_PATTERNS };
}

/**
 * Shipped vocabulary for values the books state in PROSE rather than in a
 * labelled field. The PATTERN ships; the number it finds never does — it is
 * matched against the reader's own extracted text at runtime, exactly like the
 * defense and effect scans.
 *
 * `powerValue` is the custom-class build cost ("counts as 2 1/2 custom
 * powers"). It used to be resolved offline and shipped as a number, which put
 * book values in the module; this is the fix.
 */
const DERIVE_PATTERNS = {
  powerValue: {
    // \s* at every boundary: the extracted join drops inter-run spaces.
    pattern: "counts\\s*as\\s+((?:\\d+\\s+)?\\d+\\s*/\\s*\\d+|\\d+)\\s*(?:a\\s+)?(?:custom\\s+)?powers?\\b",
    as: "count",
  },
};

/* -------------------------------------------- */
/*  Geometry helpers                            */
/* -------------------------------------------- */

/** Cluster items into lines by y (±2), sorted by y. */
function toLines(items) {
  const lines = [];
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= 2);
    if (line) {
      line.items.push(it);
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }
  return lines.sort((a, b) => a.y - b.y);
}

/**
 * Text-assembly fixes for a run sequence (the executor's exact enumeration —
 * runsIn/joinRuns imported for parity). Judgment lives here; ordinals ship.
 *  - same-line gap > 1pt        -> joinSpace (pdf runs omit inter-word spaces)
 *  - line change, no hyphen     -> joinSpace
 *  - line change after hyphen   -> mergeHyphen when the next run starts
 *    lowercase (plain hyphenation), else keep the hyphen (compound words).
 */
function computeFixes(runs) {
  const joinSpace = [];
  const mergeHyphen = [];
  for (let i = 0; i < runs.length - 1; i++) {
    const a = runs[i];
    const b = runs[i + 1];
    // A superscript ordinal sits ~4pt above its baseline but belongs to the SAME
    // word ("1"+"st"), so judge it by the x-gap like any same-line neighbour
    // rather than defaulting to a space and printing "1 st level".
    const superscript = Math.min(a.h, b.h) < Math.max(a.h, b.h) * 0.75;
    const sameLine = Math.abs(a.y - b.y) <= 2 || superscript;
    if (sameLine) {
      const gap = b.x - (a.x + (a.w ?? 0));
      if (gap > 1 && !/\s$/.test(a.str)) joinSpace.push(i);
    } else if (/-\s*$/.test(a.str) && /^[a-z]/.test(b.str.trimStart())) {
      mergeHyphen.push(i);
    } else if (!/\s$/.test(a.str)) {
      joinSpace.push(i);
    }
  }
  const fixes = {};
  if (joinSpace.length) fixes.joinSpace = joinSpace;
  if (mergeHyphen.length) fixes.mergeHyphen = mergeHyphen;
  return Object.keys(fixes).length ? fixes : null;
}

/**
 * Attach computed fixes to an instruction (or a text para). `dropSet` marks
 * items (e.g. divider-heading lines caught inside a row box) to ship as
 * `fixes.drop` ordinals so the executor discards them.
 */
function withFixes(instr, pd, dropSet, stripMap) {
  const runs = runsIn(pd, instr);
  const fixes = computeFixes(runs) ?? {};
  if (dropSet) {
    const drop = runs.map((r, i) => (dropSet.has(r) ? i : -1)).filter((i) => i >= 0);
    if (drop.length) fixes.drop = drop;
  }
  // How many leading characters of a run belong to the heading rather than the
  // prose. Ships as a COUNT, not the text — the characters live in the reader's
  // book, and the recipe only says how many of them to skip.
  if (stripMap?.size) {
    const strip = {};
    runs.forEach((r, i) => {
      if (stripMap.has(r)) strip[i] = stripMap.get(r);
    });
    if (Object.keys(strip).length) fixes.stripPrefix = strip;
  }
  if (Object.keys(fixes).length) instr.fixes = fixes;
  return instr;
}

/** Paragraph boxes from body lines: break where the line gap opens up. */
function paragraphBoxes(lines, x0, x1) {
  if (!lines.length) return [];
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i].y - lines[i - 1].y);
  const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 12;
  const paras = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].y - lines[i - 1].y > median * 1.6) paras.push([]);
    paras[paras.length - 1].push(lines[i]);
  }
  return paras.map((ls) => ({
    box: { x0, x1, y0: ls[0].y - 3, y1: ls[ls.length - 1].y + 3 },
  }));
}

/* -------------------------------------------- */
/*  Attack-name stemming (compiler judgment)    */
/* -------------------------------------------- */

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const camel = (s) =>
  s.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean)
    .map((w, i) => (i ? cap(w.toLowerCase()) : w.toLowerCase())).join("");

/* -------------------------------------------- */
/*  Monster compilation                         */
/* -------------------------------------------- */

async function compileMonster(doc, entry, kindRow, glyphChars) {
  // Per-entry ASSISTS (docs/RECIPES.md): chef-authored one-off directions the
  // compiler honors before its own heuristics. Supported: anchor (exact
  // display text), statPage, spoilsPage, noSpoils, noArt, descStopHeading.
  const assists = entry.assists ?? {};
  const page = entry.pages[0];
  const pd = await pageItems(doc, page);
  const cols = detectColumns(pd.items);

  const anchors = listHeadings(pd).filter((a) => a.mode === "display");
  // Fallback ladder for outline titles that differ from the printed heading
  // (parent/variant pages: "Statue, Animated Bronze" prints as "BRONZE" under
  // a "STATUE, ANIMATED" parent; "(Overview)" suffixes never print). Try the
  // full title, then without parentheticals, then progressively shorter word
  // tails. The string that MATCHES becomes the shipped expect text.
  const candidates = [];
  if (assists.anchor) candidates.push(assists.anchor);
  candidates.push(entry.anchor.display);
  const noParen = entry.anchor.display.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (noParen && noParen !== entry.anchor.display) candidates.push(noParen);
  const words = noParen.replace(/,/g, "").split(/\s+/).filter(Boolean);
  for (let i = 1; i < words.length; i++) candidates.push(words.slice(i).join(" "));
  let anchor = null;
  let matchedText = entry.anchor.display;
  for (const c of candidates) {
    anchor = anchors.find((a) => a.text.toLowerCase().startsWith(c.toLowerCase()));
    if (anchor) {
      matchedText = c;
      break;
    }
  }
  if (!anchor) throw new Error(`display anchor "${entry.anchor.display}" not found on p.${page}`);
  if (matchedText !== entry.anchor.display) console.error(`NOTE ${entry.id}: anchored via fallback "${matchedText}"`);

  const colX = cols[anchor.col];
  const nextX = cols[anchor.col + 1];
  const proseBox = { x0: colX - 5, x1: nextX ? nextX - 6 : pd.width };
  // Long names WRAP onto a second display line ("FAERIE, BROWNIE" /
  // "(BOGGART)") — absorb same-column display lines within one heading
  // line-height into the anchor block instead of treating them as the next
  // monster's heading (which would empty the description region).
  let anchorEndY = anchor.y;
  const laterHeads = [];
  for (const h of anchors.filter((a) => a.col === anchor.col && a.y > anchor.y + 2).sort((a, b) => a.y - b.y)) {
    if (h.y - anchorEndY <= 26) anchorEndY = h.y;
    else laterHeads.push(h);
  }
  let stopY = laterHeads[0]?.y ? laterHeads[0].y - 4 : pd.height;
  if (assists.descStopHeading) {
    const stopHead = laterHeads.find((h) => h.text.toLowerCase().startsWith(assists.descStopHeading.toLowerCase()));
    if (stopHead) stopY = stopHead.y - 4;
    else warn(`${entry.id}: assists.descStopHeading "${assists.descStopHeading}" not found`);
  }

  const bodyIn = (p, x0, x1, y0, y1) =>
    p.items.filter((it) => it.h < HEADING_MIN_H && it.x >= x0 && it.x <= x1 && it.y > y0 && it.y < y1);

  // Prose column body; Spoils splits the region so claims never overlap.
  const proseItems = bodyIn(pd, proseBox.x0, proseBox.x1, anchorEndY + 2, stopY);
  let spoilsAnchor = proseItems.find((it) => it.str.trim() === "Spoils");
  let spoilsPd = pd;
  let spoilsPage = page;
  let spoilsBox = spoilsAnchor
    ? { x0: proseBox.x0, x1: proseBox.x1, y0: spoilsAnchor.y - 3, y1: stopY }
    : null;
  const descEnd = spoilsAnchor ? spoilsAnchor.y - 3 : stopY;
  const descItems = proseItems.filter((it) => it.y < descEnd);

  const fields = {};
  fields.name = {
    op: "expect", page,
    box: { x0: proseBox.x0, x1: proseBox.x1, y0: anchor.y - 16, y1: anchorEndY + 6 },
    text: matchedText,
  };
  // Description SECTIONS: the MM prints run-in section labels as their own
  // bold runs (same mechanism as the "Spoils" anchor). Classify each paragraph
  // by the nearest label above it; leading unlabeled prose = "appearance".
  // Entries with NO labels are flagged for the classification agents.
  const SECTION_LABELS = {
    "Combat": "combat", "Ecology": "ecology", "Encounter": "encounter",
    "Special Rules": "specialRules", "Lair": "lair", "Appearance": "appearance",
    "Behavior": "behavior", "Legends": "lore", "Lore": "lore",
  };
  const sectionAnchors = descItems
    .filter((it) => SECTION_LABELS[it.str.trim()])
    .sort((a, b) => a.y - b.y);
  const descParas = paragraphBoxes(toLines(descItems), proseBox.x0, proseBox.x1).map((p) => withFixes(p, pd));
  for (const p of descParas) {
    const above = [...sectionAnchors].reverse().find((a) => a.y <= p.box.y0 + 8);
    p.section = above ? SECTION_LABELS[above.str.trim()] : "appearance";
    const owns = sectionAnchors.find((a) => a.y >= p.box.y0 && a.y <= p.box.y1);
    if (owns) p.dropText = owns.str.trim();
  }
  if (!sectionAnchors.length && descParas.length > 2) {
    console.error(`NOTE ${entry.id}: no section labels in description (${descParas.length} paras) — agent classification candidate`);
  }
  fields.description = { op: "text", page, paras: descParas };
  /* --- stat column (with two-page fallback for multi-page monsters) --- */
  const labelsOf = (p, pcols) => {
    const li = p.items.filter((it) => it.h < HEADING_MIN_H && LABEL_RE.test(it.str.trim()));
    const idx = [...new Set(li.map((it) => colOf(it.x, pcols)))]
      .map((c) => [c, li.filter((it) => colOf(it.x, pcols) === c).length])
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    return { labels: li.filter((it) => colOf(it.x, pcols) === idx).sort((a, b) => a.y - b.y), idx };
  };

  let statPd = pd;
  let statPage = page;
  let statCols = cols;
  let { labels: statLabels, idx: statColIdx } = labelsOf(pd, cols);
  // Prose column on the stat page, for the value-region bound (anchor page:
  // the anchor's own column).
  let statProseX = colX;
  if ((assists.statPage && assists.statPage !== page) || (statLabels.length < 8 && page + 1 <= doc.numPages)) {
    const pd2 = await pageItems(doc, assists.statPage ?? page + 1);
    const cols2 = detectColumns(pd2.items);
    const r2 = labelsOf(pd2, cols2);
    if (r2.labels.length >= 8 || (assists.statPage && r2.labels.length)) {
      statPd = pd2;
      statPage = assists.statPage ?? page + 1;
      statCols = cols2;
      statLabels = r2.labels;
      statColIdx = r2.idx;
      // Dominant non-stat column = the continuation prose on this page.
      const other = cols2
        .map((cx, i) => [i, pd2.items.filter((it) => it.h < HEADING_MIN_H && colOf(it.x, cols2) === i).length])
        .filter(([i]) => i !== statColIdx)
        .sort((a, b) => b[1] - a[1])[0];
      statProseX = other ? cols2[other[0]] : -1;
      console.error(`NOTE ${entry.id}: stat block found on p.${statPage} (multi-page monster)`);
    }
  }
  const statX0 = statCols[statColIdx] - 5;
  // Mirrored spreads: values sit right of the labels. When the prose column is
  // to the RIGHT of the stat block, stop before it; otherwise (prose left,
  // stats on the outer half) values run to the page edge.
  const statX1 = statProseX > statCols[statColIdx] ? statProseX - 6 : statPd.width;

  // Spoils may live near the stat block on the stat page instead — or wherever
  // an assist points.
  if (assists.noSpoils) {
    spoilsAnchor = null;
    spoilsBox = null;
  }
  if (!spoilsAnchor && !assists.noSpoils && (statPd !== pd || assists.spoilsPage)) {
    const spPd = assists.spoilsPage ? await pageItems(doc, assists.spoilsPage) : statPd;
    const spPage = assists.spoilsPage ?? statPage;
    const spCols = assists.spoilsPage ? detectColumns(spPd.items) : statCols;
    const sp2 = spPd.items.find((it) => it.h < HEADING_MIN_H && it.str.trim() === "Spoils");
    if (sp2) {
      const spCol = colOf(sp2.x, spCols);
      const spX0 = spCols[spCol] - 5;
      const spX1 = spCols[spCol + 1] ? spCols[spCol + 1] - 6 : spPd.width;
      const later2 = listHeadings(spPd)
        .filter((a) => a.mode === "display" && a.y > sp2.y)
        .sort((a, b) => a.y - b.y);
      spoilsAnchor = sp2;
      spoilsPd = spPd;
      spoilsPage = spPage;
      spoilsBox = { x0: spX0, x1: spX1, y0: sp2.y - 3, y1: later2[0]?.y ? later2[0].y - 4 : spPd.height };
    } else if (assists.spoilsPage) {
      warn(`${entry.id}: assists.spoilsPage ${assists.spoilsPage} has no "Spoils" header`);
    }
  }
  if (spoilsBox) {
    fields.spoils = withFixes({
      op: "value", page: spoilsPage, pattern: "spoilList",
      effectsTable: kindRow.fields.spoils.effectsTable,
      dropText: "Spoils",
      box: spoilsBox,
    }, spoilsPd);
  }

  // Stat block ends where the column's line flow breaks after the last label.
  const statColItems = bodyIn(statPd, statX0, statX1, 0, statPd.height).sort((a, b) => a.y - b.y);
  const lastLabelY = statLabels[statLabels.length - 1]?.y ?? 0;
  let statEnd = lastLabelY + 3;
  for (const it of statColItems) {
    if (it.y <= lastLabelY) continue;
    if (it.y - statEnd > 18) break;
    statEnd = Math.max(statEnd, it.y + 3);
  }

  const rows = kindRow.fields.stats.rows;
  const speedCfg = kindRow.fields.stats.speedRows;
  const atkCfg = kindRow.fields.stats.attackRows;
  let attacksInstr = null;
  let damageInstr = null;
  const unmapped = [];

  // Divider mini-headings ("<Name> Encounters", "<Name> Secondary/Primary
  // Characteristics") sit BETWEEN stat rows; whichever row box catches one
  // ships drop ordinals so the executor discards its runs.
  const dividerItems = new Set();
  for (const line of toLines(statColItems)) {
    // Smallcaps runs join WITHOUT spaces ("secondarycharacteristics"), so
    // compare space-stripped.
    const lineText = line.items.map((i) => i.str).join("").replace(/\s+/g, "").toLowerCase();
    if (/(secondarycharacteristics|primarycharacteristics|encounters)$/.test(lineText) && !lineText.includes(":")) {
      for (const it of line.items) dividerItems.add(it);
    }
  }

  // The MM CENTERS a stat label between its value's lines when a value wraps,
  // so a wrapped value's first line sits ABOVE its own label (confirmed
  // p298: Attacks value line y=396.7 vs label y=401.2). Assign each row the
  // band bounded by the MIDPOINTS to its neighbouring labels — this captures
  // lines above and below the label and cleanly separates adjacent fields.
  statLabels.forEach((label, i) => {
    const labelText = label.str.trim();
    const name = labelText.slice(0, -1);
    const prevY = i > 0 ? statLabels[i - 1].y : label.y - 12;
    const y0 = (prevY + label.y) / 2;
    const y1 = i + 1 < statLabels.length ? (label.y + statLabels[i + 1].y) / 2 : statEnd;
    const box = { x0: statX0, x1: statX1, y0, y1 };
    const base = { op: "value", page: statPage, box, dropText: labelText };

    if (name === atkCfg.attacks) {
      attacksInstr = base;
      return;
    }
    if (name === atkCfg.damage) {
      damageInstr = base;
      return;
    }
    if (name.startsWith(speedCfg.prefix)) {
      const kind = /\(([^)]+)\)/.exec(name)?.[1] ?? "land";
      fields[`stats.speed${cap(camel(kind))}`] = withFixes({ ...base, pattern: speedCfg.pattern }, statPd, dividerItems);
      return;
    }
    const row = rows[name];
    if (row) {
      fields[`stats.${row.field}`] = withFixes({
        ...base,
        pattern: row.pattern,
        ...(row.table ? { table: row.table } : {}),
        ...(row.parenTable ? { parenTable: row.parenTable } : {}),
        ...(row.stripRoll ? { stripRoll: true } : {}),
      }, statPd, dividerItems);
    } else {
      unmapped.push(name);
      fields[`stats._raw.${camel(name)}`] = withFixes({ ...base, pattern: "raw" }, statPd, dividerItems);
    }
  });

  /* --- attacks + damage -> attackList with color picks --- */
  if (attacksInstr && damageInstr) {
    // Executor-parity joins (same enumeration the runtime will perform).
    const aRuns = runsIn(statPd, { box: attacksInstr.box });
    const dRuns = runsIn(statPd, { box: damageInstr.box });
    const aFixes = computeFixes(aRuns);
    const dFixes = computeFixes(dRuns);
    const attacksText = joinRuns(aRuns, aFixes ?? {}, attacksInstr.dropText).replace(/\s+/g, " ").trim();
    const damageRaw = joinRuns(dRuns, dFixes ?? {}, damageInstr.dropText);

    // Names + damage are parsed at RUNTIME by the shared attackModel; the
    // compiler only needs the ordered flat damage-segment list to align glyph
    // colours to the same enumeration the executor will produce. A chef
    // `assists.attacks` normalizes the routine string for rare formats.
    const attacksParsed = assists.attacks ?? attacksText;
    const segments = attackModel(attacksParsed, damageRaw).flatDamage;
    // Per-segment printed COLOR annotation ("this glyph prints red") — an
    // authoring-time observation the executor merely maps through the color
    // table. The runtime never scrapes colors. Attribution of runs to the
    // damage line: page glyph ITEMS in STORY order (prose frame first, then
    // stat frame — InDesign emits stories in that order regardless of the
    // mirrored page side) pair 1:1 with glyph-bearing runs in stream order;
    // counts + codepoints must check out, else the annotation is omitted
    // (quality null) and a chef supplies it by hand via assists.
    let colors = null;
    const segGlyphs = segments.map((seg) => [...seg].find((ch) => glyphChars.has(ch)) ?? null);
    if (segGlyphs.some(Boolean)) {
      const proseColIdx2 = statProseX >= 0 ? colOf(statProseX + 1, statCols) : -1;
      const storyRank = (it) => (colOf(it.x, statCols) === proseColIdx2 ? 0 : 1);
      const pageGlyphItems = statPd.items
        .filter((it) => [...it.str].some((ch) => glyphChars.has(ch)))
        .sort((a, b) => storyRank(a) - storyRank(b) || a.y - b.y || a.x - b.x);
      const runs = await glyphColorRuns(doc, statPage, [...glyphChars].map((ch) => ch.codePointAt(0)));
      const aligned =
        pageGlyphItems.length === runs.length &&
        pageGlyphItems.every((it, j) => {
          const g = [...it.str].find((ch) => glyphChars.has(ch));
          return g && runs[j].text.includes(g);
        });
      if (aligned) {
        const inDamage = pageGlyphItems
          .map((it, j) => ({ it, j }))
          .filter(({ it }) => inBoxRaw(it, damageInstr.box));
        let k = 0;
        const segColors = segments.map((seg, i) => (segGlyphs[i] ? (runs[inDamage[k++]?.j]?.fill ?? null) : null));
        if (segColors.some(Boolean)) colors = segColors;
        if (segColors.some((c, i) => segGlyphs[i] && !c)) {
          warn(`${entry.id}: damage-box glyph items short of segments — some quality null (chef assist)`);
        }
      } else {
        warn(`${entry.id}: glyph item/run attribution checksum failed (${pageGlyphItems.length} items vs ${runs.length} runs) — quality null (chef assist)`);
      }
    }

    fields.attacks = {
      op: "attacks", page: statPage,
      attacksBox: attacksInstr.box, damageBox: damageInstr.box,
      dropText: { attacks: attacksInstr.dropText, damage: damageInstr.dropText },
      ...(aFixes || dFixes ? { fixes: { ...(aFixes ? { attacks: aFixes } : {}), ...(dFixes ? { damage: dFixes } : {}) } } : {}),
      ...(assists.attacks ? { attacksOverride: assists.attacks } : {}),
      glyphTable: kindRow.fields.attacks.glyphTable,
      ...(colors ? { colors, colorTable: kindRow.fields.attacks.colorTable } : {}),
    };
  }

  if (!assists.noArt) fields.art = { op: "art", page, select: kindRow.fields.art.select };

  /* --- residue triage: margin furniture -> shipped skips; rest reported.
         Anchor-page instructions only — stat-page residue is verify's job. --- */
  const claimed = new Set();
  for (const instr of Object.values(fields)) {
    if (instr.page !== page) continue;
    if (instr.op === "text") for (const p of instr.paras) for (const r of runsIn(pd, p)) claimed.add(r);
    else if (instr.op === "attacks") {
      for (const r of runsIn(pd, { box: instr.attacksBox })) claimed.add(r);
      for (const r of runsIn(pd, { box: instr.damageBox })) claimed.add(r);
    } else if (instr.box || instr.boxes) for (const r of runsIn(pd, instr)) claimed.add(r);
  }
  const residual = pd.items.filter((it) => !claimed.has(it));
  const marginBoxes = [];
  if (residual.some((it) => it.x < 45)) marginBoxes.push({ x0: 0, x1: 45, y0: 0, y1: pd.height, reason: "margin-furniture" });
  if (residual.some((it) => it.x > pd.width - 45)) marginBoxes.push({ x0: pd.width - 45, x1: pd.width, y0: 0, y1: pd.height, reason: "margin-furniture" });
  // Running head / chapter tab band above the content area.
  if (residual.some((it) => it.y < 50)) marginBoxes.push({ x0: 0, x1: pd.width, y0: 0, y1: 50, reason: "running-head" });
  const inSkips = (it) => marginBoxes.some((b) => inBoxRaw(it, b));
  const leftover = residual.filter((it) => !inSkips(it));
  if (leftover.length) {
    warn(`${entry.id}: ${leftover.length} unclaimed body item(s) on p.${page} e.g. ${leftover.slice(0, 3).map((i) => JSON.stringify(i.str.slice(0, 24))).join(" ")}`);
  }

  return {
    kind: entry.kind,
    name: entry.name,
    cite: `${BOOKS[entry.book].short} p.${page}`,
    pages: statPage !== page ? [page, statPage] : entry.pages,
    fields,
    ...(unmapped.length ? { _unmappedLabels: unmapped } : {}),
    ...(marginBoxes.length ? { _skips: { [page]: marginBoxes } } : {}),
  };
}

/* -------------------------------------------- */
/*  Adventure (AX-line) compilation             */
/* -------------------------------------------- */

// AX books print 10pt body (RR/JJ are 9), 12pt entry keys, 14pt section heads.
const AX_BODY_MAX_H = 10.6;
const AX_HEAD_MIN_H = 11.5;
const AX_TOP_BAND = 60; // running heads sit at ~y40
// Folios print at ~y757 on a 792pt page — 35pt up, above extract.mjs's 32pt
// footer filter — so they reach the item list and must be skipped here.
const AX_FOOT_Y = 750;
// AX2's inline paragraph icons render as literal [TAG] text runs; each starts
// a section that persists until the next tag (the MM run-in model). AX3 has
// none. Observed vocabulary (whole-book scan 2026-07-22):
const AX_ICON_SECTIONS = {
  MONSTER: "monster", LORE: "lore", LOOT: "loot", GRAVES: "graves",
  TRICK: "trick", TRAP: "trap", NOISE: "noise",
};
// A tag run may carry SEVERAL tags ("[MONSTER] [GRAVES]"); the run is all-tag
// either way, and the first tag names the section.
const AX_TAG_RE = /^(?:\[([A-Z][A-Z /&-]{1,20})\]\s*)+$/;
const AX_FIRST_TAG = /\[([A-Z][A-Z /&-]{1,20})\]/;
// Keys hang their headings ~9pt left of the body column edge; classify a
// heading's column with that tolerance, and widen body boxes to cover the
// hanging icon-tag runs.
const AX_HANG = 12;
const axColOf = (x, cols) => colOf(x + AX_HANG, cols);

const axCite = (book, page) => `${BOOKS[book].short} p.${page - (BOOKS[book].printedOffset ?? 0)}`;
const collapse = (s) => s.replace(/\s+/g, " ").trim();
// Mirror of the executor's expect fold (NFKD + strip marks + alnum): anchor
// FINDING must agree with runtime anchor CHECKING or a compiled entry stubs.
const axFold = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Heading LINES (>= AX_HEAD_MIN_H runs clustered by y), with joined text.
 * AX3 prints heading-size chapter banners down the outer margins; they are
 * furniture, not headings, so the margin bands are excluded here. */
function axHeadingLines(pd) {
  // y > 55: running heads print at y~40 in heading type and MUST NOT anchor or
  // stop anything. x-bands drop the AX3 margin banners (x~22 / x~590); real
  // hanging headings start at x~33.8.
  const heads = pd.items.filter(
    (it) => it.h >= AX_HEAD_MIN_H && it.y > AX_TOP_BAND - 5 && it.y < AX_FOOT_Y && it.x >= 30 && it.x <= pd.width - 30,
  );
  // Two columns often print headings at the SAME y ("12U." beside "14U."); a
  // y-cluster alone would merge them into one phantom line, so split each
  // y-line on x-gaps wider than a word space.
  const out = [];
  for (const ln of toLines(heads)) {
    const items = [...ln.items].sort((a, b) => a.x - b.x);
    const segs = [[items[0]]];
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      if (items[i].x - (prev.x + (prev.w ?? 0)) > 30) segs.push([]);
      segs[segs.length - 1].push(items[i]);
    }
    for (const seg of segs) {
      out.push({
        y: ln.y,
        x0: Math.min(...seg.map((i) => i.x)),
        x1: Math.max(...seg.map((i) => i.x + (i.w ?? 0))),
        text: collapse(seg.map((i) => i.str).join(" ")),
        items: seg,
      });
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x0 - b.x0);
}

/** Column starts for an AX page: assists win, else detection, else full width. */
function axColumns(pd, assists = {}) {
  if (assists.columns) return assists.columns;
  if (assists.fullWidth) {
    const body = pd.items.filter((it) => it.h <= AX_BODY_MAX_H && it.y > AX_TOP_BAND && it.y < AX_FOOT_Y);
    return [body.length ? Math.min(...body.map((i) => i.x)) : 50];
  }
  const cols = detectColumns(pd.items);
  return cols.length ? cols : [50];
}

/** Locate an entry's heading line, absorbing wrapped continuation lines. */
function axAnchor(pd, cols, entry, assists) {
  const want = collapse(assists.anchor ?? entry.anchor?.display ?? entry.name);
  const lines = axHeadingLines(pd);
  // Progressive word-prefix match, like definition display anchors: the PDF may
  // break the heading oddly or drop trailing words to a second line.
  const words = want.split(" ");
  const candidates = [want];
  for (let i = words.length - 1; i >= 1; i--) candidates.push(words.slice(0, i).join(" "));
  let line = null;
  let matched = want;
  for (const c of candidates) {
    line = lines.find((l) => axFold(l.text).startsWith(axFold(c)));
    if (line) {
      matched = c;
      break;
    }
  }
  if (!line) throw new Error(`heading "${want}" not found on p.${entry.pages[0]}`);
  const col = axColOf(line.x0, cols);
  // Absorb a wrapped second heading line directly below (AX3 sets long keys on
  // two 12pt lines).
  let endY = line.y;
  let x1 = line.x1;
  for (const l of lines.filter((l) => axColOf(l.x0, cols) === col && l.y > line.y + 2).sort((a, b) => a.y - b.y)) {
    if (l.y - endY <= 22 && !/^[A-Z]?\d+[A-Za-z]?\./.test(l.text)) {
      endY = l.y;
      x1 = Math.max(x1, l.x1);
    } else break;
  }
  // Absorb a "(3000 BE)" date suffix set as its own BODY-size line below the
  // heading (AX2 sets it beside the heading when it fits, below when not).
  const dateLine = toLines(
    pd.items.filter(
      (it) => it.h <= AX_BODY_MAX_H && axColOf(it.x, cols) === col && it.y > endY + 2 && it.y < endY + 20,
    ),
  )[0];
  if (dateLine) {
    const txt = collapse(dateLine.items.map((i) => i.str).join(" "));
    if (/^\([^)]{1,24}\)$/.test(txt)) endY = dateLine.y;
  }
  return { line, col, endY, x1, matched };
}

/**
 * Collect an entry's body as reading-order segments: down the anchor column,
 * across remaining columns, over the page onto the next — until a heading line
 * stops it. Pages are re-examined independently (AX2 mixes full-width and
 * columnar layouts page by page). `exclude` drops items (an NPC's statline
 * cluster, claimed by its own instruction).
 */
async function axFlow(doc, entry, assists, start, exclude = new Set()) {
  const maxPage = Math.max(...entry.pages);
  const segs = [];
  let page = start.page;
  let pd = start.pd;
  let cols = start.cols;
  let col = start.col;
  let fromY = start.endY + 2;
  for (let guard = 0; guard < 24; guard++) {
    const x0 = cols[col] - AX_HANG - 2;
    const x1 = cols[col + 1] ? cols[col + 1] - AX_HANG - 3 : pd.width - 40;
    const stopHead = axHeadingLines(pd)
      .filter((l) => axColOf(l.x0, cols) === col && l.y > fromY + 2)
      .sort((a, b) => a.y - b.y)[0];
    const stopY = Math.min(stopHead ? stopHead.y - 4 : AX_FOOT_Y, assists.descStopY ?? AX_FOOT_Y, AX_FOOT_Y);
    const items = pd.items.filter(
      (it) =>
        it.h <= AX_BODY_MAX_H && !exclude.has(it) &&
        it.x >= x0 && it.x <= x1 && it.y > fromY && it.y < stopY &&
        it.y > AX_TOP_BAND,
    );
    if (items.length) segs.push({ page, pd, x0, x1, items });
    if (stopHead || assists.descStopY) return segs;
    // No stop in this column: continue in the next column, else overleaf.
    if (col + 1 < cols.length) {
      col += 1;
      fromY = AX_TOP_BAND;
      continue;
    }
    if (page + 1 > doc.numPages || page + 1 > maxPage) return segs;
    page += 1;
    pd = await pageItems(doc, page);
    // Anchor-page column assists do not carry over — AX2 mixes full-width and
    // columnar layouts page by page, so continuation pages are re-detected
    // (with an optional per-page override for pathological layouts).
    cols = axColumns(pd, { columns: assists.flowColumns?.[String(page)] });
    col = 0;
    fromY = AX_TOP_BAND;
  }
  return segs;
}

/**
 * Paragraphs from flow segments, with per-para pages, icon-tag sections, and
 * statline reporting. A paragraph breaks on an opened line gap OR a >50pt jump
 * of the line's left edge (AX2's inset note boxes share the y-rhythm of the
 * prose beside them).
 */
function axParas(segs, anchorPage, opts = {}) {
  const paras = [];
  const statlines = [];
  let section = null;
  for (const seg of segs) {
    const lines = toLines(seg.items).map((ln) => ({
      y: ln.y,
      x0: Math.min(...ln.items.map((i) => i.x)),
      items: [...ln.items].sort((a, b) => a.x - b.x),
    }));
    if (!lines.length) continue;
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i].y - lines[i - 1].y);
    const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 12;
    const groups = [[lines[0]]];
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i].y - lines[i - 1].y;
      const xJump = Math.abs(lines[i].x0 - lines[i - 1].x0) > 50;
      if (gap > median * 1.6 || (xJump && gap > median * 0.8)) groups.push([]);
      groups[groups.length - 1].push(lines[i]);
    }
    for (const g of groups) {
      const first = g[0].items[0];
      const tag = opts.iconTags && AX_TAG_RE.test(first.str.trim()) ? AX_FIRST_TAG.exec(first.str) : null;
      if (tag) section = AX_ICON_SECTIONS[tag[1]] ?? tag[1].toLowerCase();
      const para = {
        box: {
          x0: seg.x0,
          x1: seg.x1,
          y0: g[0].y - 3,
          y1: g[g.length - 1].y + 3,
        },
      };
      if (seg.page !== anchorPage) para.page = seg.page;
      if (section) para.section = section;
      const drop = tag ? new Set([first]) : null;
      withFixes(para, seg.pd, drop);
      paras.push(para);
      // Quick-stat blocks: an indented "Name:" label opening a stat clause.
      // Checked per LINE, not per paragraph group — the y-gap segmentation may
      // keep a statline glued to the prose above it, and one group can open
      // several consecutive blocks.
      if (opts.statlines) {
        for (let li = 0; li < g.length; li++) {
          const label = g[li].items[0];
          if (!/:$/.test(label.str.trim())) continue;
          const tail = g.slice(li).map((l) => l.items.map((i) => i.str).join(" ")).join(" ");
          if (/\b(MV|AC|HD|hp)\s*-?\d/.test(tail.slice(0, 160))) {
            statlines.push({ label, para, page: seg.page, pd: seg.pd });
          }
        }
      }
    }
  }
  return { paras, statlines };
}

/** Chef-authored extra skips (assists.skips = [{page?, box, reason?}]): the
 * escape hatch for recorded page furniture no heuristic should learn — a
 * table's Average-XP footer row, a decorative divider. */
function axAssistSkips(skipsOut, assists, defaultPage) {
  for (const s of assists.skips ?? []) {
    const p = s.page ?? defaultPage;
    (skipsOut[p] ??= []).push({ ...s.box, reason: s.reason ?? "recorded-skip" });
  }
}

/** Residue triage across EVERY page an entry's instructions touch (a location
 * flows over pages; the folio on a continuation page needs its skip too). */
async function axResidueAll(doc, entryId, fields, seed = {}) {
  const pages = new Set();
  for (const instr of Object.values(fields)) {
    if (instr.page) pages.add(instr.page);
    if (instr.op === "text") for (const p of instr.paras ?? []) if (p.page) pages.add(p.page);
  }
  const out = {};
  for (const p of [...pages].sort((a, b) => a - b)) {
    const pd = seed[p] ?? (await pageItems(doc, p));
    const skips = axResidue(entryId, pd, p, fields);
    if (skips.length) out[p] = skips;
  }
  return out;
}

/** compileMonster's residue triage for an AX page: furniture -> skips. */
function axResidue(entryId, pd, page, fields) {
  const claimed = new Set();
  for (const instr of Object.values(fields)) {
    if (instr.op === "text") {
      for (const p of instr.paras) {
        if ((p.page ?? instr.page) !== page) continue;
        for (const r of runsIn(pd, p)) claimed.add(r);
      }
    } else if (instr.page === page && (instr.box || instr.boxes)) {
      for (const r of runsIn(pd, instr)) claimed.add(r);
    }
  }
  const residual = pd.items.filter((it) => !claimed.has(it));
  const skips = [];
  if (residual.some((it) => it.y < AX_TOP_BAND)) skips.push({ x0: 0, x1: pd.width, y0: 0, y1: AX_TOP_BAND, reason: "running-head" });
  if (residual.some((it) => it.y > AX_FOOT_Y)) skips.push({ x0: 0, x1: pd.width, y0: AX_FOOT_Y, y1: pd.height, reason: "folio" });
  if (residual.some((it) => it.x < 34)) skips.push({ x0: 0, x1: 34, y0: 0, y1: pd.height, reason: "margin-furniture" });
  if (residual.some((it) => it.x > pd.width - 34)) skips.push({ x0: pd.width - 34, x1: pd.width, y0: 0, y1: pd.height, reason: "margin-furniture" });
  return skips;
}

/** Shared skeleton: anchor + name expect + flowed prose paragraphs. Anchors
 * are display headings by default; `anchor.runin` instead matches a BODY-size
 * standalone line by folded text — AX3 sets its notable-resident names in
 * small-caps body type ("tRibune naRmiRio dRaKomiR"), which fold-comparison
 * absorbs on both sides. */
async function axOpen(doc, entry) {
  const assists = entry.assists ?? {};
  const page = entry.pages[0];
  const pd = await pageItems(doc, page);
  const cols = axColumns(pd, assists);
  let a;
  if (entry.anchor?.runin) {
    const want = collapse(assists.anchor ?? entry.anchor.runin);
    const w = axFold(want);
    let hit = null;
    for (let c = 0; c < cols.length && !hit; c++) {
      const colItems = pd.items.filter(
        (it) => it.h <= AX_BODY_MAX_H && axColOf(it.x, cols) === c && it.y > AX_TOP_BAND && it.y < AX_FOOT_Y,
      );
      for (const ln of toLines(colItems)) {
        const items = [...ln.items].sort((x, y) => x.x - y.x);
        const t = axFold(items.map((i) => i.str).join(""));
        // The last clause mirrors the executor's 12-char-prefix fallback: AX3's
        // small-caps name lines occasionally extract with a dropped glyph
        // ("naRmiRo"), and the runtime expect tolerates exactly this much.
        if (
          t === w ||
          (t.startsWith(w) && t.length <= w.length + 6) ||
          (w.length >= 12 && t.startsWith(w.slice(0, 12)) && Math.abs(t.length - w.length) <= 4)
        ) {
          hit = {
            line: {
              y: ln.y,
              x0: Math.min(...items.map((i) => i.x)),
              x1: Math.max(...items.map((i) => i.x + (i.w ?? 0))),
              items,
            },
            col: c,
          };
          break;
        }
      }
    }
    if (!hit) throw new Error(`runin line "${want}" not found on p.${page}`);
    a = { line: hit.line, col: hit.col, endY: hit.line.y, x1: hit.line.x1, matched: want };
  } else {
    a = axAnchor(pd, cols, entry, assists);
  }
  // The expect box spans to the column's right edge so a same-line "(3000 BE)"
  // date suffix (body-size, not part of the heading runs) is claimed with it.
  const colX1 = cols[a.col + 1] ? cols[a.col + 1] - AX_HANG - 3 : pd.width - 40;
  const name = withFixes(
    {
      op: "expect", page,
      box: {
        x0: a.line.x0 - 3,
        x1: Math.max(a.x1 + 3, colX1),
        y0: a.line.y - (entry.anchor?.runin ? 8 : 14),
        y1: a.endY + 5,
      },
      text: a.matched,
    },
    pd,
  );
  return { assists, page, pd, cols, a, name };
}

/**
 * kind.location — a keyed area / point of interest. Prose (with icon-tag
 * sections) plus one creature-name lookup per embedded quick-stat label, so
 * the binding can link the ACKS II entry the seat owns (defer-to-newest).
 */
async function compileLocation(doc, entry, kindRow) {
  const { assists, page, pd, cols, a, name } = await axOpen(doc, entry);
  const fields = { name };
  const segs = await axFlow(doc, entry, assists, { page, pd, cols, col: a.col, endY: a.endY });
  const { paras, statlines } = axParas(segs, page, { iconTags: entry.book === "ax2", statlines: true });
  if (!paras.length) throw new Error(`no body paragraphs under "${entry.name}" p.${page}`);
  fields.description = { op: "text", page, paras };
  statlines.forEach((s, i) => {
    fields[`creatures.${i}`] = {
      op: "value",
      page: s.page,
      pattern: "raw",
      table: "creature",
      stripColon: true,
      stripParen: true, // "Skeletons (12):" -> "Skeletons"
      box: { x0: s.label.x - 2, x1: s.label.x + (s.label.w ?? 40) + 2, y0: s.label.y - 4, y1: s.label.y + 4 },
    };
  });
  const out = {
    kind: entry.kind, name: entry.name, cite: axCite(entry.book, page), pages: entry.pages,
    ...(entry.meta ? { meta: entry.meta } : {}), fields,
  };
  const skipsOut2 = await axResidueAll(doc, entry.id, fields, { [page]: pd });
  axAssistSkips(skipsOut2, assists, page);
  if (Object.keys(skipsOut2).length) out._skips = skipsOut2;
  return out;
}

/**
 * kind.npc — prose plus ONE quick-stat block parsed by the statline pattern.
 * The block may sit on a different page than the prose (quick vs full
 * presentation); assists.statlineAt names it, assists.statLabel overrides the
 * label text when it differs from "<name>:".
 */
async function compileNpc(doc, entry, kindRow) {
  const { assists, page, pd, cols, a, name } = await axOpen(doc, entry);
  const fields = { name };

  const statPage = assists.statlineAt ?? page;
  const spd = statPage === page ? pd : await pageItems(doc, statPage);
  const label = assists.statLabel ?? `${entry.name}:`;
  const labelRun = spd.items.find((it) => collapse(it.str) === label) ??
    spd.items.find((it) => /:$/.test(it.str.trim()) && collapse(it.str).toLowerCase().startsWith(label.replace(/:$/, "").toLowerCase()));
  if (!labelRun) throw new Error(`statline label "${label}" not found on p.${statPage}`);
  // The block: contiguous lines at (or right of) the label's indent, WITHIN the
  // label's own column — same-y items of the neighbouring column must not join
  // the cluster or break it.
  const scols = statPage === page ? cols : axColumns(spd, assists);
  const sCol = colOf(labelRun.x, scols);
  const sColX0 = scols[sCol] - 5;
  const sColX1 = scols[sCol + 1] ? scols[sCol + 1] - 6 : spd.width - 40;
  const lines = toLines(
    spd.items.filter(
      (it) => it.h <= AX_BODY_MAX_H && it.x >= sColX0 && it.x <= sColX1 && it.y >= labelRun.y - 2 && it.y < AX_FOOT_Y,
    ),
  ).map((ln) => ({ y: ln.y, x0: Math.min(...ln.items.map((i) => i.x)), items: ln.items }));
  const cluster = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i].y - lines[i - 1].y;
    if (gap > 19 || lines[i].x0 < labelRun.x - 8) break;
    cluster.push(lines[i]);
  }
  const clusterItems = new Set(cluster.flatMap((l) => l.items));
  const sx1 = Math.max(...cluster.flatMap((l) => l.items.map((i) => i.x + (i.w ?? 0))));
  fields.statline = withFixes(
    {
      op: "value", page: statPage, pattern: "statline", dropText: collapse(labelRun.str),
      box: { x0: labelRun.x - 3, x1: sx1 + 3, y0: cluster[0].y - 4, y1: cluster[cluster.length - 1].y + 4 },
    },
    spd,
  );

  const segs = await axFlow(doc, entry, assists, { page, pd, cols, col: a.col, endY: a.endY }, clusterItems);
  const { paras } = axParas(segs, page, { iconTags: entry.book === "ax2" });
  if (paras.length) fields.description = { op: "text", page, paras };

  const out = {
    kind: entry.kind, name: entry.name, cite: axCite(entry.book, page), pages: entry.pages,
    ...(entry.meta ? { meta: entry.meta } : {}), fields,
  };
  const skipsOut2 = await axResidueAll(doc, entry.id, fields, { [page]: pd });
  axAssistSkips(skipsOut2, assists, page);
  if (Object.keys(skipsOut2).length) out._skips = skipsOut2;
  return out;
}

/**
 * kind.rolltable — two printed shapes.
 * GRID (assists.grid = {page, y0, y1, dieX0, dieX1, cellX0, cellX1,
 * claimDie?}): a die column beside result columns; one register entry per
 * result column. Rows cluster on lines that carry a die run; the die value is
 * read OFFLINE into the row's section label (r<lo> / r<lo>-<hi>) — structure,
 * like a page number — while the row text stays lazy.
 * LIST (default): the entry's own flowed prose where each row opens with an
 * "<n>:" run; the intro paragraphs before row 1 become `description` and the
 * roll formula materializes from them (or assists.rollAt).
 */
async function compileRollTable(doc, entry, kindRow) {
  const assists = entry.assists ?? {};
  const page = entry.pages[0];
  const fields = {};
  const skipsOut = {};
  let pd;
  let opened = null;
  if (assists.nameExpect) {
    // Anchor-less mode: some tables' only printed name is a small-caps column
    // header cell (the AX2 wandering grid). The expect box is chef geometry;
    // the executor's fold-compare absorbs the small-caps casing.
    const ne = assists.nameExpect;
    pd = await pageItems(doc, ne.page ?? page);
    fields.name = { op: "expect", page: ne.page ?? page, box: ne.box, text: ne.text ?? entry.name };
  } else {
    opened = await axOpen(doc, entry);
    pd = opened.pd;
    fields.name = opened.name;
  }

  if (assists.grid) {
    const g = assists.grid;
    const gpage = g.page ?? page;
    const gpd = await pageItems(doc, gpage);
    const lines = toLines(gpd.items.filter((it) => it.y >= g.y0 && it.y <= g.y1 && it.x >= g.dieX0 && it.x <= g.cellX1));
    const rows = [];
    for (const ln of lines) {
      const die = ln.items.find((it) => it.x >= g.dieX0 && it.x <= g.dieX1 && /^\d+(?:\s*[-–]\s*\d+)?$/.test(it.str.trim()));
      const cellRuns = ln.items.filter((it) => it.x >= g.cellX0 && it.x <= g.cellX1);
      if (die) rows.push({ die, lines: [ln], cellRuns: [...cellRuns] });
      else if (rows.length && cellRuns.length) {
        rows[rows.length - 1].lines.push(ln);
        rows[rows.length - 1].cellRuns.push(...cellRuns);
      }
    }
    if (!rows.length) throw new Error(`grid rows empty for ${entry.id} p.${gpage}`);
    const paras = rows.map((r) => {
      // No x padding: neighbouring result columns abut, and a run starting on
      // the shared edge must fall in exactly one entry's cell band.
      const x0 = g.claimDie ? g.dieX0 : g.cellX0;
      const para = {
        box: { x0, x1: g.cellX1, y0: r.lines[0].y - 4, y1: r.lines[r.lines.length - 1].y + 4 },
        section: `r${r.die.str.trim().replace(/\s*[-–]\s*/, "-")}`,
      };
      if (gpage !== page) para.page = gpage;
      const drop = g.claimDie ? new Set([r.die]) : null;
      return withFixes(para, gpd, drop);
    });
    fields.rows = { op: "text", page, paras };
    if (g.headerSkip) (skipsOut[gpage] ??= []).push({ x0: g.dieX0 - 2, x1: g.cellX1 + 2, y0: g.headerSkip[0], y1: g.headerSkip[1], reason: "table-header" });
    // An anchored grid table may carry section intro prose above/before the
    // grid (bounded by assists.descStopY, which also ends the flow).
    if (opened) {
      const segs = await axFlow(doc, entry, assists, { page, pd, cols: opened.cols, col: opened.a.col, endY: opened.a.endY });
      const { paras: dparas } = axParas(segs, page, { iconTags: entry.book === "ax2" });
      if (dparas.length) fields.description = { op: "text", page, paras: dparas };
    }
  } else if (!opened) {
    throw new Error(`${entry.id}: list-shape rolltable needs a heading anchor (no assists.nameExpect shortcut)`);
  } else {
    const { cols, a } = opened;
    // LIST shape: rows come out of the entry's own flow. A row that runs past
    // its column's foot continues in the next segment, so each row holds
    // PORTIONS (one per segment touched) that ship as sibling paras under the
    // same r<range> section.
    const segs = await axFlow(doc, entry, assists, { page, pd, cols, col: a.col, endY: a.endY });
    const intro = [];
    const rows = [];
    for (const seg of segs) {
      const lines = toLines(seg.items).map((ln) => ({
        y: ln.y,
        x0: Math.min(...ln.items.map((i) => i.x)),
        items: [...ln.items].sort((a, b) => a.x - b.x),
      }));
      for (const ln of lines) {
        const first = ln.items[0];
        const m = /^(\d+(?:\s*[-–]\s*\d+)?)\s*:$/.exec(first.str.trim());
        if (m) {
          rows.push({ range: m[1].replace(/\s*[-–]\s*/, "-"), anchor: first, portions: [{ seg, lines: [ln] }] });
        } else if (rows.length) {
          const row = rows[rows.length - 1];
          const last = row.portions[row.portions.length - 1];
          if (last.seg === seg) last.lines.push(ln);
          else row.portions.push({ seg, lines: [ln] });
        } else {
          intro.push({ ln, seg });
        }
      }
    }
    if (!rows.length) throw new Error(`no "<n>:" rows under "${entry.name}" p.${page}`);
    if (intro.length) {
      const iSegs = new Map();
      for (const { ln, seg } of intro) {
        if (!iSegs.has(seg)) iSegs.set(seg, []);
        iSegs.get(seg).push(...ln.items);
      }
      const iParas = axParas([...iSegs.entries()].map(([seg, items]) => ({ ...seg, items })), page, {});
      if (iParas.paras.length) {
        fields.description = { op: "text", page, paras: iParas.paras };
        if (!assists.rollAt) {
          const p0 = iParas.paras[0];
          fields.roll = { op: "value", page: p0.page ?? page, pattern: "dice", box: p0.box };
        }
      }
    }
    fields.rows = {
      op: "text", page,
      paras: rows.flatMap((r) =>
        r.portions.map((portion, pi) => {
          const para = {
            box: {
              x0: portion.seg.x0, x1: portion.seg.x1,
              y0: portion.lines[0].y - 3, y1: portion.lines[portion.lines.length - 1].y + 3,
            },
            section: `r${r.range}`,
          };
          if (portion.seg.page !== page) para.page = portion.seg.page;
          return withFixes(para, portion.seg.pd, pi === 0 ? new Set([r.anchor]) : null);
        }),
      ),
    };
  }
  if (assists.rollAt) {
    fields.roll = { op: "value", page: assists.rollAt.page ?? page, pattern: "dice", box: assists.rollAt.box };
  }
  const out = {
    kind: entry.kind, name: entry.name, cite: axCite(entry.book, page), pages: entry.pages,
    ...(entry.meta ? { meta: entry.meta } : {}), fields,
  };
  const rSkips = await axResidueAll(doc, entry.id, fields, { [fields.name.page ?? page]: pd });
  for (const [p, boxes] of Object.entries(rSkips)) skipsOut[p] = [...(skipsOut[p] ?? []), ...boxes];
  axAssistSkips(skipsOut, assists, page);
  if (Object.keys(skipsOut).length) out._skips = skipsOut;
  return out;
}

/**
 * kind.monsterLegacy — the ACKS I appendix block: a label column with one
 * value column per variant. Single-variant entries claim the labels too
 * (dropText per row, exactly the MM stat treatment); with assists.variantCol
 * the entry claims only its variant's x-band and the FIRST variant of the
 * block also claims labels.
 */
async function compileLegacyMonster(doc, entry, kindRow) {
  const { assists, page, pd, cols, a, name } = await axOpen(doc, entry);
  const fields = { name };
  const colX0 = cols[a.col] - AX_HANG - 2;
  const colX1 = cols[a.col + 1] ? cols[a.col + 1] - AX_HANG - 3 : pd.width - 40;
  const rowsMap = kindRow.fields.stats.rows;
  const labelRe = new RegExp(`^(${Object.keys(rowsMap).map((k) => k.replace(/[%()]/g, "\\$&")).join("|")})\\s*:$`);
  const labels = pd.items
    .filter((it) => it.h <= AX_BODY_MAX_H && it.x >= colX0 && it.x <= colX1 && it.y > a.endY && labelRe.test(collapse(it.str)))
    .sort((x, y) => x.y - y.y);
  if (!labels.length) throw new Error(`no legacy stat labels under "${entry.name}" p.${page}`);
  const blockY0 = labels[0].y;
  const blockY1 = labels[labels.length - 1].y;

  // Variant headers sit between the heading and the first label row.
  const variantRuns = toLines(
    pd.items.filter((it) => it.h <= AX_BODY_MAX_H && it.x >= colX0 && it.x <= colX1 && it.y > a.endY + 2 && it.y < blockY0 - 3),
  ).flatMap((ln) => ln.items).sort((x, y) => x.x - y.x);
  let bandX0;
  let bandX1 = colX1;
  let claimLabels = true;
  if (assists.variantCol) {
    const idx = variantRuns.findIndex((r) => collapse(r.str).toLowerCase() === assists.variantCol.toLowerCase());
    if (idx < 0) throw new Error(`variant column "${assists.variantCol}" not found for ${entry.id}`);
    bandX0 = variantRuns[idx].x - 6;
    if (variantRuns[idx + 1]) bandX1 = variantRuns[idx + 1].x - 6;
    claimLabels = idx === 0;
  } else {
    const valueXs = labels
      .map((l) => pd.items.filter((it) => Math.abs(it.y - l.y) <= 3 && it.x > l.x + (l.w ?? 0) + 2 && it.x <= colX1).sort((x, y) => x.x - y.x)[0])
      .filter(Boolean)
      .map((it) => it.x);
    bandX0 = (valueXs.length ? Math.min(...valueXs) : labels[0].x + 60) - 4;
  }

  for (const l of labels) {
    const key = collapse(l.str).replace(/\s*:$/, "");
    const spec = rowsMap[key];
    if (!spec) continue;
    const instr = {
      op: "value", page, pattern: spec.pattern,
      ...(spec.table ? { table: spec.table } : {}),
      box: {
        x0: claimLabels ? l.x - 2 : bandX0,
        x1: bandX1,
        y0: l.y - 4.5, y1: l.y + 4.5,
      },
      ...(claimLabels ? { dropText: collapse(l.str) } : {}),
    };
    fields[`stats.${spec.field}`] = instr;
  }
  // The variant-header line itself: claimed by the first variant via an expect
  // (integrity: the header should read as the variant name).
  if (assists.variantCol && claimLabels) {
    // covered by the name expect only when adjacent; claim header runs as a skip
    // band instead — they are column captions, not content.
  }

  const segs = await axFlow(doc, entry, { ...assists, descStopY: assists.descStopY }, { page, pd, cols, col: a.col, endY: blockY1 + 4 });
  const { paras } = axParas(segs, page, {});
  if (paras.length) fields.description = { op: "text", page, paras };

  const out = {
    kind: entry.kind, name: entry.name, cite: axCite(entry.book, page), pages: entry.pages,
    ...(entry.meta ? { meta: entry.meta } : {}), fields,
  };
  const skipsOut2 = await axResidueAll(doc, entry.id, fields, { [page]: pd });
  axAssistSkips(skipsOut2, assists, page);
  if (Object.keys(skipsOut2).length) out._skips = skipsOut2;
  return out;
}

const AX_COMPILERS = {
  "kind.location": compileLocation,
  "kind.npc": compileNpc,
  "kind.rolltable": compileRollTable,
  "kind.monsterLegacy": compileLegacyMonster,
};

/* -------------------------------------------- */
/*  Definition compilation (proficiency/power/skill) */
/* -------------------------------------------- */

/** Content-type cookbook filename for a definition kind (named by WHAT it
 * extracts, not the source book — a content type spans every book). */
const CONTENT_OF = { "kind.proficiency": "proficiencies", "kind.power": "powers", "kind.skill": "skills", "kind.combatProficiency": "proficiencies", "kind.equipment": "equipment" };

/** Definition id slug — must match the seeder so alias targets resolve. */
const slugOf = (s) =>
  s
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join("");

/**
 * Column starts for a DEFINITION page. `detectColumns` needs a bin to hold >8%
 * of body items, which a page dominated by a table can starve — RR p33 reports
 * one column when it prints two, collapsing both into a single region so an
 * entry swallows its neighbour's prose. Same histogram, gentler threshold.
 * Scoped to definitions so monster compilation is untouched.
 */
function defColumns(pd) {
  const cols = detectColumns(pd.items);
  // Trust the proven detector whenever it found a multi-column layout. Lowering
  // its threshold globally invents columns out of table cells, indents and the
  // page-edge chapter tabs (RR p33 reported EIGHT), which is far worse than the
  // miss being fixed.
  if (cols.length > 1) return cols;
  // It reported one. Run-in HEADINGS always sit at a column's left edge, so
  // their x-positions recover the true columns when a dominant table starves
  // the histogram's second bin (RR p33 prints two columns, reports one — which
  // made an entry swallow its neighbour's prose).
  const heads = pd.items.filter((it) => it.h < DEF_BODY_MAX_H && /^[A-Z][^:]{1,44}:$/.test(it.str.trim()));
  const starts = [];
  for (const x of heads.map((h) => h.x).sort((a, b) => a - b)) {
    if (!starts.length || x - starts[starts.length - 1] > 60) starts.push(x);
  }
  return starts.length > 1 ? starts : cols;
}

/**
 * The vertical chapter tab that runs down a page margin ("C H A R A C T E R S"),
 * set as a stack of tiny runs. They fall inside a column box and otherwise land
 * in the middle of extracted prose. They are the same size as superscript
 * ordinals, so size alone cannot separate them — but a tab is a STACK of small
 * runs sharing an x over a long vertical span, whereas ordinals scatter.
 * Returned as a Set so it can ship as `fixes.drop` ordinals.
 */
function marginTabs(pd) {
  const small = pd.items.filter((it) => it.h < 7);
  const byX = new Map();
  for (const it of small) {
    // Rotated tab glyphs share an x to a fraction of a point; ordinals do not.
    const k = Math.round(it.x);
    if (!byX.has(k)) byX.set(k, []);
    byX.get(k).push(it);
  }
  const out = new Set();
  for (const arr of byX.values()) {
    if (arr.length < 3) continue; // two stray ordinals can share an x; three do not
    const ys = arr.map((i) => i.y);
    if (Math.max(...ys) - Math.min(...ys) < 20) continue; // a real stack runs down the page
    for (const it of arr) out.add(it);
  }
  return out;
}

/** Raw reading-order join of a body region (compile-time inspection only). */
const joinBody = (items) =>
  [...items].sort((a, b) => a.y - b.y || a.x - b.x).map((it) => it.str).join("").replace(/\s+/g, " ").trim();

/**
 * Compile a role:definition entry (proficiency / power / skill) into
 * expect(name) + text(description). Two locate modes:
 *  - display: a heading (RR proficiency descriptions) → block to the next
 *    heading in the same column.
 *  - runin: a bold "Name:" run (JJ powers, class skills) → block to the next
 *    same-alias run-in in the same column; the heading run is dropped.
 * Descriptor prose materializes per seat (lazy @PdfText); structured effects are
 * per-entry assists (emitted later — descriptor first).
 */
async function compileDefinition(doc, entry, kindRow) {
  const assists = entry.assists ?? {};
  const page = entry.pages[0];
  const pd = await pageItems(doc, page);
  // `assists.columns` overrides the detected column lefts for THIS entry. A page
  // whose lower half is a table has more vertical gutters than it has prose
  // columns, and the detector cannot tell which is which — so a run-in entry
  // whose text spans the full width gets shredded along a table's gutter. The
  // recipe knows the page; this lets it say so, without changing detection for
  // every other entry printed on the same page.
  const cols = assists.columns ?? defColumns(pd);
  const tabs = marginTabs(pd); // dropped from every paragraph (see marginTabs)
  const mode = kindRow.fields.name.locate;
  const fields = {};
  let bodyText = "";

  if (mode === "display") {
    const heads = listHeadings(pd).filter((a) => a.mode === "display");
    const want = assists.anchor ?? entry.anchor?.display ?? entry.name;
    const noParen = want.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    // A long name WRAPS onto a second display line ("Fighting Style" /
    // "Specialization"), so the printed heading is only a PREFIX of the full
    // name. Try the whole name, then progressively shorter prefixes — the
    // continuation line is absorbed into the anchor block below either way.
    const words = noParen.split(/\s+/).filter(Boolean);
    const candidates = [want, noParen];
    for (let i = words.length - 1; i >= 1; i--) candidates.push(words.slice(0, i).join(" "));
    let anchor = null;
    let matched = want;
    for (const c of candidates.filter(Boolean)) {
      anchor = heads.find((a) => a.text.toLowerCase().startsWith(c.toLowerCase()));
      if (anchor) {
        matched = c;
        break;
      }
    }
    if (!anchor) throw new Error(`display anchor "${want}" not found on p.${page}`);
    const colX = cols[anchor.col];
    const nextX = cols[anchor.col + 1];
    const box = { x0: colX - 5, x1: nextX ? nextX - 6 : pd.width };
    // Absorb a wrapped 2-line heading into the anchor block.
    let endY = anchor.y;
    const later = [];
    for (const h of heads.filter((a) => a.col === anchor.col && a.y > anchor.y + 2).sort((a, b) => a.y - b.y)) {
      if (h.y - endY <= 20) endY = h.y;
      else later.push(h);
    }
    // A definition also ends at a TABLE. The RR sets a rank-progression table
    // for several proficiencies at the foot of a column, below the last entry
    // in it — and with no heading after that entry, the body ran to the page
    // bottom and swallowed the table (sometimes a DIFFERENT proficiency's).
    // Table titles are set in body type and end in "Progression", so they are
    // findable without a per-entry assist.
    const tableTitle = pd.items
      .filter(
        (it) =>
          it.h < DEF_BODY_MAX_H &&
          colOf(it.x, cols) === anchor.col &&
          it.y > anchor.y + 2 &&
          /\bProgression\s*$/i.test(it.str.trim()),
      )
      .sort((a, b) => a.y - b.y)[0];
    const stopY = Math.min(
      later[0]?.y ? later[0].y - 4 : pd.height,
      tableTitle ? tableTitle.y - 4 : pd.height,
      assists.descStopY ?? pd.height,
    );
    // Bound the expect box to the heading's OWN runs. The last column runs to
    // the page edge, where the vertical chapter-tab glyphs live ("Pro/FI/c/IE"),
    // and those would otherwise join the heading text and fail the check.
    const headItems = pd.items.filter(
      (it) => it.h >= HEADING_MIN_H && colOf(it.x, cols) === anchor.col && it.y >= anchor.y - 2 && it.y <= endY + 2,
    );
    const headX1 = headItems.length ? Math.max(...headItems.map((it) => it.x + (it.w ?? 0))) + 2 : box.x1;
    fields.name = {
      op: "expect", page,
      box: { x0: box.x0, x1: Math.min(headX1, box.x1), y0: anchor.y - 16, y1: endY + 6 },
      text: matched,
    };
    const body = pd.items.filter((it) => it.h < DEF_BODY_MAX_H && it.x >= box.x0 && it.x <= box.x1 && it.y > endY + 2 && it.y < stopY);
    bodyText = joinBody(body);
    const paras = paragraphBoxes(toLines(body), box.x0, box.x1).map((p) => withFixes(p, pd, tabs));
    // Column-flowed continuation (see the run-in branch): a proficiency that
    // reaches the bottom of its column resumes at the top of the next.
    // A table below the entry ends it just as a heading would, so it must also
    // suppress the column flow — otherwise the block runs on into the next
    // column and absorbs whichever proficiency is printed there.
    const cont = columnFlow(pd, cols, anchor.col, later.length > 0 || !!tableTitle, (it) => it.h >= HEADING_MIN_H);
    if (cont.length) {
      const cx0 = cols[anchor.col + 1] - 5;
      const cx1 = cols[anchor.col + 2] ? cols[anchor.col + 2] - 6 : pd.width;
      paras.push(...paragraphBoxes(toLines(cont), cx0, cx1).map((p) => withFixes(p, pd, tabs)));
      bodyText = `${bodyText} ${joinBody(cont)}`.trim();
    } else if (!later.length && !tableTitle && anchor.col + 1 >= cols.length) {
      const pf = await pageFlow(doc, page, (it) => it.h >= HEADING_MIN_H);
      if (pf?.items.length) {
        const px0 = pf.cols[0] - 5;
        const px1 = pf.cols[1] ? pf.cols[1] - 6 : pf.pd.width;
        paras.push(...paragraphBoxes(toLines(pf.items), px0, px1).map((p) => withFixes({ ...p, page: pf.page }, pf.pd, marginTabs(pf.pd))));
        bodyText = `${bodyText} ${joinBody(pf.items)}`.trim();
      }
    }
    fields.description = { op: "text", page, paras };
  } else if (mode === "subheading") {
    // A bold sub-heading sits ALONE on its line at body size with no colon
    // (RR Combat: "Armor", "Weapons", "Fighting Styles"). Anchor on the line
    // that holds exactly that one run; its alias then identifies its siblings,
    // which is where the block ends.
    const want = assists.anchor ?? entry.anchor?.subheading ?? entry.name;
    const lines = new Map();
    for (const it of pd.items.filter((i) => i.h < DEF_BODY_MAX_H)) {
      const k = `${colOf(it.x, cols)}:${Math.round(it.y / 3)}`;
      if (!lines.has(k)) lines.set(k, []);
      lines.get(k).push(it);
    }
    const solo = [...lines.values()].filter((a) => a.length === 1).map((a) => a[0]);
    const anchor = solo.find((it) => it.str.trim() === want) ?? solo.find((it) => it.str.trim().startsWith(want));
    if (!anchor) throw new Error(`subheading anchor "${want}" not found on p.${page}`);
    const col = colOf(anchor.x, cols);
    const box = { x0: cols[col] - 5, x1: cols[col + 1] ? cols[col + 1] - 6 : pd.width };
    const stop = solo
      .filter((it) => it !== anchor && it.alias === anchor.alias && colOf(it.x, cols) === col && it.y > anchor.y + 2)
      .sort((a, b) => a.y - b.y)[0];
    const nextHead = pd.items
      .filter((it) => it.h >= HEADING_MIN_H && colOf(it.x, cols) === col && it.y > anchor.y + 2)
      .sort((a, b) => a.y - b.y)[0];
    const yMax = Math.min(stop?.y ?? pd.height, nextHead?.y ?? pd.height) - 2;
    fields.name = {
      op: "expect", page,
      box: { x0: anchor.x - 2, x1: anchor.x + (anchor.w ?? 60) + 2, y0: anchor.y - 5, y1: anchor.y + 4 },
      text: want,
    };
    const body = pd.items.filter(
      (it) => it !== anchor && it.h < DEF_BODY_MAX_H && colOf(it.x, cols) === col && it.y > anchor.y + 2 && it.y < yMax,
    );
    bodyText = joinBody(body);
    const paras = paragraphBoxes(toLines(body), box.x0, box.x1).map((p) => withFixes(p, pd, tabs));
    const cont = columnFlow(pd, cols, col, !!stop, (it) => it.alias === anchor.alias);
    if (cont.length) {
      const cx0 = cols[col + 1] - 5;
      const cx1 = cols[col + 2] ? cols[col + 2] - 6 : pd.width;
      paras.push(...paragraphBoxes(toLines(cont), cx0, cx1).map((p) => withFixes(p, pd, tabs)));
      bodyText = `${bodyText} ${joinBody(cont)}`.trim();
    }
    fields.description = { op: "text", page, paras };
  } else {
    const want = assists.anchor ?? entry.anchor?.runin ?? `${entry.name}:`;
    let anchor = pd.items.find((it) => it.h < DEF_BODY_MAX_H && it.str.trim().startsWith(want));
    if (!anchor) {
      // The PDF splits some headings across runs ("Discern" + "Evil:"), so no
      // single run starts with the name. Match the JOINED line instead — PER
      // COLUMN, since lines at the same y span both columns of a spread.
      const bodyItems = pd.items.filter((it) => it.h < DEF_BODY_MAX_H);
      search: for (let c = 0; c < cols.length; c++) {
        const colItems = bodyItems.filter((it) => colOf(it.x, cols) === c);
        for (const ln of toLines(colItems)) {
          const sorted = [...ln.items].sort((a, b) => a.x - b.x);
          const joined = sorted.map((i) => i.str).join("").replace(/\s+/g, " ").trim();
          if (joined.toLowerCase().startsWith(want.toLowerCase())) {
            anchor = sorted[0];
            break search;
          }
        }
      }
    }
    if (!anchor) throw new Error(`runin anchor "${want}" not found on p.${page}`);
    const col = colOf(anchor.x, cols);
    const colX = cols[col];
    const nextX = cols[col + 1];
    const box = { x0: colX - 5, x1: nextX ? nextX - 6 : pd.width };
    const stop = pd.items
      .filter((it) => it !== anchor && it.alias === anchor.alias && colOf(it.x, cols) === col && it.y > anchor.y + 2 && Math.abs(it.x - colX) < 15)
      .sort((a, b) => a.y - b.y)[0];
    // Where the NEXT heading carries a superscript ordinal ("Hideout (9th
    // level)"), that ordinal sits above its heading's baseline — so a block
    // that stops just above the heading still catches it, and the paragraph box
    // built around it swallows the heading line too. End above the superscript.
    let yStop = stop ? stop.y : pd.height;
    if (stop) {
      for (const it of pd.items) {
        if (it.h >= (stop.h ?? 9) * 0.8 || colOf(it.x, cols) !== col) continue;
        if (it.y >= stop.y || it.y < stop.y - 8) continue;
        yStop = Math.min(yStop, it.y);
      }
    }
    // `assists.descStopY` is the floor for an entry whose block ends at
    // something that is not another run-in heading — a table, a sidebar. The
    // stop rule only knows how to see the next heading.
    const yMax = Math.min(yStop - 2, assists.descStopY ?? pd.height);
    // The heading may be ONE run or several. Walk the anchor's line rightward
    // until the accumulated text covers the name — those runs are the heading.
    const sameLine = pd.items
      .filter((it) => Math.abs(it.y - anchor.y) <= 2 && colOf(it.x, cols) === col && it.x >= anchor.x)
      .sort((a, b) => a.x - b.x);
    const headRuns = new Set();
    // A run the heading only PARTLY covers: run -> how many leading characters
    // are heading. The PDF frequently emits "Acrobatics" and ": The character
    // is trained to…" as two runs, so the run carrying the colon carries the
    // opening sentence too. Dropping it wholesale loses that sentence — ten
    // entries were starting mid-sentence for exactly this reason.
    const stripMap = new Map();
    let headEnd = anchor.x + (anchor.w ?? 60) - 1;
    const fold = (s) => s.replace(/\s+/g, " ").trim();
    let acc = "";
    for (const it of sameLine) {
      if (fold(acc).length >= want.length) break;
      // Does this run overshoot the heading? Find the fewest of its characters
      // that finish covering `want`; anything past that is prose.
      let need = it.str.length;
      for (let k = 1; k <= it.str.length; k++) {
        if (fold(acc + it.str.slice(0, k)).length >= want.length) {
          need = k;
          break;
        }
      }
      if (need < it.str.length) {
        stripMap.set(it, need);
        acc += it.str.slice(0, need);
        headEnd = it.x + (it.w ?? 30) - 1;
        break;
      }
      headRuns.add(it);
      acc += it.str;
      headEnd = it.x + (it.w ?? 30) - 1;
    }
    // An ordinal inside a heading ("Hideout (9th level)") prints its suffix as
    // a SUPERSCRIPT on its own baseline a few points higher. It belongs to the
    // heading, so it joins the heading's drop set — otherwise it survives as a
    // stray "th" at the head of the description.
    for (const it of pd.items) {
      if (headRuns.has(it) || it.h >= (anchor.h ?? 9) * 0.8) continue;
      if (it.y >= anchor.y || it.y < anchor.y - 8) continue;
      if (it.x < anchor.x - 2 || it.x > headEnd + 2) continue;
      headRuns.add(it);
    }
    // Box membership tests a run's ORIGIN x, and the prose run starts flush
    // after the heading — so stop just short of it.
    // The band reaches above the baseline to catch tall glyphs. Where the
    // heading carries a SUPERSCRIPT ("Hideout (9th level)"), that ordinal sits
    // on its own baseline inside the band and lands in the extracted text,
    // which then cannot match the printed name. `assists.expectTop` tightens
    // the band to exclude it.
    fields.name = {
      op: "expect", page,
      box: { x0: anchor.x - 2, x1: headEnd, y0: anchor.y - (assists.expectTop ?? 5), y1: anchor.y + 4 },
      text: want,
    };
    const body = pd.items.filter((it) => {
      if (headRuns.has(it) || it.h >= DEF_BODY_MAX_H || colOf(it.x, cols) !== col) return false;
      const sameLineAfter = Math.abs(it.y - anchor.y) <= 2 && it.x >= anchor.x;
      return sameLineAfter || (it.y > anchor.y + 2 && it.y < yMax);
    });
    bodyText = joinBody(body);
    // Drop the heading by run ORDINAL rather than by text: that works whether
    // the PDF emitted it as one run or split it across several.
    const paras = paragraphBoxes(toLines(body), box.x0, box.x1).map((p, i) =>
      withFixes(p, pd, i === 0 ? new Set([...headRuns, ...tabs]) : tabs, i === 0 ? stripMap : null),
    );
    // Column-flowed continuation: an entry reaching the column bottom resumes
    // at the top of the next column, which is where ~1 in 5 entries lost their
    // second half.
    const isRunin = (it) => it.alias === anchor.alias && Math.abs(it.x - cols[colOf(it.x, cols)]) < 15;
    const cont = columnFlow(pd, cols, col, !!stop || assists.descStopY != null, isRunin);
    if (cont.length) {
      const cx0 = cols[col + 1] - 5;
      const cx1 = cols[col + 2] ? cols[col + 2] - 6 : pd.width;
      paras.push(...paragraphBoxes(toLines(cont), cx0, cx1).map((p) => withFixes(p, pd, tabs)));
      bodyText = `${bodyText} ${joinBody(cont)}`.trim();
    } else if (!stop && col + 1 >= cols.length) {
      // Bottom of the LAST column: the block continues overleaf.
      const pf = await pageFlow(doc, page, (it) => it.alias === anchor.alias);
      if (pf?.items.length) {
        const px0 = pf.cols[0] - 5;
        const px1 = pf.cols[1] ? pf.cols[1] - 6 : pf.pd.width;
        paras.push(...paragraphBoxes(toLines(pf.items), px0, px1).map((p) => withFixes({ ...p, page: pf.page }, pf.pd, marginTabs(pf.pd))));
        bodyText = `${bodyText} ${joinBody(pf.items)}`.trim();
      }
    }
    fields.description = { op: "text", page, paras };
  }

  /**
   * `assists.progression` — this ability's numbers live in a TABLE, not in its
   * entry. The chef names the table's heading and which column is this
   * ability's; the compiler resolves those to coordinates and ships only those,
   * so the values still come from the reader's book.
   *
   * Column headers are left-aligned while the cells under them are centred, so
   * a header's x does not land on its data. The data columns are found from the
   * FIRST data row instead, and each header claims the nearest one.
   */
  if (assists.progression) {
    const { table, column, page: tPage = page } = assists.progression;
    const tpd = tPage === page ? pd : await pageItems(doc, tPage);
    const fold = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    const head = tpd.items.find((i) => fold(i.str).startsWith(fold(table)));
    if (!head) {
      warn(`${entry.id}: progression table "${table}" not found on p.${tPage}`);
    } else {
      const below = tpd.items.filter((i) => i.y > head.y + 2 && i.y < head.y + 220);
      const rowsOf = (items) => {
        const by = new Map();
        for (const it of items) {
          const k = Math.round(it.y / 3);
          (by.get(k) ?? by.set(k, []).get(k)).push(it);
        }
        return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sort((a, b) => a.x - b.x));
      };
      const rows = rowsOf(below);
      // The header row is the first below the heading; data rows are the ones
      // whose leftmost cell is a bare level number.
      const header = rows[0] ?? [];
      const dataRows = rows.slice(1).filter((r) => /^\d+$/.test(r[0]?.str.trim()));
      if (!dataRows.length) {
        warn(`${entry.id}: progression table "${table}" has no numeric rows`);
      } else {
        // Header cells split across runs ("t"+"rapbreaking"), so rebuild them.
        const cells = [];
        for (const it of header) {
          const prev = cells[cells.length - 1];
          if (prev && it.x - (prev.x + (prev.w ?? 0)) < 3) prev.str += it.str;
          else cells.push({ str: it.str, x: it.x, w: it.w ?? 0 });
        }
        const want = cells.find((c) => fold(c.str) === fold(column)) ?? cells.find((c) => fold(c.str).startsWith(fold(column)));
        const dataXs = [...new Set(dataRows[0].slice(1).map((c) => c.x))].sort((a, b) => a - b);
        if (!want) {
          warn(`${entry.id}: progression column "${column}" not in table "${table}"`);
        } else {
          const colX = dataXs.reduce((best, x) => (Math.abs(x - want.x) < Math.abs(best - want.x) ? x : best), dataXs[0]);
          const y0 = dataRows[0][0].y - 4;
          const y1 = dataRows[dataRows.length - 1][0].y + 4;
          const lx = dataRows[0][0].x;
          fields.progression = {
            op: "progression", page: tPage,
            levelBox: { x0: lx - 6, x1: lx + 18, y0, y1 },
            valueBox: { x0: colX - 8, x1: colX + 26, y0, y1 },
          };
        }
      }
    }
  }

  // Chef-authored effect specs, for shapes the prose scan cannot classify on
  // its own (a companion pointing at a monster entry, a reroll's keep rule).
  // These ship STRUCTURE only — type, refs, mode, stacking. Any NUMBER they
  // carry is a `from.pattern` locator resolved against the seat's own prose, so
  // the recipe can be as convoluted as it likes without holding a value.
  if (entry.effects?.length) fields.effects = { op: "effects", specs: entry.effects };

  // Chef-authored ROLL recipes. The recipe ships how MANY rolls the entry has
  // and where each one's parts live; the label, the target and every ladder
  // step materialize from the reader's own book. Present means the chef read
  // this entry, so the recipe replaces the generic scan entirely.
  if (entry.rolls?.length) fields.rolls = { op: "rolls", specs: entry.rolls };

  metaCandidates(entry.id, entry, bodyText);

  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    book: entry.book,
    cite: `${BOOKS[entry.book].short} p.${page}`,
    pages: entry.pages,
    // Classification facts are AUTHORED, never inferred from the page here.
    // A pattern over body text is a scan, and scans locate rather than
    // conclude (docs/RECIPES.md, "The audit gate"): `metaCandidates` reports
    // what the text suggests so a chef can read the entry and author the
    // flag, and reports the inverse too. Only the register's own meta ships.
    meta: { ...(entry.meta ?? {}) },
    // A chef read this entry's FULL materialized output against the printed
    // page and signed it off (the register records the date; only the fact
    // ships). Until then the entry's mechanics are a machine draft — the
    // generic prose scans locate candidates but cannot judge what a number
    // MEANS in its sentence — and the binding marks them as such.
    ...(entry.audited ? { audited: true } : {}),
    // Authored per entry, like every other judgment in the register. An icon is
    // PRESENTATION: it says nothing about what the book states, so unlike a
    // mechanic a wrong one is a cosmetic bug rather than a wrong ruling — but
    // it is still authored data, reviewable in a diff and correctable in one
    // line, not computed from the name at load time.
    ...(entry.icon ? { icon: entry.icon } : {}),
    // Optional upgrade from the game-icons.net pack, used only where that
    // module is installed. `icon` above stays the floor every seat gets.
    ...(entry.iconNiche ? { iconNiche: entry.iconNiche } : {}),
    // A "See X." entry is a CROSS-REFERENCE, not an ability of its own. The
    // raw target is resolved to a real id in a post-pass (once every id is
    // known) so we never ship a dangling pointer. The conclusion ships; the
    // sentence never does.
    // `assists.aliasOf` is the chef pre-baking the link by hand, for the cases
    // where the printed cross-reference cannot be read back cleanly (a target
    // name that wraps mid-phrase, a heading the PDF split). Naming the target
    // needs the book; the resulting id does not, so it ships safely.
    ...(entry.assists?.aliasOf ? { _aliasTarget: entry.assists.aliasOf } : {}),
    ...(seeReference(bodyText) ? { _aliasRaw: seeReference(bodyText) } : {}),
    ...(replacementPhrase(bodyText) ? { _replacedRaw: replacementPhrase(bodyText) } : {}),
    fields,
  };
}

/** "2 1/2" -> 2.5, "1/2" -> 0.5, "3" -> 3. */
function parseCount(tok) {
  const t = String(tok).trim();
  const mixed = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return +mixed[1] + +mixed[2] / +mixed[3];
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return +frac[1] / +frac[2];
  const n = parseInt(t, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Report classification flags the body text SUGGESTS but the register does not
 * author — and, in the other direction, authored flags the text does not
 * appear to support. Pure diagnostics: nothing here reaches a shipped node.
 *
 * These patterns used to write straight into the compiled meta. That was the
 * anti-pattern this pipeline exists to prevent: a book-wide regex standing in
 * for a per-entry read (docs/RECIPES.md, "Never generalize a fix across
 * entries"). It looked harmless because it was only setting booleans, and it
 * was true on all twelve entries it hit — but six of those twelve state a
 * per-rank PROGRESSION in the very sentence it matched ("each time improving
 * the proficiency throw", "learning an additional three languages each"), and
 * flattening them to `repeatable: true` made that missing mechanic invisible.
 * A conclusion the chef never drew must not look like one they did.
 *
 * The custom-class BUILD COST is likewise absent by design: "counts as 2 1/2
 * custom powers" is a NUMBER off the page, and shipping it would put book
 * values in the module. It materializes at runtime from the reader's own prose
 * against the shipped pattern in `registers.derive` (see DERIVE_PATTERNS).
 */
const META_HINTS = {
  // The raw compile-time join omits some inter-run spaces ("removed fromACKS
  // II"), so every boundary is \s* rather than a literal space.
  deprecated: /removed\s*from\s*ACKS\s*II/i,
  repeatable: /selected\s*(?:multiple|several)\s*times|selected\s*more\s*than\s*once/i,
};

/**
 * The high-recall counterpart to META_HINTS, used ONLY to decide whether the
 * page is silent on a flag — never to suggest authoring one.
 *
 * The precise hints above are a reading prompt and are deliberately narrow.
 * Measured against the RR they miss roughly half the repeatable entries,
 * because the book writes the active "a character can select Bargaining
 * multiple times" as often as the passive form. So a hint MISSING is no
 * evidence at all that a chef's authored flag is wrong, and warning on that
 * disagreement just trains everyone to ignore warnings. These loose patterns
 * decide the reverse direction: complain only when nothing on the page is
 * even in the neighbourhood.
 */
const META_PRESENT = {
  deprecated: /removed|no\s*longer|retired/i,
  // Every gap is \s* for the same reason the precise hints above are: the
  // compile-time run join drops inter-run spaces, so "selected multiple times"
  // can arrive as "selectedmultipletimes". A literal-space version of this net
  // reported five entries as unsupported that I had read and verified myself.
  repeatable: /multiple\s*times|more\s*than\s*once|additional\s*times?|each\s*selection|again/i,
};

function metaCandidates(id, entry, bodyText) {
  if (!bodyText) return;
  for (const [flag, re] of Object.entries(META_HINTS)) {
    const hinted = re.test(bodyText);
    const authored = !!entry.meta?.[flag];
    // A hint is a READING PROMPT, not a finding: the pattern cannot tell
    // "can be selected multiple times" from "cannot", and does not see what
    // the rest of the sentence goes on to say.
    if (hinted && !authored) warn(`${id}: text may state "${flag}" — read the entry and author meta.${flag} if so`);
    if (authored && !META_PRESENT[flag].test(bodyText)) {
      warn(`${id}: register authors meta.${flag} but nothing on the page suggests it — re-read the entry`);
    }
  }
}

/**
 * What supersedes a power the book retired. A removed power is still INGESTED
 * (an older or converted source may name it) and flagged; this is the pointer
 * that lets a reference to it land on the thing that replaced it.
 */
function replacementPhrase(bodyText) {
  if (!bodyText) return null;
  const spaced =
    bodyText.match(/In lieu of this power,?\s*the\s*[A-Za-z]+\s*power\s*([a-z][a-z' -]{2,40}?)\s*has\s*been/i) ??
    bodyText.match(/should be assigned the\s*([a-z][a-z' -]{2,40}?)\s*power instead/i) ??
    bodyText.match(/Replace it with\s*(?:one rank of\s*)?([A-Za-z][A-Za-z' -]{2,40}?)\s*proficiency/i);
  if (spaced) return spaced[1].replace(/\s+/g, " ").trim();
  // The raw join can drop spaces wholesale ("Inlieuofthispower"), so retry
  // against a whitespace-free form. The squashed name still resolves, because
  // id matching compares case- and separator-folded.
  const flat = bodyText.replace(/\s+/g, "");
  const m =
    flat.match(/inlieuofthispower,?the[a-z]+power([a-z][a-z'-]{2,40}?)hasbeen/i) ??
    flat.match(/shouldbeassignedthe([a-z][a-z'-]{2,40}?)powerinstead/i) ??
    flat.match(/replaceitwith(?:onerankof)?([a-z][a-z'-]{2,40}?)proficiency/i);
  return m ? m[1] : null;
}

/**
 * The acks-lib capability token for a definition id
 * ("def.prof.sensingEvil" → "kw:sensingevil").
 *
 * Inlined rather than imported: acks-content does not otherwise depend on
 * acks-lib, and a build tool reaching into a sibling repo would break a
 * standalone clone. acks-lib's `capabilityForId` is the canonical definition
 * and is covered by its tests — keep the two in step.
 */
const capabilityToken = (id) =>
  "kw:" +
  String(id ?? "")
    .split(".")
    .slice(2)
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * The target text of a "See X." cross-reference body, or null. Conservative:
 * only a SHORT body that is ENTIRELY a see-reference qualifies, so a
 * description merely mentioning "see Chapter 6" is never mistaken for one.
 */
function seeReference(bodyText) {
  if (!bodyText || bodyText.length > 60) return null;
  const m = bodyText.match(/^See\s*(.+?)\s*\.?$/i);
  return m ? m[1] : null;
}

/**
 * Resolve a see-reference to a known definition id. Handles the three ways the
 * naive slug misses: trailing locators ("see alertness ABOVE"), cross-registry
 * references (a power pointing at a proficiency), and headings the PDF prints
 * without a space ("DiscernEvil"), which slug differently but compare equal
 * case-folded. Returns null when unresolvable — better no alias than a wrong one.
 */
function resolveAlias(raw, entryId, ids) {
  const cleaned = raw
    .replace(/\b(above|below|earlier|later|in this section)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const slug = slugOf(cleaned);
  if (!slug) return null;
  const own = entryId.split(".").slice(0, 2).join(".");
  for (const p of [...new Set([own, "def.power", "def.prof", "def.drawback"])]) {
    if (ids.has(`${p}.${slug}`)) return `${p}.${slug}`;
  }
  const want = slug.toLowerCase();
  for (const id of ids) if (id.split(".").slice(2).join(".").toLowerCase() === want) return id;
  return null;
}

/* -------------------------------------------- */
/*  Main                                        */
/* -------------------------------------------- */

async function main() {
  const only = positional[0];
  const { entries, kinds, refs } = loadRegister();
  const registers = compileRegisters(refs);
  const glyphChars = new Set(Object.keys(registers.tables.damageGlyph ?? {}));

  fs.mkdirSync(COOKBOOK, { recursive: true });
  fs.writeFileSync(path.join(COOKBOOK, "registers.json"), JSON.stringify(registers, null, 2) + "\n");

  const byBook = {};
  for (const e of entries) {
    if (only && e.book !== only) continue;
    (byBook[e.book] ??= []).push(e);
  }

  // Definition entries (proficiency/power/skill) aggregate into CONTENT-TYPE
  // cookbooks spanning every book; monsters keep their per-book file.
  const contentOut = {};

  for (const [bookId, list] of Object.entries(byBook)) {
    const file = FILES[bookId];
    if (!file || !fs.existsSync(file)) {
      warn(`book ${bookId}: reference PDF not found — skipped`);
      continue;
    }
    const { doc, numPages, title } = await openBook(fs.readFileSync(file));
    const fw = fingerprintWarning(bookId, numPages, title);
    if (fw) warn(fw);

    const out = {
      schema: "acks-cookbook/1",
      book: {
        id: bookId, label: BOOKS[bookId].label, short: BOOKS[bookId].short,
        pages: BOOKS[bookId].pages, titleRe: BOOKS[bookId].titleRe.source,
      },
      entries: {},
    };
    for (const entry of list.sort((a, b) => a.pages[0] - b.pages[0])) {
      const kindRow = kinds[entry.kind];
      if (!kindRow) {
        warn(`${entry.id}: unknown kind ${entry.kind} — skipped`);
        continue;
      }
      if (entry.status && entry.status !== "active") {
        console.error(`SKIP ${entry.id}: status "${entry.status}" (pending review)`);
        continue;
      }
      if (kindRow.role === "definition") {
        const content = CONTENT_OF[entry.kind];
        if (!content) {
          warn(`${entry.id}: definition kind ${entry.kind} has no content-type mapping — skipped`);
          continue;
        }
        try {
          const compiled = await compileDefinition(doc, entry, kindRow);
          (contentOut[content] ??= { schema: "acks-cookbook/1", content, entries: {} }).entries[entry.id] = compiled;
          console.error(`OK   ${entry.id}: ${compiled.fields.description.paras.length} para(s) [${content}]`);
        } catch (err) {
          warn(`${entry.id}: ${err.message}`);
        }
        continue;
      }
      const axCompile = AX_COMPILERS[entry.kind];
      if (entry.kind !== "kind.monster" && !axCompile) {
        warn(`${entry.id}: kind ${entry.kind} not compilable yet — skipped`);
        continue;
      }
      try {
        const compiled = axCompile
          ? await axCompile(doc, entry, kindRow)
          : await compileMonster(doc, entry, kindRow, glyphChars);
        const { _unmappedLabels, _skips, ...ship } = compiled;
        if (_skips) {
          // Entries sharing a page report the same furniture; dedup on merge.
          for (const [p, boxes] of Object.entries(_skips)) {
            const have = (out.skips ??= {})[p] ?? [];
            const seen = new Set(have.map((b) => JSON.stringify(b)));
            out.skips[p] = [...have, ...boxes.filter((b) => !seen.has(JSON.stringify(b)))];
          }
        }
        out.entries[entry.id] = ship;
        const n = Object.keys(ship.fields).length;
        const paraCount = ship.fields.description?.paras?.length ?? ship.fields.rows?.paras?.length ?? 0;
        console.error(
          `OK   ${entry.id}: ${n} instructions (${paraCount} paras${ship.fields.spoils ? ", spoils" : ""}${ship.fields.statline ? ", statline" : ""}${ship.fields.rows ? `, ${ship.fields.rows.paras.length} row-paras` : ""}${ship.fields.attacks?.colors ? ", colors" : ""})${_unmappedLabels ? ` — unmapped labels: ${_unmappedLabels.join(", ")}` : ""}`,
        );
      } catch (err) {
        warn(`${entry.id}: ${err.message}`);
      }
    }
    if (Object.keys(out.entries).length) {
      const outPath = path.join(COOKBOOK, `${bookId}.json`);
      fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
      console.error(`wrote ${Object.keys(out.entries).length} entr(ies) -> ${outPath}`);
    }
  }

  // Resolve "See X." cross-references once every id is known. Ids from content
  // types compiled in an EARLIER run are folded in too, so a per-book compile
  // still resolves across registries (a power may point at a proficiency).
  const entryById = new Map();
  for (const data of Object.values(contentOut)) for (const [id, e] of Object.entries(data.entries)) entryById.set(id, e);
  for (const name of new Set(Object.values(CONTENT_OF))) {
    const prev = path.join(COOKBOOK, `${name}.json`);
    if (contentOut[name] || !fs.existsSync(prev)) continue;
    for (const [id, e] of Object.entries(readJson(prev)?.entries ?? {})) entryById.set(id, e);
  }
  const knownIds = new Set(entryById.keys());

  // Pass 1: what each cross-reference points at, before anything is rewritten.
  const aliasTarget = new Map();
  let unresolved = 0;
  for (const data of Object.values(contentOut)) {
    for (const [id, e] of Object.entries(data.entries)) {
      // A retired power keeps its entry and its flag; this resolves the pointer
      // to whatever superseded it, falling back to the printed name. The
      // REGISTER's own `replacedBy` always wins — a chef who read the entry
      // outranks the phrase scan, which is only a candidate finder here.
      const rep = e._replacedRaw;
      delete e._replacedRaw;
      if (rep) {
        const found = resolveAlias(rep, id, knownIds) ?? rep;
        if (!e.meta?.replacedBy) warn(`${id}: text suggests replacedBy "${found}" — read the entry and author meta.replacedBy`);
        else if (e.meta.replacedBy !== found) warn(`${id}: authored replacedBy "${e.meta.replacedBy}" differs from the text's "${found}"`);
      }

      const raw = e._aliasRaw;
      const explicit = e._aliasTarget;
      delete e._aliasRaw;
      delete e._aliasTarget;
      if (!raw && !explicit) continue;
      // A hand-authored target wins: it exists precisely because reading the
      // printed reference back failed.
      if (explicit && !knownIds.has(explicit)) {
        unresolved++;
        warn(`${id}: assists.aliasOf "${explicit}" is not a known definition`);
        continue;
      }
      const target = explicit ?? resolveAlias(raw, id, knownIds);
      if (target && target !== id) aliasTarget.set(id, target);
      else {
        unresolved++;
        warn(`${id}: see-reference could not be resolved to a known definition`);
      }
    }
  }
  // Snapshot the text pointers BEFORE rewriting: an alias may point at another
  // alias, and it must land on the entry that actually prints the text.
  const textOf = new Map([...entryById].map(([id, e]) => [id, e.fields?.description]));
  const citeOf = new Map([...entryById].map(([id, e]) => [id, e.cite]));
  const finalTarget = (id) => {
    const seen = new Set([id]);
    let at = aliasTarget.get(id);
    while (at && aliasTarget.has(at) && !seen.has(at)) {
      seen.add(at);
      at = aliasTarget.get(at);
    }
    return at;
  };

  // Pass 2: an alias is its OWN ability, not a redirect. The books list a name
  // whose rules text is printed under another entry — so it gets a real entry
  // and the recipe carries a pre-baked pointer to WHERE that text lives. The
  // pointer is page coordinates, not the passage: safe to ship, useless without
  // the book. Because the effect scan reads whatever prose the pointer yields,
  // the alias materializes the same mechanics without restating any of them.
  let linked = 0;
  let dangling = 0;
  for (const data of Object.values(contentOut)) {
    for (const [id, e] of Object.entries(data.entries)) {
      const target = finalTarget(id);
      if (!target) continue;
      e.aliasOf = target;
      const desc = textOf.get(target);
      if (!desc) {
        dangling++;
        warn(`${id}: alias target ${target} has no text pointer to follow`);
        continue;
      }
      e.fields.description = desc;
      // The prose alone only carries what the SCAN can classify. Anything the
      // chef authored on the target — a prerequisite, a companion slot, a
      // progression column — is equally part of the capability, and an alias
      // that shares the capability shares those too. Its own authored specs
      // always win; this only fills what it did not state for itself.
      const tf = entryById.get(target)?.fields ?? {};
      if (tf.effects && !e.fields.effects) e.fields.effects = tf.effects;
      if (tf.progression && !e.fields.progression) e.fields.progression = tf.progression;
      // The citation labels the PROSE, and the prose is the target's — so cite
      // where a reader would actually turn to read it.
      e.cite = citeOf.get(target) ?? e.cite;
      // Two names for one capability do not stack. The target's build cost and
      // retirement carry over too (same content), but never overwrite anything
      // the alias's own listing stated.
      const t = entryById.get(target);
      e.meta = {
        ...(t?.meta?.powerValue != null ? { powerValue: t.meta.powerValue } : {}),
        ...(t?.meta?.deprecated ? { deprecated: true, ...(t.meta.replacedBy ? { replacedBy: t.meta.replacedBy } : {}) } : {}),
        ...(e.meta ?? {}),
        notStacksWith: [target],
        // The alias and its target are one capability under two names, so both
        // declare it. A gate written against the capability is then satisfied
        // by whichever of them the character actually took.
        provides: [capabilityToken(target)],
      };
      t.meta = { ...(t.meta ?? {}), provides: [capabilityToken(target)] };
      linked++;
    }
  }
  if (linked || unresolved || dangling) {
    console.error(`aliases: ${linked} linked to their text, ${unresolved} unresolved, ${dangling} dangling`);
  }

  // Content-type cookbooks: named by WHAT they extract, spanning every book
  // (powers appear in JJ and other books; monsters in MM and adventures).
  for (const [content, data] of Object.entries(contentOut)) {
    const outPath = path.join(COOKBOOK, `${content}.json`);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
    // The audit burn-down, stated at every build so nobody mistakes scan
    // coverage for verified correctness. An entry counts only when a chef has
    // read its full output against the page and set `audited` in the register.
    const all = Object.values(data.entries);
    const done = all.filter((e) => e.audited).length;
    console.error(`wrote ${all.length} entr(ies) -> ${outPath} (chef-audited: ${done}/${all.length})`);
  }

  // An index of what actually exists, so the runtime loads by name instead of
  // probing every book id and 404-ing for the ones with no cookbook yet.
  // Written from the DIRECTORY, not this run, so a per-book compile does not
  // drop the files an earlier run produced.
  const present = fs.readdirSync(COOKBOOK).filter((f) => f.endsWith(".json"));
  const stem = (f) => f.replace(/\.json$/, "");
  const contentNames = new Set(Object.values(CONTENT_OF));
  fs.writeFileSync(
    path.join(COOKBOOK, "index.json"),
    JSON.stringify(
      {
        books: present.map(stem).filter((s) => BOOKS[s]),
        content: present.map(stem).filter((s) => contentNames.has(s)),
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`compile done — ${warns.length} warning(s).`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
