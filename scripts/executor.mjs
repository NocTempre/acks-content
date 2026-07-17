/**
 * Cookbook executor — the DUMB runtime interpreter (frozen instruction set,
 * schema "acks-cookbook/1"; see docs/COOKBOOK.md).
 *
 * Performs instructions mechanically against the seat's own opened PDF: filter
 * text runs by shipped geometry, apply shipped assembly fixes, parse with the
 * fixed pattern library, resolve tokens through shipped exact-match tables,
 * read instructed visual attributes (glyph fill colors). NO judgment lives
 * here: no detection, inference, normalization, or promotion — every decision
 * was made offline and shipped as data. Content failures degrade to misses/
 * stubs; this module never throws on content.
 *
 * Runs identically in the browser (Foundry binding) and Node (verify harness).
 */
import { pageItems, pageArtInfo } from "./extract.mjs";

export const COOKBOOK_SCHEMA = "acks-cookbook/1";

/* -------------------------------------------- */
/*  Mechanical helpers (fixed, part of v1)      */
/* -------------------------------------------- */

// Private-use-area glyphs (icons, foot/inch marks) are stripped from prose and
// raw values; damage handling reads them deliberately before the strip.
const PUA_RE = /[-]/g;
const clean = (s) => (s ?? "").replace(PUA_RE, "").replace(/\s+/g, " ").trim();

const inBox = (it, box) => it.x >= box.x0 && it.x <= box.x1 && it.y >= box.y0 && it.y <= box.y1;

/**
 * Runs inside the instruction's box(es), in reading order (y, then x). ALL
 * matching runs are returned (and claimed by the caller); dropText removal
 * happens at join time so fix ordinals and claims stay stable. Exported for
 * the compiler, which must enumerate identically when computing fixes.
 */
export function runsIn(pageData, instr) {
  const boxes = instr.boxes ?? (instr.box ? [instr.box] : []);
  return pageData.items
    .filter((it) => boxes.some((b) => inBox(it, b)))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Join runs applying shipped fixes ({drop,joinSpace,mergeHyphen} run ordinals)
 * and skipping dropText runs (labels/headers claimed but not part of the
 * value). Ordinals index the FULL run list. Exported for compiler parity.
 */
export function joinRuns(runs, fixes = {}, dropText) {
  const drop = new Set(fixes.drop ?? []);
  const joinSpace = new Set(fixes.joinSpace ?? []);
  const mergeHyphen = new Set(fixes.mergeHyphen ?? []);
  let out = "";
  runs.forEach((r, i) => {
    if (drop.has(i) || (dropText && r.str.trim() === dropText)) return;
    let s = r.str;
    if (mergeHyphen.has(i)) s = s.replace(/-\s*$/, "");
    out += s;
    if (joinSpace.has(i)) out += " ";
  });
  return out;
}

/** Exact-match table lookup: token -> {text, key?, ref?}; miss -> {text}. */
function lookup(registers, tableName, token, misses) {
  const row = registers?.tables?.[tableName]?.[token];
  if (!row) {
    if (token && misses) misses.push({ table: tableName, token });
    return { text: token };
  }
  return { text: token, ...row };
}

const DICE_RE = /\d*d\d+(?:[+-]\d+)?/;
const SPOIL_RE = /([A-Za-z][A-Za-z' -]*?)\s*\((\d+)(?:\s*(\d)\/6)?\s*st,\s*([\d,]+)\s*gp(?:,\s*([^)]+))?\)/g;

/** Fixed pattern library (frozen with the schema). */
function applyPattern(raw, instr, registers, misses) {
  const text = clean(raw);
  switch (instr.pattern ?? "raw") {
    case "raw":
    case "statValue":
      return instr.table ? lookup(registers, instr.table, text, misses) : text;
    case "int": {
      const m = /(-?[\d,]+)/.exec(text);
      return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
    }
    case "dice":
      return DICE_RE.exec(text)?.[0] ?? null;
    case "refList":
      if (!text || /^none/i.test(text)) return [];
      return text.split(",").map((s) => s.trim()).filter(Boolean).map((t) => lookup(registers, instr.table, t, misses));
    case "parenSplit": {
      const m = /^([^(]+?)\s*(?:\(([^)]*)\))?$/.exec(text);
      if (!m) return { text };
      const main = instr.table ? lookup(registers, instr.table, m[1].trim(), misses) : { text: m[1].trim() };
      const paren = (m[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
        .map((t) => (instr.parenTable ? lookup(registers, instr.parenTable, t, misses) : { text: t }));
      return { ...main, ...(paren.length ? { paren } : {}) };
    }
    case "spoilList": {
      const spoils = [];
      for (const m of text.matchAll(SPOIL_RE)) {
        spoils.push({
          name: m[1].trim(),
          weight6: parseInt(m[2], 10) * 6 + (m[3] ? parseInt(m[3], 10) : 0),
          cost: parseInt(m[4].replace(/,/g, ""), 10),
          effects: (m[5] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
            .map((t) => (instr.effectsTable ? lookup(registers, instr.effectsTable, t, misses) : { text: t })),
        });
      }
      return spoils;
    }
    default:
      return text; // unknown pattern: degrade to raw text, never throw
  }
}

/** Page-art selection by shipped criteria (no judgment beyond the config). */
function selectArt(infos, select = {}, name) {
  if (name) return infos.find((i) => i.name === name) ?? null;
  const { minW = 200, minH = 200, maxW = 1500, maxRatio = 3 } = select;
  return (
    infos
      .filter((i) => i.width >= minW && i.height >= minH && i.width < maxW)
      .filter((i) => i.width / i.height < maxRatio && i.height / i.width < maxRatio)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null
  );
}

/* -------------------------------------------- */
/*  Instruction execution                       */
/* -------------------------------------------- */

async function execInstruction(instr, ctx) {
  const { doc, registers, getPage, claims, misses } = ctx;
  const pd = await getPage(instr.page);

  const claim = (runs, field) => {
    if (claims) for (const r of runs) claims.set(r, field);
  };

  switch (instr.op) {
    case "expect": {
      const runs = runsIn(pd, instr);
      claim(runs, ctx.field);
      const found = clean(joinRuns(runs));
      const ok = found.toLowerCase().startsWith(instr.text.toLowerCase());
      return { ok, found: found.slice(0, 60) };
    }
    case "text": {
      const paras = [];
      for (const para of instr.paras ?? []) {
        const runs = runsIn(pd, para);
        claim(runs, ctx.field);
        const text = clean(joinRuns(runs, para.fixes ?? instr.fixes));
        if (text) paras.push({ type: "paragraph", text });
      }
      return paras;
    }
    case "value": {
      const runs = runsIn(pd, instr);
      claim(runs, ctx.field);
      return applyPattern(joinRuns(runs, instr.fixes, instr.dropText), instr, registers, misses);
    }
    case "attacks": {
      const aRuns = runsIn(pd, { box: instr.attacksBox });
      const dRuns = runsIn(pd, { box: instr.damageBox });
      claim(aRuns, ctx.field);
      claim(dRuns, ctx.field);
      const attacksText = clean(joinRuns(aRuns, instr.fixes?.attacks, instr.dropText?.attacks));
      const damageRaw = joinRuns(dRuns, instr.fixes?.damage, instr.dropText?.damage); // glyphs preserved
      const throwMatch = /(\d+)\+/.exec(attacksText);
      const routines = /^(\d+)/.exec(attacksText);
      // Segment damage; per segment: dice + glyph -> damageType via table.
      // Quality comes from the shipped per-segment COLOR ANNOTATION ("this
      // glyph prints red") mapped through the color table — an observation
      // the compiler made; the runtime never scrapes colors. It only applies
      // when the seat's book actually yields the segment.
      const segments = damageRaw.split("/").map((s) => s.trim()).filter((s) => DICE_RE.test(s));
      const colors = instr.colors
        ? instr.colors.map((c) => (c ? (registers?.tables?.[instr.colorTable]?.[c] ?? null) : null))
        : null;
      const names = instr.names ?? [];
      return {
        text: [attacksText, clean(damageRaw)].filter(Boolean).join(" — "),
        throw: throwMatch ? parseInt(throwMatch[1], 10) : null,
        routines: routines ? parseInt(routines[1], 10) : null,
        segments: segments.map((seg, i) => {
          let damageType = { text: "" };
          for (const ch of seg) {
            if (registers?.tables?.[instr.glyphTable]?.[ch]) {
              damageType = { text: ch, ...registers.tables[instr.glyphTable][ch] };
              break;
            }
          }
          return {
            name: names[i]?.name ?? names[names.length - 1]?.name ?? null,
            naturalWeapon: names[i]?.nw ?? names[names.length - 1]?.nw ?? null,
            damage: DICE_RE.exec(clean(seg))?.[0] ?? clean(seg),
            damageType: damageType.ref || damageType.key ? damageType : null,
            quality: colors?.[i] ?? null, // "extraordinary" | "mundane" | null
          };
        }),
      };
    }
    case "art": {
      const infos = await pageArtInfo(doc, instr.page).catch(() => []);
      const chosen = selectArt(infos, instr.select, instr.name);
      return chosen ? { name: chosen.name, width: chosen.width, height: chosen.height, kind: chosen.kind } : null;
    }
    default:
      return null; // unknown op: future schema — degrade, never throw
  }
}

/* -------------------------------------------- */
/*  Entry execution                             */
/* -------------------------------------------- */

/**
 * Execute one cookbook entry against an open document.
 * Returns { id, kind, name, cite, ok, fields, misses } — `fields` nests
 * "stats.x" instructions under fields.stats.x. With opts.trackClaims, also
 * returns `claims` (Map: text item -> field name) and `pages` touched, for the
 * verify harness's residue accounting.
 */
export async function executeEntry(doc, bookCookbook, registers, entryId, opts = {}) {
  const entry = bookCookbook?.entries?.[entryId];
  if (!entry || bookCookbook.schema !== COOKBOOK_SCHEMA) {
    return { id: entryId, ok: false, reason: !entry ? "unknown-entry" : "schema-mismatch", fields: {} };
  }
  const pageCache = opts.pageCache ?? new Map();
  const getPage = async (n) => {
    if (!pageCache.has(n)) pageCache.set(n, await pageItems(doc, n));
    return pageCache.get(n);
  };
  const claims = opts.trackClaims ? new Map() : null;
  const misses = [];
  const fields = {};
  let ok = true;

  for (const [field, instr] of Object.entries(entry.fields ?? {})) {
    if (opts.skipOps?.includes(instr.op)) continue; // caller choice (e.g. verify without art)
    const ctx = { doc, registers, getPage, claims, misses, field };
    let result = null;
    try {
      result = await execInstruction(instr, ctx);
    } catch (err) {
      misses.push({ field, error: err.message });
      result = null;
    }
    if (field === "name") {
      if (result && result.ok === false) ok = false;
      fields.name = result;
      continue;
    }
    // Nest "stats.x" under fields.stats
    if (field.startsWith("stats.")) {
      (fields.stats ??= {})[field.slice(6)] = result;
    } else {
      fields[field] = result;
    }
  }

  return {
    id: entryId,
    kind: entry.kind,
    name: entry.name,
    cite: entry.cite,
    ok,
    fields,
    misses,
    ...(claims ? { claims, pages: [...pageCache.keys()] } : {}),
  };
}
