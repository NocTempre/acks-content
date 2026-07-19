/**
 * Cookbook runtime — the Foundry side of docs/BINDING-FOUNDRY.md.
 *
 * Loads the shipped cookbook database (cookbook/registers.json +
 * cookbook/<book>.json), executes entries through the DUMB executor against
 * the seat's own connected book, and binds executor output to acks documents:
 *   - GM import dialog: pick monsters -> Actors (stats, weapons with
 *     damage type + extraordinary-from-printed-color, abilities, spoils, art);
 *   - lazy prose: imported actors carry only @PdfText[id] tags; the entry's
 *     description is executed on demand per seat and kept in session memory.
 *
 * The cookbook is read-only data; all judgment happened in the offline
 * pipeline. This file only maps executor output onto acks system fields.
 */
import { MODULE_ID, LANG_PREFIX } from "./constants.mjs";
import { BOOKS } from "./books.mjs";
import { executeEntry, materializeEffects } from "./executor.mjs";
import { savesForLevel } from "./stats.mjs";

const FOLDER_NAME = "ACKS Cookbook";

/**
 * Shipped data, fetched once at ready. Two cookbook shapes:
 *  - `books`   per-book files (monsters) — the file names its book.
 *  - `content` CONTENT-TYPE files (proficiencies/powers/skills), each spanning
 *    every book that prints that content, so the BOOK is named per entry.
 */
const data = { registers: null, books: new Map(), content: new Map() };
/** Content-type cookbooks, named by WHAT they extract, not the source book. */
const CONTENT_FILES = ["proficiencies", "powers", "skills"];
/** Injected module state (session docs + prose memory) — set by initCookbook. */
let ctx = null;
/** Name collisions already reported this session, so a bulk import says each once. */
const warnedAmbiguous = new Set();

export function initCookbook(moduleCtx) {
  ctx = moduleCtx;
}

export async function loadCookbook() {
  const base = `modules/${MODULE_ID}/cookbook`;
  try {
    data.registers = await foundry.utils.fetchJsonWithTimeout(`${base}/registers.json`);
  } catch {
    console.log(`${MODULE_ID} | no cookbook shipped (registers.json missing) — cookbook features disabled.`);
    return false;
  }
  // The compiler writes an index naming exactly the files it produced. Probing
  // for every book id instead would 404 for each book with no cookbook yet —
  // caught and harmless, but it fills the console with what look like errors.
  let index = null;
  try {
    index = await foundry.utils.fetchJsonWithTimeout(`${base}/index.json`);
  } catch {
    /* cookbook compiled before the index existed — fall back to probing */
  }
  const bookFiles = index?.books ?? Object.keys(BOOKS);
  const contentFiles = index?.content ?? CONTENT_FILES;
  for (const bookId of bookFiles) {
    try {
      const cb = await foundry.utils.fetchJsonWithTimeout(`${base}/${bookId}.json`);
      if (cb?.entries) data.books.set(bookId, cb);
    } catch {
      /* book without a cookbook yet */
    }
  }
  for (const name of contentFiles) {
    try {
      const cb = await foundry.utils.fetchJsonWithTimeout(`${base}/${name}.json`);
      if (cb?.entries) data.content.set(name, cb);
    } catch {
      /* this content type isn't compiled yet */
    }
  }
  const n = [...data.books.values()].reduce((s, cb) => s + Object.keys(cb.entries).length, 0);
  const c = [...data.content.values()].reduce((s, cb) => s + Object.keys(cb.entries).length, 0);
  console.log(
    `${MODULE_ID} | cookbook loaded: ${n} entr(ies) across ${data.books.size} book(s)` +
      `${c ? `, ${c} definition(s) across ${data.content.size} content type(s)` : ""}.`,
  );
  return n + c > 0;
}

/** "mm.griffon#combat" -> { id, section } (section null when absent). */
const splitId = (full) => {
  const [id, section] = String(full ?? "").split("#");
  return { id, section: section || null };
};

export const cookbookEntry = (fullId) => {
  const { id } = splitId(fullId);
  for (const cb of data.books.values()) if (cb.entries[id]) return { cb, entry: cb.entries[id], id };
  for (const cb of data.content.values()) if (cb.entries[id]) return { cb, entry: cb.entries[id], id };
  return null;
};

/**
 * Which book an entry is read from. Per-book cookbooks name it on the file;
 * content-type cookbooks span books, so the entry names its own.
 */
const bookOf = (found) => found?.cb?.book?.id ?? found?.entry?.book ?? null;
/**
 * How many shipped entries this book unlocks.
 *
 * Both shapes count. Per-book cookbooks (monsters) are keyed by the book;
 * content-type cookbooks span books and name it per entry, so counting only
 * the first reported 0 for the Revised Rulebook while 120 proficiencies sat in
 * proficiencies.json waiting on exactly that book.
 */
export const cookbookCount = (bookId) => {
  let n = Object.keys(data.books.get(bookId)?.entries ?? {}).length;
  for (const cb of data.content.values()) {
    for (const e of Object.values(cb.entries)) if (e.book === bookId) n++;
  }
  return n;
};

/* -------------------------------------------- */
/*  Lazy prose (session memory, per seat)       */
/* -------------------------------------------- */

/** Stub line for a cookbook id: name + citation (no book needed). */
export function cookbookStub(fullId) {
  const found = cookbookEntry(fullId);
  if (!found) return null;
  return game.i18n.format(`${LANG_PREFIX}.ui.cookbookStub`, { name: found.entry.name, cite: found.entry.cite });
}

/** Whether this seat could reveal prose for the id right now. */
export function cookbookCanReveal(fullId) {
  const found = cookbookEntry(fullId);
  return !!found && ctx.sessionDocs.has(bookOf(found));
}

/** Cache an entry's description paragraphs (session memory only). */
export function cookbookCacheParas(bookId, id, paras) {
  if (!paras?.length) return;
  const mem = ctx.proseMem.get(bookId) ?? {};
  mem[id] = paras;
  ctx.proseMem.set(bookId, mem);
}

/**
 * Execute the entry's description on demand; cache paragraphs in session
 * memory only. A "#section" suffix filters to that section's paragraphs.
 */
export async function cookbookProse(fullId) {
  const found = cookbookEntry(fullId);
  if (!found) return null;
  const { section } = splitId(fullId);
  const bookId = bookOf(found);
  let paras = (ctx.proseMem.get(bookId) ?? {})[found.id];
  if (!paras) {
    const session = ctx.sessionDocs.get(bookId);
    if (!session) return null;
    const res = await executeEntry(session.doc, found.cb, data.registers, found.id);
    paras = res.fields.description ?? [];
    cookbookCacheParas(bookId, found.id, paras);
  }
  const picked = section ? paras.filter((p) => (p.section ?? "appearance") === section) : paras;
  const prose = picked.map((p) => p.text).join("\n\n");
  return prose || null;
}

/* -------------------------------------------- */
/*  Binding: executor output -> acks Actor      */
/* -------------------------------------------- */

const firstInt = (v) => {
  const m = /(-?[\d,]+)/.exec(String(v ?? ""));
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
};
const diceOf = (v) => /\d+d\d+(?:[+-]\d+)?/.exec(String(v ?? ""))?.[0] ?? "";
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* -------------------------------------------- */
/*  Full Monster Sheet extras (acks-monsters)   */
/* -------------------------------------------- */

const SAVE_CLASS_BY_ABBR = { F: "fighter", C: "crusader", M: "mage", T: "thief", D: "dwarvenVaultguard", E: "elvenSpellsword" };
const AGE_KEYS = ["baby", "juvenile", "adolescent", "adult", "middleAged", "old", "ancient", "maximum"];
const TRAINED_ROLE_MAP = {
  "war mount": "warMount", "work beast": "workbeast", workbeast: "workbeast", guard: "guard",
  mount: "mount", hunter: "hunter", herald: "herald",
};
const DAMAGE_WORDS = {
  acid: "acidic", acidic: "acidic", arcane: "arcane", bludgeoning: "bludgeoning", cold: "cold",
  electrical: "electrical", electricity: "electrical", lightning: "electrical", fire: "fire",
  luminous: "luminous", necrotic: "necrotic", piercing: "piercing", poison: "poisonous",
  poisonous: "poisonous", seismic: "seismic", slashing: "slashing",
};

/** "Wandering noun (2d4) / Lair noun (2d6)" -> encounter side object. */
function encSide(value) {
  if (!value || /^none/i.test(String(value))) return null;
  const parse = (part) => {
    const m = /^([^(]+?)\s*\((\d+d\d+(?:[+-]\d+)?)\)/.exec((part ?? "").trim());
    return m ? { noun: m[1].trim(), number: m[2] } : null;
  };
  const parts = String(value).split("/");
  const wandering = parse(parts[0]);
  const lair = parse(parts[1] ?? parts[0]);
  if (!wandering && !lair) return null;
  return { wandering: wandering ?? { noun: "", number: "" }, lair: lair ?? { noun: "", number: "" } };
}

/**
 * Map executor output onto the Full Monster Sheet's extras schema
 * (Classification / Rating & Saves / Vision / Movement / Ecology / Defenses).
 * Pure data mapping — exported so the dev harness can test it without Foundry.
 */
export function buildExtras(node) {
  const s = node.fields.stats ?? {};
  const raw = (k) => s[`_raw.${k}`];
  const extras = {};

  /* --- classification --- */
  if (s.type) extras.types = s.type.keys ?? (s.type.key ? [s.type.key] : []);
  const sub = s.type?.paren?.[0];
  if (sub) extras.subtype = sub.key ?? sub.text;
  if (s.size?.key) extras.size = s.size.key;
  const massText = s.size?.paren?.map((p) => p.text).join(",") ?? "";
  const stone = firstInt(massText);
  if (stone != null && /st/.test(massText)) extras.mass = { stone, lbs: stone * 10 };

  /* --- rating & saves --- */
  const hdm = /^(\d+)(?:\s*([+-])\s*(\d+))?\s*(\**)/.exec(String(s.hitDice ?? "").trim());
  if (hdm) {
    extras.hd = {
      count: parseInt(hdm[1], 10),
      bonus: hdm[2] ? (hdm[2] === "-" ? -1 : 1) * parseInt(hdm[3], 10) : null,
      asterisks: hdm[4]?.length || null,
      dieType: 8,
    };
  }
  const sv = /^([A-Z]+)\s*(\d+)?/.exec(String(s.save ?? "").trim());
  if (sv) extras.saveAs = { class: SAVE_CLASS_BY_ABBR[sv[1]] ?? "fighter", level: sv[1] === "NH" ? 0 : parseInt(sv[2] ?? "0", 10) || 0 };
  if (s.normalLoad != null || s.maxLoad != null) {
    extras.load = { ...(s.normalLoad != null ? { normal: s.normalLoad } : {}), ...(s.maxLoad != null ? { capacity: s.maxLoad } : {}) };
  }

  /* --- vision & senses --- */
  const vis = String(s.vision ?? "").toLowerCase();
  if (vis) {
    extras.vision = ["standard", "night", "lightless", "acute", "blind"].filter((k) => vis.includes(k));
    const range = /lightless[^(]*\((\d+)/.exec(vis);
    if (range) extras.lightlessRange = parseInt(range[1], 10);
  }
  if (s.otherSenses && !/^standard$/i.test(s.otherSenses)) extras.otherSenses = s.otherSenses;

  /* --- movement --- */
  const speeds = [];
  for (const [k, v] of Object.entries(s)) {
    const m = /^speed([A-Z][a-z]+)$/.exec(k);
    if (!m || !v) continue;
    const nums = [...String(v).matchAll(/(\d+)/g)].map((n) => parseInt(n[1], 10));
    if (!nums.length) continue;
    speeds.push({ type: m[1].toLowerCase(), combat: nums[0] ?? null, run: nums[1] ?? nums[0] ?? null, hover: false });
  }
  if (speeds.length) extras.speeds = speeds;

  /* --- encounter --- */
  const d = encSide(s.dungeonEnc);
  const w = encSide(s.wildernessEnc);
  if (d || w || s.lairChance != null) {
    extras.encounter = {
      ...(d ? { dungeon: d } : {}),
      ...(w ? { wilderness: w } : {}),
      ...(s.lairChance != null ? { lairChance: s.lairChance } : {}),
    };
  }

  /* --- ecology (secondary) --- */
  const secondary = {};
  const exp = firstInt(raw("expeditionSpeed"));
  if (exp != null) secondary.expeditionSpeed = exp;
  const supply = raw("supplyCost");
  if (supply && !/^none/i.test(supply)) secondary.supplyCost = firstInt(supply) ?? supply;
  const tp = raw("trainingPeriod");
  if (tp && !/untrainable/i.test(tp)) secondary.trainingMonths = firstInt(tp);
  const tm = raw("trainingModifier");
  if (tm && !/untrainable/i.test(tm)) secondary.trainingModifier = firstInt(tm);
  const br = raw("battleRating");
  if (br) {
    const ind = /([\d.]+)\s*\(individual\)/i.exec(br);
    const unit = /([\d.]+)\s*\(unit\)/i.exec(br);
    const single = /^([\d.]+)\s*$/.exec(String(br).trim());
    if (ind || unit || single) {
      secondary.battleRating = {
        ...(ind || single ? { individual: parseFloat((ind ?? single)[1]) } : {}),
        ...(unit ? { unit: parseFloat(unit[1]) } : {}),
      };
    }
  }
  const life = raw("lifespan");
  if (life && /\d+\s*\/\s*\d+/.test(life)) {
    const vals = life.split("/").map((v) => firstInt(v));
    const lifespan = {};
    AGE_KEYS.forEach((k, i) => {
      if (vals[i] != null) lifespan[k] = vals[i];
    });
    secondary.lifespan = lifespan;
  }
  const rep = raw("reproduction");
  if (rep && !/^none/i.test(rep)) {
    const count = diceOf(rep) || (firstInt(rep) != null ? String(firstInt(rep)) : "");
    let yt = "";
    if (/egg|hatchling|clutch/i.test(rep)) {
      yt = "egg";
      secondary.oviparous = true;
    } else if (/litter/i.test(rep)) yt = "litter";
    else if (/spawn/i.test(rep)) yt = "spawn";
    else if (/foal|calf|pup|kit|cub|whelp|infant|joey|kid|lamb|piglet|fawn|live/i.test(rep)) yt = "live";
    else if (/juvenile/i.test(rep)) yt = "juvenile";
    secondary.reproduction = { ...(count ? { count } : {}), ...(yt ? { youngType: yt } : {}) };
    const iv = /every\s+(\d+)?\s*(year|month|week|day)/i.exec(rep);
    if (iv) {
      secondary.reproduction.interval = iv[1] ? parseInt(iv[1], 10) : 1;
      secondary.reproduction.intervalUnit = iv[2].toLowerCase();
    }
  }
  const uv = raw("untrainedValue");
  if (uv && !/^none/i.test(uv)) {
    // Schema: adult/juvenile/baby are NUMBERS (gp), keyed by the (A)/(J)/(B|e) marker.
    const bucketNum = (marker) => {
      const m = new RegExp(`([\\d,]+)\\s*gp\\s*\\((?:${marker})\\)`, "i").exec(uv);
      return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
    };
    const adult = bucketNum("A");
    const juvenile = bucketNum("J");
    const baby = bucketNum("B|e|egg");
    if (adult != null || juvenile != null || baby != null) {
      secondary.untrainedValue = {
        ...(adult != null ? { adult } : {}),
        ...(juvenile != null ? { juvenile } : {}),
        ...(baby != null ? { baby } : {}),
      };
    }
  }
  const tv = raw("trainedValue");
  if (tv && !/^none/i.test(tv)) {
    // Schema: array of { role (enum), value (gp num), note }. "315gp (war
    // mount) 40gp (work beast)" -> two rows; unknown roles -> other + note.
    const list = [];
    for (const m of tv.matchAll(/([\d,]+)\s*gp\s*(?:\(([^)]+)\))?/g)) {
      const label = (m[2] ?? "").trim();
      const role = TRAINED_ROLE_MAP[label.toLowerCase()] ?? "other";
      list.push({ role, value: parseInt(m[1].replace(/,/g, ""), 10), ...(role === "other" && label ? { note: label } : {}) });
    }
    if (list.length) secondary.trainedValue = list;
  }
  if (Object.keys(secondary).length) extras.secondary = secondary;

  /* --- defenses (materialized by the executor from this seat's prose) --- */
  if (node.fields.defenses) {
    const packSide = (b) =>
      b ? { damage: b.damage ?? [], effects: (b.effects ?? []).join(", "), mundane: !!b.mundane, extraordinary: !!b.extraordinary } : undefined;
    const def = {};
    for (const side of ["immunities", "resistances", "susceptibilities"]) {
      const p = packSide(node.fields.defenses[side]);
      if (p) def[side] = p;
    }
    if (Object.keys(def).length) extras.defenses = def;
  }

  /* --- spellcasting (formulaic prose) --- */
  const paras = node.fields.description ?? [];
  const castM = /casts? spells(?: and uses magic items)? as (?:an? )?(\d+)(?:st|nd|rd|th)?[- ]level (\w+)/i.exec(
    paras.map((p) => p.text).join(" "),
  );
  if (castM) extras.spellcasting = { class: capitalize(castM[2]), level: parseInt(castM[1], 10) };

  return extras;
}

/**
 * Size key -> prototype token footprint in grid squares.
 *
 * The book gives each size class a FRONTAGE in 5' squares, and acks-monsters
 * already publishes the whole size table (scripts/config.mjs SIZES) — so this
 * is the same posture as SAVES_LUT in stats.mjs: derived game math already
 * published by a sibling, not new disclosure. Kept local rather than imported
 * because a seat may not have acks-monsters installed.
 *
 * Two deliberate readings, because frontage and footprint are not the same
 * question. "1 sq or less" and "2/3 sq" both describe how many creatures fit
 * in a line, not a sub-square token, so Small and Man-Sized are both 1×1 — a
 * half-square token would be a presentation choice the book never asked for.
 * `largeHugeGigantic` is absent on purpose: that register key exists because
 * the page gives a RANGE, and picking one for the GM would be inventing.
 */
const TOKEN_SIZE = {
  small: { width: 1, height: 1 },
  man: { width: 1, height: 1 },
  large: { width: 2, height: 1 },
  huge: { width: 2, height: 2 },
  gigantic: { width: 4, height: 3 },
  colossal: { width: 8, height: 6 },
};

/** Map one executed node to acks actor data + embedded items. */
export function bindMonster(node) {
  const f = node.fields;
  const s = f.stats ?? {};
  const system = {};

  if (Number.isInteger(s.armorClass)) system.aac = { value: s.armorClass };

  const hdm = /^(\d+)(?:\s*([+-])\s*(\d+))?/.exec(String(s.hitDice ?? "").trim());
  if (hdm) {
    const count = parseInt(hdm[1], 10);
    const bonus = hdm[2] ? (hdm[2] === "-" ? -1 : 1) * parseInt(hdm[3], 10) : 0;
    const avg = Math.max(1, Math.floor(count * 4.5 + bonus));
    system.hp = { hd: `${count}d8${bonus ? (bonus > 0 ? `+${bonus}` : bonus) : ""}`, value: avg, max: avg };
  }

  const sv = /^([A-Z]+)\s*(\d+)?/.exec(String(s.save ?? "").trim());
  if (sv) {
    const level = sv[1] === "NH" ? 0 : parseInt(sv[2] ?? "0", 10) || 0;
    const row = savesForLevel(level);
    system.saves = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { value: v }]));
    system.saves.breath = { value: row.blast };
    system.saves.wand = { value: row.implements };
  }

  // "N/A" morale (mindless undead) is not 0 (=always flees): leave it unset and
  // flag it, rather than writing a misleading number.
  const moraleNA = s.morale === "N/A";
  system.details = {
    ...(typeof s.morale === "number" ? { morale: s.morale } : {}),
    ...(s.xp != null && s.xp !== "N/A" ? { xp: s.xp } : {}),
    ...(s.alignment ? { alignment: capitalize(s.alignment.key ?? s.alignment.text ?? "") } : {}),
    ...(s.treasureType ? { treasure: { type: /^none/i.test(s.treasureType) ? "None" : s.treasureType } } : {}),
  };
  if (s.dungeonEnc || s.wildernessEnc) {
    system.details.appearing = { d: diceOf(s.dungeonEnc), w: diceOf(s.wildernessEnc) };
  }

  const speed = String(s.speedLand ?? "");
  const nums = [...speed.matchAll(/(\d+)/g)].map((m) => parseInt(m[1], 10));
  if (nums.length) system.movement = { base: nums[nums.length - 1] };

  const atk = f.attacks;
  if (atk) {
    if (atk.throw != null) system.thac0 = { throw: atk.throw };
    if (atk.text) system.attacks = atk.text;
  }

  // Each attack MODE is an OR-alternative (weapon OR claws+bite). Build a
  // weapon item per segment; only mode 0 is equipped by default, later modes
  // are tagged so the GM can swap. Duplicate names within a mode get a #suffix.
  const items = [];
  for (const [mi, mode] of (atk?.modes ?? []).entries()) {
    const seen = {};
    for (const seg of mode.segments) {
      const base = seg.name ?? "Attack";
      seen[base] = (seen[base] ?? 0) + 1;
      items.push({
        name: seen[base] > 1 ? `${base} ${seen[base]}` : base,
        type: "weapon",
        img: "icons/svg/sword.svg",
        flags: {
          "acks-monsters": {
            ...(seg.naturalWeapon ? { naturalWeapon: seg.naturalWeapon } : {}),
            ...(seg.damageType?.key ? { damageType: seg.damageType.key } : {}),
            extraordinary: seg.quality === "extraordinary",
            ...(mi > 0 ? { attackMode: mi } : {}),
          },
        },
        system: {
          description: "", damage: seg.damage, bonus: 0, melee: true, missile: false, equipped: mi === 0,
          pattern: "transparent", tags: [], counter: { value: 1, max: 1 }, cost: 0, weight: 0, weight6: 0,
        },
      });
    }
  }
  // Stat-block proficiency tokens resolve in three tiers — reuse what the world
  // already has, else build it from the cookbook, else mint a namesake. Both
  // indexes are built once per monster and only when there is a token to spend
  // them on (most monsters print none).
  const profs = (f.stats?.proficiencies ?? []).filter((p) => p.text && !/^none/i.test(p.text));
  const nameIndex = profs.length ? abilityNameIndex() : null;
  const loadedById = profs.length ? loadedAbilityIndex() : new Map();
  const present = new Set(loadedById.keys());
  for (const prof of profs) {
    // When the stat block named it by an older name, the EMBEDDED copy records
    // the rename (not the shared world item — that would stamp one source's
    // history onto everyone's). The sheet then explains why the name on the
    // page and the name in the book differ.
    const renamed = prof.convertedFrom ? { conversionStatus: "renamed", conversionFrom: prof.convertedFrom } : {};

    // WHICH definition this is. An authored registry `ref` is a decision someone
    // made and wins outright; without one the printed name is only a guess, so
    // it is resolved against the ids this world actually holds before category
    // preference applies. 14 names ("Alertness", "Climbing") are both a
    // proficiency and a class power, and a world that imported one list and not
    // the other has already answered which was meant.
    const guess = prof.ref ? null : idForName(nameIndex, prof.text, present);
    const id = prof.ref ?? guess?.id ?? null;
    // A guess is reported, but ONCE per distinct resolution: a bulk import walks
    // hundreds of blocks and the same handful of shared names ("climbing") would
    // otherwise bury the console in the same line.
    if (guess?.ambiguous && !warnedAmbiguous.has(`${prof.text}>${id}`)) {
      warnedAmbiguous.add(`${prof.text}>${id}`);
      console.warn(`${MODULE_ID} | "${prof.text}" matches several definitions; adopted ${id}.`);
    }

    // The block prints THIS creature's own throw target ("climbing 6+"), split
    // off by the refList's stripRoll. It outranks the definition's generic
    // ladder — which bindAbility can only resolve at 1st level, having no actor
    // to read — and it is materialized from the seat's own page like every other
    // value. Until now nothing consumed it, which was invisible while the tiers
    // below effectively never fired.
    const withTarget = (item) =>
      prof.target == null
        ? item
        : {
            ...item,
            system: {
              ...item.system,
              roll: item.system?.roll || "1d20",
              rollType: item.system?.rollType || "above",
              rollTarget: prof.target,
            },
          };

    // 1. ALREADY LOADED — copy the item the world holds. Worth preferring over a
    //    fresh bind: this path has no executed node for the ability, so building
    //    from the cookbook yields structure only, while an item imported with
    //    the book open already materialized its throws and effects. It also
    //    inherits whatever the GM tuned.
    const loaded = id ? loadedById.get(id) : null;
    if (loaded) {
      const src = loaded.toObject();
      // Identity and filing belong to the world item, not to this copy of it.
      delete src._id;
      delete src.folder;
      delete src.sort;
      if (prof.convertedFrom) {
        const abil = ((src.flags ??= {})["acks-abilities"] ??= {});
        abil.extras = { ...(abil.extras ?? {}), ...renamed };
      }
      items.push(withTarget(src));
      continue;
    }

    // 2. COULD BE LOADED — the cookbook carries the definition, so embed THAT
    //    ability (lazy descriptor, classification, shared cookbook id) rather
    //    than a bare namesake.
    const shared = id ? cookbookEntry(id) : null;
    if (shared) {
      items.push(withTarget(bindAbility(shared.entry, null, id, renamed)));
      continue;
    }

    // 3. Nothing to point at — degrade to a plain named ability, never a failure.
    items.push(withTarget({
      name: prof.text,
      type: "ability",
      img: "icons/svg/book.svg",
      system: {
        description: "", proficiencytype: "general", favorite: false, pattern: "white",
        requirements: "", roll: "", rollType: "above", rollTarget: 0, blindroll: false, save: "",
      },
    }));
  }
  for (const sp of f.spoils ?? []) {
    items.push({
      name: capitalize(sp.name),
      type: "item",
      img: "icons/svg/item-bag.svg",
      system: { description: "", subtype: "item", quantity: { value: 1, max: 0 }, cost: sp.cost, weight: 0, weight6: sp.weight6 },
      flags: { "acks-monsters": { spoil: true, component: true, researchEffects: sp.effects.map((e) => e.text) } },
    });
  }

  // A Gigantic monster on a 1×1 token is wrong before anyone reads a stat, and
  // the size is right there in the block. Only set what the table actually
  // says: an unrecognised or ranged size leaves Foundry's default alone.
  const token = TOKEN_SIZE[s.size?.key];

  return {
    system,
    items,
    ...(token ? { prototypeToken: token } : {}),
    flags: moraleNA ? { [MODULE_ID]: { moraleNA: true } } : {},
  };
}

/* -------------------------------------------- */
/*  GM import dialog                            */
/* -------------------------------------------- */

async function ensureFolder() {
  return (
    game.folders.find((fo) => fo.type === "Actor" && fo.name === FOLDER_NAME) ??
    Folder.create({ name: FOLDER_NAME, type: "Actor" })
  );
}

/**
 * Cookbook ids this world already holds an actor for.
 *
 * Unlike an ability, a monster import always CREATES — there is no reuse to fall
 * back on — so importing the same entry twice leaves two actors claiming one
 * cookbook id, and anything resolving by id (a companion slot, say) then picks
 * between them arbitrarily. Every import path filters through this, which is
 * what makes "import all" safe to press twice.
 */
const importedMonsterIds = () =>
  new Set(game.actors.map((a) => a.getFlag(MODULE_ID, "cookbook")?.id).filter(Boolean));

/**
 * Run a list of entry ids through importOne with a progress bar.
 *
 * Each import parses pages out of the seat's PDF, so a whole book is minutes of
 * work: without feedback the client looks hung. Errors are per-entry — one
 * unreadable page must not abandon the other 286.
 */
async function importMany(bookId, ids, folderId, label) {
  const bar = ui.notifications.info(label, { progress: true });
  let done = 0;
  for (const [i, id] of ids.entries()) {
    bar?.update?.({ pct: i / ids.length, message: `${label} ${i + 1}/${ids.length}` });
    if (await importOne(bookId, id, folderId).catch((err) => (console.error(`${MODULE_ID} | import ${id}`, err), null))) done++;
  }
  bar?.update?.({ pct: 1, message: label });
  return done;
}

/** Report an import run, naming what was skipped as already present. */
function reportImport(done, picked, skipped) {
  ui.notifications.info(
    game.i18n.format(`${LANG_PREFIX}.ui.cookbookDone`, { done, picked, folder: FOLDER_NAME }) +
      (skipped ? ` ${game.i18n.format(`${LANG_PREFIX}.ui.cookbookSkipped`, { skipped })}` : ""),
  );
}

async function importOne(bookId, id, folderId) {
  const found = cookbookEntry(id);
  const session = ctx.sessionDocs.get(bookId);
  const node = await executeEntry(session.doc, found.cb, data.registers, id);
  if (!node.ok) {
    ui.notifications.warn(`acks-content | ${found.entry.name}: page did not match the cookbook (different printing?) — skipped.`);
    return null;
  }
  const { system, items, flags, prototypeToken } = bindMonster(node);

  // Prose stays lazy: the actor carries only tags; description reproduces per
  // seat. Cache this GM's extraction in session memory for instant reveal.
  const paras = node.fields.description ?? [];
  cookbookCacheParas(bookId, id, paras);
  const tag = (section) => `<p>@PdfText[${id}${section ? `#${section}` : ""}]{${found.entry.cite}}</p>`;
  const fmsActive = game.modules.get("acks-monsters")?.active;
  if (!fmsActive) system.details = { ...(system.details ?? {}), biography: tag(null) };

  const actor = await Actor.create({
    name: found.entry.name,
    type: "monster",
    folder: folderId,
    system,
    ...(prototypeToken ? { prototypeToken } : {}),
    ...(Object.keys(flags ?? {}).length ? { flags } : {}),
  });
  // Foundry REPORTS a schema-validation failure and returns undefined rather
  // than throwing, so without this the next line dereferences nothing and the
  // real error — already in the console — is buried under a TypeError from
  // three frames away. One unimportable monster must read as one skipped
  // monster, not as a crash in the importer.
  if (!actor) {
    ui.notifications.warn(`acks-content | ${found.entry.name}: the system rejected the extracted stats — skipped (see console).`);
    return null;
  }
  if (fmsActive) {
    // Route description SECTIONS onto the Full Monster Sheet's fields; each
    // field gets its own section-scoped lazy tag. Unrouted sections -> notes.
    const ROUTE = {
      appearance: "appearance", combat: "combat", ecology: "ecology",
      encounter: "encounterText", lair: "encounterText",
      lore: "lore", specialRules: "notes", behavior: "notes",
    };
    const description = {};
    for (const sec of [...new Set(paras.map((p) => p.section ?? "appearance"))]) {
      const field = ROUTE[sec] ?? "notes";
      description[field] = (description[field] ?? "") + tag(sec);
    }
    if (!Object.keys(description).length) description.appearance = tag(null);
    // Classification / saves / vision / movement / ecology / defenses extras
    // mapped from the same executed node (see buildExtras).
    await actor.update({ "flags.acks-monsters.extras": { ...buildExtras(node), description } });
  }
  if (items.length) {
    await actor.createEmbeddedDocuments(
      "Item",
      // Merge, don't replace: an embedded shared ability keeps its cookbook id
      // (that id is what resolves its lazy prose and marks it as the shared one).
      items.map((i) => ({
        ...i,
        flags: { ...(i.flags ?? {}), [MODULE_ID]: { ...(i.flags?.[MODULE_ID] ?? {}), generated: true } },
      })),
    );
  }
  await actor.setFlag(MODULE_ID, "cookbook", { id, cite: found.entry.cite });
  if (node.fields.art && ctx.importArtForPage) {
    await ctx.importArtForPage(actor, session.doc, { id, page: found.entry.pages[0] });
  }
  return actor;
}

/**
 * Re-read an already-imported monster's stats from this seat's book.
 *
 * The counterpart to importOne for an actor that already exists: same
 * extraction, same binding, but it UPDATES rather than creates. Embedded items
 * are left alone — a refill that re-added the abilities would duplicate them
 * on every run, and the stats are what go stale when a recipe improves.
 *
 * Returns null when the actor is not ours or its book is not open this
 * session, so the caller can fall back or explain.
 */
export async function refillMonster(actor) {
  const id = actor?.getFlag(MODULE_ID, "cookbook")?.id;
  if (!id) return null;
  const found = cookbookEntry(id);
  if (!found) return null;
  const bookId = bookOf(found);
  const session = ctx.sessionDocs.get(bookId);
  if (!session) return { ok: false, reason: "book-closed", book: bookId, name: found.entry.name };
  const node = await executeEntry(session.doc, found.cb, data.registers, found.id);
  if (!node.ok) return { ok: false, reason: "no-match", book: bookId, name: found.entry.name };
  const { system, prototypeToken } = bindMonster(node);
  await actor.update({ system, ...(prototypeToken ? { prototypeToken } : {}) });
  cookbookCacheParas(bookId, found.id, node.fields.description ?? []);
  return { ok: true, book: bookId, name: found.entry.name };
}

/* -------------------------------------------- */
/*  Abilities (proficiencies / powers / skills) */
/* -------------------------------------------- */

/**
 * Map a definition entry (+ its executed node, when the seat owns the book)
 * onto a core `ability` item. The FULL literal text stays a lazy @PdfText
 * descriptor; classification and any materialized mechanics persist in
 * flags["acks-abilities"].extras, so the ability stays usable without the book.
 */
/**
 * Resolve a LevelValue at a level. A local copy of acks-lib's resolver, kept
 * small on purpose: acks-content does not otherwise depend on acks-lib, and a
 * runtime reaching into a sibling module would break a seat that has not
 * installed it. Only the shapes this file can encounter are handled.
 */
function levelValueAt(v, level = 1) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v !== "object") return null;
  if (v.kind === "perLevel" && v.base != null) return v.base + (v.per ?? 0) * (Math.max(1, level) - 1);
  if (Array.isArray(v.breakpoints) && v.breakpoints.length) {
    let out = null;
    for (const b of [...v.breakpoints].sort((a, c) => a.atLevel - c.atLevel)) if (level >= b.atLevel) out = b.value;
    return out;
  }
  return v.flat ?? null;
}

/** "kw:sensingevil" -> "Sensing Evil"-ish, for the system's requirements field. */
const capabilityLabel = (token) => {
  const slug = String(token).replace(/^kw:/, "");
  for (const cb of data.content.values()) {
    for (const [id, e] of Object.entries(cb.entries)) {
      if (id.split(".").slice(2).join("").toLowerCase() === slug) return e.name;
    }
  }
  return slug;
};

/** The optional icon pack whose niche art beats core for several abilities. */
const NICHE_ICON_MODULE = "game-icons-net";

/**
 * Which picture this ability gets.
 *
 * Foundry's own 7,100 icons cover most of the corpus, but not the ACKS-shaped
 * corners of it: Acrobatics, Blind Fighting, Caving and Mapping have no core
 * icon worth the name, and game-icons.net has all four. So an entry may name
 * both — `icon` from core, which every seat has, and `iconNiche` from the
 * optional pack. The niche one wins where the pack is installed and is simply
 * ignored where it is not, which is the same bring-your-own posture the rest
 * of this module takes with books.
 *
 * Referencing those paths carries no licensing weight for us: the art ships in
 * THAT module under its own CC BY terms and attribution, and we only point at
 * it. Nothing is copied here.
 *
 * NOTE an item stores its img at creation. Installing the pack later does not
 * repaint abilities already imported — "Update Abilities" does that.
 */
export function abilityIcon(entry) {
  if (entry?.iconNiche && game.modules?.get?.(NICHE_ICON_MODULE)?.active) return entry.iconNiche;
  // Falls back to the generic book, so an entry nobody has picked an icon for
  // looks exactly as it did before rather than breaking.
  return entry?.icon || "icons/svg/book.svg";
}

export function bindAbility(entry, node, id, opts = {}) {
  const meta = entry.meta ?? {};
  const cite = entry.cite ?? "";
  // An alias is a DISTINCT ability that shares another entry's rules text, not a
  // redirect to it. Two names for one capability do not stack, so the relation
  // ships as a real effect rather than a note the reader has to interpret.
  const aliasEffects = meta.notStacksWith?.length
    ? [{ type: "capability", ref: entry.aliasOf ?? meta.notStacksWith[0], notStacksWith: meta.notStacksWith }]
    : [];
  const extras = {
    category: meta.category ?? "proficiency",
    general: !!meta.general,
    repeatable: !!meta.repeatable,
    // A retired entry is still imported — an older or converted source may name
    // it — but carries the flag and a pointer at whatever superseded it.
    deprecated: !!meta.deprecated,
    ...(meta.replacedBy ? { replacedBy: meta.replacedBy } : {}),
    // The build cost is READ FROM THE SEAT'S BOOK, never shipped — so it is
    // present only once someone with the book imports or updates, like every
    // other value. `meta.powerValue` remains only as the inherited value an
    // alias takes from its target.
    ...(node?.fields?.powerValue != null
      ? { powerValue: node.fields.powerValue }
      : meta.powerValue != null
        ? { powerValue: meta.powerValue }
        : {}),
    ...(meta.requires ? { requires: meta.requires } : {}),
    ...(entry.aliasOf ? { aliasOf: entry.aliasOf } : {}),
    // Capabilities this ability confers, so a prerequisite written against a
    // capability resolves no matter which of the same-capability entries the
    // character actually holds.
    ...(meta.provides?.length ? { provides: meta.provides } : {}),
    // No chef has read this entry's full output against the printed page yet.
    // The scan-classified mechanics still bind — an inert ability helps nobody
    // — but they present as the machine draft they are: a wrong sign or a
    // missed bonus must read as unverified, never as the book's ruling. The
    // flag clears only when the register entry gains its `audited` sign-off.
    ...(entry.audited ? {} : { unaudited: true }),
    // Set when this reference arrived under an older/foreign name: the reader's
    // source calls it `conversionFrom`, ACKS II calls it `entry.name`.
    ...(opts.conversionStatus ? { conversionStatus: opts.conversionStatus } : {}),
    ...(opts.conversionFrom ? { conversionFrom: opts.conversionFrom } : {}),
    // Structured effects are CLASSIFIED from the seat's own prose (type, target
    // and value all materialize; the cookbook pre-declares none of them). An
    // ability the scan can't classify is still valid — name + type + lazy prose.
    // An alias reads the TARGET's prose through its pre-baked pointer, so it
    // materializes the same mechanics without the cookbook restating any.
    //
    // Without the book there is no prose to classify — but a chef-authored spec
    // that carries no `from` locator has no value to materialize either. It is
    // pure structure (a prerequisite, a companion slot), so gating it on the
    // book would withhold something the cookbook already states. Those apply
    // either way; anything pointing at a number still waits for the book.
    effects: [...aliasEffects, ...(node?.fields?.effects ?? materializeEffects(entry.fields?.effects?.specs, []))],
    // Each roll the ability offers, so the Rolls tab can present them
    // individually rather than the core item's single roll standing in for all.
    ...(node?.fields?.rolls?.length ? { rolls: node.fields.rolls } : {}),
    // Immunity-granting abilities (Divine Health, Wakefulness, Fiery
    // Resistance…) materialize defenses from the seat's OWN prose via the
    // executor's vocabulary scan — nothing about which is shipped.
    ...(node?.fields?.defenses ? { defenses: node.fields.defenses } : {}),
  };
  // Drive the SYSTEM's own fields, not just our flag. An ability whose extract
  // classified a proficiency throw becomes rollable natively — the core sheet
  // already has roll / rollType / rollTarget and a rollFormula() behind them —
  // and a prerequisite lands in the requirements field the sheet already shows.
  // Without this the mechanics exist but nothing in the game can reach them.
  const thrown = extras.effects.find((e) => e.type === "throw");
  const gate = extras.effects.filter((e) => e.type === "requires").flatMap((e) => e.refs ?? []);
  const roll = thrown
    ? {
        roll: thrown.roll || "1d20",
        rollType: thrown.rollType || "above",
        // A level ladder is resolved at 1st level here, because a shared world
        // item has no level. The sheet shows the whole ladder, and an actor's
        // own level is applied when the copy lands on it.
        rollTarget: levelValueAt(thrown.value, 1) ?? 0,
      }
    : {};
  return {
    name: entry.name,
    type: "ability",
    img: abilityIcon(entry),
    system: {
      description: `<p>@PdfText[${id}]{${cite}}</p>`,
      proficiencytype: meta.general ? "general" : "class",
      ...roll,
      ...(gate.length ? { requirements: gate.map(capabilityLabel).join(", ").slice(0, 120) } : {}),
    },
    flags: {
      [MODULE_ID]: { cookbook: { id, cite }, generated: true },
      "acks-abilities": { extras },
    },
  };
}

async function ensureItemFolder() {
  return (
    game.folders.find((fo) => fo.type === "Item" && fo.name === FOLDER_NAME) ??
    Folder.create({ name: FOLDER_NAME, type: "Item" })
  );
}

/**
 * Build — or REUSE — the shared ability item for a definition id. Deduped by
 * cookbook id, so every monster/NPC referencing a proficiency links to the SAME
 * item instead of minting a per-actor copy. Works bookless: without the citing
 * book the item still imports with its structure and lazy descriptor.
 */
export async function importAbility(id, folderId) {
  const found = cookbookEntry(id);
  if (!found) return null;
  // NOTE an alias gets its OWN item. The books list a name whose rules text is
  // printed under another entry; that makes it a distinct ability sharing a
  // passage, not a synonym to redirect away. Its recipe already carries a
  // pointer to where that text lives, so it extracts and classifies normally —
  // it just does not stack with the entry it points at.
  const existing = game.items.find((i) => i.getFlag(MODULE_ID, "cookbook")?.id === id);
  if (existing) return existing;

  const bookId = bookOf(found);
  const session = ctx.sessionDocs.get(bookId);
  let node = null;
  if (session) {
    node = await executeEntry(session.doc, found.cb, data.registers, id);
    if (node?.ok) cookbookCacheParas(bookId, id, node.fields.description ?? []);
    else node = null;
  }
  const folder = folderId ?? (await ensureItemFolder())?.id ?? null;
  const doc = bindAbility(found.entry, node, id);
  const extras = doc.flags["acks-abilities"].extras;
  extras.effects = await resolveCompanions(extras.effects);
  return Item.create({ ...doc, folder });
}

/** Every definition id the shipped content-type cookbooks carry. */
export const cookbookAbilityIds = () => [...data.content.values()].flatMap((cb) => Object.keys(cb.entries));

/* -------------------------------------------- */
/*  Companions                                  */
/* -------------------------------------------- */

/**
 * Fill a companion effect's actor slot. `ref` names the monster entry the
 * ability confers — a pointer the recipe can ship because it is not the book's
 * text. When that book is connected we import the creature and link it; when it
 * is not, the slot stays EMPTY on purpose so a GM can drop an actor in, or so
 * `cookbookFillCompanions()` can fill it once the book loads.
 *
 * Abilities whose creature is BUILT rather than named (a totem animal, a
 * familiar chosen from a list) carry no `ref` at all and keep an empty slot for
 * good — there is no single entry to point at.
 */
async function resolveCompanion(effect) {
  if (effect?.type !== "companion" || effect.actorUuid || !effect.ref) return effect;
  const found = cookbookEntry(effect.ref);
  if (!found) return effect;
  const existing = game.actors.find((a) => a.getFlag(MODULE_ID, "cookbook")?.id === effect.ref);
  if (existing) return { ...effect, actorUuid: existing.uuid };
  const bookId = bookOf(found);
  if (!ctx.sessionDocs.has(bookId)) return effect; // bookless: leave the bucket
  const actor = await importOne(bookId, effect.ref, (await ensureFolder())?.id ?? null).catch((err) => {
    console.error(`${MODULE_ID} | companion ${effect.ref}`, err);
    return null;
  });
  return actor ? { ...effect, actorUuid: actor.uuid } : effect;
}

/** Resolve every companion slot in an effects array, in order (creates actors). */
async function resolveCompanions(effects) {
  if (!effects?.some((e) => e?.type === "companion" && !e.actorUuid && e.ref)) return effects;
  const out = [];
  for (const e of effects) out.push(await resolveCompanion(e));
  return out;
}

/**
 * Fill companion slots left empty because the citing book was not connected.
 * Safe to re-run: a slot already holding an actor is never touched.
 */
export async function cookbookFillCompanions() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  let filled = 0;
  for (const { doc, extras } of eachAbility()) {
    const effects = await resolveCompanions(extras.effects);
    if (effects === extras.effects) continue;
    await doc.update({ [`flags.acks-abilities.extras.effects`]: effects });
    filled += effects.filter((e, i) => e.actorUuid && !extras.effects[i]?.actorUuid).length;
  }
  ui.notifications.info(`acks-content | companions: ${filled} slot(s) linked to an actor.`);
  return filled;
}

/* -------------------------------------------- */
/*  Bulk import / update                        */
/* -------------------------------------------- */

/** Every ability item in the world — loose in the library and on actors alike. */
function* eachAbility() {
  const extrasOf = (doc) => doc.getFlag("acks-abilities", "extras") ?? {};
  for (const item of game.items) {
    if (item.type === "ability") yield { doc: item, extras: extrasOf(item), on: null };
  }
  for (const actor of game.actors) {
    for (const item of actor.items) {
      if (item.type === "ability") yield { doc: item, extras: extrasOf(item), on: actor };
    }
  }
}

/** Names vary by punctuation and case between sources, so match folded. */
const nameKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Resolve an item name to a definition id. Tries the name as printed, then
 * again with a trailing throw value stripped: a stat block writes its
 * proficiencies as "climbing 6+", which is the same proficiency as "Climbing"
 * with its target number attached. Without this, every monster-embedded
 * proficiency fails to match and never gets adopted.
 */
function idForName(index, name, present) {
  let ids = index.get(nameKey(name));
  if (!ids) {
    const bare = String(name ?? "").replace(/\s*\d+\s*\+?\s*$/, "");
    ids = bare && bare !== name ? index.get(nameKey(bare)) : undefined;
  }
  if (!ids?.length) return null;
  return preferredId(ids, present);
}

/**
 * Folded name -> every definition id printing that name.
 *
 * The books reuse names across categories: 14 of them, "Alertness" and
 * "Climbing" among them, are both a proficiency and a class power. A name is
 * therefore only a guess at identity, and the index keeps ALL the candidates so
 * the caller can choose deliberately instead of silently taking the first.
 */
function abilityNameIndex() {
  const index = new Map();
  const add = (name, id) => {
    const key = nameKey(name);
    if (!key) return;
    const list = index.get(key) ?? index.set(key, []).get(key);
    if (!list.includes(id)) list.push(id);
  };
  for (const cb of data.content.values()) {
    for (const [id, e] of Object.entries(cb.entries)) {
      add(e.name, id);
      for (const a of e.aliases ?? []) add(a, id);
    }
  }
  return index;
}

/**
 * Definition id -> the world item already standing for it.
 *
 * Doubles as the "which definitions does this world hold" signal that settles a
 * name collision without guessing. First one wins: duplicates are a world the
 * GM built by hand, and picking the earliest is at least stable across runs.
 */
function loadedAbilityIndex() {
  const byId = new Map();
  for (const item of game.items) {
    const id = item.getFlag(MODULE_ID, "cookbook")?.id;
    if (id && !byId.has(id)) byId.set(id, item);
  }
  return byId;
}

/**
 * Pick among same-named definitions.
 *
 * A collision stops being a guess when only ONE of the candidates is actually
 * available — a world that imported the proficiency list but not the powers has
 * already answered the question. So candidates present in the world win outright,
 * and only when that leaves the choice open (none present, or several) does the
 * category preference apply: a stat block's proficiency list and a hand-made
 * ability both far more often mean the PROFICIENCY than the same-named class
 * power. `ambiguous` reports whether a real guess was made.
 */
const CATEGORY_RANK = ["def.prof.", "def.skill.", "def.power.", "def.drawback."];
const byCategory = (ids) =>
  [...ids].sort((a, b) => {
    const r = (x) => {
      const i = CATEGORY_RANK.findIndex((p) => x.startsWith(p));
      return i === -1 ? CATEGORY_RANK.length : i;
    };
    return r(a) - r(b);
  })[0];

function preferredId(ids, present) {
  if (ids.length === 1) return { id: ids[0], ambiguous: false };
  const here = ids.filter((id) => present.has(id));
  if (here.length === 1) return { id: here[0], ambiguous: false };
  return { id: byCategory(here.length ? here : ids), ambiguous: true };
}

/**
 * GM: browse every shipped ability and pick which to import.
 *
 * The counterpart to the monster import dialog. Works WITHOUT a connected book
 * — an ability always imports with its name, classification and lazy descriptor
 * — but the header says whether the citing book is open, because that is the
 * difference between importing structure and importing structure + mechanics.
 */
export async function cookbookImportAbilitiesDialog() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only (creates items).");
  const rows = [];
  for (const cb of data.content.values()) {
    for (const [id, e] of Object.entries(cb.entries)) {
      rows.push({ id, name: e.name, cite: e.cite, book: e.book, category: e.meta?.category ?? "proficiency", alias: !!e.aliasOf, deprecated: !!e.meta?.deprecated });
    }
  }
  if (!rows.length) return ui.notifications.warn("acks-content | no abilities in the shipped cookbook.");
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const esc = foundry.utils.escapeHTML ?? ((x) => x);
  const have = new Set(game.items.filter((i) => i.getFlag(MODULE_ID, "cookbook")?.id).map((i) => i.getFlag(MODULE_ID, "cookbook").id));
  const openBooks = [...new Set(rows.map((r) => r.book))].filter((b) => ctx.sessionDocs.has(b));
  const cats = [...new Set(rows.map((r) => r.category))].sort();

  const list = rows
    .map((r) => {
      const marks = [
        r.alias ? `<i class="fa-solid fa-link" data-tooltip="${esc(game.i18n.localize(`${LANG_PREFIX}.ui.abilAlias`))}"></i>` : "",
        r.deprecated ? `<i class="fa-solid fa-triangle-exclamation" data-tooltip="${esc(game.i18n.localize(`${LANG_PREFIX}.ui.abilDeprecated`))}"></i>` : "",
        have.has(r.id) ? `<i class="fa-solid fa-check" data-tooltip="${esc(game.i18n.localize(`${LANG_PREFIX}.ui.abilPresent`))}"></i>` : "",
      ].join("");
      return `<label class="acks-content-browse-row" data-name="${esc(r.name.toLowerCase())}" data-cat="${esc(r.category)}" data-have="${have.has(r.id) ? 1 : 0}">
        <input type="checkbox" name="sel" value="${esc(r.id)}">
        <span>${esc(r.name)}</span><span class="acks-content-marks">${marks}</span>
        <span class="acks-content-cite">${esc(r.cite)}</span>
      </label>`;
    })
    .join("");

  const catOptions = cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const content = `
    <p class="notes">${game.i18n.format(`${LANG_PREFIX}.ui.abilIntro`, {
      n: rows.length,
      books: openBooks.length ? openBooks.map((b) => BOOKS[b].short).join(", ") : game.i18n.localize(`${LANG_PREFIX}.ui.abilNoBook`),
    })}</p>
    <div class="acks-content-abil-filters">
      <input type="text" name="filter" placeholder="${game.i18n.localize(`${LANG_PREFIX}.ui.cookbookFilter`)}">
      <select name="cat"><option value="">${game.i18n.localize(`${LANG_PREFIX}.ui.abilAllCats`)}</option>${catOptions}</select>
      <label><input type="checkbox" name="hideHave"> ${game.i18n.localize(`${LANG_PREFIX}.ui.abilHidePresent`)}</label>
    </div>
    <div class="acks-content-abil-actions">
      <button type="button" data-act="all">${game.i18n.localize(`${LANG_PREFIX}.ui.abilSelectShown`)}</button>
      <button type="button" data-act="none">${game.i18n.localize(`${LANG_PREFIX}.ui.abilClear`)}</button>
      <span class="acks-content-abil-count"></span>
    </div>
    <div class="acks-content-browse-list acks-content-abil-list">${list}</div>`;

  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.abilTitle`), resizable: true },
    position: { width: 620, height: 700 },
    content,
    render: (event, dialog) => {
      const root = dialog.element ?? dialog;
      const listEl = root.querySelector(".acks-content-abil-list");
      const count = root.querySelector(".acks-content-abil-count");
      const shown = () => [...listEl.querySelectorAll(".acks-content-browse-row")].filter((r) => r.style.display !== "none");
      const refresh = () => {
        const q = root.querySelector('[name="filter"]').value.toLowerCase();
        const cat = root.querySelector('[name="cat"]').value;
        const hide = root.querySelector('[name="hideHave"]').checked;
        for (const r of listEl.querySelectorAll(".acks-content-browse-row")) {
          const ok = r.dataset.name.includes(q) && (!cat || r.dataset.cat === cat) && (!hide || r.dataset.have === "0");
          r.style.display = ok ? "" : "none";
          if (!ok) r.querySelector('input[name="sel"]').checked = false;
        }
        tally();
      };
      const tally = () => {
        const n = listEl.querySelectorAll('input[name="sel"]:checked').length;
        count.textContent = game.i18n.format(`${LANG_PREFIX}.ui.abilCount`, { n, shown: shown().length });
      };
      for (const sel of ['[name="filter"]', '[name="cat"]', '[name="hideHave"]']) {
        root.querySelector(sel).addEventListener("input", refresh);
      }
      listEl.addEventListener("change", tally);
      root.querySelector('[data-act="all"]').addEventListener("click", () => {
        for (const r of shown()) r.querySelector('input[name="sel"]').checked = true;
        tally();
      });
      root.querySelector('[data-act="none"]').addEventListener("click", () => {
        for (const r of listEl.querySelectorAll('input[name="sel"]')) r.checked = false;
        tally();
      });
      tally();
    },
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.abilGo`),
      callback: async (event, button) => {
        const picked = [...button.form.querySelectorAll('input[name="sel"]:checked')].map((el) => el.value);
        if (!picked.length) return ui.notifications.warn("acks-content | nothing selected.");
        const folder = (await ensureItemFolder())?.id ?? null;
        let done = 0;
        for (const id of picked) {
          if (await importAbility(id, folder).catch((err) => (console.error(`${MODULE_ID} | import ${id}`, err), null))) done++;
        }
        ui.notifications.info(game.i18n.format(`${LANG_PREFIX}.ui.abilDone`, { done, picked: picked.length, folder: FOLDER_NAME }));
      },
    },
  });
}

/** GM: import every shipped ability as a shared, deduped item. */
export async function cookbookImportAbilities() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  const ids = cookbookAbilityIds();
  if (!ids.length) return ui.notifications.warn("acks-content | no abilities in the shipped cookbook.");
  const folder = (await ensureItemFolder())?.id ?? null;
  let made = 0;
  let reused = 0;
  for (const id of ids) {
    if (game.items.find((i) => i.getFlag(MODULE_ID, "cookbook")?.id === id)) reused++;
    else made++;
    await importAbility(id, folder).catch((err) => console.error(`${MODULE_ID} | import ${id}`, err));
  }
  ui.notifications.info(`acks-content | abilities: ${made} imported, ${reused} already present.`);
  return { made, reused };
}

/**
 * GM: refresh every ability already in the world — loose items AND the copies
 * embedded on actors — against the current cookbook.
 *
 * Matched by cookbook id first, then by folded NAME, so abilities made by hand
 * or imported by an older version get adopted and repaired rather than
 * duplicated. Only the generated surface is rewritten (the lazy descriptor, the
 * structured extras, the cookbook id); the item's name and the system fields a
 * GM may have tuned are left alone.
 */
export async function cookbookUpdateAbilities() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  const index = abilityNameIndex();
  if (!index.size) return ui.notifications.warn("acks-content | no abilities in the shipped cookbook.");

  // Which definitions the world already holds — the signal that resolves a
  // name collision without guessing.
  const present = new Set(loadedAbilityIndex().keys());
  const nodeCache = new Map();
  let updated = 0;
  let adopted = 0;
  let onActors = 0;
  let guessed = 0;
  let skipped = 0;
  for (const { doc, extras, on } of eachAbility()) {
    const flagged = doc.getFlag(MODULE_ID, "cookbook")?.id;
    const guess = flagged ? null : idForName(index, doc.name, present);
    const id = flagged ?? guess?.id;
    if (!id || !cookbookEntry(id)) {
      skipped++;
      continue;
    }
    if (guess?.ambiguous) {
      guessed++;
      console.warn(`${MODULE_ID} | "${doc.name}" matches several definitions; adopted ${id}.`);
    }
    const found = cookbookEntry(id);
    // Re-extract once per definition, not once per copy of it.
    if (!nodeCache.has(id)) {
      const session = ctx.sessionDocs.get(bookOf(found));
      let node = null;
      if (session) {
        node = await executeEntry(session.doc, found.cb, data.registers, id).catch(() => null);
        if (node?.ok) cookbookCacheParas(bookOf(found), id, node.fields.description ?? []);
        else node = null;
      }
      nodeCache.set(id, node);
    }
    const built = bindAbility(found.entry, nodeCache.get(id), id, {
      // A copy that recorded arriving under an older name keeps saying so.
      ...(extras.conversionStatus ? { conversionStatus: extras.conversionStatus } : {}),
      ...(extras.conversionFrom ? { conversionFrom: extras.conversionFrom } : {}),
    });
    built.flags["acks-abilities"].extras.effects = await resolveCompanions(built.flags["acks-abilities"].extras.effects);
    await doc.update({
      "system.description": built.system.description,
      [`flags.${MODULE_ID}.cookbook`]: built.flags[MODULE_ID].cookbook,
      "flags.acks-abilities.extras": built.flags["acks-abilities"].extras,
    });
    updated++;
    if (!flagged) adopted++;
    if (on) onActors++;
  }
  const stale = danglingAbilities().length;
  ui.notifications.info(
    `acks-content | abilities updated: ${updated} (${onActors} on actors, ${adopted} matched by name` +
      `${guessed ? `, ${guessed} of them ambiguous — see console` : ""}), ${skipped} not in the cookbook` +
      `${stale ? `; ${stale} left over from a withdrawn definition — run Prune` : ""}.`,
  );
  return { updated, adopted, onActors, guessed, skipped, stale };
}

/**
 * Ability items this module generated whose definition no longer exists.
 *
 * A definition can be withdrawn — ten were, once it turned out the harvest had
 * read the tail of a spaceless heading as an ability of its own. The items it
 * already created stay behind in every world that imported them, pointing at
 * nothing. They are unambiguously ours (generated, with a cookbook id that no
 * longer resolves), which is what makes them safe to offer for removal.
 */
export function danglingAbilities() {
  const out = [];
  for (const item of game.items) {
    if (item.type !== "ability") continue;
    const flags = item.getFlag(MODULE_ID, "cookbook");
    if (!flags?.id || !item.getFlag(MODULE_ID, "generated")) continue;
    if (!cookbookEntry(flags.id)) out.push(item);
  }
  return out;
}

/**
 * GM: remove those items, after showing exactly what will go. Never silent —
 * deleting documents out of someone's world on a version bump is not a thing to
 * do quietly, even when they are certainly stale.
 */
export async function cookbookPruneAbilities() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  const stale = danglingAbilities();
  if (!stale.length) return ui.notifications.info(game.i18n.localize(`${LANG_PREFIX}.ui.pruneNone`));
  const esc = foundry.utils.escapeHTML ?? ((x) => x);
  const rows = stale
    .map((i) => `<li>${esc(i.name)} <code>${esc(i.getFlag(MODULE_ID, "cookbook").id)}</code></li>`)
    .join("");
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.pruneTitle`) },
    content: `<p>${game.i18n.format(`${LANG_PREFIX}.ui.prunePrompt`, { n: stale.length })}</p>
      <ul class="acks-content-browse-list" style="max-height:280px;overflow-y:auto;">${rows}</ul>`,
  });
  if (!ok) return null;
  await Item.deleteDocuments(stale.map((i) => i.id));
  ui.notifications.info(game.i18n.format(`${LANG_PREFIX}.ui.pruneDone`, { n: stale.length }));
  return stale.length;
}

/**
 * GM-only Import All / Update All buttons at the top of the Item directory.
 *
 * Both are idempotent, which is what makes them safe to hand a GM: importing
 * twice reuses the existing items rather than duplicating them, and updating
 * only rewrites the generated surface. Buttons disable while running — these
 * touch every ability in the world and a double-click would interleave.
 */
export function registerAbilityDirectoryButtons() {
  Hooks.on("renderItemDirectory", (app, element) => {
    if (!game.user.isGM) return;
    const root = element instanceof HTMLElement ? element : element?.[0];
    if (!root || root.querySelector(".acks-content-ability-tools")) return;

    const bar = document.createElement("div");
    bar.className = "acks-content-ability-tools";
    const button = (labelKey, tipKey, icon, run) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<i class="${icon}"></i> ${game.i18n.localize(`${LANG_PREFIX}.ui.${labelKey}`)}`;
      b.dataset.tooltip = game.i18n.localize(`${LANG_PREFIX}.ui.${tipKey}`);
      b.addEventListener("click", async () => {
        for (const x of bar.querySelectorAll("button")) x.disabled = true;
        try {
          await run();
        } catch (err) {
          console.error(`${MODULE_ID} | ability tools`, err);
          ui.notifications.error(`acks-content | ${err.message}`);
        } finally {
          for (const x of bar.querySelectorAll("button")) x.disabled = false;
        }
      });
      return b;
    };
    bar.append(
      button("browseAbilities", "browseAbilitiesTip", "fa-solid fa-list-check", cookbookImportAbilitiesDialog),
      button("importAllAbilities", "importAllAbilitiesTip", "fa-solid fa-download", cookbookImportAbilities),
      button("updateAllAbilities", "updateAllAbilitiesTip", "fa-solid fa-rotate", cookbookUpdateAbilities),
      button("pruneAbilities", "pruneAbilitiesTip", "fa-solid fa-broom", cookbookPruneAbilities),
    );
    (root.querySelector(".directory-header") ?? root).prepend(bar);
  });
  // The sidebar renders before this module's `ready` runs, so the hook above
  // misses that first pass — re-render once to catch it.
  if (ui.items?.rendered) ui.items.render();
}

/* -------------------------------------------- */
/*  Debug window: raw executor output           */
/* -------------------------------------------- */

/**
 * GM inspection popout: execute one cookbook entry against the connected book
 * and show the RAW extract JSON next to nothing — exactly what the binder
 * receives. Ephemeral (session memory only), so binder errors can be traced to
 * either the extraction (wrong here) or the binding (right here, wrong on the
 * actor).
 */
export async function cookbookDebug(entryId) {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  const esc = foundry.utils.escapeHTML ?? ((x) => x);

  if (!entryId) {
    const openBooks = [...data.books.keys()].filter((b) => ctx.sessionDocs.has(b));
    if (!openBooks.length) return ui.notifications.warn("acks-content | connect a cookbook book first (PoC 2 / unlock).");
    const cb = data.books.get(openBooks[0]);
    const rows = Object.entries(cb.entries)
      .sort((a, b) => a[1].pages[0] - b[1].pages[0])
      .map(([id, e]) => `<option value="${esc(id)}">${esc(e.name)} — ${esc(e.cite)}</option>`)
      .join("");
    return foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.debugTitle`) },
      content: `<div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.debugPick`)}</label>
        <select name="entry">${rows}</select></div>`,
      ok: {
        label: game.i18n.localize(`${LANG_PREFIX}.ui.debugGo`),
        callback: (event, button) => cookbookDebug(button.form.elements.entry.value),
      },
    });
  }

  const found = cookbookEntry(entryId);
  if (!found) return ui.notifications.warn(`acks-content | unknown cookbook id "${entryId}".`);
  const session = ctx.sessionDocs.get(found.cb.book.id);
  if (!session) return ui.notifications.warn(`acks-content | ${found.cb.book.label} is not open this session.`);

  const node = await executeEntry(session.doc, found.cb, data.registers, entryId);
  const f = node.fields;
  const pre = (v) => `<pre class="acks-content-debug-pre">${esc(JSON.stringify(v, null, 1) ?? "null")}</pre>`;
  const statRows = Object.entries(f.stats ?? {})
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(JSON.stringify(v))}</code></td></tr>`)
    .join("");
  const paras = (f.description ?? [])
    .map((p, i) => `<p class="acks-content-debug-para"><b>[${i}]</b> ${esc(p.text)}</p>`)
    .join("");
  const content = `<div class="acks-content-debug" style="max-height:70vh;overflow-y:auto;">
    <p><b>${esc(node.name)}</b> — ${esc(node.cite)} · pages ${esc(JSON.stringify(found.entry.pages))} · ok=${node.ok}</p>
    <details open><summary>expect</summary>${pre(f.name)}</details>
    <details open><summary>stats (${Object.keys(f.stats ?? {}).length})</summary>
      <table class="acks-content-debug-table">${statRows}</table></details>
    <details open><summary>attacks</summary>${pre(f.attacks ?? null)}</details>
    <details open><summary>spoils</summary>${pre(f.spoils ?? null)}</details>
    <details><summary>art</summary>${pre(f.art ?? null)}</details>
    <details><summary>description (${(f.description ?? []).length} paras — this seat's book, session only)</summary>${paras}</details>
    <details><summary>misses (${node.misses.length})</summary>${pre(node.misses)}</details>
  </div>`;
  return foundry.applications.api.DialogV2.prompt({
    window: { title: `${game.i18n.localize(`${LANG_PREFIX}.ui.debugTitle`)} — ${node.name}`, resizable: true },
    position: { width: 640, height: 720 },
    content,
    ok: { label: game.i18n.localize(`${LANG_PREFIX}.ui.close`) },
  });
}

export async function cookbookImport() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only (creates actors).");
  const openBooks = [...data.books.keys()].filter((b) => ctx.sessionDocs.has(b));
  if (!openBooks.length) {
    return ui.notifications.warn(
      `acks-content | no cookbook book is open this session — connect one first (PoC 2 / unlock dialog).`,
    );
  }
  const bookId = openBooks[0]; // one cookbook book so far (MM)
  const cb = data.books.get(bookId);
  const esc = foundry.utils.escapeHTML ?? ((x) => x);
  const have = importedMonsterIds();
  const rows = Object.entries(cb.entries)
    .sort((a, b) => a[1].pages[0] - b[1].pages[0])
    .map(
      ([id, e]) => `<label class="acks-content-browse-row" data-name="${esc(e.name.toLowerCase())}" data-have="${have.has(id) ? 1 : 0}">
        <input type="checkbox" name="sel" value="${esc(id)}">
        <span>${esc(e.name)}</span>
        <span class="acks-content-marks">${
          have.has(id)
            ? `<i class="fa-solid fa-check" data-tooltip="${esc(game.i18n.localize(`${LANG_PREFIX}.ui.cookbookPresent`))}"></i>`
            : ""
        }</span>
        <span class="acks-content-cite">${esc(e.cite)}</span>
      </label>`,
    )
    .join("");
  const content = `
    <p class="notes">${game.i18n.format(`${LANG_PREFIX}.ui.cookbookIntro`, { n: Object.keys(cb.entries).length, book: BOOKS[bookId].label })}</p>
    <div class="acks-content-abil-filters">
      <input type="text" name="filter" placeholder="${game.i18n.localize(`${LANG_PREFIX}.ui.cookbookFilter`)}">
      <label><input type="checkbox" name="hideHave"> ${game.i18n.localize(`${LANG_PREFIX}.ui.abilHidePresent`)}</label>
    </div>
    <div class="acks-content-abil-actions">
      <button type="button" data-act="all">${game.i18n.localize(`${LANG_PREFIX}.ui.cookbookSelectAll`)}</button>
      <button type="button" data-act="shown">${game.i18n.localize(`${LANG_PREFIX}.ui.abilSelectShown`)}</button>
      <button type="button" data-act="none">${game.i18n.localize(`${LANG_PREFIX}.ui.abilClear`)}</button>
      <span class="acks-content-abil-count"></span>
    </div>
    <div class="acks-content-browse-list acks-content-mon-list">${rows}</div>`;

  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.cookbookTitle`), resizable: true },
    position: { width: 560, height: 700 },
    content,
    render: (event, dialog) => {
      const root = dialog.element ?? dialog;
      const listEl = root.querySelector(".acks-content-mon-list");
      const count = root.querySelector(".acks-content-abil-count");
      const all = () => [...listEl.querySelectorAll(".acks-content-browse-row")];
      const shown = () => all().filter((r) => r.style.display !== "none");
      const tally = () => {
        const n = listEl.querySelectorAll('input[name="sel"]:checked').length;
        count.textContent = game.i18n.format(`${LANG_PREFIX}.ui.abilCount`, { n, shown: shown().length });
      };
      const refresh = () => {
        const q = root.querySelector('[name="filter"]').value.toLowerCase();
        const hide = root.querySelector('[name="hideHave"]').checked;
        for (const r of all()) {
          const ok = r.dataset.name.includes(q) && (!hide || r.dataset.have === "0");
          r.style.display = ok ? "" : "none";
          // A hidden row must not stay selected: what the list shows is the only
          // honest account of what pressing Import will do.
          if (!ok) r.querySelector('input[name="sel"]').checked = false;
        }
        tally();
      };
      const check = (rows_) => {
        for (const r of rows_) r.querySelector('input[name="sel"]').checked = true;
        tally();
      };
      for (const sel of ['[name="filter"]', '[name="hideHave"]']) {
        root.querySelector(sel).addEventListener("input", refresh);
      }
      listEl.addEventListener("change", tally);
      // "All" ignores the filter on purpose — it is the whole-book button, and
      // clearing the filter first would silently change what the user is looking
      // at. "Shown" is the filtered counterpart.
      root.querySelector('[data-act="all"]').addEventListener("click", () => {
        root.querySelector('[name="filter"]').value = "";
        root.querySelector('[name="hideHave"]').checked = false;
        refresh();
        check(all());
      });
      root.querySelector('[data-act="shown"]').addEventListener("click", () => check(shown()));
      root.querySelector('[data-act="none"]').addEventListener("click", () => {
        for (const el of listEl.querySelectorAll('input[name="sel"]')) el.checked = false;
        tally();
      });
      tally();
    },
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.cookbookGo`),
      callback: async (event, button) => {
        const picked = [...button.form.querySelectorAll('input[name="sel"]:checked')].map((el) => el.value);
        if (!picked.length) return ui.notifications.warn("acks-content | nothing selected.");
        // Re-read rather than trusting the marks drawn when the dialog opened —
        // an import may have happened in another window since.
        const present = importedMonsterIds();
        const todo = picked.filter((id) => !present.has(id));
        const folder = await ensureFolder();
        const done = await importMany(bookId, todo, folder.id, game.i18n.localize(`${LANG_PREFIX}.ui.cookbookWorking`));
        reportImport(done, picked.length, picked.length - todo.length);
      },
    },
  });
}

/**
 * GM: import every monster the open book's cookbook ships.
 *
 * The counterpart to importing every ability. Skips what the world already has,
 * so it is a top-up after connecting more of the book, not a duplicator.
 */
export async function cookbookImportMonsters() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only (creates actors).");
  const openBooks = [...data.books.keys()].filter((b) => ctx.sessionDocs.has(b));
  if (!openBooks.length) {
    return ui.notifications.warn(
      `acks-content | no cookbook book is open this session — connect one first (PoC 2 / unlock dialog).`,
    );
  }
  const bookId = openBooks[0];
  const ids = Object.entries(data.books.get(bookId).entries)
    .sort((a, b) => a[1].pages[0] - b[1].pages[0])
    .map(([id]) => id);
  const present = importedMonsterIds();
  const todo = ids.filter((id) => !present.has(id));
  if (!todo.length) {
    return ui.notifications.info(game.i18n.format(`${LANG_PREFIX}.ui.cookbookAllPresent`, { n: ids.length }));
  }
  // Reading a whole book takes minutes and makes hundreds of actors, so say what
  // is about to happen while it can still be called off.
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.cookbookTitle`) },
    content: `<p>${game.i18n.format(`${LANG_PREFIX}.ui.cookbookAllConfirm`, {
      n: todo.length,
      book: BOOKS[bookId].label,
      folder: FOLDER_NAME,
    })}${
      todo.length < ids.length
        ? ` ${game.i18n.format(`${LANG_PREFIX}.ui.cookbookAllConfirmSkip`, { skipped: ids.length - todo.length })}`
        : ""
    }</p>`,
  });
  if (!ok) return null;
  const folder = await ensureFolder();
  const done = await importMany(bookId, todo, folder.id, game.i18n.localize(`${LANG_PREFIX}.ui.cookbookWorking`));
  reportImport(done, ids.length, ids.length - todo.length);
  return { done, skipped: ids.length - todo.length };
}
