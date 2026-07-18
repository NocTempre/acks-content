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
  return orderRuns(pageData.items.filter((it) => boxes.some((b) => inBox(it, b))));
}

/**
 * Reading order that keeps SUPERSCRIPTS with their own line. Ordinal marks
 * ("1st", "5th") are set ~4pt above the baseline, so a plain (y,x) sort files
 * them ahead of the entire line and the prose comes out "st When the character
 * casts…" with the digit stranded. Derive baselines from the full-size runs,
 * attach every run to its nearest baseline, then order by (baseline, x).
 *
 * Exported behaviour is shared with the compiler, so fix ORDINALS stay aligned —
 * changing this ordering requires recompiling the cookbooks.
 */
function orderRuns(items) {
  if (items.length < 2) return [...items];
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const heights = sorted.map((i) => i.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 0;
  const full = sorted.filter((i) => i.h >= median * 0.8);
  const lines = [];
  for (const it of full.length ? full : sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= 2);
    if (line) {
      line.y = (line.y * line.n + it.y) / (line.n + 1);
      line.n += 1;
    } else {
      lines.push({ y: it.y, n: 1 });
    }
  }
  lines.sort((a, b) => a.y - b.y);
  const lineOf = (it) => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const d = Math.abs(lines[i].y - it.y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  };
  return sorted
    .map((it) => ({ it, line: lineOf(it) }))
    .sort((a, b) => a.line - b.line || a.it.x - b.it.x || a.it.y - b.it.y)
    .map((r) => r.it);
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

/** Names vary by small-caps and spacing between books, so compare folded. */
const convKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Look a name up in the conversion table (harvested offline from the System
 * Compatibility Guide). Returns `{from, to?, status, category}` for an OGL/OSR
 * or legacy name, else null. The folded index is memoised on the registers
 * object so repeated lookups stay cheap.
 */
export function convertName(registers, token) {
  const table = registers?.tables?.conversion;
  if (!table || !token) return null;
  let index = registers.__convIndex;
  if (!index) {
    index = new Map();
    for (const [from, row] of Object.entries(table)) index.set(convKey(from), { from, ...row });
    Object.defineProperty(registers, "__convIndex", { value: index, enumerable: false });
  }
  return index.get(convKey(token)) ?? null;
}

/**
 * Exact-match table lookup: token -> {text, key?, ref?}; miss -> {text}.
 *
 * On a miss the token may be a legacy or foreign (OGL/OSR) name, so the
 * conversion table is consulted and the ACKS II equivalent retried — that is
 * what lets a converted source resolve even though the original entry was
 * renamed. A name the guide marks "deleted"/"absent" resolves to a WARNING
 * rather than a silent miss: it is understood, just not present.
 */
function lookup(registers, tableName, token, misses) {
  const row = registers?.tables?.[tableName]?.[token];
  if (row) return { text: token, ...row };

  const conv = convertName(registers, token);
  if (conv?.status === "renamed" && conv.to) {
    const renamed = registers?.tables?.[tableName]?.[conv.to];
    if (renamed) return { text: token, ...renamed, convertedFrom: conv.from, convertedTo: conv.to };
  }
  if (conv) return { text: token, conversion: conv.status, ...(conv.to ? { convertedTo: conv.to } : {}) };

  if (token && misses) misses.push({ table: tableName, token });
  return { text: token };
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
/**
 * Materialize an ability's structured EFFECTS from chef-authored specs.
 *
 * The cookbook ships the effect's STRUCTURE (type, target, mode, refs, ifHas,
 * stacking) — never its numbers. A spec that carries a number points at it with
 * `from.pattern`, a short locator applied to THIS SEAT'S own extracted prose,
 * so the value materializes from the reader's book exactly like a monster stat.
 * A locator that doesn't match (different printing) drops that effect rather
 * than inventing a value.
 */
export function materializeEffects(specs, paras) {
  const text = (paras ?? []).map((p) => (typeof p === "string" ? p : p.text)).join(" ");
  const out = [];
  for (const spec of specs ?? []) {
    const { from, ...effect } = spec ?? {};
    if (from?.pattern) {
      if (!text) continue;
      let m = null;
      try {
        m = new RegExp(from.pattern, from.flags ?? "i").exec(text);
      } catch {
        m = null; // a malformed locator never throws at the table
      }
      if (!m) continue;
      const n = parseInt(String(m[1] ?? m[0]).replace(/[^\d-]/g, ""), 10);
      if (Number.isNaN(n)) continue;
      effect.value =
        from.as === "perLevel" ? { kind: "perLevel", base: n, per: from.per ?? -1 } : n;
    }
    out.push(effect);
  }
  return out;
}

/**
 * Derive an ability's structured EFFECTS from its OWN prose, classified against
 * a SHIPPED vocabulary (the `modifierTarget` register) plus a fixed library of
 * shape patterns. Effect TYPE, TARGET and VALUE all materialize from the seat's
 * book — the cookbook pre-declares none of them, exactly as the defense scan
 * ships only the keyword vocabulary and never which creature has what.
 * Per-entry assists remain the fallback for shapes this cannot classify.
 */
export function effectScan(paras, registers) {
  const text = (paras ?? []).map((p) => (typeof p === "string" ? p : p.text)).join(" ");
  if (!text) return [];
  // Longest surface wins ("initiative rolls" before "initiative").
  const targets = Object.entries(registers?.tables?.modifierTarget ?? {})
    .map(([surface, row]) => [surface.toLowerCase(), row.key])
    .sort((a, b) => b[0].length - a[0].length);
  const classify = (phrase) => {
    const p = ` ${String(phrase).toLowerCase().replace(/\s+/g, " ").trim()} `;
    for (const [surface, key] of targets) if (p.includes(` ${surface} `)) return key;
    return null;
  };
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const k = JSON.stringify(e);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };

  // Values ship as acks-lib LevelValue objects so they satisfy the ability
  // DataModel directly (a bare number would fail the SchemaField).
  const flat = (n) => ({ kind: "flat", flat: n });

  const OWNER = "(?:all\\s+|his\\s+|her\\s+|their\\s+|its\\s+|the\\s+)?";
  // The target phrase must be long enough to reach the end of a two-activity
  // name ("Hiding and Sneaking proficiency throws"), which a shorter cap cuts
  // mid-word so the vocabulary lookup misses.
  const TARGET = `${OWNER}[A-Za-z' -]{2,50}`;
  // "gains a +1 bonus to avoid surprise" / "suffers a -2 penalty on reaction rolls"
  for (const m of text.matchAll(new RegExp(`([+-]?\\d+)\\s+(bonus|penalty)\\s+(?:to|on)\\s+(${TARGET})`, "gi"))) {
    const key = classify(m[3]);
    if (!key) continue;
    let n = parseInt(m[1], 10);
    if (Number.isNaN(n)) continue;
    if (/penalty/i.test(m[2])) n = -Math.abs(n);
    push({ type: "modifier", target: key, value: flat(n), mode: "add" });
  }
  // "gains a +2 to saving throws" (no bonus/penalty word — require an explicit sign)
  for (const m of text.matchAll(new RegExp(`([+-]\\d+)\\s+(?:to|on)\\s+(${TARGET})`, "gi"))) {
    const key = classify(m[2]);
    if (key) push({ type: "modifier", target: key, value: flat(parseInt(m[1], 10)), mode: "add" });
  }
  // Reversed order: "+1 initiative bonus" / "-2 saving throw penalty".
  for (const m of text.matchAll(/([+-]\d+)\s+([a-z][a-z' -]{2,30}?)\s+(bonus|penalty)\b/gi)) {
    const key = classify(m[2]);
    if (!key) continue;
    let n = parseInt(m[1], 10);
    if (/penalty/i.test(m[3])) n = -Math.abs(n);
    push({ type: "modifier", target: key, value: flat(n), mode: "add" });
  }
  // Verb form: "his maximum number of cleaves is increased by 1", "morale score
  // is increased by 1". Rejects "increased TO 2x" (a multiplier, not a delta).
  for (const m of text.matchAll(/([A-Za-z][A-Za-z' -]{2,50}?)\s+(?:is|are)\s+(increased|reduced|decreased)\s+by\s+(\d+)/gi)) {
    const key = classify(m[1]);
    if (!key) continue;
    const n = parseInt(m[3], 10);
    push({ type: "modifier", target: key, value: flat(/increase/i.test(m[2]) ? n : -n), mode: "add" });
  }
  // "succeeds on a Dungeonbashing proficiency throw of 18+" — the capitalised
  // qualifier says WHICH activity, so a bundle like Adventuring's five throws
  // stays five distinct effects instead of collapsing on the number.
  for (const m of text.matchAll(/(?:([A-Z][A-Za-z-]+)\s+)?proficiency throw of (\d+)\+/g)) {
    const e = { type: "throw", value: flat(parseInt(m[2], 10)), roll: "1d20", rollType: "above" };
    if (m[1]) e.forWhat = m[1];
    push(e);
  }
  /* --- Spell-like abilities: "can cast X (as the spell) once per week" --- */
  const FREQ = [
    [/\bat will\b/i, "atWill"],
    [/\bonce per round\b/i, "perRound"],
    [/\bonce per turn\b/i, "perTurn"],
    [/\bonce per 8 hours\b/i, "per8Hours"],
    [/\bonce per hour\b/i, "perHour"],
    [/\bonce per day\b/i, "perDay"],
    [/\bonce per week\b/i, "perWeek"],
    [/\bonce per month\b/i, "perMonth"],
    [/\bonce per year\b/i, "perYear"],
  ];
  const freqOf = (s) => FREQ.find(([re]) => re.test(s))?.[1] ?? "";
  for (const m of text.matchAll(
    /can (?:cast|bestow|perform|use) ([a-z][a-z' -]{2,40}?)\s*(?:\(as the (?:\d+(?:st|nd|rd|th)? level )?(?:divine |arcane )?spell\)|as a spell-like ability)([^.]{0,60})/gi,
  )) {
    const frequency = freqOf(m[2] ?? "");
    push({ type: "spellLike", spell: m[1].trim(), ...(frequency ? { frequency } : {}) });
  }

  /* --- Prerequisite: "must have the mercantile network power" / "requires that
   * the character have the ability to inspire dread" --- */
  for (const m of text.matchAll(/must have (?:the |gained )?([A-Z][A-Za-z' -]{2,40}?) (?:custom |class )?power\b/g)) {
    push({ type: "requires", note: m[1].trim() });
  }
  for (const m of text.matchAll(/requires that the character (?:have|has) the ability to ([a-z][a-z' -]{2,40})/gi)) {
    push({ type: "requires", note: m[1].trim() });
  }

  /* --- Usage limit with no spell attached. WHAT it gates is free text, but the
   * limit itself is a clean mechanical fact worth surfacing, so it ships as a
   * capability carrying only the frequency. --- */
  if (!out.some((e) => e.type === "spellLike")) {
    const frequency = freqOf(text);
    if (frequency) push({ type: "capability", frequency });
  }

  /* --- Resource spend/gain: Fate Points, spell slots, stigma --- */
  for (const m of text.matchAll(/\b(spend|spends|spending|expend|expends|expending|gain|gains|recovers?)\b[^.]{0,24}?\b(Fate Points?|spell slots?|stigma)\b/gi)) {
    const kind = /fate/i.test(m[2]) ? "fatePoint" : /stigma/i.test(m[2]) ? "stigma" : "spellSlot";
    push({ type: "resource", resource: kind, action: /gain|recover/i.test(m[1]) ? "gain" : "spend" });
  }

  /* --- Caster-level equivalence: "two caster levels higher than actual" --- */
  const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  for (const m of text.matchAll(/\b(one|two|three|four|five|\d+)\s+(?:class|caster)\s+levels?\s+higher\s+than\s+(?:(?:his|her|their|its)\s+)?actual/gi)) {
    const n = WORD_NUM[m[1].toLowerCase()] ?? parseInt(m[1], 10);
    if (n) push({ type: "spellcastingMod", casterLevelDelta: n });
  }

  /* --- Movement grant: "gains a flying movement rate of 30'" --- */
  for (const m of text.matchAll(/\b(flying|climbing|swimming|burrowing)\s+movement rate of\s+(\d+)/gi)) {
    const movementMode = { flying: "fly", climbing: "climb", swimming: "swim", burrowing: "burrow" }[m[1].toLowerCase()];
    push({ type: "movement", movementMode, value: flat(parseInt(m[2], 10)) });
  }

  /* --- Economic rate: "construction rate of 1.33gp per day" --- */
  for (const m of text.matchAll(/\b(?:construction|research) rate of\s+([\d.]+)\s*(gp|sp|cp)\s*per\s+(day|week|month)/gi)) {
    push({ type: "economic", amount: parseFloat(m[1]), unit: m[2].toLowerCase(), period: m[3].toLowerCase() });
  }

  /* --- Grants a choice of proficiencies, resolved through the register --- */
  for (const m of text.matchAll(/can select one (?:class )?proficiency,\s*choosing(?:\s+from)?\s+([^.]{4,160})\./gi)) {
    const table = registers?.tables?.proficiency ?? {};
    const refs = m[1]
      .split(/,|\band\b/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .map((s) => table[s]?.ref)
      .filter(Boolean);
    if (refs.length) push({ type: "grants", refs, choose: 1 });
  }

  // "climb as a thief of his class level" / "control undead as a crusader of one
  // half his class level" / "as thieves of his class level" (plural, no article)
  // / "as a thief of his level" (the class/caster qualifier is sometimes absent).
  for (const m of text.matchAll(
    /as\s+(?:an?\s+)?(thie(?:f|ves)|crusaders?|fighters?|mages?)\s+of\s+(one[- ]half\s+)?(?:his|her|their)\s+(?:(?:class|caster)\s+)?level/gi,
  )) {
    const as = m[1].toLowerCase().replace(/^thieves$/, "thief").replace(/s$/, "");
    push({ type: "progressionAs", as, atLevel: m[2] ? "half" : "full" });
  }
  return out;
}

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
      // A printed heading can carry glyph artifacts the shipped label does not
      // ("Conjure Dark Powers (1st level)" vs "(1level)" when the superscript
      // detaches), so compare folded and fall back to a prefix. That still
      // proves we are on the right entry — a wrong page shares no prefix — but
      // does not fail over a stray glyph, and a failed expect would otherwise
      // zero the entry's mechanics.
      const fold = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const f = fold(found);
      const w = fold(instr.text);
      const ok = !!w && (f.startsWith(w) || (w.length >= 12 && f.startsWith(w.slice(0, 12))));
      return { ok, found: found.slice(0, 60) };
    }
    case "text": {
      const paras = [];
      for (const para of instr.paras ?? []) {
        // A paragraph may name its OWN page: definition blocks are column- and
        // page-flowed, so an entry starting low on a page continues overleaf.
        // Absent `para.page` this is exactly the old single-page behaviour.
        const ppd = para.page && para.page !== instr.page ? await getPage(para.page) : pd;
        const runs = runsIn(ppd, para);
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
    /**
     * One COLUMN of a level-progression table, read as a LevelValue.
     *
     * Some abilities keep no numbers in their own entry at all — every thief
     * skill's target numbers live in a single grid, one column per skill, one
     * row per level. The recipe ships the grid's coordinates (which column,
     * which rows) and nothing else, so the numbers still materialize from the
     * reader's own book exactly like a monster's hit dice.
     *
     * Rows are paired by vertical proximity rather than by index, because a
     * blank cell would otherwise shift every level below it.
     */
    case "progression": {
      const levels = runsIn(pd, { box: instr.levelBox });
      const values = runsIn(pd, { box: instr.valueBox });
      claim([...levels, ...values], ctx.field);
      const num = (s) => {
        const m = /-?\d+/.exec(String(s).replace(/[^\d+-]/g, ""));
        return m ? parseInt(m[0], 10) : null;
      };
      const breakpoints = [];
      for (const lv of levels) {
        const atLevel = num(lv.str);
        if (atLevel == null) continue;
        const cell = values.find((v) => Math.abs(v.y - lv.y) <= (instr.rowTol ?? 3));
        const value = cell ? num(cell.str) : null;
        if (value != null) breakpoints.push({ atLevel, value });
      }
      breakpoints.sort((a, b) => a.atLevel - b.atLevel);
      if (!breakpoints.length) {
        misses.push({ field: ctx.field, error: "progression table matched no rows" });
        return null;
      }
      return { kind: "breakpoints", breakpoints };
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
    if (field === "effects") continue; // assist specs applied below, once description exists
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
    // Structured effects: classified from THIS SEAT'S prose against the shipped
    // vocabulary. Per-entry assist specs merge in for shapes the scan cannot
    // classify — their values still materialize from the book, never baked.
    const effects = [
      ...effectScan(fields.description, registers),
      ...materializeEffects(entry.fields?.effects?.specs, fields.description),
    ];
    if (effects.length) fields.effects = effects;
  }
  // An ability whose numbers live in a TABLE rather than in its own entry: the
  // column just read IS its proficiency throw, level by level. Added after the
  // prose scan so it lands even on an entry whose description says nothing
  // mechanical — which is exactly the case that motivated it.
  if (fields.progression?.breakpoints?.length) {
    (fields.effects ??= []).push({
      type: "throw",
      value: fields.progression,
      roll: "1d20",
      rollType: "above",
      forWhat: entry.name,
    });
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
