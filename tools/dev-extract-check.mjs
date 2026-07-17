/**
 * DEV-ONLY harness: run every recipe through the SHIPPING extraction engine
 * (scripts/extract.mjs) against the local reference library. Requires the
 * LOCAL-ONLY PDFs at C:\Proj\acks-reference — never usable in CI, which is
 * why this is not wired to `npm test`.
 *
 * Usage:  node tools/dev-extract-check.mjs
 * Output: per-recipe OK/MISS with word counts and a <=40-char opening snippet
 * (diagnostics only — never dumps passages).
 */
import fs from "node:fs";
import { openBook, extractRecipe, pageItems } from "../scripts/extract.mjs";
import { extractStatPairs, mapPairs } from "../scripts/stats.mjs";
import { RECIPES } from "../scripts/recipes.mjs";
import { BOOKS, fingerprintWarning } from "../scripts/books.mjs";

const LIB = "C:\\Proj\\acks-reference\\ACKSII";
const FILES = {
  rr: `${LIB}\\ACKSII_Revised_Rulebook_DIGITAL_FINAL_r10_2nd_Printing.pdf`,
  jj: `${LIB}\\ACKSII_Judges_Journal_DIGITAL_FINAL_r9_2nd_Printing.pdf`,
  mm: `${LIB}\\ACKSII_Monstrous_Manual_DIGITAL_FINAL_r7_2nd_Printing.pdf`,
};

let failed = false;
const docs = {};
for (const [id, file] of Object.entries(FILES)) {
  if (!fs.existsSync(file)) {
    console.log(`SKIP book ${id}: ${file} not found`);
    continue;
  }
  const { doc, numPages, title } = await openBook(fs.readFileSync(file));
  const warn = fingerprintWarning(id, numPages, title);
  console.log(`book ${id}: ${numPages}pp "${title}"${warn ? ` — WARN ${warn}` : " — fingerprint OK"}`);
  docs[id] = doc;
}

for (const recipe of RECIPES) {
  const fake = BOOKS[recipe.book]?.fake;
  const doc = docs[recipe.book];
  if (!doc) {
    console.log(`${fake ? "FAKE" : "SKIP"} ${recipe.id} (book ${recipe.book} ${fake ? "does not exist — stub path by design" : "not loaded"})`);
    if (!fake) failed = true;
    continue;
  }
  const prose = await extractRecipe(doc, recipe).catch((err) => {
    console.log(`ERR  ${recipe.id}: ${err.message}`);
    return null;
  });
  if (!prose) {
    console.log(`MISS ${recipe.id} (${recipe.mode} "${recipe.heading}" @ ${recipe.book} p.${recipe.page})`);
    failed = true;
    continue;
  }
  console.log(`OK   ${recipe.id}: ${prose.split(" ").length}w | ${JSON.stringify(prose.slice(0, 40))}`);
}

// Stat setup: parse every real monster recipe's stat block through the
// shipping mapper (numbers only — safe to print).
for (const recipe of RECIPES.filter((r) => r.kind === "monster" && !BOOKS[r.book]?.fake)) {
  const doc = docs[recipe.book];
  if (!doc) continue;
  const pairs = extractStatPairs(await pageItems(doc, recipe.page));
  const { system, applied, unmapped } = mapPairs(pairs);
  console.log(`STATS ${recipe.id}: ${pairs.length} rows -> ${applied.length} mapped [${applied.join(", ")}]`);
  console.log(
    `      ac=${system.aac?.value} hd=${system.hp?.hd} hp=${system.hp?.max} save.death=${system.saves?.death?.value} morale=${system.details?.morale} xp=${system.details?.xp} align=${system.details?.alignment} move=${system.movement?.base} appearing.w=${system.details?.appearing?.w} attacks=${JSON.stringify(system.attacks)}`,
  );
  if (unmapped.length) console.log(`      unmapped (stored raw): ${unmapped.join(", ")}`);
  if (!applied.length) failed = true;
}

process.exit(failed ? 1 : 0);
