/**
 * bindEquipment ↔ the acks-equipment EQUIPMENT ROOT.
 *
 * "Equipment is just a special class of item; they should share a root" (user,
 * 2026-07-24). acks-equipment owns that root (`equipmentClass(name)`); this test
 * checks that bindEquipment consumes it — a torch imports as a 1d4 light-weapon,
 * a flask of holy water as a thrown splash weapon, a lantern as a light-bearing
 * item — and that it DEGRADES to the register's own type when the module (and
 * thus the root) is absent. No RAW value is baked here; the root supplies them.
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
    if (/^torch$/i.test(name)) return { type: "weapon", damage: "1d4", melee: true, missile: true, thrown: true, light: true };
    if (/holy water/i.test(name)) return { type: "weapon", damage: "1d8", missile: true, thrown: true, splash: true, consumable: true };
    if (/^(lantern|candle)$/i.test(name)) return { type: "item", light: true };
    return null;
  },
};

// --- With the root present ----------------------------------------------------
globalThis.acksEquipment = ROOT;

const torch = bindEquipment(mk("Torch"), { fields: {} }, "def.equip.torch");
check("torch upgrades to a weapon", torch.type === "weapon");
check("torch carries the root's 1d4 (not baked in content)", torch.system.damage === "1d4");
check("torch is melee AND thrown-capable (missile)", torch.system.melee === true && torch.system.missile === true);
check("torch is a light source (flagged)", torch.flags[MODULE_ID].light === true);
// A weapon-torch is a SINGLE wielded torch — core weapons have no quantity field,
// so it must not be handed one (it would be stripped by the schema anyway).
check("torch (a weapon) is not given a quantity", torch.system.quantity === undefined);

const hw = bindEquipment(mk("Holy Water"), { fields: {} }, "def.equip.holywater");
check("holy water upgrades to a weapon (1d8)", hw.type === "weapon" && hw.system.damage === "1d8");

const lantern = bindEquipment(mk("Lantern"), { fields: {} }, "def.equip.lantern");
check("a lantern stays an item", lantern.type === "item");
check("a lantern is flagged a light source", lantern.flags[MODULE_ID].light === true);

// A page-extracted value still wins over the root's fallback.
const torchPaged = bindEquipment(mk("Torch"), { fields: { damage: "1d6" } }, "def.equip.torch");
check("an extracted damage overrides the root fallback", torchPaged.system.damage === "1d6");

// A real weapon-group entry is unaffected by the root (already a weapon).
const sword = bindEquipment(mk("Sword", "weapon"), { fields: { damage: "1d6", melee: true } }, "def.equip.sword");
check("a register weapon still binds as a weapon", sword.type === "weapon" && sword.system.damage === "1d6");

// --- Degrade: no acks-equipment → the register's own type stands --------------
globalThis.acksEquipment = undefined;
const torchAlone = bindEquipment(mk("Torch"), { fields: {} }, "def.equip.torch");
check("without the root, a torch stays a plain item", torchAlone.type === "item");
check("without the root, no light flag is invented", !torchAlone.flags[MODULE_ID].light);

console.log(`test-equipment-binding: all ${pass} checks passed`);
