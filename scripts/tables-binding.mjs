/**
 * Table import binding: materialize ruledata tables from the seat's connected
 * PDFs and hand them to the acks-lib `ruledata-import` contract (provider:
 * acks-location) at world priority. Sibling modules (acks-henchmen) then read
 * them from `acksLib.tables`. No values ship — they are read here, live, from
 * the reader's book and persist only in their world.
 *
 * Tables MERGE into any doc already imported, so coverage can grow one book /
 * one table at a time without dropping what is already present.
 */
import { pageItems } from "./extract.mjs";
import { extractTable } from "./table-extract.mjs";
import { TABLE_RECIPES } from "./table-recipes.mjs";
import { BOOKS } from "./books.mjs";

async function locatePage(doc, recipe) {
  const guess = recipe.printedPage ?? recipe.pdfPage ?? 1;
  const order = [];
  for (let d = 0; d <= (recipe.searchRadius ?? 12); d++) {
    if (guess + d <= doc.numPages) order.push(guess + d);
    if (d && guess - d >= 1) order.push(guess - d);
  }
  const seen = new Set(order);
  for (let p = 1; p <= doc.numPages; p++) if (!seen.has(p)) order.push(p);
  for (const p of order) {
    const { items } = await pageItems(doc, p);
    if (items.map((i) => i.str).join(" ").includes(recipe.locate)) return items;
  }
  return null;
}

/**
 * @param {Map} sessionDocs - bookId → { doc } for connected books
 * @returns {Promise<{imported, missingBooks, missingTables}>}
 */
export async function importTables(sessionDocs, { priority } = {}) {
  const lib = globalThis.acksLib;
  const svc = lib?.services?.get?.("ruledata-import");
  if (!svc) {
    throw new Error("acks-content: no ruledata-import provider — enable acks-location (the table host).");
  }
  const P = priority ?? lib.tables.PRIORITY.WORLD;
  const report = { imported: [], missingBooks: new Set(), missingTables: [] };

  for (const [docId, docRec] of Object.entries(TABLE_RECIPES)) {
    const fresh = {};
    for (const [tableId, recipe] of Object.entries(docRec.tables)) {
      const session = sessionDocs.get(recipe.book);
      if (!session?.doc) {
        report.missingBooks.add(recipe.book);
        continue;
      }
      try {
        const items = await locatePage(session.doc, recipe);
        if (!items) {
          report.missingTables.push(`${docId}.${tableId} (page not found)`);
          continue;
        }
        fresh[tableId] = extractTable(items, recipe);
      } catch (err) {
        report.missingTables.push(`${docId}.${tableId} (${err.message})`);
      }
    }
    if (!Object.keys(fresh).length) continue;

    // Merge over whatever is already imported for this doc, so partial
    // coverage accumulates instead of replacing.
    const existing = lib.tables.hasDoc(docId) ? lib.tables.getDoc(docId).tables ?? {} : {};
    const doc = { id: docId, source: docRec.source, tables: { ...existing, ...fresh } };
    await svc.importDoc(doc, { priority: P, source: "acks-content" });
    report.imported.push({ docId, tables: Object.keys(fresh) });
  }
  report.missingBooks = [...report.missingBooks].map((b) => BOOKS[b]?.label ?? b);
  return report;
}
