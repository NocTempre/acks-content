/**
 * Monster stat-block extraction + mapping (PoC).
 *
 * MM stat tables are bold-label/regular-value pairs ("Armor Class:" → "4").
 * extractStatPairs() collects them from a page's text stream; mapPairs()
 * converts the labels we understand into the acks monster schema. Unknown
 * labels are returned untouched (and stashed on the actor under this
 * module's own flag namespace) — per the recipe philosophy, odd entries get
 * one-off recipe directions later rather than a cleverer parser.
 *
 * IP posture: parsed NUMBERS from the seat's own PDF are persisted into the
 * WORLD actor (actor data must be shared and playable — equivalent to typing
 * the stat block in by hand at your own table). Nothing here ships content:
 * the save LUT below is derived game math, identical to the one acks-monsters
 * publishes (scripts/config.mjs MONSTER_SAVES_LUT).
 */

const SAVES_LUT = {
  0: { paralysis: 14, death: 15, blast: 16, implements: 17, spell: 18 },
  1: { paralysis: 13, death: 14, blast: 15, implements: 16, spell: 17 },
  2: { paralysis: 12, death: 13, blast: 14, implements: 15, spell: 16 },
  4: { paralysis: 11, death: 12, blast: 13, implements: 14, spell: 15 },
  5: { paralysis: 10, death: 11, blast: 12, implements: 13, spell: 14 },
  7: { paralysis: 9, death: 10, blast: 11, implements: 12, spell: 13 },
  8: { paralysis: 8, death: 9, blast: 10, implements: 11, spell: 12 },
  10: { paralysis: 7, death: 8, blast: 9, implements: 10, spell: 11 },
  11: { paralysis: 6, death: 7, blast: 8, implements: 9, spell: 10 },
  13: { paralysis: 5, death: 6, blast: 7, implements: 8, spell: 9 },
  14: { paralysis: 4, death: 5, blast: 6, implements: 7, spell: 8 },
};

function savesForLevel(level) {
  let chosen = 0;
  for (const band of Object.keys(SAVES_LUT).map(Number).sort((a, b) => a - b)) {
    if (level >= band) chosen = band;
  }
  return SAVES_LUT[chosen];
}

const LABEL_RE = /^[A-Z][A-Za-z ()'/]{0,28}:$/;
const VALUE_CAP = 140; // stat values are short; prose after the table must not bleed in

/** Bold-label/value pairs from a page's items (stream order). */
export function extractStatPairs({ items }) {
  const pairs = [];
  let cur = null;
  for (const it of items) {
    if (it.h >= 12) continue; // display headings are never stat rows
    const raw = it.str.replace(/[-]/g, ""); // strip private-use glyphs
    const text = raw.trim();
    if (!text) continue;
    if (LABEL_RE.test(text)) {
      if (cur) pairs.push(cur);
      cur = { label: text.slice(0, -1), value: "" };
    } else if (cur && cur.value.length < VALUE_CAP) {
      cur.value += raw;
    }
  }
  if (cur) pairs.push(cur);
  return pairs.map((p) => ({ label: p.label, value: p.value.replace(/\s+/g, " ").trim() }));
}

/**
 * Map understood labels into an acks monster system patch.
 * Returns { system, applied[], unmapped[] }.
 */
export function mapPairs(pairs) {
  const get = (label) => pairs.find((p) => p.label.toLowerCase() === label.toLowerCase())?.value ?? null;
  const system = {};
  const applied = [];
  const unmappedLabels = new Set(pairs.map((p) => p.label));
  const take = (label) => {
    const v = get(label);
    if (v !== null) {
      applied.push(label);
      for (const p of pairs) if (p.label.toLowerCase() === label.toLowerCase()) unmappedLabels.delete(p.label);
    }
    return v;
  };

  const ac = take("Armor Class");
  if (ac && /^\d+/.test(ac)) system.aac = { value: parseInt(ac, 10) };

  const hd = take("Hit Dice");
  if (hd) {
    const m = /^(\d+)(?:\s*[+-]\s*(\d+))?(\**)/.exec(hd.replace(/\s/g, ""));
    if (m) {
      const count = parseInt(m[1], 10);
      const bonus = /-/.test(hd) ? -parseInt(m[2] ?? 0, 10) : parseInt(m[2] ?? 0, 10);
      const avg = Math.max(1, Math.floor(count * 4.5 + bonus));
      system.hp = { hd: `${count}d8${bonus ? (bonus > 0 ? `+${bonus}` : bonus) : ""}`, value: avg, max: avg };
    }
  }

  const save = take("Save");
  if (save) {
    const m = /^([A-Z]+)\s*(\d+)?/.exec(save.trim());
    const level = m?.[1] === "NH" ? 0 : parseInt(m?.[2] ?? "0", 10) || 0;
    const row = savesForLevel(level);
    system.saves = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { value: v }]));
    // Written for both key generations, like the family's pack builders do.
    system.saves.breath = { value: row.blast };
    system.saves.wand = { value: row.implements };
  }

  const morale = take("Morale");
  const xp = take("XP");
  const alignment = take("Alignment");
  const treasure = take("Treasure Type");
  system.details = {
    ...(morale ? { morale: parseInt(morale.replace(/[^\d-]/g, ""), 10) || 0 } : {}),
    ...(xp ? { xp: parseInt(xp.replace(/[^\d]/g, ""), 10) || 0 } : {}),
    ...(alignment ? { alignment: (() => { const a = alignment.split(/[ (]/)[0]; return a.charAt(0).toUpperCase() + a.slice(1); })() } : {}),
    ...(treasure ? { treasure: { type: treasure } } : {}),
  };

  const dungeonEnc = take("Dungeon Enc");
  const wildernessEnc = take("Wilderness Enc");
  const dice = (v) => /\d+d\d+/.exec(v ?? "")?.[0] ?? "";
  if (dungeonEnc || wildernessEnc) {
    system.details.appearing = { d: dice(dungeonEnc), w: dice(wildernessEnc) };
  }

  // Land speed "40' / 120'" → base movement is the second (exploration) value.
  const speed = take("Speed (land)") ?? take("Speed");
  if (speed) {
    const nums = [...speed.matchAll(/(\d+)/g)].map((m) => parseInt(m[1], 10));
    if (nums.length) system.movement = { base: nums[nums.length - 1] };
  }

  // Attack summary is a display string in the core schema.
  const attacks = take("Attacks");
  const damage = take("Damage");
  if (attacks || damage) system.attacks = [attacks, damage].filter(Boolean).join(" — ");

  return { system, applied, unmapped: [...unmappedLabels] };
}
