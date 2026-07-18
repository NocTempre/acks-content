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
import { executeEntry } from "./executor.mjs";
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
  for (const bookId of Object.keys(BOOKS)) {
    try {
      const cb = await foundry.utils.fetchJsonWithTimeout(`${base}/${bookId}.json`);
      if (cb?.entries) data.books.set(bookId, cb);
    } catch {
      /* book without a cookbook yet */
    }
  }
  for (const name of CONTENT_FILES) {
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
export const cookbookCount = (bookId) => Object.keys(data.books.get(bookId)?.entries ?? {}).length;

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
  for (const prof of f.stats?.proficiencies ?? []) {
    if (!prof.text || /^none/i.test(prof.text)) continue;
    // Prefer the SHARED definition: when the token resolved to a def ref the
    // cookbook carries, embed THAT ability (lazy descriptor, classification,
    // shared cookbook id) instead of minting a bare namesake. A registry miss
    // degrades to a plain named ability — never a failure.
    const shared = prof.ref ? cookbookEntry(prof.ref) : null;
    if (shared) {
      items.push({ img: "icons/svg/book.svg", ...bindAbility(shared.entry, null, prof.ref) });
      continue;
    }
    items.push({
      name: prof.text,
      type: "ability",
      img: "icons/svg/book.svg",
      system: {
        description: "", proficiencytype: "general", favorite: false, pattern: "white",
        requirements: "", roll: "", rollType: "above", rollTarget: 0, blindroll: false, save: "",
      },
    });
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

  return { system, items, flags: moraleNA ? { [MODULE_ID]: { moraleNA: true } } : {} };
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

async function importOne(bookId, id, folderId) {
  const found = cookbookEntry(id);
  const session = ctx.sessionDocs.get(bookId);
  const node = await executeEntry(session.doc, found.cb, data.registers, id);
  if (!node.ok) {
    ui.notifications.warn(`acks-content | ${found.entry.name}: page did not match the cookbook (different printing?) — skipped.`);
    return null;
  }
  const { system, items, flags } = bindMonster(node);

  // Prose stays lazy: the actor carries only tags; description reproduces per
  // seat. Cache this GM's extraction in session memory for instant reveal.
  const paras = node.fields.description ?? [];
  cookbookCacheParas(bookId, id, paras);
  const tag = (section) => `<p>@PdfText[${id}${section ? `#${section}` : ""}]{${found.entry.cite}}</p>`;
  const fmsActive = game.modules.get("acks-monsters")?.active;
  if (!fmsActive) system.details = { ...(system.details ?? {}), biography: tag(null) };

  const actor = await Actor.create({ name: found.entry.name, type: "monster", folder: folderId, system, ...(Object.keys(flags ?? {}).length ? { flags } : {}) });
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

/* -------------------------------------------- */
/*  Abilities (proficiencies / powers / skills) */
/* -------------------------------------------- */

/**
 * Map a definition entry (+ its executed node, when the seat owns the book)
 * onto a core `ability` item. The FULL literal text stays a lazy @PdfText
 * descriptor; classification and any materialized mechanics persist in
 * flags["acks-abilities"].extras, so the ability stays usable without the book.
 */
export function bindAbility(entry, node, id) {
  const meta = entry.meta ?? {};
  const cite = entry.cite ?? "";
  const extras = {
    category: meta.category ?? "proficiency",
    general: !!meta.general,
    repeatable: !!meta.repeatable,
    deprecated: !!meta.deprecated,
    ...(meta.powerValue != null ? { powerValue: meta.powerValue } : {}),
    ...(meta.requires ? { requires: meta.requires } : {}),
    // Structured effects arrive with the per-entry extraction assists; an
    // ability with none is still valid (name + type + lazy prose).
    effects: [],
    // Immunity-granting abilities (Divine Health, Wakefulness, Fiery
    // Resistance…) materialize defenses from the seat's OWN prose via the
    // executor's vocabulary scan — nothing about which is shipped.
    ...(node?.fields?.defenses ? { defenses: node.fields.defenses } : {}),
  };
  return {
    name: entry.name,
    type: "ability",
    system: {
      description: `<p>@PdfText[${id}]{${cite}}</p>`,
      proficiencytype: meta.general ? "general" : "class",
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
  return Item.create({ ...bindAbility(found.entry, node, id), folder });
}

/** Every definition id the shipped content-type cookbooks carry. */
export const cookbookAbilityIds = () => [...data.content.values()].flatMap((cb) => Object.keys(cb.entries));

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
    await importAbility(id, folder);
  }
  ui.notifications.info(`acks-content | abilities: ${made} imported, ${reused} already present.`);
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
  const rows = Object.entries(cb.entries)
    .sort((a, b) => a[1].pages[0] - b[1].pages[0])
    .map(
      ([id, e]) => `<label class="acks-content-browse-row" data-name="${esc(e.name.toLowerCase())}">
        <input type="checkbox" name="sel" value="${esc(id)}">
        <span>${esc(e.name)}</span><span class="acks-content-cite">${esc(e.cite)}</span>
      </label>`,
    )
    .join("");
  const content = `
    <p class="notes">${game.i18n.format(`${LANG_PREFIX}.ui.cookbookIntro`, { n: Object.keys(cb.entries).length, book: BOOKS[bookId].label })}</p>
    <input type="text" name="filter" placeholder="${game.i18n.localize(`${LANG_PREFIX}.ui.cookbookFilter`)}"
      oninput="const q=this.value.toLowerCase();for(const r of this.parentElement.querySelectorAll('.acks-content-browse-row'))r.style.display=r.dataset.name.includes(q)?'':'none';">
    <div class="acks-content-browse-list" style="max-height:360px;overflow-y:auto;">${rows}</div>`;

  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.cookbookTitle`), resizable: true },
    position: { width: 520 },
    content,
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.cookbookGo`),
      callback: async (event, button) => {
        const picked = [...button.form.querySelectorAll('input[name="sel"]:checked')].map((el) => el.value);
        if (!picked.length) return ui.notifications.warn("acks-content | nothing selected.");
        const folder = await ensureFolder();
        let done = 0;
        for (const id of picked) {
          if (await importOne(bookId, id, folder.id).catch((err) => (console.error(`${MODULE_ID} | import ${id}`, err), null))) done++;
        }
        ui.notifications.info(
          game.i18n.format(`${LANG_PREFIX}.ui.cookbookDone`, { done, picked: picked.length, folder: FOLDER_NAME }),
        );
      },
    },
  });
}
