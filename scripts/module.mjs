/**
 * acks-content — bring-your-own-book content streamer (PoC).
 *
 * POSSESSION MODEL: what persists across sessions is the LOCATION of each
 * seat's book (a FileSystemFileHandle in IndexedDB) — never the prose. Every
 * session re-reads descriptions from the actual file; lose the file, lose the
 * prose (stubs + citations remain). Mechanical data (stats, attacks, spoils)
 * is imported into world documents and persists like hand-entered data.
 *
 * Persisted documents carry only @PdfText[recipe-id]{citation} tags, resolved
 * per viewing seat at render time from that seat's in-memory extraction.
 * Browsers without the File System Access API (e.g. Firefox players) fall
 * back to re-picking the file each session — same enforcement, more clicks.
 *
 * PoC api (globalThis.acksContent / game.modules.get("acks-content").api):
 *   connectBook()    pick a book + your local PDF (location remembered)
 *   browseAndLoad()  GM: pick a page, choose headings, load actors/items
 *   createSamples()  load the fixed sample set (GM, acks system)
 *   applyStats()     fill monster actors from the connected book
 *   audit()          popout contrasting language options A and B
 *   bookStatus()     which books are open / remembered / absent on this seat
 *   forgetBooks()    drop remembered locations + this session's prose
 */
import { MODULE_ID, LANG_PREFIX } from "./constants.mjs";
import { BOOKS, fingerprintWarning } from "./books.mjs";
import { RECIPES, recipeById } from "./recipes.mjs";
import { openBook, pageItems, extractRecipe, extractDisplay, extractRunin, extractSpoils, extractPageArt, listHeadings, setWorker } from "./extract.mjs";
import { extractStatPairs } from "./stats.mjs";
import { mapPairs } from "./stats-map.mjs";
import { createSamples, createDocFor, audit as auditDialog } from "./poc.mjs";
import {
  initCookbook, loadCookbook, cookbookImport, cookbookImportAbilities, importAbility, cookbookDebug, cookbookStub,
  cookbookCanReveal, cookbookProse, cookbookCount,
} from "./cookbook.mjs";

const SETTING_DYNAMIC = "dynamicRecipes";
const LEGACY_KEYS = ["acks-content.proseCache", "acks-content.contentCache"]; // pre-possession-model storage

/** Open PDFs this session: bookId -> { doc, title }. Memory only. */
const sessionDocs = new Map();
/** Extracted prose this session: bookId -> { recipeId: prose }. Memory only, by design. */
const proseMem = new Map();

/* -------------------------------------------- */
/*  Remembered book locations (IndexedDB)       */
/* -------------------------------------------- */

const IDB_STORE = "bookHandles";

function idb() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open("acks-content", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(IDB_STORE);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const rq = fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => resolve(rq?.result);
    tx.onerror = () => reject(tx.error);
  });
}

const handleSet = (bookId, handle) => idbOp("readwrite", (s) => s.put(handle, bookId));
const handleGet = (bookId) => idbOp("readonly", (s) => s.get(bookId));
const handleKeys = () => idbOp("readonly", (s) => s.getAllKeys());
const handleClear = () => idbOp("readwrite", (s) => s.clear());

/* -------------------------------------------- */
/*  Recipe resolution (static + dynamic)        */
/* -------------------------------------------- */

const dynamicRecipes = () => game.settings.get(MODULE_ID, SETTING_DYNAMIC) ?? {};
const resolveRecipe = (id) => recipeById(id) ?? dynamicRecipes()[id] ?? null;
const allRecipes = () => [...RECIPES, ...Object.values(dynamicRecipes())];
const recipesForBookAll = (bookId) => allRecipes().filter((r) => r.book === bookId);
const tagHtmlFor = (recipe) => `<p>@PdfText[${recipe.id}]{${recipe.cite}}</p>`;

function stubFor(recipe) {
  if (!recipe.dynamic) return game.i18n.localize(`${LANG_PREFIX}.pdftext.${recipe.id}`);
  return game.i18n.format(`${LANG_PREFIX}.ui.dynamicStub`, {
    name: recipe.name,
    book: BOOKS[recipe.book]?.label ?? recipe.book,
    page: recipe.page,
  });
}

function proseFor(recipeId) {
  const recipe = resolveRecipe(recipeId);
  if (!recipe) return null;
  return proseMem.get(recipe.book)?.[recipeId] ?? null;
}

/* -------------------------------------------- */
/*  Connect / restore books                     */
/* -------------------------------------------- */

async function ingestBook(bookId, buffer, { silent = false } = {}) {
  const { doc, numPages, title } = await openBook(buffer);
  const warning = fingerprintWarning(bookId, numPages, title);
  if (warning && !silent) ui.notifications.warn(`acks-content | ${warning}`);
  sessionDocs.set(bookId, { doc, title });
  const recipes = recipesForBookAll(bookId);
  const entries = proseMem.get(bookId) ?? {};
  for (const recipe of recipes) {
    const prose = await extractRecipe(doc, recipe).catch(() => null);
    if (prose) entries[recipe.id] = prose;
  }
  proseMem.set(bookId, entries);
  const hits = Object.keys(entries).length;
  const message = `acks-content | ${BOOKS[bookId].label}: open — ${hits}/${recipes.length} descriptions readable this session (in memory only; never stored).`;
  if (silent) console.log(message);
  else ui.notifications.info(message);
  return hits;
}

const fsaAvailable = () => typeof window.showOpenFilePicker === "function";

async function connectBook() {
  const options = Object.entries(BOOKS)
    .map(([id, b]) => `<option value="${id}">${b.label}</option>`)
    .join("");
  const fsa = fsaAvailable();
  const fileRow = fsa
    ? `<p class="notes">${game.i18n.localize(`${LANG_PREFIX}.ui.connectNoteFsa`)}</p>`
    : `<div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.connectFile`)}</label>
         <input type="file" name="pdf" accept="application/pdf"></div>
       <p class="notes">${game.i18n.localize(`${LANG_PREFIX}.ui.connectNote`)}</p>`;
  const content = `
    <div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.connectBook`)}</label>
      <select name="book">${options}</select></div>
    ${fileRow}`;
  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.connectTitle`) },
    content,
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.connectGo`),
      callback: async (event, button) => {
        const form = button.form;
        const bookId = form.elements.book.value;
        if (fsa) {
          try {
            const [handle] = await window.showOpenFilePicker({
              types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
            });
            await ingestBook(bookId, await (await handle.getFile()).arrayBuffer());
            await handleSet(bookId, handle);
            ui.notifications.info(game.i18n.format(`${LANG_PREFIX}.ui.locationSaved`, { book: BOOKS[bookId].label }));
          } catch (err) {
            if (err?.name !== "AbortError") throw err;
          }
        } else {
          const file = form.elements.pdf.files[0];
          if (!file) return ui.notifications.warn("acks-content | no file chosen — nothing read.");
          await ingestBook(bookId, await file.arrayBuffer());
        }
      },
    },
  });
}

/**
 * Reopen remembered books. Non-interactive first (silently opens whatever is
 * already permitted); books needing a permission gesture are offered in an
 * unlock dialog — clicking it IS the user gesture the browser requires.
 */
async function restoreBooks({ interactive = false } = {}) {
  if (!fsaAvailable()) return [];
  const pending = [];
  for (const bookId of (await handleKeys().catch(() => [])) ?? []) {
    if (sessionDocs.has(bookId)) continue;
    const handle = await handleGet(bookId).catch(() => null);
    if (!handle?.queryPermission) continue;
    try {
      let perm = await handle.queryPermission({ mode: "read" });
      if (perm === "prompt" && interactive) perm = await handle.requestPermission({ mode: "read" });
      if (perm !== "granted") {
        pending.push(bookId);
        continue;
      }
      await ingestBook(bookId, await (await handle.getFile()).arrayBuffer(), { silent: !interactive });
    } catch (err) {
      console.warn(`${MODULE_ID} | remembered ${BOOKS[bookId]?.label ?? bookId} could not be opened (moved/deleted?)`, err);
      pending.push(bookId);
    }
  }
  return pending;
}

async function offerUnlock(pending) {
  const list = pending.map((id) => `<li>${BOOKS[id]?.label ?? id}</li>`).join("");
  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.unlockTitle`) },
    content: `<p>${game.i18n.localize(`${LANG_PREFIX}.ui.unlockBody`)}</p><ul>${list}</ul>`,
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.unlockGo`),
      callback: async () => {
        const still = await restoreBooks({ interactive: true });
        if (still.length) {
          ui.notifications.warn(
            `acks-content | still locked/missing: ${still.map((id) => BOOKS[id]?.label ?? id).join(", ")} — reconnect via PoC 2 if the file moved.`,
          );
        }
      },
    },
  });
}

function bookStatus() {
  const lines = [];
  handleKeys()
    .catch(() => [])
    .then(async (keys) => {
      for (const [id, book] of Object.entries(BOOKS)) {
        const want = allRecipes().filter((r) => r.book === id).length;
        const have = Object.keys(proseMem.get(id) ?? {}).length;
        let state;
        if (sessionDocs.has(id)) state = `OPEN this session — ${have}/${want} descriptions readable`;
        else if ((keys ?? []).includes(id)) state = "location remembered — locked until unlocked this session";
        else state = book.fake ? "fake book (never connectable — stub demo)" : "not connected on this seat";
        lines.push(`${book.label}: ${state}`);
      }
      ui.notifications.info(
        `acks-content | ${game.i18n.localize(`${LANG_PREFIX}.ui.statusNote`)} Console has per-book detail.`,
      );
      console.log(`${MODULE_ID} | book status (this seat):\n${lines.join("\n")}`);
    });
}

async function forgetBooks() {
  await handleClear().catch(() => {});
  proseMem.clear();
  sessionDocs.clear();
  ui.notifications.info("acks-content | remembered book locations dropped; in-memory prose cleared. Sheets show stubs until books reconnect.");
}

/* -------------------------------------------- */
/*  Browse & load: pick a page, choose headings */
/* -------------------------------------------- */

const slug = (text) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);

function guessKind(bookId, mode) {
  if (mode === "runin") return "item";
  return bookId === "mm" ? "monster" : "ability";
}

async function browseAndLoad() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only (creates documents and world recipes).");

  const options = Object.entries(BOOKS)
    .filter(([, b]) => !b.fake)
    .map(([id, b]) => `<option value="${id}">${b.label}${sessionDocs.has(id) ? " ✓ open" : ""}</option>`)
    .join("");
  const step1 = `
    <div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.connectBook`)}</label>
      <select name="book">${options}</select></div>
    <div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.browsePage`)}</label>
      <input type="number" name="page" min="1" step="1" placeholder="PDF page #"></div>
    <p class="notes">${game.i18n.localize(`${LANG_PREFIX}.ui.browseNote`)}</p>`;

  await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.browseTitle`) },
    content: step1,
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.browseGo`),
      callback: async (event, button) => {
        const form = button.form;
        const bookId = form.elements.book.value;
        const page = parseInt(form.elements.page.value, 10);
        if (!Number.isFinite(page) || page < 1) return ui.notifications.warn("acks-content | enter a PDF page number.");
        if (!sessionDocs.has(bookId)) {
          return ui.notifications.warn(
            `acks-content | ${BOOKS[bookId].label} is not open this session — connect it first (PoC 2 / unlock dialog).`,
          );
        }
        return pickHeadings(bookId, page);
      },
    },
  });
}

async function pickHeadings(bookId, page) {
  const { doc, title } = sessionDocs.get(bookId);
  if (page > doc.numPages) return ui.notifications.warn(`acks-content | page ${page} > ${doc.numPages}.`);
  const pageData = await pageItems(doc, page);
  const heads = listHeadings(pageData);
  if (!heads.length) return ui.notifications.warn(`acks-content | no extraction anchors detected on PDF p. ${page}.`);

  const esc = foundry.utils.escapeHTML ?? ((s) => s);
  const rows = heads
    .map(
      (h, i) => `<label class="acks-content-browse-row">
        <input type="checkbox" name="sel" value="${i}">
        <span>${esc(h.text)}</span>
        <span class="acks-content-cite">${h.mode === "display" ? game.i18n.localize(`${LANG_PREFIX}.ui.modeDisplay`) : game.i18n.localize(`${LANG_PREFIX}.ui.modeRunin`)}</span>
      </label>`,
    )
    .join("");
  const kinds = ["auto", "monster", "ability", "item"]
    .map((k) => `<option value="${k}">${game.i18n.localize(`${LANG_PREFIX}.ui.kind.${k}`)}</option>`)
    .join("");
  const content = `
    <p class="notes">${game.i18n.format(`${LANG_PREFIX}.ui.browseFound`, { n: heads.length, book: BOOKS[bookId].label, page })}</p>
    <div class="acks-content-browse-list">${rows}</div>
    <div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.kindLabel`)}</label>
      <select name="kind">${kinds}</select></div>`;

  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.format(`${LANG_PREFIX}.ui.browsePick`, { book: BOOKS[bookId].label, page }), resizable: true },
    position: { width: 480 },
    content,
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.browseLoad`),
      callback: async (event, button) => {
        const form = button.form;
        const kindChoice = form.elements.kind.value;
        const picked = [...form.querySelectorAll('input[name="sel"]:checked')].map((el) => heads[+el.value]);
        if (!picked.length) return ui.notifications.warn("acks-content | nothing selected.");
        return loadHeadings(bookId, page, pageData, picked, kindChoice, title);
      },
    },
  });
}

async function loadHeadings(bookId, page, pageData, picked, kindChoice) {
  const dyn = foundry.utils.deepClone(dynamicRecipes());
  const mem = proseMem.get(bookId) ?? {};
  let created = 0;
  for (const head of picked) {
    const prose = head.mode === "runin" ? extractRunin(pageData, head.text) : extractDisplay(pageData, head.text);
    if (!prose) {
      ui.notifications.warn(`acks-content | "${head.text}" extracted nothing — skipped.`);
      continue;
    }
    const name = head.text.replace(/:$/, "");
    const recipe = {
      id: `dyn.${bookId}.${page}.${slug(name)}`,
      book: bookId,
      page,
      mode: head.mode,
      heading: head.text,
      cite: `${bookId.toUpperCase()} PDF p. ${page}`,
      kind: kindChoice === "auto" ? guessKind(bookId, head.mode) : kindChoice,
      name,
      dynamic: true,
    };
    dyn[recipe.id] = recipe;
    mem[recipe.id] = prose; // this seat's session memory — other seats resolve via their own book
    const created0 = await createDocFor(recipe);
    if (recipe.kind === "monster") await applyStatsToActor(created0, sessionDocs.get(bookId).doc, pageData, recipe);
    created++;
  }
  if (!created) return;
  proseMem.set(bookId, mem);
  await game.settings.set(MODULE_ID, SETTING_DYNAMIC, dyn);
  ui.notifications.info(game.i18n.format(`${LANG_PREFIX}.ui.browseDone`, { n: created, book: BOOKS[bookId].label, page }));
}

/* -------------------------------------------- */
/*  Stat setup (numbers → world actor data)     */
/* -------------------------------------------- */

/** Extract the page illustration from the GM's book and set it as actor+token
 *  art. NOTE the deliberate asymmetry with prose: art must render on every
 *  client's canvas, so it uploads into world data (acks-content-art/) — a
 *  world asset sourced from the GM's own book, like a scan the GM saved. */
async function importArt(actor, doc, recipe) {
  try {
    const art = await extractPageArt(doc, recipe.page);
    if (!art) {
      console.log(`${MODULE_ID} | ${actor.name}: no suitable illustration found on PDF p. ${recipe.page}.`);
      return false;
    }
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const dir = "acks-content-art";
    await FP.createDirectory("data", dir).catch(() => {});
    const filename = `${recipe.id.replaceAll(".", "-")}.png`;
    const file = new File([art.blob], filename, { type: "image/png" });
    const res = await FP.upload("data", dir, file, {}, { notify: false });
    if (!res?.path) return false;
    await actor.update({ img: res.path, "prototypeToken.texture.src": res.path });
    console.log(`${MODULE_ID} | ${actor.name}: art imported (${art.width}x${art.height}) -> ${res.path}`);
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | ${actor.name}: art import failed`, err);
    return false;
  }
}

async function applyStatsToActor(actor, doc, pageData, recipe) {
  const pairs = extractStatPairs(pageData);
  if (!pairs.length) return ui.notifications.warn(`acks-content | ${recipe.name}: no stat rows found on PDF p. ${recipe.page}.`);
  const { system, extras, items, applied, unmapped } = mapPairs(pairs);

  // Stream the entry prose where the sheet the seat is using will ENRICH it,
  // so the @PdfText tag resolves per seat (stub for a bookless seat, "show book
  // text" reveal for one with the book):
  //   • Full Monster Sheet active → the visible APPEARANCE field
  //     (extras.description.appearance). FMS v0.x enriches its description
  //     fields, so the tag renders there — the first field on the Description
  //     tab, which is where the reader looks.
  //   • otherwise → the core biography ({{{enriched.biography}}}).
  // Each target is written as ONE object/path — never a parent object plus a
  // dotted leaf of it in the same update() (that ambiguity clobbered the write).
  const update = { [`flags.${MODULE_ID}.statPairs`]: pairs };
  const fmsActive = game.modules.get("acks-monsters")?.active;
  if (fmsActive) {
    extras.description = { ...(extras.description ?? {}), appearance: tagHtmlFor(recipe) };
    update["flags.acks-monsters.extras"] = extras;
  } else {
    system.details = { ...(system.details ?? {}), biography: tagHtmlFor(recipe) };
  }
  update.system = system;
  await actor.update(update);
  // Truthful diagnostics: verify the streamed description actually landed.
  const back = fmsActive
    ? actor.getFlag("acks-monsters", "extras")?.description?.appearance
    : actor.system?.details?.biography;
  console.log(`${MODULE_ID} | ${actor.name}: description ${back ? "VERIFIED on actor" : "MISSING after write (!)"}`);

  // Spoils subsection -> spoil-flagged items (Full Monster Sheet Spoils tab).
  // Book weights are authoritative as printed (stored in 1/6-stone units).
  const spoils = extractSpoils(pageData).map((s) => ({
    name: s.name.charAt(0).toUpperCase() + s.name.slice(1),
    type: "item",
    img: "icons/svg/item-bag.svg",
    system: { description: "", subtype: "item", quantity: { value: 1, max: 0 }, cost: s.cost, weight: 0, weight6: s.weight6 },
    flags: { "acks-monsters": { spoil: true, component: true, researchEffects: s.effects } },
  }));

  // Embedded attacks/abilities/spoils: replace previously generated ones (idempotent re-apply).
  const stale = actor.items.filter((i) => i.getFlag(MODULE_ID, "generated")).map((i) => i.id);
  if (stale.length) await actor.deleteEmbeddedDocuments("Item", stale);
  const embed = [...items, ...spoils];
  if (embed.length) {
    await actor.createEmbeddedDocuments(
      "Item",
      embed.map((i) => ({ ...i, flags: { ...(i.flags ?? {}), [MODULE_ID]: { ...(i.flags?.[MODULE_ID] ?? {}), generated: true } } })),
    );
  }

  const gotArt = await importArt(actor, doc, recipe);

  console.log(
    `${MODULE_ID} | ${actor.name}: stats [${applied.join(", ")}]; ${spoils.length} spoils${unmapped.length ? `; unmapped: ${unmapped.join(", ")}` : ""}`,
  );
  ui.notifications.info(
    `acks-content | ${actor.name}: ${applied.length} stat fields, ${items.length} attack/ability items, ${spoils.length} spoils${gotArt ? ", art imported" : ""}, ${unmapped.length} labels stored raw (console has details).`,
  );
}

/** The monster recipe whose name matches an actor ("Griffon" or "Griffon (PoC)"). */
function monsterRecipeForActor(actor) {
  return (
    allRecipes().find(
      (r) =>
        r.kind === "monster" &&
        !BOOKS[r.book]?.fake &&
        (actor.name === r.name || actor.name === `${r.name} (PoC)`),
    ) ?? null
  );
}

/** Fill one monster actor from its recipe's book (must be open this session). */
async function fillMonster(actor, recipe) {
  const session = sessionDocs.get(recipe.book);
  if (!session) {
    ui.notifications.warn(
      `acks-content | ${BOOKS[recipe.book]?.label ?? recipe.book} is not open this session — connect it (PoC 2 / unlock) to fill ${actor.name}.`,
    );
    return false;
  }
  const pageData = await pageItems(session.doc, recipe.page);
  await applyStatsToActor(actor, session.doc, pageData, recipe);
  return true;
}

/**
 * Fill stats on the SELECTED monster tokens only (not every monster in the
 * world). Select the token(s) on the canvas, then run this.
 */
async function applyStats() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  const selected = [
    ...new Set((canvas.tokens?.controlled ?? []).map((t) => t.actor).filter((a) => a?.type === "monster")),
  ];
  if (!selected.length) {
    return ui.notifications.warn(
      "acks-content | select the monster token(s) to fill first — Apply Stats now targets only your selection, never every monster.",
    );
  }
  let touched = 0;
  for (const actor of selected) {
    const recipe = monsterRecipeForActor(actor);
    if (!recipe) {
      ui.notifications.warn(`acks-content | no recipe matches "${actor.name}" — browse-load it (PoC 4) or rename it to a known sample.`);
      continue;
    }
    if (await fillMonster(actor, recipe)) touched++;
  }
  if (touched) ui.notifications.info(`acks-content | filled ${touched} selected monster${touched === 1 ? "" : "s"}.`);
}

/**
 * Create the fixed sample set (poc.mjs) and immediately auto-fill each created
 * monster whose book is open this session — a populated sheet on import, no
 * separate Apply-Stats step.
 */
async function createSamplesAndFill() {
  await createSamples();
  for (const recipe of allRecipes().filter((r) => r.kind === "monster" && !BOOKS[r.book]?.fake)) {
    if (!sessionDocs.has(recipe.book)) continue;
    const actor = game.actors.find(
      (a) => a.type === "monster" && (a.name === recipe.name || a.name === `${recipe.name} (PoC)`),
    );
    if (actor) await fillMonster(actor, recipe);
  }
}

/* -------------------------------------------- */
/*  @PdfText enricher (per-client resolution)   */
/* -------------------------------------------- */

function enrichPdfText(recipeId, label) {
  const recipe = resolveRecipe(recipeId);
  const holder = document.createElement("span");
  holder.classList.add("acks-content-pdftext");
  const stubEl = document.createElement("span");
  stubEl.classList.add("acks-content-stub");
  stubEl.textContent =
    (recipe ? stubFor(recipe) : cookbookStub(recipeId)) ?? game.i18n.localize(`${LANG_PREFIX}.pdftext.${recipeId}`);
  holder.append(stubEl);
  if (proseFor(recipeId) || cookbookCanReveal(recipeId)) {
    const reveal = document.createElement("a");
    reveal.classList.add("acks-content-reveal");
    reveal.dataset.acksContentId = recipeId;
    reveal.textContent = `📖 ${game.i18n.localize(`${LANG_PREFIX}.ui.reveal`)}${label ? ` (${label})` : ""}`;
    holder.append(" ", reveal);
  }
  return holder;
}

async function onRevealClick(event) {
  const link = event.target.closest?.(".acks-content-reveal");
  if (!link) return;
  event.preventDefault();
  const holder = link.closest(".acks-content-pdftext");
  const open = holder?.querySelector(".acks-content-prose");
  if (open) return open.remove(); // toggle off — reproduction stays on-demand
  // Session memory first; else a cookbook id executes lazily from this seat's book.
  const id = link.dataset.acksContentId;
  const prose = proseFor(id) ?? (cookbookCanReveal(id) ? await cookbookProse(id) : null);
  if (!prose) return;
  const block = document.createElement("span");
  block.classList.add("acks-content-prose");
  block.textContent = prose; // textContent: extracted text is never parsed as HTML
  holder.append(block);
}

/* -------------------------------------------- */
/*  Boot                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_DYNAMIC, { scope: "world", config: false, type: Object, default: {} });
  setWorker(`modules/${MODULE_ID}/vendor/pdf.worker.mjs`);
  CONFIG.TextEditor.enrichers.push({
    // id may carry a "#section" suffix (cookbook description sections).
    pattern: /@PdfText\[([\w.#-]+)\](?:\{([^}]+)\})?/g,
    enricher: async (match) => enrichPdfText(match[1], match[2]),
  });
});

Hooks.once("ready", async () => {
  // Possession model: purge any prose persisted by earlier PoC builds.
  for (const key of LEGACY_KEYS) {
    if (localStorage.getItem(key) !== null) {
      localStorage.removeItem(key);
      console.log(`${MODULE_ID} | purged legacy persisted prose (${key}) — prose is session-memory only now.`);
    }
  }

  document.body.addEventListener("click", onRevealClick);
  initCookbook({ sessionDocs, proseMem, importArtForPage: importArt });
  await loadCookbook();
  const audit = () => auditDialog(allRecipes(), stubFor);
  const api = {
    connectBook, browseAndLoad, createSamples: createSamplesAndFill, applyStats, audit, bookStatus, forgetBooks,
    proseFor, cookbookImport, cookbookImportAbilities, importAbility, cookbookDebug, cookbookProse, cookbookCount,
    RECIPES, BOOKS,
  };
  globalThis.acksContent = api;
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
  console.log(
    `${MODULE_ID} | ready. PoC macros in "ACKS Content — PoC Macros", or: acksContent.connectBook() · acksContent.cookbookImport() · acksContent.cookbookImportAbilities() · acksContent.browseAndLoad() · acksContent.audit().`,
  );

  // Reopen remembered books; offer the unlock gesture for the rest.
  const pending = await restoreBooks();
  if (pending.length) await offerUnlock(pending);
});
