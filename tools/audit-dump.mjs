/**
 * Audit-package builder for the tiered audit workflow (docs/RECIPES.md, "The
 * audit gate"). For each requested ability entry it executes the compiled
 * cookbook through the SHIPPING executor against the local reference PDFs and
 * writes one package per entry: the full materialized output next to the
 * printed page text, so a first-pass auditor can compare them without any
 * other tooling.
 *
 * The packages contain licensed book text. They are written OUTSIDE the repo
 * (the out dir is required and must not be inside it) and are never committed
 * — same rule as every other authoring-side dump. Requires
 * C:\Proj\acks-reference; never CI.
 *
 * Usage: node tools/audit-dump.mjs <book> <outDir> [id ...]
 *        (no ids: every ability entry of that book, unaudited first)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBook, pageItems, detectColumns, colOf } from "../scripts/extract.mjs";
import { executeEntry } from "../scripts/executor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKBOOK = path.join(HERE, "..", "cookbook");
const LIB = "C:\\Proj\\acks-reference\\ACKSII";
const FILES = {
  rr: `${LIB}\\ACKSII_Revised_Rulebook_DIGITAL_FINAL_r10_2nd_Printing.pdf`,
  jj: `${LIB}\\ACKSII_Judges_Journal_DIGITAL_FINAL_r9_2nd_Printing.pdf`,
  mm: `${LIB}\\ACKSII_Monstrous_Manual_DIGITAL_FINAL_r7_2nd_Printing.pdf`,
};

const [bookArg, outDirArg, ...idArgs] = process.argv.slice(2);
if (!bookArg || !outDirArg || !FILES[bookArg]) {
  console.error("usage: node tools/audit-dump.mjs <rr|jj|mm> <outDir> [id ...]");
  process.exit(1);
}
const outDir = path.resolve(outDirArg);
const repoRoot = path.resolve(HERE, "..");
if (outDir.startsWith(repoRoot + path.sep)) {
  console.error(`refusing: out dir ${outDir} is inside the repo — packages carry book text and must never be committable`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const registers = JSON.parse(fs.readFileSync(path.join(COOKBOOK, "registers.json"), "utf8"));
const books = fs
  .readdirSync(COOKBOOK)
  .filter((f) => f.endsWith(".json") && !["registers.json", "index.json"].includes(f))
  .map((f) => JSON.parse(fs.readFileSync(path.join(COOKBOOK, f), "utf8")));

/** id -> [cookbook data, entry] across every content file. */
const entryOf = new Map();
for (const cb of books) for (const [id, e] of Object.entries(cb.entries ?? {})) entryOf.set(id, [cb, e]);

/** The page's text in print reading order (column by column, top to bottom). */
function pageText(pd) {
  const cols = detectColumns(pd.items);
  const byCol = new Map();
  for (const it of pd.items) {
    if (!it.str?.trim()) continue;
    const c = colOf(it.x, cols);
    (byCol.get(c) ?? byCol.set(c, []).get(c)).push(it);
  }
  const lines = [];
  for (const c of [...byCol.keys()].sort((a, b) => a - b)) {
    const items = byCol.get(c).sort((a, b) => a.y - b.y || a.x - b.x);
    let line = [];
    let y = -99;
    for (const it of items) {
      if (Math.abs(it.y - y) > 2 && line.length) {
        lines.push(line.join(" "));
        line = [];
      }
      y = it.y;
      line.push(it.str.trim());
    }
    if (line.length) lines.push(line.join(" "));
  }
  return lines.join("\n");
}

async function main() {
  const ids = idArgs.length
    ? idArgs
    : [...entryOf.entries()]
        .filter(([, [, e]]) => e.book === bookArg)
        .sort(([, [, a]], [, [, b]]) => (a.audited ? 1 : 0) - (b.audited ? 1 : 0))
        .map(([id]) => id);

  const { doc } = await openBook(fs.readFileSync(FILES[bookArg]));
  const textCache = new Map();
  const textOf = async (p) => {
    if (!textCache.has(p)) textCache.set(p, pageText(await pageItems(doc, p)));
    return textCache.get(p);
  };

  for (const id of ids) {
    const [cb, entry] = entryOf.get(id) ?? [];
    if (!entry || entry.book !== bookArg) {
      console.error(`skip ${id}: not an ability entry of ${bookArg}`);
      continue;
    }
    const res = await executeEntry(doc, cb, registers, id);
    // The entry's own pages plus the following one, because a column can flow.
    const pages = [...new Set([...(entry.pages ?? []), Math.max(...(entry.pages ?? [0])) + 1])];
    const pkg = {
      id,
      name: entry.name,
      meta: entry.meta ?? {},
      audited: entry.audited ?? false,
      extracted: {
        description: (res?.fields?.description ?? []).map((p) => p.text),
        effects: res?.fields?.effects ?? [],
        rolls: res?.fields?.rolls ?? [],
        ...(res?.fields?.progression ? { progression: res.fields.progression } : {}),
        ...(res?.fields?.powerValue != null ? { powerValue: res.fields.powerValue } : {}),
        ...(res?.fields?.defenses ? { defenses: res.fields.defenses } : {}),
      },
      pageText: Object.fromEntries(await Promise.all(pages.map(async (p) => [p, await textOf(p)]))),
    };
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(pkg, null, 2) + "\n");
    console.error(`wrote ${id} (${pkg.extracted.description.length} para(s), pages ${pages.join(",")})`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
