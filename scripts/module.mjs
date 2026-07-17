/**
 * acks-content — bring-your-own-book content streamer (PoC).
 *
 * Persisted documents carry only @PdfText[recipe-id]{citation} tags. Each
 * client resolves tags at render time: prose extracted from THAT seat's own
 * PDF (cached per-browser, never written to world data, never sent over the
 * socket) → else the sparse lang-file stub with a page reference. Book prose
 * is reproduced only on explicit demand ("show book text") and only for seats
 * that connected the book — per-player enforcement by construction.
 *
 * PoC api (globalThis.acksContent / game.modules.get("acks-content").api):
 *   connectBook()   pick a book + your local PDF; extracts recipes, caches
 *   createSamples() load the sample actors/items (GM, acks system)
 *   audit()         chat card contrasting language options A and B
 *   clearCache()    forget this browser's extracted prose
 */
import { MODULE_ID, LANG_PREFIX } from "./constants.mjs";
import { BOOKS, fingerprintWarning } from "./books.mjs";
import { RECIPES, recipesForBook, recipeById } from "./recipes.mjs";
import { openBook, extractRecipe, setWorker } from "./extract.mjs";
import { createSamples, audit } from "./poc.mjs";

const SETTING_CACHE = "contentCache";

/* -------------------------------------------- */
/*  Per-browser prose cache                     */
/* -------------------------------------------- */

function proseFor(recipeId) {
  const recipe = recipeById(recipeId);
  if (!recipe) return null;
  const cache = game.settings.get(MODULE_ID, SETTING_CACHE);
  return cache?.[recipe.book]?.entries?.[recipeId] ?? null;
}

async function ingestBook(bookId, buffer) {
  const { doc, numPages, title } = await openBook(buffer);
  const warning = fingerprintWarning(bookId, numPages, title);
  if (warning) ui.notifications.warn(`acks-content | ${warning}`);
  const recipes = recipesForBook(bookId);
  const entries = {};
  for (const recipe of recipes) {
    const prose = await extractRecipe(doc, recipe).catch(() => null);
    if (prose) entries[recipe.id] = prose;
  }
  const cache = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTING_CACHE));
  cache[bookId] = { title, when: Date.now(), entries };
  await game.settings.set(MODULE_ID, SETTING_CACHE, cache);
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
/*  @PdfText enricher (per-client resolution)   */
/* -------------------------------------------- */

function enrichPdfText(recipeId, label) {
  const stub = game.i18n.localize(`${LANG_PREFIX}.pdftext.${recipeId}`);
  const holder = document.createElement("span");
  holder.classList.add("acks-content-pdftext");
  const stubEl = document.createElement("span");
  stubEl.classList.add("acks-content-stub");
  stubEl.textContent = stub;
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
  setWorker(`modules/${MODULE_ID}/vendor/pdf.worker.mjs`);
  CONFIG.TextEditor.enrichers.push({
    pattern: /@PdfText\[([\w.-]+)\](?:\{([^}]+)\})?/g,
    enricher: async (match) => enrichPdfText(match[1], match[2]),
  });
});

Hooks.once("ready", () => {
  document.body.addEventListener("click", onRevealClick);
  const api = { connectBook, createSamples, audit, clearCache, proseFor, RECIPES, BOOKS };
  globalThis.acksContent = api;
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
  console.log(
    `${MODULE_ID} | ready. PoC: acksContent.connectBook() → pick your PDF · acksContent.createSamples() → load actors/items · acksContent.audit() → language-options card.`,
  );
});
