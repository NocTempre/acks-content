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
 * Usage: node tools/compile-cookbook.mjs [book]   (default: all books with entries)
 * Emits: cookbook/<book>.json + cookbook/registers.json; report to stderr.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBook, pageItems, listHeadings, detectColumns, colOf, glyphColorRuns } from "../scripts/extract.mjs";
import { runsIn, joinRuns } from "../scripts/executor.mjs";
import { BOOKS, fingerprintWarning } from "../scripts/books.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTER = path.join(HERE, "..", "register");
const COOKBOOK = path.join(HERE, "..", "cookbook");
const LIB = "C:\\Proj\\acks-reference\\ACKSII";
const FILES = {
  rr: `${LIB}\\ACKSII_Revised_Rulebook_DIGITAL_FINAL_r10_2nd_Printing.pdf`,
  jj: `${LIB}\\ACKSII_Judges_Journal_DIGITAL_FINAL_r9_2nd_Printing.pdf`,
  mm: `${LIB}\\ACKSII_Monstrous_Manual_DIGITAL_FINAL_r7_2nd_Printing.pdf`,
};

const HEADING_MIN_H = 12; // mirrors extract.mjs
const LABEL_RE = /^[A-Z][A-Za-z ()'/]{0,28}:$/;
const DICE_RE = /\d*d\d+(?:[+-]\d+)?/;
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
  return { schema: "acks-cookbook/1", tables, nodes };
}

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
    const sameLine = Math.abs(a.y - b.y) <= 2;
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

/** Attach computed fixes to an instruction (or a text para). */
function withFixes(instr, pd) {
  const fixes = computeFixes(runsIn(pd, instr));
  if (fixes) instr.fixes = fixes;
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

const NW_STEMS = [
  ["bite", /^bit/], ["stinger", /^stinger/], ["sting", /^sting/], ["gore", /^gor/],
  ["horn", /^horn/], ["tusk", /^tusk/], ["spine", /^spine/], ["claw", /^claw/],
  ["talon", /^talon/], ["pincer", /^pincer/], ["hoof", /^(hoof|hoov)/], ["tail", /^tail/],
  ["tentacle", /^tentacl/], ["tongue", /^tongue/], ["constriction", /^constrict/],
  ["ram", /^ram/], ["feeler", /^feeler/], ["envelopment", /^envelop/], ["weapon", /^weapon/],
];
const stemNw = (name) => {
  const n = name.toLowerCase().trim();
  for (const [key, re] of NW_STEMS) if (re.test(n)) return key;
  return null;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const camel = (s) =>
  s.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean)
    .map((w, i) => (i ? cap(w.toLowerCase()) : w.toLowerCase())).join("");

/* -------------------------------------------- */
/*  Monster compilation                         */
/* -------------------------------------------- */

async function compileMonster(doc, entry, kindRow, glyphChars) {
  const page = entry.pages[0];
  const pd = await pageItems(doc, page);
  const cols = detectColumns(pd.items);

  const anchors = listHeadings(pd).filter((a) => a.mode === "display");
  // Fallback ladder for outline titles that differ from the printed heading
  // (parent/variant pages: "Statue, Animated Bronze" prints as "BRONZE" under
  // a "STATUE, ANIMATED" parent; "(Overview)" suffixes never print). Try the
  // full title, then without parentheticals, then progressively shorter word
  // tails. The string that MATCHES becomes the shipped expect text.
  const candidates = [entry.anchor.display];
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
  const laterHeads = anchors.filter((a) => a.col === anchor.col && a.y > anchor.y + 2).sort((a, b) => a.y - b.y);
  const stopY = laterHeads[0]?.y ? laterHeads[0].y - 4 : pd.height;

  const bodyIn = (p, x0, x1, y0, y1) =>
    p.items.filter((it) => it.h < HEADING_MIN_H && it.x >= x0 && it.x <= x1 && it.y > y0 && it.y < y1);

  // Prose column body; Spoils splits the region so claims never overlap.
  const proseItems = bodyIn(pd, proseBox.x0, proseBox.x1, anchor.y + 2, stopY);
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
    box: { x0: proseBox.x0, x1: proseBox.x1, y0: anchor.y - 16, y1: anchor.y + 6 },
    text: matchedText,
  };
  fields.description = {
    op: "text", page,
    paras: paragraphBoxes(toLines(descItems), proseBox.x0, proseBox.x1).map((p) => withFixes(p, pd)),
  };
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
  if (statLabels.length < 8 && page + 1 <= doc.numPages) {
    const pd2 = await pageItems(doc, page + 1);
    const cols2 = detectColumns(pd2.items);
    const r2 = labelsOf(pd2, cols2);
    if (r2.labels.length >= 8) {
      statPd = pd2;
      statPage = page + 1;
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

  // Spoils may live near the stat block on the stat page instead.
  if (!spoilsAnchor && statPd !== pd) {
    const sp2 = statPd.items.find((it) => it.h < HEADING_MIN_H && it.str.trim() === "Spoils");
    if (sp2) {
      const spCol = colOf(sp2.x, statCols);
      const spX0 = statCols[spCol] - 5;
      const spX1 = statCols[spCol + 1] ? statCols[spCol + 1] - 6 : statPd.width;
      const laterHeads2 = listHeadings(statPd)
        .filter((a) => a.mode === "display" && colOf(a.text ? sp2.x : sp2.x, statCols) === spCol && a.y > sp2.y)
        .sort((a, b) => a.y - b.y);
      spoilsAnchor = sp2;
      spoilsPd = statPd;
      spoilsPage = statPage;
      spoilsBox = { x0: spX0, x1: spX1, y0: sp2.y - 3, y1: laterHeads2[0]?.y ? laterHeads2[0].y - 4 : statPd.height };
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

  // Value baselines can sit up to ~4pt ABOVE their label's baseline (font
  // ascent skew on wrapped values), so each row's band is shifted up by 4.
  statLabels.forEach((label, i) => {
    const labelText = label.str.trim();
    const name = labelText.slice(0, -1);
    const y0 = label.y - 4;
    const y1 = i + 1 < statLabels.length ? statLabels[i + 1].y - 4.01 : statEnd;
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
      fields[`stats.speed${cap(camel(kind))}`] = withFixes({ ...base, pattern: speedCfg.pattern }, statPd);
      return;
    }
    const row = rows[name];
    if (row) {
      fields[`stats.${row.field}`] = withFixes({
        ...base,
        pattern: row.pattern,
        ...(row.table ? { table: row.table } : {}),
        ...(row.parenTable ? { parenTable: row.parenTable } : {}),
      }, statPd);
    } else {
      unmapped.push(name);
      fields[`stats._raw.${camel(name)}`] = withFixes({ ...base, pattern: "raw" }, statPd);
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

    // Names from the parenthetical: "2 talons, bite 4+" -> Talon, Talon, Bite
    const inner = /\(([^)]*)\)/.exec(attacksText)?.[1] ?? "";
    const names = [];
    for (let token of inner.replace(/\d+\+\s*$/, "").split(",")) {
      token = token.trim().replace(/\d+\+\s*$/, "").trim();
      const counted = /^(\d+)\s+(.+)$/.exec(token);
      const push = (t) => {
        const nw = stemNw(t);
        if (!nw) warn(`${entry.id}: no naturalWeapon stem for "${t}"`);
        names.push({ name: cap(t), ...(nw ? { nw } : {}) });
      };
      if (counted) {
        for (let k = 0; k < Math.min(parseInt(counted[1], 10), 8); k++) push(counted[2]);
      } else if (token) {
        push(token);
      }
    }

    const segments = damageRaw.split("/").map((s) => s.trim()).filter((s) => DICE_RE.test(s));
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
      names,
      glyphTable: kindRow.fields.attacks.glyphTable,
      ...(colors ? { colors, colorTable: kindRow.fields.attacks.colorTable } : {}),
    };
  }

  fields.art = { op: "art", page, select: kindRow.fields.art.select };

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
/*  Main                                        */
/* -------------------------------------------- */

async function main() {
  const only = process.argv[2];
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
      if (entry.kind !== "kind.monster") {
        warn(`${entry.id}: kind ${entry.kind} not compilable yet — skipped`);
        continue;
      }
      if (entry.status && entry.status !== "active") {
        console.error(`SKIP ${entry.id}: status "${entry.status}" (pending review)`);
        continue;
      }
      try {
        const compiled = await compileMonster(doc, entry, kindRow, glyphChars);
        const { _unmappedLabels, _skips, ...ship } = compiled;
        if (_skips) for (const [p, boxes] of Object.entries(_skips)) (out.skips ??= {})[p] = boxes;
        out.entries[entry.id] = ship;
        const n = Object.keys(ship.fields).length;
        console.error(
          `OK   ${entry.id}: ${n} instructions (${ship.fields.description.paras.length} paras${ship.fields.spoils ? ", spoils" : ""}${ship.fields.attacks?.colors ? ", colors" : ""})${_unmappedLabels ? ` — unmapped labels: ${_unmappedLabels.join(", ")}` : ""}`,
        );
      } catch (err) {
        warn(`${entry.id}: ${err.message}`);
      }
    }
    const outPath = path.join(COOKBOOK, `${bookId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
    console.error(`wrote ${Object.keys(out.entries).length} entr(ies) -> ${outPath}`);
  }
  console.error(`compile done — ${warns.length} warning(s).`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
