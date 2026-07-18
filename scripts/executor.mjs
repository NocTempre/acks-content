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

const DICE_RE = /\d*d\d+(?:[×xX]\d+)?(?:[+-]\d+)?/;
// A damage segment is real when it has dice, a flat number (e.g. "1"), or is a
// "by weapon" placeholder — the last two are silently dropped by a dice-only
// filter, which zeroes out most humanoid/flat-damage attacks.
const isDamageSeg = (s) => {
  const c = clean(s);
  return DICE_RE.test(c) || /^\d+$/.test(c) || /weapon/i.test(c);
};
// Component: "name (W st, Ngp, effects…)" where W = "2", "2 3/6", or "4/6" —
// the whole-stone part is OPTIONAL (fractional-only weights are common).
const SPOIL_RE = /([A-Za-z][A-Za-z' -]*?)\s*\((?:(\d+)\s*)?(?:(\d)\/6\s*)?st,\s*([\d,]+)\s*gp(?:,\s*((?:[^()]|\([^)]*\))+?))?\)/g;

/** Split on commas at parenthesis depth 0 ("a (b, c), d" -> ["a (b, c)", "d"]). */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s ?? "") {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

/* -------------------------------------------- */
/*  Attack model (frozen, shared with compiler) */
/* -------------------------------------------- */

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Natural-weapon stems (bit->bite): fixed game vocabulary, frozen with the
// schema. Ordered so a more specific stem wins (stinger before sting).
const NW_STEMS = [
  ["bite", /^bit/], ["stinger", /^stinger/], ["sting", /^sting/], ["gore", /^gor/],
  ["horn", /^horn/], ["tusk", /^tusk/], ["spine", /^spine/], ["claw", /^claw/],
  ["talon", /^talon/], ["pincer", /^pincer/], ["hoof", /^(hoof|hoov)/], ["tail", /^tail/],
  ["tentacle", /^tentacl/], ["tongue", /^tongue/], ["constriction", /^constrict/],
  ["ram", /^ram/], ["feeler", /^feeler/], ["envelopment", /^envelop/], ["weapon", /weapon/],
];
export function stemNw(name) {
  const n = (name ?? "").toLowerCase().trim();
  for (const [key, re] of NW_STEMS) if (re.test(n)) return key;
  return null;
}

/** Split a string on top-level " or " / " OR " (not inside parentheses). */
function splitOr(s) {
  const str = s ?? "";
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\bor\b/i.test(str.slice(i, i + 4)) && str.slice(i, i + 4).toLowerCase() === " or ") {
      parts.push(cur);
      cur = "";
      i += 3;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Parse one routine "3 (2 claws, bite 8+)" -> { count, throw, names:[{name,nw}] }. */
function parseRoutine(text) {
  const t = (text ?? "").trim();
  const m = /^(\d+)?\s*(?:\(([^)]*)\))?/.exec(t);
  const count = m?.[1] ? parseInt(m[1], 10) : null;
  const inner = (m?.[2] ?? t.replace(/^\d+\s*/, "")).trim();
  const throwM = /(-?\d+)\+/.exec(inner);
  const partsText = inner.replace(/-?\d+\+\s*$/, "").trim();
  const names = [];
  for (let token of partsText.split(",")) {
    token = token.trim().replace(/-?\d+\+\s*$/, "").trim();
    if (!token) continue;
    const counted = /^(\d+)\s+(.+)$/.exec(token);
    const pushName = (nm) => names.push({ name: cap(nm), nw: stemNw(nm) });
    if (counted) for (let k = 0; k < Math.min(parseInt(counted[1], 10), 8); k++) pushName(counted[2]);
    else pushName(token);
  }
  return { count, throw: throwM ? parseInt(throwM[1], 10) : null, names };
}

/**
 * Structured attack model: Attacks and Damage fields each split on top-level
 * " or " into aligned MODES (alternatives like "1 weapon OR 2 claws + bite").
 * Within a mode, damage segments zip 1:1 with expanded attack names. Returns
 * `modes` and `flatDamage` (all damage segs in mode order — the compiler uses
 * it to align glyph colours identically to what the runtime will enumerate).
 * Shared verbatim by compiler + executor so nothing drifts.
 */
export function attackModel(attacksText, damageRaw) {
  const damageGroups = splitOr(damageRaw);
  // Coalesce a BARE-NUMBER attack part ("1 or 2 (hooves 7+)") into the routine
  // that follows it — it is a count RANGE for one attack, not a separate mode.
  // The damage "or"-groups are authoritative for how many attack modes exist.
  const routineStrs = [];
  let alt = null;
  for (const part of splitOr(attacksText)) {
    if (/^\d+$/.test(part.trim())) {
      alt = parseInt(part, 10);
      continue;
    }
    routineStrs.push({ text: part, alt });
    alt = null;
  }
  if (!routineStrs.length) routineStrs.push({ text: alt != null ? String(alt) : attacksText ?? "", alt: null });
  const n = Math.max(damageGroups.length, routineStrs.length, 1);
  const modes = [];
  const flatDamage = [];
  for (let i = 0; i < n; i++) {
    const r = routineStrs[i] ?? routineStrs[routineStrs.length - 1];
    const routine = parseRoutine(r.text);
    if (r.alt != null) routine.altCount = r.alt;
    const dmgGroup = damageGroups[i] ?? damageGroups[damageGroups.length - 1] ?? "";
    const dmgSegs = dmgGroup.split("/").map((s) => s.trim()).filter(isDamageSeg);
    for (const d of dmgSegs) flatDamage.push(d);
    modes.push({ ...routine, dmgSegs });
  }
  return { modes, flatDamage };
}

/* -------------------------------------------- */
/*  Defense scan (frozen, vocabulary-driven)    */
/* -------------------------------------------- */

// Damage-word -> type key. Keys mirror the damageGlyph registry; a few English
// synonyms map to the canonical key. Generic vocabulary, frozen like the rest.
const DAMAGE_WORDS = {
  acid: "acidic", acidic: "acidic", arcane: "arcane", bludgeoning: "bludgeoning",
  necrotic: "necrotic", cold: "cold", frost: "cold", electric: "electrical",
  electrical: "electrical", electricity: "electrical", lightning: "electrical",
  fire: "fire", flame: "fire", luminous: "luminous", slashing: "slashing",
  piercing: "piercing", poison: "poisonous", poisonous: "poisonous", seismic: "seismic",
};
// A defense clause ends at the sentence end OR the next defence verb / contrast
// word — so "immune to X and resistant to Y" doesn't leak Y's flags into X.
const DEF_BOUNDARY =
  "(?=[.;]|\\b(?:but|however|except|while|though|although|whereas)\\b|\\b(?:resistant|resistance|vulnerable|susceptible)\\b|\\bhave full effect\\b|$)";

/**
 * Scan a monster's OWN description prose for immunity / resistance /
 * susceptibility statements, matching a SHIPPED vocabulary (damage words +
 * the defenseEffect register). Materializes per seat from that seat's book —
 * nothing about which defenses apply is ever baked. Exported so authoring
 * tools can preview the same result.
 */
export function defenseScan(paras, registers) {
  const text = (paras ?? []).map((p) => (typeof p === "string" ? p : p.text)).join(" ");
  if (!text) return null;
  const effVocab = Object.entries(registers?.tables?.defenseEffect ?? {}); // [surface, {key}]
  const bucket = () => ({ damage: [], effects: [], mundane: false, extraordinary: false });
  const scan = (verbRe) => {
    const b = bucket();
    for (const m of text.matchAll(verbRe)) {
      const clause = m[1].toLowerCase();
      for (const [word, key] of Object.entries(DAMAGE_WORDS)) {
        if (new RegExp(`\\b${word}\\b`).test(clause) && !b.damage.includes(key)) b.damage.push(key);
      }
      for (const [surface, row] of effVocab) {
        const re = new RegExp(`\\b${surface.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`);
        if (re.test(clause) && !b.effects.includes(row.key)) b.effects.push(row.key);
      }
      if (/\b(mundane|ordinary|non-?magical)\b/.test(clause)) b.mundane = true;
      if (/\b(extraordinary|magical? weapons?)\b/.test(clause)) b.extraordinary = true;
    }
    return b;
  };
  // "can only be harmed/hit by extraordinary/magic" == immune to mundane damage.
  const out = {};
  const imm = scan(new RegExp(`(?:immun(?:e|ity) to|unaffected by|not affected by|cannot be) (.+?)${DEF_BOUNDARY}`, "gi"));
  if (/only be (?:harmed|hit|struck|damaged) by (?:extraordinary|magic)/i.test(text)) imm.mundane = true;
  const res = scan(new RegExp(`(?:resistan(?:t|ce) to|takes? half (?:damage )?from) (.+?)${DEF_BOUNDARY}`, "gi"));
  const sus = scan(new RegExp(`(?:susceptible|vulnerable|especially vulnerable) to (.+?)${DEF_BOUNDARY}`, "gi"));
  const any = (b) => b.damage.length || b.effects.length || b.mundane || b.extraordinary;
  if (any(imm)) out.immunities = imm;
  if (any(res)) out.resistances = res;
  if (any(sus)) out.susceptibilities = sus;
  return Object.keys(out).length ? out : null;
}

/** Union two defense objects (type-inherent ACKS rule + per-entry prose scan). */
export function mergeDefenses(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const out = {};
  for (const cat of ["immunities", "resistances", "susceptibilities"]) {
    const x = a[cat];
    const y = b[cat];
    if (!x && !y) continue;
    out[cat] = {
      damage: [...new Set([...(x?.damage ?? []), ...(y?.damage ?? [])])],
      effects: [...new Set([...(x?.effects ?? []), ...(y?.effects ?? [])])],
      mundane: !!(x?.mundane || y?.mundane),
      extraordinary: !!(x?.extraordinary || y?.extraordinary),
    };
  }
  return out;
}

/** Fixed pattern library (frozen with the schema). */
function applyPattern(raw, instr, registers, misses) {
  const text = clean(raw);
  switch (instr.pattern ?? "raw") {
    case "raw":
    case "statValue":
      return instr.table ? lookup(registers, instr.table, text, misses) : text;
    case "int": {
      // A genuine "not applicable" (undead morale prints "N/A") is NOT zero —
      // preserve it distinctly so the binding leaves the field blank, not 0.
      if (/^\s*(n\s*[/\\]?\s*a|nil|not applicable|—)\s*$/i.test(text)) return "N/A";
      const m = /(-?[\d,]+)/.exec(text);
      return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
    }
    case "dice":
      return DICE_RE.exec(text)?.[0] ?? null;
    case "refList":
      if (!text || /^none/i.test(text)) return [];
      return splitTop(text).map((t) => {
        // Shipped config: strip a trailing roll target ("Climbing 5+" -> token
        // "Climbing", target 5) before the exact-match lookup.
        const roll = instr.stripRoll ? /\s*(\d+)\+\s*$/.exec(t) : null;
        const token = roll ? t.slice(0, roll.index).trim() : t;
        const row = lookup(registers, instr.table, token, misses);
        return roll ? { ...row, target: parseInt(roll[1], 10) } : row;
      });
    case "parenSplit": {
      const m = /^([^(]+?)\s*(?:\(([^)]*)\))?$/.exec(text);
      if (!m) return { text };
      const main = instr.table ? lookup(registers, instr.table, m[1].trim(), misses) : { text: m[1].trim() };
      // splitTop keeps "1,600 st." whole (thousands comma is between digits and
      // not a list separator; protect digit,digit before the top-level split).
      const paren = splitTop((m[2] ?? "").replace(/(\d),(\d)/g, "$1 $2"))
        .map((t) => t.replace(/ /g, ","))
        .map((t) => (instr.parenTable ? lookup(registers, instr.parenTable, t, misses) : { text: t }));
      return { ...main, ...(paren.length ? { paren } : {}) };
    }
    case "spoilList": {
      const spoils = [];
      for (const m of text.matchAll(SPOIL_RE)) {
        spoils.push({
          name: m[1].trim(),
          weight6: (m[2] ? parseInt(m[2], 10) : 0) * 6 + (m[3] ? parseInt(m[3], 10) : 0),
          cost: parseInt(m[4].replace(/,/g, ""), 10),
          effects: splitTop(m[5] ?? "")
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
        const text = clean(joinRuns(runs, para.fixes ?? instr.fixes, para.dropText));
        if (text) paras.push({ type: "paragraph", ...(para.section ? { section: para.section } : {}), text });
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
      // Parse both fields into aligned MODES ("1 weapon OR 2 claws + bite").
      // A chef may ship `attacksOverride` — a normalized routine string for a
      // rare format the generic parser mishandles; damage still extracts live.
      // Quality per segment comes from the shipped COLOR ANNOTATION indexed by
      // GLOBAL segment position (flatDamage order) — an observation the compiler
      // made; the runtime never scrapes colours.
      const { modes } = attackModel(instr.attacksOverride ?? attacksText, damageRaw);
      const colors = instr.colors
        ? instr.colors.map((c) => (c ? (registers?.tables?.[instr.colorTable]?.[c] ?? null) : null))
        : null;
      const damageTypeOf = (seg) => {
        for (const ch of seg) {
          if (registers?.tables?.[instr.glyphTable]?.[ch]) {
            const dt = { text: ch, ...registers.tables[instr.glyphTable][ch] };
            return dt.ref || dt.key ? dt : null;
          }
        }
        return null;
      };
      let gi = 0; // global damage-segment index, matches compiler flatDamage/colors
      const outModes = modes.map((mode) => ({
        count: mode.count,
        throw: mode.throw,
        segments: mode.dmgSegs.map((seg, j) => {
          const ne = mode.names[j] ?? mode.names[mode.names.length - 1];
          const quality = colors?.[gi] ?? null;
          gi++;
          return {
            name: ne?.name ?? null,
            naturalWeapon: ne?.nw ?? null,
            damage: DICE_RE.exec(clean(seg))?.[0] ?? clean(seg),
            damageType: damageTypeOf(seg),
            quality, // "extraordinary" | "mundane" | null
          };
        }),
      }));
      return {
        text: [attacksText, clean(damageRaw)].filter(Boolean).join(" — "),
        throw: outModes[0]?.throw ?? null,
        alternatives: outModes.length > 1, // modes are OR-alternatives, GM picks
        modes: outModes,
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

  // Defenses = per-entry prose scan (this seat's own description + shipped
  // vocabulary) UNIONED with the creature's TYPE-inherent defenses (an ACKS
  // type rule authored once on the type node, e.g. "all undead are immune
  // to..."). Both are applied by the type/prose the SEAT extracted — nothing
  // about which defenses a specific creature has is baked on the entry.
  if (fields.description?.length) {
    const scanned = defenseScan(fields.description, registers);
    if (scanned) fields.defenses = scanned;
  }
  const t = fields.stats?.type;
  const typeRefs = t?.refs ?? (t?.ref ? [t.ref] : []);
  for (const ref of typeRefs) {
    const td = registers?.nodes?.[ref]?.defenses;
    if (td) fields.defenses = mergeDefenses(fields.defenses, td);
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
