/** LOCAL-ONLY: gear/clothing price extraction vs the real RR PDF. Skips w/o ref lib. */
import assert from "node:assert";
import fs from "node:fs";
import { openBook, pageItems } from "../scripts/extract.mjs";
import { FILES, referenceComplete } from "./reference-lib.mjs";
import { extractPriceMapFromDoc, priceFor, parseCost } from "../scripts/gear-prices.mjs";

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); pass++; };

// Unit: coin conversion (1gp = 10sp = 100cp), verified against core costs.
check("parseCost 10gp → 10", parseCost("10gp") === 10);
check("parseCost 3sp → 0.3", Math.abs(parseCost("3sp") - 0.3) < 1e-9);
check("parseCost 2cp → 0.02", Math.abs(parseCost("2cp") - 0.02) < 1e-9);
check("parseCost '5gp/60gp value' → 5", parseCost("5gp/60gp value") === 5);
check("parseCost Varies → null", parseCost("Varies") === null);

if (!referenceComplete()) {
  console.log(`test-gear-prices: ${pass} unit checks passed; reference PDFs absent — extraction skipped.`);
  process.exit(0);
}

const { doc } = await openBook(fs.readFileSync(FILES.rr));
const map = await extractPriceMapFromDoc(doc, pageItems);

check(`built a substantial price map (${map.size})`, map.size >= 150);

// Known gear (matches core exactly): Archery Target 0.3gp / w6 12; Lock 20gp/1.
const at = priceFor(map, "Archery Target");
check("Archery Target cost 0.3 (book 3sp)", Math.abs((at?.cost ?? 0) - 0.3) < 1e-9);
check("Archery Target weight6 12 (book 2 stone)", at?.weight6 === 12);
check("Lock cost 20gp", priceFor(map, "Lock")?.cost === 20);
check("Backpack cost 2gp", priceFor(map, "Backpack")?.cost === 2);

// Clothing (cost only): Belt/Sash Leather 0.1gp (book 1sp).
check("Belt/Sash, Leather cost 0.1", Math.abs((priceFor(map, "Belt/Sash, Leather")?.cost ?? 0) - 0.1) < 1e-9);

// A general multi-variant category returns null, not a guessed variant.
check("'Army Emblem' (Silver + Gold variants) stays unpriced", priceFor(map, "Army Emblem") === null);

console.log(`\ntest-gear-prices: all ${pass} checks passed (price map ${map.size} entries)`);
