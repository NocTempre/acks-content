/**
 * IP + schema lint for everything that ships: the register source
 * (register/<book>/, _kinds/, _refs/) and the compiled cookbook (cookbook/).
 * The hard guarantee that no passage can reach a release: every literal is
 * length-capped and shapes are validated. Module-owned (NOT the synced
 * tools/validate.mjs); wired into `npm run validate` via package.json.
 *
 * No PDFs required — runs in CI. Usage: node tools/lint-register.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOKS } from "../scripts/books.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTER = path.join(HERE, "..", "register");
const COOKBOOK = path.join(HERE, "..", "cookbook");

const MAX_STR = 60; // labels/names/headings/citations — never a sentence
const MAX_NOTE = 400; // authoring commentary in register sources ("note" keys)
const MAX_PATTERN = 200; // a regex locator, validated by looksLikeRegex
const COMPOSITE_ID = /^[a-z]{2,4}\.[A-Za-z0-9-]+$/;
const DEF_ID = /^def\.[a-z]+\.[A-Za-z0-9-]+$/;
const KIND_ID = /^kind\.[a-z][A-Za-z0-9]*$/;
const SHAPES = new Set(["open", "descriptor", "keyword", "table"]);
const OPS = new Set(["expect", "text", "value", "attacks", "art", "effects", "progression", "rolls"]);
const PATTERNS = new Set(["raw", "statValue", "int", "dice", "refList", "parenSplit", "spoilList"]);

const errors = [];
const err = (s) => errors.push(s);
const readJson = (p, label) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    err(`${label}: invalid JSON — ${e.message}`);
    return null;
  }
};

/**
 * A `pattern` is shipped machine vocabulary (a locator applied to the reader's
 * own text), not a passage, so it gets a longer cap — but only if it actually
 * looks like a regex. The check is what keeps the allowance from becoming a
 * hole prose could ship through: it must carry regex metacharacters and must
 * not contain a long run of plain words.
 */
function looksLikeRegex(v) {
  if (!/[\\\[\](){}|+*?^$]/.test(v)) return false;
  const words = v.replace(/\\[a-zA-Z]/g, " ").match(/[A-Za-z]{2,}/g) ?? [];
  return !/(?:[A-Za-z]{2,}\s+){6,}/.test(v) && words.length <= 12;
}

/** Cap every string leaf; "note" and validated "pattern" keys get longer caps. */
function capStrings(obj, label, keyPath = "") {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (typeof v === "string") {
      if (k === "pattern" && looksLikeRegex(v)) {
        if (v.length > MAX_PATTERN) err(`${label}: ${keyPath}${k} is ${v.length} chars (>${MAX_PATTERN})`);
        continue;
      }
      const cap = k === "note" ? MAX_NOTE : MAX_STR;
      if (v.length > cap) err(`${label}: ${keyPath}${k} is ${v.length} chars (>${cap}) — looks like prose`);
    } else if (v && typeof v === "object") {
      capStrings(v, label, `${keyPath}${k}.`);
    }
  }
}

/* --- register entries --- */
const seenIds = new Set();
const kindIds = new Set();
const kindRoles = new Map(); // kind id -> role (composite | definition | note | table)

const kindsDir = path.join(REGISTER, "_kinds");
if (fs.existsSync(kindsDir)) {
  for (const f of fs.readdirSync(kindsDir).sort()) {
    if (!f.endsWith(".json")) continue;
    const k = readJson(path.join(kindsDir, f), `_kinds/${f}`);
    if (!k) continue;
    if (!KIND_ID.test(k.id ?? "")) err(`_kinds/${f}: bad kind id "${k.id}"`);
    kindIds.add(k.id);
    kindRoles.set(k.id, k.role);
    capStrings(k, `_kinds/${f}`);
  }
}

for (const dirent of fs.existsSync(REGISTER) ? fs.readdirSync(REGISTER, { withFileTypes: true }) : []) {
  if (!dirent.isDirectory() || dirent.name.startsWith("_")) continue;
  const bookId = dirent.name;
  if (!BOOKS[bookId]) err(`register/${bookId}: unknown book directory`);
  for (const f of fs.readdirSync(path.join(REGISTER, bookId)).sort()) {
    if (!f.endsWith(".json")) continue;
    const label = `register/${bookId}/${f}`;
    const arr = readJson(path.join(REGISTER, bookId, f), label);
    if (!arr) continue;
    if (!Array.isArray(arr)) {
      err(`${label}: top level must be an array`);
      continue;
    }
    for (const e of arr) {
      const id = e.id ?? "?";
      // Composites are book-scoped (mm.griffon). DEFINITIONS are register-scoped
      // and edition-independent (def.prof.alertness) even though their entry row
      // lives under the book that prints them — the same concept can be revised
      // in another book without changing its id.
      if (kindRoles.get(e.kind) === "definition") {
        if (!DEF_ID.test(id)) err(`${label}: bad definition id "${id}" (expect def.<class>.<slug>)`);
      } else {
        if (!COMPOSITE_ID.test(id)) err(`${label}: bad composite id "${id}"`);
        if (!id.startsWith(`${bookId}.`)) err(`${id}: composite id must be book-scoped (${bookId}.*)`);
      }
      if (seenIds.has(id)) err(`duplicate id ${id}`);
      seenIds.add(id);
      if (!kindIds.has(e.kind)) err(`${id}: unknown kind "${e.kind}"`);
      if (e.book !== bookId) err(`${id}: book "${e.book}" != directory "${bookId}"`);
      if (!Array.isArray(e.pages) || !e.pages.every((p) => Number.isInteger(p) && p > 0)) err(`${id}: pages must be positive ints`);
      if (!e.name) err(`${id}: name required`);
      const anchorKeys = Object.keys(e.anchor ?? {});
      if (anchorKeys.length !== 1 || !["display", "runin", "label", "subheading"].includes(anchorKeys[0])) {
        err(`${id}: anchor must have exactly one of display|runin|label|subheading`);
      }
      if (e.aliases && !Array.isArray(e.aliases)) err(`${id}: aliases must be an array`);
      // An icon must at least be SHAPED like a Foundry core icon path. Whether
      // the file exists can only be checked against an install, and CI has
      // none — but a typo'd path renders as a broken image on every seat, so
      // the cheap half of the check is worth having. `tools/propose-icons.mjs
      // --search` lists real paths from a local install.
      if (e.icon !== undefined) {
        if (typeof e.icon !== "string" || !/^icons\/[\w./-]+\.(webp|svg|png|jpg)$/.test(e.icon)) {
          err(`${id}: icon must be a core path like "icons/svg/eye.svg" (got ${JSON.stringify(e.icon)})`);
        }
      }
      capStrings(e, id);
    }
  }
}

/* --- reference registers --- */
const refsDir = path.join(REGISTER, "_refs");
if (fs.existsSync(refsDir)) {
  for (const f of fs.readdirSync(refsDir).sort()) {
    if (!f.endsWith(".json")) continue;
    const label = `_refs/${f}`;
    const r = readJson(path.join(refsDir, f), label);
    if (!r) continue;
    if (!SHAPES.has(r.shape)) err(`${label}: bad shape "${r.shape}"`);
    if (r.shape === "table") {
      if (!r.table || typeof r.table !== "object") err(`${label}: table shape requires "table"`);
    } else {
      for (const [token, row] of Object.entries(r.tokens ?? {})) {
        if (token.length > MAX_STR) err(`${label}: token "${token.slice(0, 20)}…" too long`);
        if (row.ref && !DEF_ID.test(row.ref)) err(`${label}: token "${token}" bad ref "${row.ref}"`);
        if (row.ref && !(r.nodes ?? {})[row.ref]) err(`${label}: token "${token}" ref ${row.ref} has no node in this registry`);
      }
      for (const [id, node] of Object.entries(r.nodes ?? {})) {
        if (!DEF_ID.test(id)) err(`${label}: bad node id "${id}"`);
        for (const [, ed] of Object.entries(node.editions ?? {})) {
          if (ed.book && !BOOKS[ed.book]) err(`${label}: ${id} unknown edition book "${ed.book}"`);
        }
      }
    }
    capStrings(r, label);
  }
}

/* --- compiled cookbook (when present) --- */
if (fs.existsSync(COOKBOOK)) {
  // index.json names which cookbook files exist; it is not itself a cookbook.
  const idx = readJson(path.join(COOKBOOK, "index.json"), "cookbook/index.json");
  if (idx) {
    for (const key of ["books", "content"]) {
      if (!Array.isArray(idx[key])) err(`cookbook/index.json: "${key}" must be an array`);
      for (const name of idx[key] ?? []) {
        if (!fs.existsSync(path.join(COOKBOOK, `${name}.json`))) err(`cookbook/index.json: ${key} names missing "${name}.json"`);
      }
    }
  }
  for (const f of fs.readdirSync(COOKBOOK).sort()) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    const label = `cookbook/${f}`;
    const cb = readJson(path.join(COOKBOOK, f), label);
    if (!cb) continue;
    if (cb.schema !== "acks-cookbook/1") err(`${label}: bad schema "${cb.schema}"`);
    capStrings(cb, label);
    for (const [id, e] of Object.entries(cb.entries ?? {})) {
      for (const [field, instr] of Object.entries(e.fields ?? {})) {
        if (!OPS.has(instr.op)) err(`${label}: ${id}.${field} unknown op "${instr.op}"`);
        if (instr.pattern && !PATTERNS.has(instr.pattern)) err(`${label}: ${id}.${field} unknown pattern "${instr.pattern}"`);
      }
    }
  }
}

if (errors.length) {
  console.error(`register lint: ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`register lint OK (${seenIds.size} entr(ies), ${kindIds.size} kind(s)).`);
