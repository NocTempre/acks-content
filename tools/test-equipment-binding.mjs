/**
 * bindEquipment ↔ the acks-equipment EQUIPMENT ROOT.
 *
 * "Equipment is just a special class of item; they should share a root" (user,
 * 2026-07-24). acks-equipment owns that root (`equipmentClass(name)`); this test
 * checks that bindEquipment consumes it — a torch imports as a carried light
 * STACK (a bundle; it becomes a 1d4 weapon only when readied), a flask of holy
 * water as a thrown splash weapon, a lantern as a light-bearing item — and that
 * it DEGRADES to the register's own type when the module (and thus the root) is
 * absent. No RAW value is baked here; the root supplies them.
 */
import assert from "node:assert";
import { bindEquipment } from "../scripts/cookbook.mjs";

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); pass++; };

const MODULE_ID = "acks-content";
const mk = (name, group) => ({ name, cite: "p.1", meta: group ? { group } : {} });

// A stand-in for acks-equipment's root, matching the shipped classifier's shape.
const ROOT = {
  equipmentClass: (name) => {
    if (/^torch$/i.test(name)) return { type: "item", prepareAs: "weapon", damage: "1d4", melee: true, missile: true, thrown: true, light: true };
    if (/holy water/i.test(name)) return { type: "weapon", damage: "1d8", missile: true, thrown: true, splash: true, consumable: true };
    if (/^(lantern|candle)$/i.test(name)) return { type: "item", light: true };
    return null;
  },
};

// --- With the root present ----------------------------------------------------
globalThis.acksEquipment = ROOT;

const torch = bindEquipment(mk("Torch"), { fields: {} }, "def.equip.torch");
check("torch imports as a carried STACK (item), not a wielded weapon", torch.type === "item");
check("torch keeps a quantity (a bundle you carry)", torch.system.quantity?.value === 1);
check("torch is a light source (flagged)", torch.flags[MODULE_ID].light === true);
// The 1d4 lives on the readied weapon-torch (acks-equipment prepareTorch), never
// on the bundle — a stack is not a weapon and carries no damage die.
check("torch stack carries no damage die", torch.system.damage === undefined);

const hw = bindEquipment(mk("Holy Water"), { fields: {} }, "def.equip.holywater");
check("holy water upgrades to a weapon (1d8)", hw.type === "weapon" && hw.system.damage === "1d8");

const lantern = bindEquipment(mk("Lantern"), { fields: {} }, "def.equip.lantern");
check("a lantern stays an item", lantern.type === "item");
check("a lantern is flagged a light source", lantern.flags[MODULE_ID].light === true);

// A page-extracted value still wins over the root's fallback (weapon-class gear).
const hwPaged = bindEquipment(mk("Holy Water"), { fields: { damage: "2d4" } }, "def.equip.holywater");
check("an extracted damage overrides the root fallback", hwPaged.system.damage === "2d4");

// A real weapon-group entry is unaffected by the root (already a weapon).
const sword = bindEquipment(mk("Sword", "weapon"), { fields: { damage: "1d6", melee: true } }, "def.equip.sword");
check("a register weapon still binds as a weapon", sword.type === "weapon" && sword.system.damage === "1d6");

// --- Degrade: no acks-equipment → the register's own type stands --------------
globalThis.acksEquipment = undefined;
const torchAlone = bindEquipment(mk("Torch"), { fields: {} }, "def.equip.torch");
check("without the root, a torch stays a plain item", torchAlone.type === "item");
check("without the root, no light flag is invented", !torchAlone.flags[MODULE_ID].light);

console.log(`test-equipment-binding: all ${pass} checks passed`);
