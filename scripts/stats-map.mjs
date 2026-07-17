/**
 * Mapping: stat-block labels -> acks core system patch + Full Monster Sheet
 * extras (acks-monsters MonsterExtras schema) + embedded items (weapons from
 * Attacks/Damage, abilities from Proficiencies).
 *
 * Unknown labels stay raw (stored on the actor by the caller) — one-off
 * recipe directions come later, per the recipe philosophy. Enum keys mirror
 * acks-monsters scripts/config.mjs (public shipped data).
 */
import { savesForLevel } from "./stats.mjs";

const TYPE_KEYS = ["animal", "beastman", "construct", "enchanted", "giant", "humanoid", "incarnation", "monstrosity", "ooze", "plant", "undead", "vermin"];
const SIZE_KEYS = ["small", "man", "large", "huge", "gigantic", "colossal"];
const SPEED_KEYS = ["land", "burrow", "climb", "fly", "swim", "webcrawl"];
const SAVE_CLASS_BY_ABBR = { F: "fighter", C: "crusader", M: "mage", T: "thief", D: "dwarvenVaultguard", E: "elvenSpellsword" };

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const PUA_RE = /[-]/g;
const clean = (v) => (v ?? "").replace(PUA_RE, "").replace(/\s+/g, " ").trim();

// Damage-type icon glyphs, decoded from the MM legend (PDF p. 14). Keys are
// acks-monsters DAMAGE_TYPES enum values. E907 = luminous by elimination.
const DAMAGE_GLYPHS = {
  "": "acidic",
  "": "arcane",
  "": "bludgeoning",
  "": "necrotic",
  "": "cold",
  "": "electrical",
  "": "fire",
  "": "luminous",
  "": "slashing",
  "": "piercing",
  "": "poisonous",
  "": "seismic",
};
const damageTypeOf = (segment) => {
  for (const ch of segment) if (DAMAGE_GLYPHS[ch]) return DAMAGE_GLYPHS[ch];
  return null;
};

const NATURAL_WEAPONS = /^(claws?|talons?|bites?|tails?|stings?|slams?|hugs?|gores?|horns?|tentacles?|crush|wings?|hoo(f|ves)|fists?|touch|constrict|trample|kick)$/i;

const firstInt = (v) => {
  const m = /(-?[\d,]+)/.exec(v ?? "");
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
};

/** "Wandering-noun (2d4) / Lair-noun (2d4)" -> encounter side object. */
function encSide(value) {
  if (!value || /^none/i.test(value)) return null;
  const parts = value.split("/").map((s) => s.trim());
  const parse = (part) => {
    const m = /^([^(]+?)\s*\((\d+d\d+(?:[+-]\d+)?)\)/.exec(part ?? "");
    return m ? { noun: m[1].trim(), number: m[2] } : null;
  };
  const wandering = parse(parts[0]);
  const lair = parse(parts[1] ?? parts[0]);
  if (!wandering && !lair) return null;
  return { wandering: wandering ?? { noun: "", number: "" }, lair: lair ?? { noun: "", number: "" } };
}

export function mapPairs(pairs) {
  const system = {};
  const extras = {};
  const items = [];
  const applied = [];
  const unmappedLabels = new Set(pairs.map((p) => p.label));
  const take = (label, { raw = false } = {}) => {
    const found = pairs.find((p) => p.label.toLowerCase() === label.toLowerCase());
    if (!found) return null;
    applied.push(found.label);
    unmappedLabels.delete(found.label);
    return raw ? found.value : clean(found.value);
  };

  /* --- core system --- */

  const ac = take("Armor Class");
  if (ac && /^\d+/.test(ac)) system.aac = { value: parseInt(ac, 10) };

  const hd = take("Hit Dice");
  if (hd) {
    const m = /^(\d+)(?:\s*([+-])\s*(\d+))?\s*(\**)/.exec(hd);
    if (m) {
      const count = parseInt(m[1], 10);
      const bonus = m[2] ? (m[2] === "-" ? -1 : 1) * parseInt(m[3], 10) : 0;
      const asterisks = (m[4] ?? "").length;
      const avg = Math.max(1, Math.floor(count * 4.5 + bonus));
      system.hp = { hd: `${count}d8${bonus ? (bonus > 0 ? `+${bonus}` : bonus) : ""}`, value: avg, max: avg };
      extras.hd = { count, bonus: bonus || null, asterisks: asterisks || null, dieType: 8 };
    }
  }

  const save = take("Save");
  if (save) {
    const m = /^([A-Z]+)\s*(\d+)?/.exec(save.trim());
    const abbr = m?.[1] ?? "F";
    const level = abbr === "NH" ? 0 : parseInt(m?.[2] ?? "0", 10) || 0;
    const row = savesForLevel(level);
    system.saves = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { value: v }]));
    system.saves.breath = { value: row.blast };
    system.saves.wand = { value: row.implements };
    extras.saveAs = { class: SAVE_CLASS_BY_ABBR[abbr] ?? "fighter", level };
  }

  const morale = take("Morale");
  const xp = take("XP");
  const alignment = take("Alignment");
  const treasure = take("Treasure Type");
  system.details = {
    ...(morale ? { morale: parseInt(morale.replace(/[^\d-]/g, ""), 10) || 0 } : {}),
    ...(xp !== null ? { xp: firstInt(xp) ?? 0 } : {}),
    ...(alignment ? { alignment: capitalize(alignment.split(/[ (]/)[0].toLowerCase()) } : {}),
    ...(treasure ? { treasure: { type: /^none/i.test(treasure) ? "none" : treasure.trim().charAt(0).toUpperCase() } } : {}),
  };

  const dungeonEnc = take("Dungeon Enc");
  const wildernessEnc = take("Wilderness Enc");
  const dice = (v) => /\d+d\d+(?:[+-]\d+)?/.exec(v ?? "")?.[0] ?? "";
  if (dungeonEnc || wildernessEnc) {
    system.details.appearing = { d: dice(dungeonEnc), w: dice(wildernessEnc) };
    const d = encSide(dungeonEnc);
    const w = encSide(wildernessEnc);
    if (d || w) extras.encounter = { ...(d ? { dungeon: d } : {}), ...(w ? { wilderness: w } : {}) };
  }
  const lair = take("Lair");
  if (lair) (extras.encounter ??= {}).lairChance = firstInt(lair);

  /* --- speeds (all rows) + core base movement --- */

  const speedRows = pairs.filter((p) => /^speed(\s*\(|$)/i.test(p.label));
  if (speedRows.length) {
    extras.speeds = [];
    for (const row of speedRows) {
      applied.push(row.label);
      unmappedLabels.delete(row.label);
      const typeKey = SPEED_KEYS.find((k) => row.label.toLowerCase().includes(k)) ?? "land";
      const nums = [...row.value.matchAll(/(\d+)/g)].map((n) => parseInt(n[1], 10));
      extras.speeds.push({ type: typeKey, combat: nums[0] ?? null, run: nums[1] ?? nums[0] ?? null, hover: false });
      if (typeKey === "land" && nums.length) system.movement = { base: nums[nums.length - 1] };
    }
    if (!system.movement && extras.speeds[0]?.run) system.movement = { base: extras.speeds[0].run };
  }

  /* --- classification --- */

  const type = take("Type");
  if (type) {
    const lower = type.toLowerCase();
    extras.types = TYPE_KEYS.filter((k) => lower.includes(k));
    const sub = /\(([^)]+)\)/.exec(type);
    if (sub) extras.subtype = sub[1].trim();
  }

  const size = take("Size");
  if (size) {
    const lower = size.toLowerCase();
    extras.size = lower.startsWith("man") ? "man" : (SIZE_KEYS.find((k) => lower.startsWith(k)) ?? "");
    const stone = /([\d,]+)\s*st/.exec(size);
    if (stone) {
      const st = parseInt(stone[1].replace(/,/g, ""), 10);
      extras.mass = { stone: st, lbs: st * 10 };
    }
  }

  /* --- senses --- */

  const vision = take("Vision");
  if (vision) {
    const lower = vision.toLowerCase();
    extras.vision = ["standard", "night", "lightless", "acute", "blind"].filter((k) => lower.includes(k));
    const range = /lightless[^(]*\((\d+)/i.exec(vision);
    if (range) extras.lightlessRange = parseInt(range[1], 10);
  }
  take("Other Senses"); // acknowledged; structured senses get per-recipe directions later

  /* --- carrying --- */

  const load = take("Normal Load");
  if (load) extras.load = { normal: firstInt(load) };
  const maxLoad = take("Max Load");
  if (maxLoad) (extras.load ??= {}).capacity = firstInt(maxLoad);

  /* --- attacks -> weapon items; the throw rides in the Attacks parenthetical --- */

  const attacks = take("Attacks");
  const damageRaw = take("Damage", { raw: true });
  const damage = clean(damageRaw);
  if (attacks) {
    const throwMatch = /(\d+)\+/.exec(attacks);
    if (throwMatch) system.thac0 = { throw: parseInt(throwMatch[1], 10) };
    system.attacks = [attacks, damage].filter(Boolean).join(" — ");
    // Split RAW segments so each keeps its damage-type icon glyph.
    const segments = (damageRaw ?? "").split("/").map((s) => s.trim()).filter((s) => /\d*d\d+/.test(s));
    // Names from the parenthetical: "2 talons, bite 4+" -> [talons, talons, bite]
    const inner = /\(([^)]*)\)/.exec(attacks)?.[1] ?? "";
    const names = [];
    for (let token of inner.replace(/\d+\+\s*$/, "").split(",")) {
      token = token.trim().replace(/\d+\+\s*$/, "").trim();
      const counted = /^(\d+)\s+(.+)$/.exec(token);
      if (counted) {
        for (let i = 0; i < Math.min(parseInt(counted[1], 10), 8); i++) names.push(counted[2]);
      } else if (token) {
        names.push(token);
      }
    }
    segments.forEach((dmgSeg, i) => {
      const dmg = /\d*d\d+(?:[+-]\d+)?/.exec(clean(dmgSeg))?.[0] ?? clean(dmgSeg);
      const damageType = damageTypeOf(dmgSeg);
      const name = capitalize((names[i] ?? names[names.length - 1] ?? `attack ${i + 1}`).trim());
      items.push({
        name,
        type: "weapon",
        img: "icons/svg/sword.svg",
        flags: {
          "acks-monsters": {
            ...(damageType ? { damageType } : {}),
            naturalWeapon: NATURAL_WEAPONS.test(name),
          },
        },
        system: {
          description: "",
          damage: dmg,
          bonus: 0,
          melee: true,
          missile: false,
          equipped: true,
          pattern: "transparent",
          tags: [],
          counter: { value: 1, max: 1 },
          cost: 0,
          weight: 0,
          weight6: 0,
        },
      });
    });
  }

  /* --- proficiencies -> ability items --- */

  const profs = take("Proficiencies");
  if (profs && !/^none/i.test(profs)) {
    for (const name of profs.split(",").map((s) => s.trim()).filter(Boolean)) {
      items.push({
        name,
        type: "ability",
        img: "icons/svg/book.svg",
        system: {
          description: "",
          proficiencytype: "general",
          favorite: false,
          pattern: "white",
          requirements: "",
          roll: "",
          rollType: "above",
          rollTarget: 0,
          blindroll: false,
          save: "",
        },
      });
    }
  }

  return { system, extras, items, applied, unmapped: [...unmappedLabels] };
}
