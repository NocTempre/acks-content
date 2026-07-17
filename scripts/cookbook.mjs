/**
 * Cookbook runtime — the Foundry side of docs/BINDING-FOUNDRY.md.
 *
 * Loads the shipped cookbook database (cookbook/registers.json +
 * cookbook/<book>.json), executes entries through the DUMB executor against
 * the seat's own connected book, and binds executor output to acks documents:
 *   - GM import dialog: pick monsters -> Actors (stats, weapons with
 *     damage type + extraordinary-from-printed-color, abilities, spoils, art);
 *   - lazy prose: imported actors carry only @PdfText[id] tags; the entry's
 *     description is executed on demand per seat and kept in session memory.
 *
 * The cookbook is read-only data; all judgment happened in the offline
 * pipeline. This file only maps executor output onto acks system fields.
 */
import { MODULE_ID, LANG_PREFIX } from "./constants.mjs";
import { BOOKS } from "./books.mjs";
import { executeEntry } from "./executor.mjs";
import { savesForLevel } from "./stats.mjs";

const FOLDER_NAME = "ACKS Cookbook";

/** Shipped data, fetched once at ready: { registers, books: {bookId: cookbook} } */
const data = { registers: null, books: new Map() };
/** Injected module state (session docs + prose memory) — set by initCookbook. */
let ctx = null;

export function initCookbook(moduleCtx) {
  ctx = moduleCtx;
}

export async function loadCookbook() {
  const base = `modules/${MODULE_ID}/cookbook`;
  try {
    data.registers = await foundry.utils.fetchJsonWithTimeout(`${base}/registers.json`);
  } catch {
    console.log(`${MODULE_ID} | no cookbook shipped (registers.json missing) — cookbook features disabled.`);
    return false;
  }
  for (const bookId of Object.keys(BOOKS)) {
    try {
      const cb = await foundry.utils.fetchJsonWithTimeout(`${base}/${bookId}.json`);
      if (cb?.entries) data.books.set(bookId, cb);
    } catch {
      /* book without a cookbook yet */
    }
  }
  const n = [...data.books.values()].reduce((s, cb) => s + Object.keys(cb.entries).length, 0);
  console.log(`${MODULE_ID} | cookbook loaded: ${n} entr(ies) across ${data.books.size} book(s).`);
  return n > 0;
}

export const cookbookEntry = (id) => {
  for (const cb of data.books.values()) if (cb.entries[id]) return { cb, entry: cb.entries[id] };
  return null;
};
export const cookbookCount = (bookId) => Object.keys(data.books.get(bookId)?.entries ?? {}).length;

/* -------------------------------------------- */
/*  Lazy prose (session memory, per seat)       */
/* -------------------------------------------- */

/** Stub line for a cookbook id: name + citation (no book needed). */
export function cookbookStub(id) {
  const found = cookbookEntry(id);
  if (!found) return null;
  return game.i18n.format(`${LANG_PREFIX}.ui.cookbookStub`, { name: found.entry.name, cite: found.entry.cite });
}

/** Whether this seat could reveal prose for the id right now. */
export function cookbookCanReveal(id) {
  const found = cookbookEntry(id);
  return !!found && ctx.sessionDocs.has(found.cb.book.id);
}

/** Execute the entry's description on demand; cache in session memory only. */
export async function cookbookProse(id) {
  const found = cookbookEntry(id);
  if (!found) return null;
  const bookId = found.cb.book.id;
  const mem = ctx.proseMem.get(bookId) ?? {};
  if (mem[id]) return mem[id];
  const session = ctx.sessionDocs.get(bookId);
  if (!session) return null;
  const res = await executeEntry(session.doc, found.cb, data.registers, id);
  const prose = (res.fields.description ?? []).map((p) => p.text).join("\n\n");
  if (!prose) return null;
  mem[id] = prose;
  ctx.proseMem.set(bookId, mem);
  return prose;
}

/* -------------------------------------------- */
/*  Binding: executor output -> acks Actor      */
/* -------------------------------------------- */

const firstInt = (v) => {
  const m = /(-?[\d,]+)/.exec(String(v ?? ""));
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
};
const diceOf = (v) => /\d+d\d+(?:[+-]\d+)?/.exec(String(v ?? ""))?.[0] ?? "";
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Map one executed node to acks actor data + embedded items. */
export function bindMonster(node) {
  const f = node.fields;
  const s = f.stats ?? {};
  const system = {};

  if (Number.isInteger(s.armorClass)) system.aac = { value: s.armorClass };

  const hdm = /^(\d+)(?:\s*([+-])\s*(\d+))?/.exec(String(s.hitDice ?? "").trim());
  if (hdm) {
    const count = parseInt(hdm[1], 10);
    const bonus = hdm[2] ? (hdm[2] === "-" ? -1 : 1) * parseInt(hdm[3], 10) : 0;
    const avg = Math.max(1, Math.floor(count * 4.5 + bonus));
    system.hp = { hd: `${count}d8${bonus ? (bonus > 0 ? `+${bonus}` : bonus) : ""}`, value: avg, max: avg };
  }

  const sv = /^([A-Z]+)\s*(\d+)?/.exec(String(s.save ?? "").trim());
  if (sv) {
    const level = sv[1] === "NH" ? 0 : parseInt(sv[2] ?? "0", 10) || 0;
    const row = savesForLevel(level);
    system.saves = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { value: v }]));
    system.saves.breath = { value: row.blast };
    system.saves.wand = { value: row.implements };
  }

  system.details = {
    ...(s.morale != null ? { morale: s.morale } : {}),
    ...(s.xp != null ? { xp: s.xp } : {}),
    ...(s.alignment ? { alignment: capitalize(s.alignment.key ?? s.alignment.text ?? "") } : {}),
    ...(s.treasureType ? { treasure: { type: /^none/i.test(s.treasureType) ? "None" : s.treasureType } } : {}),
  };
  if (s.dungeonEnc || s.wildernessEnc) {
    system.details.appearing = { d: diceOf(s.dungeonEnc), w: diceOf(s.wildernessEnc) };
  }

  const speed = String(s.speedLand ?? "");
  const nums = [...speed.matchAll(/(\d+)/g)].map((m) => parseInt(m[1], 10));
  if (nums.length) system.movement = { base: nums[nums.length - 1] };

  const atk = f.attacks;
  if (atk) {
    if (atk.throw != null) system.thac0 = { throw: atk.throw };
    if (atk.text) system.attacks = atk.text;
  }

  const items = [];
  for (const seg of atk?.segments ?? []) {
    items.push({
      name: seg.name ?? "Attack",
      type: "weapon",
      img: "icons/svg/sword.svg",
      flags: {
        "acks-monsters": {
          ...(seg.naturalWeapon ? { naturalWeapon: seg.naturalWeapon } : {}),
          ...(seg.damageType?.key ? { damageType: seg.damageType.key } : {}),
          extraordinary: seg.quality === "extraordinary",
        },
      },
      system: {
        description: "", damage: seg.damage, bonus: 0, melee: true, missile: false, equipped: true,
        pattern: "transparent", tags: [], counter: { value: 1, max: 1 }, cost: 0, weight: 0, weight6: 0,
      },
    });
  }
  for (const prof of f.stats?.proficiencies ?? []) {
    if (!prof.text || /^none/i.test(prof.text)) continue;
    items.push({
      name: prof.text,
      type: "ability",
      img: "icons/svg/book.svg",
      system: {
        description: "", proficiencytype: "general", favorite: false, pattern: "white",
        requirements: "", roll: "", rollType: "above", rollTarget: 0, blindroll: false, save: "",
      },
    });
  }
  for (const sp of f.spoils ?? []) {
    items.push({
      name: capitalize(sp.name),
      type: "item",
      img: "icons/svg/item-bag.svg",
      system: { description: "", subtype: "item", quantity: { value: 1, max: 0 }, cost: sp.cost, weight: 0, weight6: sp.weight6 },
      flags: { "acks-monsters": { spoil: true, component: true, researchEffects: sp.effects.map((e) => e.text) } },
    });
  }

  return { system, items };
}

/* -------------------------------------------- */
/*  GM import dialog                            */
/* -------------------------------------------- */

async function ensureFolder() {
  return (
    game.folders.find((fo) => fo.type === "Actor" && fo.name === FOLDER_NAME) ??
    Folder.create({ name: FOLDER_NAME, type: "Actor" })
  );
}

async function importOne(bookId, id, folderId) {
  const found = cookbookEntry(id);
  const session = ctx.sessionDocs.get(bookId);
  const node = await executeEntry(session.doc, found.cb, data.registers, id);
  if (!node.ok) {
    ui.notifications.warn(`acks-content | ${found.entry.name}: page did not match the cookbook (different printing?) — skipped.`);
    return null;
  }
  const { system, items } = bindMonster(node);

  // Prose stays lazy: the actor carries only the tag; description reproduces
  // per seat. Cache this GM's extraction in session memory for instant reveal.
  const mem = ctx.proseMem.get(bookId) ?? {};
  const paras = (node.fields.description ?? []).map((p) => p.text).join("\n\n");
  if (paras) {
    mem[id] = paras;
    ctx.proseMem.set(bookId, mem);
  }
  const tag = `<p>@PdfText[${id}]{${found.entry.cite}}</p>`;
  const fmsActive = game.modules.get("acks-monsters")?.active;
  if (!fmsActive) system.details = { ...(system.details ?? {}), biography: tag };

  const actor = await Actor.create({ name: found.entry.name, type: "monster", folder: folderId, system });
  if (fmsActive) await actor.update({ "flags.acks-monsters.extras": { description: { appearance: tag } } });
  if (items.length) {
    await actor.createEmbeddedDocuments(
      "Item",
      items.map((i) => ({ ...i, flags: { ...(i.flags ?? {}), [MODULE_ID]: { generated: true } } })),
    );
  }
  await actor.setFlag(MODULE_ID, "cookbook", { id, cite: found.entry.cite });
  if (node.fields.art && ctx.importArtForPage) {
    await ctx.importArtForPage(actor, session.doc, { id, page: found.entry.pages[0] });
  }
  return actor;
}

/* -------------------------------------------- */
/*  Debug window: raw executor output           */
/* -------------------------------------------- */

/**
 * GM inspection popout: execute one cookbook entry against the connected book
 * and show the RAW extract JSON next to nothing — exactly what the binder
 * receives. Ephemeral (session memory only), so binder errors can be traced to
 * either the extraction (wrong here) or the binding (right here, wrong on the
 * actor).
 */
export async function cookbookDebug(entryId) {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  const esc = foundry.utils.escapeHTML ?? ((x) => x);

  if (!entryId) {
    const openBooks = [...data.books.keys()].filter((b) => ctx.sessionDocs.has(b));
    if (!openBooks.length) return ui.notifications.warn("acks-content | connect a cookbook book first (PoC 2 / unlock).");
    const cb = data.books.get(openBooks[0]);
    const rows = Object.entries(cb.entries)
      .sort((a, b) => a[1].pages[0] - b[1].pages[0])
      .map(([id, e]) => `<option value="${esc(id)}">${esc(e.name)} — ${esc(e.cite)}</option>`)
      .join("");
    return foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.debugTitle`) },
      content: `<div class="form-group"><label>${game.i18n.localize(`${LANG_PREFIX}.ui.debugPick`)}</label>
        <select name="entry">${rows}</select></div>`,
      ok: {
        label: game.i18n.localize(`${LANG_PREFIX}.ui.debugGo`),
        callback: (event, button) => cookbookDebug(button.form.elements.entry.value),
      },
    });
  }

  const found = cookbookEntry(entryId);
  if (!found) return ui.notifications.warn(`acks-content | unknown cookbook id "${entryId}".`);
  const session = ctx.sessionDocs.get(found.cb.book.id);
  if (!session) return ui.notifications.warn(`acks-content | ${found.cb.book.label} is not open this session.`);

  const node = await executeEntry(session.doc, found.cb, data.registers, entryId);
  const f = node.fields;
  const pre = (v) => `<pre class="acks-content-debug-pre">${esc(JSON.stringify(v, null, 1) ?? "null")}</pre>`;
  const statRows = Object.entries(f.stats ?? {})
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(JSON.stringify(v))}</code></td></tr>`)
    .join("");
  const paras = (f.description ?? [])
    .map((p, i) => `<p class="acks-content-debug-para"><b>[${i}]</b> ${esc(p.text)}</p>`)
    .join("");
  const content = `<div class="acks-content-debug" style="max-height:70vh;overflow-y:auto;">
    <p><b>${esc(node.name)}</b> — ${esc(node.cite)} · pages ${esc(JSON.stringify(found.entry.pages))} · ok=${node.ok}</p>
    <details open><summary>expect</summary>${pre(f.name)}</details>
    <details open><summary>stats (${Object.keys(f.stats ?? {}).length})</summary>
      <table class="acks-content-debug-table">${statRows}</table></details>
    <details open><summary>attacks</summary>${pre(f.attacks ?? null)}</details>
    <details open><summary>spoils</summary>${pre(f.spoils ?? null)}</details>
    <details><summary>art</summary>${pre(f.art ?? null)}</details>
    <details><summary>description (${(f.description ?? []).length} paras — this seat's book, session only)</summary>${paras}</details>
    <details><summary>misses (${node.misses.length})</summary>${pre(node.misses)}</details>
  </div>`;
  return foundry.applications.api.DialogV2.prompt({
    window: { title: `${game.i18n.localize(`${LANG_PREFIX}.ui.debugTitle`)} — ${node.name}`, resizable: true },
    position: { width: 640, height: 720 },
    content,
    ok: { label: game.i18n.localize(`${LANG_PREFIX}.ui.close`) },
  });
}

export async function cookbookImport() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only (creates actors).");
  const openBooks = [...data.books.keys()].filter((b) => ctx.sessionDocs.has(b));
  if (!openBooks.length) {
    return ui.notifications.warn(
      `acks-content | no cookbook book is open this session — connect one first (PoC 2 / unlock dialog).`,
    );
  }
  const bookId = openBooks[0]; // one cookbook book so far (MM)
  const cb = data.books.get(bookId);
  const esc = foundry.utils.escapeHTML ?? ((x) => x);
  const rows = Object.entries(cb.entries)
    .sort((a, b) => a[1].pages[0] - b[1].pages[0])
    .map(
      ([id, e]) => `<label class="acks-content-browse-row" data-name="${esc(e.name.toLowerCase())}">
        <input type="checkbox" name="sel" value="${esc(id)}">
        <span>${esc(e.name)}</span><span class="acks-content-cite">${esc(e.cite)}</span>
      </label>`,
    )
    .join("");
  const content = `
    <p class="notes">${game.i18n.format(`${LANG_PREFIX}.ui.cookbookIntro`, { n: Object.keys(cb.entries).length, book: BOOKS[bookId].label })}</p>
    <input type="text" name="filter" placeholder="${game.i18n.localize(`${LANG_PREFIX}.ui.cookbookFilter`)}"
      oninput="const q=this.value.toLowerCase();for(const r of this.parentElement.querySelectorAll('.acks-content-browse-row'))r.style.display=r.dataset.name.includes(q)?'':'none';">
    <div class="acks-content-browse-list" style="max-height:360px;overflow-y:auto;">${rows}</div>`;

  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.cookbookTitle`), resizable: true },
    position: { width: 520 },
    content,
    ok: {
      label: game.i18n.localize(`${LANG_PREFIX}.ui.cookbookGo`),
      callback: async (event, button) => {
        const picked = [...button.form.querySelectorAll('input[name="sel"]:checked')].map((el) => el.value);
        if (!picked.length) return ui.notifications.warn("acks-content | nothing selected.");
        const folder = await ensureFolder();
        let done = 0;
        for (const id of picked) {
          if (await importOne(bookId, id, folder.id).catch((err) => (console.error(`${MODULE_ID} | import ${id}`, err), null))) done++;
        }
        ui.notifications.info(
          game.i18n.format(`${LANG_PREFIX}.ui.cookbookDone`, { done, picked: picked.length, folder: FOLDER_NAME }),
        );
      },
    },
  });
}
