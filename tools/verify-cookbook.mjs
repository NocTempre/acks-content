/**
 * Cookbook acceptance gate: execute the compiled cookbook through the
 * SHIPPING dumb executor (scripts/executor.mjs) against the LOCAL reference
 * PDFs, and check:
 *   - expect integrity per entry (anchor found where instructed);
 *   - values/prose/attacks/spoils/art materialize (word counts + key numbers
 *     as diagnostics — never passages);
 *   - referential integrity (every emitted ref exists in registers.nodes;
 *     definition nodes with empty pages -> warning);
 *   - unknown-token report (lookup misses = promotion candidates);
 *   - per-page line-coverage residue: body items claimed by no instruction
 *     (goal: zero) and cross-entry double-claims.
 *
 * Failures (exit 1): expect mismatch, empty description, zero stats fields.
 * Warnings: stubs, misses, residue.
 *
 * Usage: node tools/verify-cookbook.mjs [book] [pageStart] [pageEnd]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBook, pageItems } from "../scripts/extract.mjs";
import { executeEntry } from "../scripts/executor.mjs";
import { fingerprintWarning } from "../scripts/books.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKBOOK = path.join(HERE, "..", "cookbook");
const LIB = "C:\\Proj\\acks-reference\\ACKSII";
const FILES = {
  rr: `${LIB}\\ACKSII_Revised_Rulebook_DIGITAL_FINAL_r10_2nd_Printing.pdf`,
  jj: `${LIB}\\ACKSII_Judges_Journal_DIGITAL_FINAL_r9_2nd_Printing.pdf`,
  mm: `${LIB}\\ACKSII_Monstrous_Manual_DIGITAL_FINAL_r7_2nd_Printing.pdf`,
};

const [bookArg, startArg, endArg] = process.argv.slice(2);
const start = startArg ? parseInt(startArg, 10) : 0;
const end = endArg ? parseInt(endArg, 10) : Infinity;

const registers = JSON.parse(fs.readFileSync(path.join(COOKBOOK, "registers.json"), "utf8"));
const bookFiles = fs.readdirSync(COOKBOOK).filter((f) => f.endsWith(".json") && f !== "registers.json");

let failures = 0;
let warnings = 0;
const promo = new Map(); // "table:token" -> count

const wordsOf = (paras) => (paras ?? []).reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0);

/** Every ref emitted anywhere in a value tree must resolve in registers.nodes. */
function checkRefs(value, entryId, path0) {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkRefs(v, entryId, `${path0}[${i}]`));
    return;
  }
  if (typeof value !== "object") return;
  if (value.ref) {
    const node = registers.nodes[value.ref];
    if (!node) {
      console.log(`FK   ${entryId}: ${path0} -> ${value.ref} MISSING from registers.nodes`);
      failures++;
    } else {
      const ed = Object.values(node.editions ?? {});
      if (node.role === "definition" && !ed.some((e) => (e.pages ?? []).length)) {
        console.log(`STUB ${entryId}: ${path0} -> ${value.ref} has no defining pages yet (warning)`);
        warnings++;
      }
    }
  }
  for (const [k, v] of Object.entries(value)) if (k !== "ref") checkRefs(v, entryId, `${path0}.${k}`);
}

for (const file of bookFiles) {
  const cb = JSON.parse(fs.readFileSync(path.join(COOKBOOK, file), "utf8"));
  const bookId = cb.book.id;
  if (bookArg && bookId !== bookArg) continue;
  const pdf = FILES[bookId];
  if (!pdf || !fs.existsSync(pdf)) {
    console.log(`SKIP book ${bookId}: reference PDF not found`);
    continue;
  }
  const { doc, numPages, title } = await openBook(fs.readFileSync(pdf));
  const fw = fingerprintWarning(bookId, numPages, title);
  console.log(`book ${bookId}: ${numPages}pp "${title}"${fw ? ` — WARN ${fw}` : " — fingerprint OK"}`);

  const claimedAll = new Map(); // text item -> "entryId.field" (items are unique per cached page)
  const pageCache = new Map();

  const ids = Object.keys(cb.entries).filter((id) => {
    const p = cb.entries[id].pages[0];
    return p >= start && p <= end;
  });

  const skipOps = process.env.VERIFY_NO_ART ? ["art"] : undefined;
  for (const id of ids) {
    const res = await executeEntry(doc, cb, registers, id, { trackClaims: true, pageCache, skipOps });
    const f = res.fields;

    // Merge claims; flag cross-entry double-claims.
    for (const [item, field] of res.claims ?? []) {
      const prev = claimedAll.get(item);
      if (prev && !prev.startsWith(`${id}.`)) {
        console.log(`DUP  item claimed by both ${prev} and ${id}.${field}`);
        warnings++;
      }
      claimedAll.set(item, `${id}.${field}`);
    }

    for (const m of res.misses) {
      if (m.table && m.token) promo.set(`${m.table}:${m.token}`, (promo.get(`${m.table}:${m.token}`) ?? 0) + 1);
      else if (m.error) {
        console.log(`ERR  ${id}.${m.field}: ${m.error}`);
        failures++;
      }
    }

    const words = wordsOf(f.description);
    const statCount = Object.values(f.stats ?? {}).filter(
      (v) => v === 0 || (!!v && (typeof v !== "object" || Object.keys(v).length) && v !== ""),
    ).length;
    const nameOk = f.name?.ok;
    if (!nameOk || !words || !statCount) {
      console.log(`FAIL ${id}: expect=${nameOk ? "ok" : `MISMATCH(${f.name?.found ?? "none"})`} descWords=${words} stats=${statCount}`);
      failures++;
      continue;
    }
    checkRefs(f, id, "");
    const atk = f.attacks;
    const atkStr = atk
      ? `atk[${atk.segments.map((s) => `${s.name ?? "?"} ${s.damage} ${s.damageType?.key ?? "?"}${s.quality ? ` ${s.quality.toUpperCase()}` : ""}`).join(" | ")}] throw=${atk.throw}`
      : "no-attacks";
    const type = f.stats.type;
    console.log(
      `OK   ${id}: ${f.description.length} paras/${words}w stats=${statCount} ac=${f.stats.armorClass} hd=${f.stats.hitDice} ` +
        `type=${type?.key ?? type?.text ?? "?"}${type?.paren ? `(${type.paren.map((p) => p.key ?? p.text).join(",")})` : ""} ` +
        `${atkStr} spoils=${(f.spoils ?? []).length} art=${f.art ? `${f.art.width}x${f.art.height}` : "none"}`,
    );
  }

  // Line-coverage residue per touched page (shipped skips count as claimed).
  let residuePages = 0;
  let residueItems = 0;
  for (const [page, pd] of [...pageCache.entries()].sort((a, b) => a[0] - b[0])) {
    const skips = cb.skips?.[page] ?? [];
    const skipped = (it) => skips.some((b) => it.x >= b.x0 && it.x <= b.x1 && it.y >= b.y0 && it.y <= b.y1);
    const unclaimed = pd.items.filter((it) => !claimedAll.has(it) && !skipped(it));
    if (unclaimed.length) {
      residuePages++;
      residueItems += unclaimed.length;
      warnings++;
      const sample = unclaimed.slice(0, 4).map((it) => JSON.stringify(it.str.slice(0, 24))).join(" ");
      console.log(`RESIDUE p${page}: ${unclaimed.length} unclaimed item(s) e.g. ${sample}`);
    }
  }
  if (residuePages) console.log(`residue total: ${residueItems} item(s) across ${residuePages} page(s)`);
}

if (promo.size) {
  console.log(`\npromotion candidates (unknown tokens):`);
  for (const [k, n] of [...promo.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k} x${n}`);
}
console.log(`\nverify done — ${failures} failure(s), ${warnings} warning(s).`);
process.exit(failures ? 1 : 0);
