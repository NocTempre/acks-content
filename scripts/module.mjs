/**
 * acks-content — bring-your-own-book content streamer (PoC).
 *
 * Persisted documents carry only @PdfText[recipe-id]{citation} tags. Each
 * client resolves tags at render time: prose extracted from THAT seat's own
 * PDF (cached per-browser, never written to world data, never sent over the
 * socket) → else a sparse stub with a page reference. Book prose is
 * reproduced only on explicit demand ("show book text") and only for seats
 * that connected the book — per-player enforcement by construction.
 *
 * Recipes come in two flavours:
 *   static  — shipped in recipes.mjs with lang-file stubs
 *   dynamic — created at the table via browseAndLoad() (pick book + page,
 *             tick detected headings); pointers only (name/book/page/heading)
 *             stored in a world setting, stubs generated from a template.
 *
 * PoC api (globalThis.acksContent / game.modules.get("acks-content").api):
 *   connectBook()    pick a book + your local PDF; extracts all recipes
 *   browseAndLoad()  GM: pick a page, choose headings, load actors/items
 *   createSamples()  load the fixed sample set (GM, acks system)
 *   audit()          popout contrasting language options A and B
 *   clearCache()     forget this browser's extracted prose
 */
import { MODULE_ID, LANG_PREFIX } from "./constants.mjs";
import { BOOKS, fingerprintWarning } from "./books.mjs";
import { RECIPES, recipesForBook, recipeById } from "./recipes.mjs";
import { openBook, pageItems, extractRecipe, extractDisplay, extractRunin, listHeadings, setWorker } from "./extract.mjs";
import { createSamples, createDocFor, audit as auditDialog } from "./poc.mjs";

const SETTING_CACHE = "contentCache";
const SETTING_DYNAMIC = "dynamicRecipes";

/** PDFs opened this session (memory only — file handles don't persist). */
const sessionDocs = new Map();

/* -------------------------------------------- */
/*  Recipe resolution (static + dynamic)        */
/* -------------------------------------------- */

const dynamicRecipes = () => game.settings.get(MODULE_ID, SETTING_DYNAMIC) ?? {};
const resolveRecipe = (id) => recipeById(id) ?? dynamicRecipes()[id] ?? null;
const allRecipes = () => [...RECIPES, ...Object.values(dynamicRecipes())];
const recipesForBookAll = (bookId) => allRecipes().filter((r) => r.book === bookId);

function stubFor(recipe) {
  if (!recipe.dynamic) return game.i18n.localize(`${LANG_PREFIX}.pdftext.${recipe.id}`);
  return game.i18n.format(`${LANG_PREFIX}.ui.dynamicStub`, {
    name: recipe.name,
    book: BOOKS[recipe.book]?.label ?? recipe.book,
    page: recipe.page,
  });
}

/* -------------------------------------------- */
/*  Per-browser prose cache                     */
/* -------------------------------------------- */

function proseFor(recipeId) {
  const recipe = resolveRecipe(recipeId);
  if (!recipe) return null;
  const cache = game.settings.get(MODULE_ID, SETTING_CACHE);
  return cache?.[recipe.book]?.entries?.[recipeId] ?? null;
}

async function cacheEntries(bookId, title, newEntries) {
  const cache = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTING_CACHE));
  const bucket = (cache[bookId] ??= { title, entries: {} });
  bucket.title = title;
  bucket.when = Date.now();
  Object.assign(bucket.entries, newEntries);
  await game.settings.set(MODULE_ID, SETTING_CACHE, cache);
}

async function ingestBook(bookId, buffer) {
  const { doc, numPages, title } = await openBook(buffer);
  const warning = fingerprintWarning(bookId, numPages, title);
  if (warning) ui.notifications.warn(`acks-content | ${warning}`);
  sessionDocs.set(bookId, { doc, title });
  const recipes = recipesForBookAll(bookId);
  const entries = {};
  for (const recipe of recipes) {
    const prose = await extractRecipe(doc, recipe).catch(() => null);
    if (prose) entries[recipe.id] = prose;
  }
  await cacheEntries(bookId, title, entries);
  const hits = Object.keys(entries).length;
  ui.notifications.info(
    `acks-content | ${BOOKS[bookId].label}: ${hits}/${recipes.length} entries extracted into THIS browser's cache. Re-open sheets to see them.`,
  );
  return hits;
}

async function connectBook() {
  const options = Object.entries(BOOKS)
    .map(([id, b]) => `<option value="${id}">${b.label}</option>`)
    .join("");
  const content = `
    <div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.connectBook`)}</label>
      <select name="book">${options}</select></div>
    <div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.connectFile`)}</label>
      <input type="file" name="pdf" accept="application/pdf"></div>
    <p class="notes">${game.i18n.localize(`${LANG_PREFIX}.ui.connectNote`)}</p>`;
  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.connectTitle`) },
    content,
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.connectGo`),
      callback: async (event, button) => {
        const form = button.form;
        const bookId = form.elements.book.value;
        const file = form.elements.pdf.files[0];
        if (!file) return ui.notifications.warn("acks-content | no file chosen — nothing extracted.");
        return ingestBook(bookId, await file.arrayBuffer());
      },
    },
  });
}

async function clearCache() {
  await game.settings.set(MODULE_ID, SETTING_CACHE, {});
  ui.notifications.info("acks-content | this browser's extracted-prose cache cleared.");
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
    .map(([id, b]) => `<option value="${id}">${b.label}${sessionDocs.has(id) ? " ✓ connected" : ""}</option>`)
    .join("");
  const step1 = `
    <div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.connectBook`)}</label>
      <select name="book">${options}</select></div>
    <div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.browsePage`)}</label>
      <input type="number" name="page" min="1" step="1" placeholder="PDF page #"></div>
    <div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.connectFile`)}</label>
      <input type="file" name="pdf" accept="application/pdf"></div>
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
        const file = form.elements.pdf.files[0];
        if (!Number.isFinite(page) || page < 1) return ui.notifications.warn("acks-content | enter a PDF page number.");
        if (!sessionDocs.has(bookId)) {
          if (!file) return ui.notifications.warn("acks-content | book not connected this session — choose its PDF file.");
          const { doc, numPages, title } = await openBook(await file.arrayBuffer());
          const warning = fingerprintWarning(bookId, numPages, title);
          if (warning) ui.notifications.warn(`acks-content | ${warning}`);
          sessionDocs.set(bookId, { doc, title });
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

async function loadHeadings(bookId, page, pageData, picked, kindChoice, title) {
  const dyn = foundry.utils.deepClone(dynamicRecipes());
  const entries = {};
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
    entries[recipe.id] = prose;
    await createDocFor(recipe);
    created++;
  }
  if (!created) return;
  await game.settings.set(MODULE_ID, SETTING_DYNAMIC, dyn);
  await cacheEntries(bookId, title, entries);
  ui.notifications.info(
    game.i18n.format(`${LANG_PREFIX}.ui.browseDone`, { n: created, book: BOOKS[bookId].label, page }),
  );
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
  stubEl.textContent = recipe ? stubFor(recipe) : game.i18n.localize(`${LANG_PREFIX}.pdftext.${recipeId}`);
  holder.append(stubEl);
  if (proseFor(recipeId)) {
    const reveal = document.createElement("a");
    reveal.classList.add("acks-content-reveal");
    reveal.dataset.acksContentId = recipeId;
    reveal.textContent = `📖 ${game.i18n.localize(`${LANG_PREFIX}.ui.reveal`)}${label ? ` (${label})` : ""}`;
    holder.append(" ", reveal);
  }
  return holder;
}

function onRevealClick(event) {
  const link = event.target.closest?.(".acks-content-reveal");
  if (!link) return;
  event.preventDefault();
  const holder = link.closest(".acks-content-pdftext");
  const open = holder?.querySelector(".acks-content-prose");
  if (open) return open.remove(); // toggle off — reproduction stays on-demand
  const prose = proseFor(link.dataset.acksContentId);
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
  game.settings.register(MODULE_ID, SETTING_CACHE, { scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, SETTING_DYNAMIC, { scope: "world", config: false, type: Object, default: {} });
  setWorker(`modules/${MODULE_ID}/vendor/pdf.worker.mjs`);
  CONFIG.TextEditor.enrichers.push({
    pattern: /@PdfText\[([\w.-]+)\](?:\{([^}]+)\})?/g,
    enricher: async (match) => enrichPdfText(match[1], match[2]),
  });
});

Hooks.once("ready", () => {
  document.body.addEventListener("click", onRevealClick);
  const audit = () => auditDialog(allRecipes(), stubFor);
  const api = { connectBook, browseAndLoad, createSamples, audit, clearCache, proseFor, RECIPES, BOOKS };
  globalThis.acksContent = api;
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
  console.log(
    `${MODULE_ID} | ready. PoC macros in "ACKS Content — PoC Macros", or: acksContent.connectBook() · acksContent.browseAndLoad() · acksContent.createSamples() · acksContent.audit().`,
  );
});
