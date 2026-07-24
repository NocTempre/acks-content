/**
 * acks-content — bring-your-own-book content streamer (PoC).
 *
 * POSSESSION MODEL: what persists across sessions is the LOCATION of each
 * seat's book (in IndexedDB, per seat) — never the prose. Every session
 * re-reads descriptions from the actual file; lose the file, lose the prose
 * (stubs + citations remain). Mechanical data (stats, attacks, spoils) is
 * imported into world documents and persists like hand-entered data.
 *
 * Persisted documents carry only @PdfText[recipe-id]{citation} tags, resolved
 * per viewing seat at render time from that seat's in-memory extraction.
 * A location is a file handle, a fetchable path, or — where the browser allows
 * neither — the remembered NAME of the file, which the join-time reconnect
 * dialog offers back with a picker beside it. Same enforcement throughout;
 * only the number of clicks changes.
 *
 * PoC api (globalThis.acksContent / game.modules.get("acks-content").api):
 *   connectBook()    pick a book + your local PDF (location remembered)
 *   reconnectBooks() reopen this seat's remembered books (runs on join too)
 *   browseAndLoad()  GM: pick a page, choose headings, load actors/items
 *   applyStats()     fill monster actors from the connected book
 *   bookStatus()     which books are open / remembered / absent on this seat
 *   forgetBooks()    drop remembered locations + this session's prose
 */
import { MODULE_ID, LANG_PREFIX } from "./constants.mjs";
import { BOOKS, fingerprintWarning } from "./books.mjs";
import { RECIPES, recipeById } from "./recipes.mjs";
import { openBook, pageItems, extractRecipe, extractDisplay, extractRunin, extractSpoils, extractPageArt, extractPageArtRegion, listHeadings, setWorker, setWasmUrl } from "./extract.mjs";
import { extractStatPairs } from "./stats.mjs";
import { mapPairs } from "./stats-map.mjs";
import { createDocFor } from "./poc.mjs";
import { importTables, tableRecipeCount } from "./tables-binding.mjs";
import { progressBar } from "./progress.mjs";
import {
  initCookbook, loadCookbook, cookbookImport, cookbookImportIds, cookbookImportMonsters, cookbookImportAbilities, cookbookImportAbilitiesDialog, cookbookUpdateAbilities,
  cookbookFillCompanions, cookbookPruneAbilities, registerAbilityDirectoryButtons, importAbility, cookbookDebug, cookbookStub,
  cookbookCanReveal, cookbookProse, cookbookCount, refillMonster, resolveAbilities,
  importEquipment, importAllEquipment, cookbookEquipmentIds, repairEquipmentAbilities,
  cookbookImportJournals, cookbookImportRollTables, cookbookOrganize,
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

/**
 * Where each book lives ON THIS SEAT, so the next session can offer to reopen
 * it. The LOCATION persists; the book's text still never does.
 *
 * Three kinds, because the three ways a seat can reach its own PDF have three
 * different reconnect stories:
 *
 *   handle  a FileSystemFileHandle (Chromium on a secure origin). Reopens
 *           itself after the one permission click browsers insist on per page
 *           load — the original, and still the best case.
 *   url     a path this seat can fetch (a copy staged on the host). The only
 *           kind that reconnects with NO gesture at all.
 *   file    the IDENTITY of a file picked through <input type="file"> — name,
 *           size, mtime. No browser will reopen that from storage, so this is
 *           a reminder rather than a location: on join we can name the exact
 *           file and put a picker in front of it, which is the difference
 *           between "reconnect Monstrous Manual.pdf?" and a seat that starts
 *           blank and silent every session.
 *
 * `file` is not a nicety: the File System Access API is absent on any insecure
 * origin, so a GM joining over plain http on the LAN — or anyone on Firefox —
 * had nothing remembered at all.
 */
const IDB_STORE = "bookHandles"; // store name predates the record shape; renaming it would strand every already-remembered book

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

const locationPut = (bookId, record) => idbOp("readwrite", (s) => s.put(record, bookId));
const locationClear = () => idbOp("readwrite", (s) => s.clear());

/** The record kinds this module writes. Anything else is not ours to read. */
const LOCATION_KINDS = new Set(["handle", "url", "file"]);

/**
 * Records written before the shape existed are the bare handle itself. Read
 * them as the handle they are rather than discarding them — a seat that has
 * had its book remembered for weeks must not lose it to an upgrade.
 *
 * The handle is identified by BEHAVIOUR, and before anything else, because
 * `FileSystemHandle.kind` is a real property whose value is the string "file"
 * — the same word this module uses for a record it cannot reopen. Trusting
 * `kind` first read every legacy handle as "re-pick this by hand", which is
 * precisely the regression the migration exists to prevent.
 */
function asLocation(value) {
  if (!value) return null;
  if (typeof value.getFile === "function") return { kind: "handle", handle: value, name: value.name ?? null };
  return LOCATION_KINDS.has(value.kind) ? value : null;
}

/** Every remembered location on this seat, bookId → record. */
async function locations() {
  let keys = [];
  let values = [];
  try {
    const db = await idb();
    [keys, values] = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      // One transaction for both, so the two arrays are guaranteed to line up.
      const k = store.getAllKeys();
      const v = store.getAll();
      tx.oncomplete = () => resolve([k.result ?? [], v.result ?? []]);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read remembered book locations (IndexedDB)`, err);
    return new Map();
  }
  const out = new Map();
  keys.forEach((key, i) => {
    const record = asLocation(values[i]);
    if (!record) return;
    // A book this build no longer reads (the Judge's Screen inserts, whose
    // tables moved into the JJ and RR in 0.38.0) must not be offered for
    // reconnect: there is nothing left for it to unlock, and every downstream
    // caller would have to defend itself against a book id with no entry in
    // BOOKS. The record is left in place rather than deleted — harmless, and a
    // withdrawn book that ever comes back finds its location still remembered.
    if (!BOOKS[key]) {
      console.log(`${MODULE_ID} | remembered location for "${key}" ignored — this build no longer reads that book.`);
      return;
    }
    out.set(key, record);
  });
  return out;
}

/** What to call a remembered location in front of a reader. */
const describeLocation = (record) =>
  record?.kind === "url" ? record.url : (record?.name ?? game.i18n.localize(`${LANG_PREFIX}.ui.locationUnnamed`));

/** Remember a file picked through the plain input: name only, and say so. */
const rememberFile = (bookId, file) =>
  locationPut(bookId, { kind: "file", name: file.name, size: file.size, lastModified: file.lastModified }).catch((err) =>
    console.warn(`${MODULE_ID} | could not remember ${file.name}`, err),
  );

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

/**
 * Re-render open sheets that show a @PdfText tag.
 *
 * The enricher decides AT RENDER TIME whether this seat can reveal the text, so
 * a sheet drawn before the book was connected keeps its "connect your PDF on
 * this seat" stub — and no reveal link — for as long as it stays open. The
 * message then tells the reader to do the thing they have just done. Only apps
 * actually showing a tag are touched; this fires on connect, not per frame.
 */
function rerenderPdfTextApps() {
  const open = [...(foundry.applications?.instances?.values?.() ?? []), ...Object.values(ui.windows ?? {})];
  let n = 0;
  for (const app of open) {
    const el = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
    if (!el?.querySelector?.(".acks-content-pdftext")) continue;
    try {
      app.render();
      n++;
    } catch (err) {
      console.warn(`${MODULE_ID} | could not re-render ${app?.constructor?.name ?? "an open sheet"}`, err);
    }
  }
  return n;
}

/**
 * Programmatic connect: read a PDF from a URL this seat can fetch (a file the
 * GM staged under the Foundry data dir, or any served path). The interactive
 * connectBook() stays the normal path; this one serves hosted copies and
 * automated live tests.
 *
 * The prose is session memory as always — what persists is the PATH, so the
 * seat reconnects itself on every future join. Pass `{ remember: false }` for
 * a one-off read that should leave nothing behind.
 */
async function connectBookUrl(bookId, url, { remember = true } = {}) {
  if (!BOOKS[bookId]) return ui.notifications.warn(`acks-content | unknown book id "${bookId}".`);
  const resp = await fetch(url);
  if (!resp.ok) return ui.notifications.warn(`acks-content | could not read ${url} (${resp.status}).`);
  const buffer = await resp.arrayBuffer();
  const hits = await ingestBook(bookId, buffer);
  // A path IS a location, and the one kind that needs no gesture to reopen, so
  // a seat pointed at a staged copy reconnects itself on every future join.
  if (remember) {
    await locationPut(bookId, { kind: "url", url, name: url.split("/").pop() || url }).catch((err) =>
      console.warn(`${MODULE_ID} | could not remember ${url}`, err),
    );
  }
  return hits;
}

async function ingestBook(bookId, buffer, { silent = false } = {}) {
  const recipes = recipesForBookAll(bookId);
  // Opening a book is the one wait every seat pays, restore included: pdf.js
  // parses the whole file, then each shipped recipe is extracted from it.
  const bar = progressBar(game.i18n.format(`${LANG_PREFIX}.ui.progressReading`, { book: BOOKS[bookId]?.label ?? bookId }), recipes.length);
  try {
    bar.note(game.i18n.localize(`${LANG_PREFIX}.ui.progressOpening`));
    const { doc, numPages, title } = await openBook(buffer);
    const warning = fingerprintWarning(bookId, numPages, title);
    if (warning && !silent) ui.notifications.warn(`acks-content | ${warning}`);
    sessionDocs.set(bookId, { doc, title });
    const entries = proseMem.get(bookId) ?? {};
    for (const recipe of recipes) {
      const prose = await extractRecipe(doc, recipe).catch(() => null);
      if (prose) entries[recipe.id] = prose;
      bar.step(recipe.name ?? recipe.id);
    }
    proseMem.set(bookId, entries);
    const hits = Object.keys(entries).length;
    // Anything already on screen still says "connect your book" until it is drawn
    // again — the tag resolves per render, not per document.
    const redrawn = rerenderPdfTextApps();
    const message = `acks-content | ${BOOKS[bookId]?.label ?? bookId}: open — ${hits}/${recipes.length} descriptions readable this session (in memory only; never stored).`;
    if (silent) console.log(message);
    else ui.notifications.info(message);
    if (redrawn) console.log(`${MODULE_ID} | re-rendered ${redrawn} open sheet(s) so their page references resolve.`);
    return hits;
  } finally {
    bar.finish();
  }
}

/**
 * Import ACKS rules TABLES (availability, wages, rarity, …) from the connected
 * books into the world, via the acks-lib ruledata-import contract. GM-only
 * (it writes world data). Sibling modules (acks-henchmen) read the result from
 * acksLib.tables; markets, wages and hiring light up as coverage grows.
 */
async function cookbookImportTables() {
  if (!game.user.isGM) {
    ui.notifications.warn(game.i18n.localize(`${LANG_PREFIX}.tables.gmOnly`));
    return null;
  }
  if (!globalThis.acksLib?.services?.get?.("ruledata-import")) {
    ui.notifications.error(game.i18n.localize(`${LANG_PREFIX}.tables.noProvider`));
    return null;
  }
  let report;
  const bar = progressBar(game.i18n.localize(`${LANG_PREFIX}.ui.progressTables`), tableRecipeCount());
  try {
    report = await importTables(sessionDocs, { onProgress: (name) => bar.step(name) });
  } catch (err) {
    ui.notifications.error(`acks-content | ${err.message}`);
    return null;
  } finally {
    bar.finish();
  }
  const nTables = report.imported.reduce((s, d) => s + d.tables.length, 0);
  if (nTables) {
    ui.notifications.info(
      game.i18n.format(`${LANG_PREFIX}.tables.imported`, {
        tables: nTables,
        docs: report.imported.map((d) => d.docId).join(", "),
      }),
    );
  }
  if (report.missingBooks.length) {
    ui.notifications.warn(
      game.i18n.format(`${LANG_PREFIX}.tables.missingBooks`, { books: report.missingBooks.join(", ") }),
    );
  }
  console.log(`${MODULE_ID} | table import`, report);
  return report;
}

const fsaAvailable = () => typeof window.showOpenFilePicker === "function";

async function connectBook() {
  // Say which books this seat already has, and which it merely remembers the
  // location of. Without this the list is identical before and after connecting
  // and the only way to find out is to connect again and see what happens.
  const remembered = await locations();
  const mark = (id) =>
    sessionDocs.has(id)
      ? ` — ${game.i18n.localize(`${LANG_PREFIX}.ui.connectOpen`)}`
      : remembered.has(id)
        ? ` — ${game.i18n.format(`${LANG_PREFIX}.ui.connectRemembered`, { where: describeLocation(remembered.get(id)) })}`
        : "";
  const options = Object.entries(BOOKS)
    .map(([id, b]) => `<option value="${id}">${b.label}${mark(id)}</option>`)
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
            await locationPut(bookId, { kind: "handle", handle, name: handle.name ?? null });
            ui.notifications.info(game.i18n.format(`${LANG_PREFIX}.ui.locationSaved`, { book: BOOKS[bookId].label }));
          } catch (err) {
            if (err?.name !== "AbortError") throw err;
          }
        } else {
          const file = form.elements.pdf.files[0];
          if (!file) return ui.notifications.warn("acks-content | no file chosen — nothing read.");
          await ingestBook(bookId, await file.arrayBuffer());
          // All this browser will let us keep is which file it was. That is
          // still worth keeping: next session says the name and offers the
          // picker instead of leaving the seat to work it out.
          await rememberFile(bookId, file);
          ui.notifications.info(
            game.i18n.format(`${LANG_PREFIX}.ui.locationNameOnly`, { book: BOOKS[bookId].label, name: file.name }),
          );
        }
      },
    },
  });
}

/**
 * Reopen ONE remembered book. Returns whether this seat can now read it.
 *
 * Each kind fails differently and each failure is logged as itself — "it did
 * not reconnect" and "there was nothing to reconnect" used to be indis-
 * tinguishable from the outside, and they are not the same problem.
 *
 * `interactive` is the caller promising it holds a fresh user gesture, which
 * is the only state in which a browser will re-grant file permission.
 */
async function openRemembered(bookId, record, { interactive = false } = {}) {
  if (sessionDocs.has(bookId)) return true;
  const label = BOOKS[bookId]?.label ?? bookId;

  // A served path needs no permission and no gesture: this is the one kind
  // that puts a seat back exactly where it was, silently, on every join.
  if (record?.kind === "url") {
    try {
      const resp = await fetch(record.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await ingestBook(bookId, await resp.arrayBuffer(), { silent: !interactive });
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | remembered ${label}: ${record.url} could not be read`, err);
      return false;
    }
  }

  // Identity only — no browser hands a picked file back from storage. The
  // dialog names it and offers the picker; there is nothing to try here.
  if (record?.kind === "file") {
    console.log(`${MODULE_ID} | remembered ${label}: "${record.name}" must be re-picked (this browser cannot reopen it by itself).`);
    return false;
  }

  if (!fsaAvailable() || !record?.handle?.queryPermission) {
    console.warn(
      `${MODULE_ID} | remembered ${label}: this browser cannot reopen a stored file location (insecure origin, or no File System Access API) — re-pick the file.`,
    );
    return false;
  }
  try {
    let perm = await record.handle.queryPermission({ mode: "read" });
    // Expected on every reload: browsers drop file permission when the page
    // goes away, so a remembered book is "prompt" until a user gesture
    // re-grants it. That gesture is the reconnect dialog — this is the normal
    // path, not a failure, and saying so stops it reading like one.
    if (perm === "prompt" && interactive) perm = await record.handle.requestPermission({ mode: "read" });
    if (perm !== "granted") {
      console.log(`${MODULE_ID} | remembered ${label}: permission "${perm}" — needs the unlock gesture this session.`);
      return false;
    }
    await ingestBook(bookId, await (await record.handle.getFile()).arrayBuffer(), { silent: !interactive });
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | remembered ${label} could not be opened (moved/deleted?)`, err);
    return false;
  }
}

/**
 * Reopen everything this seat remembers, silently. Runs on join: whatever can
 * be opened without asking is opened, and the rest comes back as `pending` for
 * the reconnect dialog.
 */
async function restoreBooks() {
  const records = await locations();
  if (!records.size) {
    console.log(`${MODULE_ID} | no book locations remembered on this seat yet — connect one to have it offered next session.`);
    return [];
  }
  const pending = [];
  for (const [bookId, record] of records) {
    if (!(await openRemembered(bookId, record))) pending.push(bookId);
  }
  return pending;
}

/**
 * The join-time offer: one row per book that could not reopen itself.
 *
 * One control PER BOOK, not one button for the lot, because re-granting file
 * permission consumes the user gesture that authorized it — a single click can
 * only ever unlock the first book, which is exactly how a three-book seat used
 * to end up with one book open and no explanation. A row therefore carries its
 * own Unlock (handle), Retry (path) or file picker, acts the moment it is
 * used, and says what happened; the dialog closes itself once nothing is left.
 */
async function offerReconnect(pending) {
  const records = await locations();
  const esc = foundry.utils.escapeHTML ?? ((s) => s);
  const control = (id, record) => {
    if (record?.kind === "file") {
      return `<input type="file" name="pdf-${esc(id)}" data-book="${esc(id)}" accept="application/pdf">`;
    }
    const key = record?.kind === "url" ? "reconnectRetry" : "reconnectGo";
    return `<button type="button" data-book="${esc(id)}">${game.i18n.localize(`${LANG_PREFIX}.ui.${key}`)}</button>`;
  };
  const why = (record) => {
    if (record?.kind === "file") return game.i18n.format(`${LANG_PREFIX}.ui.reconnectFile`, { name: esc(record.name ?? "") });
    if (record?.kind === "url") return game.i18n.format(`${LANG_PREFIX}.ui.reconnectUrlFailed`, { where: esc(record.url) });
    return game.i18n.format(`${LANG_PREFIX}.ui.reconnectHandle`, { where: esc(describeLocation(record)) });
  };
  const rows = pending
    .map((id) => {
      const record = records.get(id);
      return `<div class="acks-content-reconnect-row" data-row="${esc(id)}">
        <div class="acks-content-reconnect-head">
          <strong>${esc(BOOKS[id]?.label ?? id)}</strong>
          ${control(id, record)}
        </div>
        <p class="notes" data-status="${esc(id)}">${why(record)}</p>
      </div>`;
    })
    .join("");

  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.reconnectTitle`) },
    position: { width: 480 },
    content: `<p>${game.i18n.localize(`${LANG_PREFIX}.ui.reconnectBody`)}</p>${rows}`,
    // Dismissing this is a legitimate answer ("not tonight"), not an error to
    // throw out of the ready hook.
    rejectClose: false,
    render: (event, dialog) => {
      const root = dialog.element ?? dialog;
      const left = new Set(pending);
      const settle = (bookId, ok, message) => {
        const status = root.querySelector(`[data-status="${bookId}"]`);
        if (status) status.textContent = message;
        if (!ok) return;
        left.delete(bookId);
        root.querySelector(`[data-row="${bookId}"]`)?.classList.add("acks-content-reconnect-done");
        // Nothing left to ask for: get out of the way rather than making the
        // reader dismiss a dialog that has finished its job.
        if (!left.size) dialog.close();
      };

      for (const button of root.querySelectorAll("button[data-book]")) {
        button.addEventListener("click", async () => {
          const bookId = button.dataset.book;
          button.disabled = true;
          // This click is the fresh gesture the browser was holding out for.
          const ok = await openRemembered(bookId, records.get(bookId), { interactive: true }).catch((err) => {
            console.error(`${MODULE_ID} | reconnect ${bookId}`, err);
            return false;
          });
          button.disabled = ok;
          settle(
            bookId,
            ok,
            ok
              ? game.i18n.localize(`${LANG_PREFIX}.ui.reconnectOpened`)
              : game.i18n.localize(`${LANG_PREFIX}.ui.reconnectFailed`),
          );
        });
      }

      for (const input of root.querySelectorAll("input[type=file][data-book]")) {
        input.addEventListener("change", async () => {
          const bookId = input.dataset.book;
          const file = input.files?.[0];
          if (!file) return;
          input.disabled = true;
          try {
            await ingestBook(bookId, await file.arrayBuffer());
            await rememberFile(bookId, file); // may be a different copy than last time
            settle(bookId, true, game.i18n.localize(`${LANG_PREFIX}.ui.reconnectOpened`));
          } catch (err) {
            console.error(`${MODULE_ID} | reconnect ${bookId}`, err);
            input.disabled = false;
            settle(bookId, false, game.i18n.localize(`${LANG_PREFIX}.ui.reconnectFailed`));
          }
        });
      }
    },
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.reconnectDone`),
      callback: () => {
        const still = pending.filter((id) => !sessionDocs.has(id));
        if (still.length) {
          ui.notifications.warn(
            game.i18n.format(`${LANG_PREFIX}.ui.reconnectIncomplete`, {
              books: still.map((id) => BOOKS[id]?.label ?? id).join(", "),
            }),
          );
        }
      },
    },
  });
}

/**
 * Reconnect on demand — the same pass that runs on join, for a seat that
 * dismissed the dialog or plugged its drive in afterwards.
 */
async function reconnectBooks() {
  const pending = await restoreBooks();
  if (!pending.length) {
    const open = [...sessionDocs.keys()].map((id) => BOOKS[id]?.label ?? id);
    return ui.notifications.info(
      open.length
        ? game.i18n.format(`${LANG_PREFIX}.ui.reconnectAllOpen`, { books: open.join(", ") })
        : game.i18n.localize(`${LANG_PREFIX}.ui.reconnectNothing`),
    );
  }
  return offerReconnect(pending);
}

/**
 * Which books this seat can read, and how much of each.
 *
 * The count used to be `allRecipes()` — the handful of hand-written PoC
 * recipes — against `proseMem`, the prose extracted eagerly on connect. Both
 * predate the cookbook, so a seat holding the whole MM was told about a
 * denominator of a dozen and a numerator that starts at zero and stays there,
 * because cookbook prose is extracted lazily per reveal and never lands in
 * proseMem. The number was not wrong so much as measuring something nobody
 * asked about. What a reader wants to know is how many SHIPPED entries this
 * book's connection unlocks.
 */
async function bookStatus() {
  const records = await locations();
  const lines = [];
  for (const [id, book] of Object.entries(BOOKS)) {
    const entries = cookbookCount(id);
    const recipes = allRecipes().filter((r) => r.book === id).length;
    const scope = [entries ? `${entries} cookbook entr${entries === 1 ? "y" : "ies"}` : "", recipes ? `${recipes} recipe(s)` : ""]
      .filter(Boolean)
      .join(" + ");
    const record = records.get(id);
    // Naming the remembered location is the whole point of remembering it: a
    // reader who moved or renamed the file can see that from here.
    const where = record ? ` [${record.kind}: ${describeLocation(record)}]` : "";
    let state;
    if (sessionDocs.has(id)) state = `OPEN this session — ${scope || "nothing shipped for it yet"} readable${where}`;
    else if (record) state = `location remembered${where} — reconnect this session to read ${scope || "it"}`;
    else state = `not connected on this seat${scope ? ` — would unlock ${scope}` : ""}`;
    lines.push(`${book.label}: ${state}`);
  }
  ui.notifications.info(`acks-content | ${game.i18n.localize(`${LANG_PREFIX}.ui.statusNote`)} Console has per-book detail.`);
  console.log(`${MODULE_ID} | book status (this seat):\n${lines.join("\n")}`);
}

async function forgetBooks() {
  await locationClear().catch(() => {});
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
    // Name-first: with the wasm decoders shipped, the placed XObject itself
    // extracts cleanly (the AX books' art is JPEG2000). The placement-box
    // page-render crop stays as a fallback for a seat whose decoders fail.
    const art =
      (await extractPageArt(doc, recipe.page, recipe.name ?? null)) ??
      (recipe.box ? await extractPageArtRegion(doc, recipe.page, recipe.box) : null);
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
 * Which monsters Apply Stats should act on.
 *
 * Selected tokens, plus any monster whose SHEET is open. A monster that has
 * never been placed on a scene has no token to select, which made the whole
 * feature unreachable for it — and an imported bestiary is mostly actors
 * nobody has dragged out yet. Opening the sheet is the natural way to say
 * "this one". Deduped, because an open sheet for a selected token is one
 * monster, not two.
 */
function applyStatsTargets() {
  const fromTokens = (canvas.tokens?.controlled ?? []).map((t) => t.actor);
  const open = [...(foundry.applications?.instances?.values?.() ?? []), ...Object.values(ui.windows ?? {})];
  const fromSheets = open.map((app) => app?.document ?? app?.object).filter((d) => d instanceof Actor);
  return [...new Set([...fromTokens, ...fromSheets].filter((a) => a?.type === "monster"))];
}

/**
 * Re-read stats from the connected book for the selected/open monsters.
 *
 * Never every monster in the world: this rewrites system data, so it acts on
 * what the GM pointed at and nothing else.
 */
async function applyStats() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  const selected = applyStatsTargets();
  if (!selected.length) {
    return ui.notifications.warn(
      "acks-content | select a monster token or open its sheet first — Apply Stats targets only what you point at, never every monster.",
    );
  }
  let touched = 0;
  const closed = new Set();
  const unknown = [];
  for (const actor of selected) {
    // A cookbook-imported monster knows exactly which entry it came from, so
    // ask it rather than guessing from its name. Before this, Apply Stats
    // resolved names against allRecipes() alone — the dozen hand-written PoC
    // recipes — so it could not touch ANY of the hundreds of monsters the
    // cookbook imports, with or without a token.
    const refilled = await refillMonster(actor).catch((err) => {
      console.error(`${MODULE_ID} | refill ${actor.name}`, err);
      return { ok: false, reason: "error" };
    });
    if (refilled?.ok) {
      touched++;
      continue;
    }
    if (refilled?.reason === "book-closed") {
      closed.add(BOOKS[refilled.book]?.label ?? refilled.book);
      continue;
    }
    if (refilled) continue; // ours, but this printing did not match — already logged
    const recipe = monsterRecipeForActor(actor);
    if (!recipe) {
      unknown.push(actor.name);
      continue;
    }
    if (await fillMonster(actor, recipe)) touched++;
  }
  if (closed.size) {
    ui.notifications.warn(`acks-content | not open this session: ${[...closed].join(", ")} — connect to refill from it.`);
  }
  if (unknown.length) {
    ui.notifications.warn(
      `acks-content | not from the cookbook and no recipe matches: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` (+${unknown.length - 5})` : ""}.`,
    );
  }
  if (touched) ui.notifications.info(`acks-content | refilled ${touched} monster${touched === 1 ? "" : "s"} from your book.`);
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
  setWasmUrl(`modules/${MODULE_ID}/vendor/wasm/`);
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
  registerAbilityDirectoryButtons();
  await loadCookbook();
  const api = {
    connectBook, connectBookUrl, reconnectBooks, browseAndLoad, applyStats, bookStatus, forgetBooks,
    proseFor, cookbookImport, cookbookImportIds, cookbookImportMonsters, cookbookImportAbilities, cookbookImportAbilitiesDialog, cookbookUpdateAbilities, cookbookFillCompanions, cookbookPruneAbilities,
    importAbility, cookbookDebug, cookbookProse, cookbookCount,
    cookbookImportTables,
    cookbookImportJournals, cookbookImportRollTables, cookbookOrganize,
    importEquipment, importAllEquipment, cookbookEquipmentIds, repairEquipmentAbilities,
    RECIPES, BOOKS,
  };
  globalThis.acksContent = api;

  // Provide the ability-resolution contract (acks-lib docs/API.md): sibling
  // modules embed proficiency packages on hired actors through this, without
  // naming this module.
  if (globalThis.acksLib?.services) {
    globalThis.acksLib.services.register("ability-provider", { resolve: resolveAbilities });
  }
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
  console.log(
    `${MODULE_ID} | ready. Macros in "ACKS Content — Macros", or: acksContent.connectBook() · acksContent.cookbookImport() · acksContent.cookbookImportAbilitiesDialog() · acksContent.cookbookUpdateAbilities() · acksContent.browseAndLoad().`,
  );

  // Reopen remembered books; offer the reconnect gesture for the rest.
  const pending = await restoreBooks();
  if (pending.length) await offerReconnect(pending);
});
