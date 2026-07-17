/**
 * PoC drivers: load sample documents INTO ACTORS/ITEMS (persisting only
 * @PdfText tags — never prose), and the audit POPOUT contrasting the two
 * language options:
 *   A — persisted stub + page reference (what ships; what a bookless seat sees)
 *   B — the tag enriched live for THIS seat: with a connected book, "show
 *       book text" reproduces the passage on demand; without one, B renders
 *       exactly as A. The popout is ephemeral — nothing persists at all.
 */
import { LANG_PREFIX } from "./constants.mjs";
import { RECIPES, recipeById } from "./recipes.mjs";
import { BOOKS } from "./books.mjs";

const FOLDER_NAME = "ACKS Content PoC";
const tagFor = (recipe) => `@PdfText[${recipe.id}]{${recipe.cite}}`;
const tagP = (id) => `<p>${tagFor(recipeById(id))}</p>`;

/**
 * Where a monster's streamed description prose belongs, matching applyStats:
 * the Full Monster Sheet's visible APPEARANCE field when acks-monsters is
 * active (it enriches its description fields), else the core biography. Kept in
 * one place so a monster never ends up with the prose in BOTH fields.
 */
function monsterDescData(html) {
  return game.modules.get("acks-monsters")?.active
    ? { flags: { "acks-monsters": { extras: { description: { appearance: html } } } } }
    : { system: { details: { biography: html } } };
}

export async function ensureFolder(type) {
  return (
    game.folders.find((f) => f.type === type && f.name === FOLDER_NAME) ??
    Folder.create({ name: FOLDER_NAME, type })
  );
}

async function resetFolder(type) {
  const existing = game.folders.find((f) => f.type === type && f.name === FOLDER_NAME);
  if (existing) await existing.delete({ deleteSubfolders: true, deleteContents: true });
  return Folder.create({ name: FOLDER_NAME, type });
}

/** Create the world document for one recipe (used by dynamic browse-loads). */
export async function createDocFor(recipe) {
  const html = `<p>${tagFor(recipe)}</p>`;
  if (recipe.kind === "monster") {
    const folder = await ensureFolder("Actor");
    return Actor.create({ name: recipe.name, type: "monster", folder: folder.id, ...monsterDescData(html) });
  }
  const folder = await ensureFolder("Item");
  return Item.create({ name: recipe.name, type: recipe.kind === "ability" ? "ability" : "item", folder: folder.id, system: { description: html } });
}

export async function createSamples() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  if (game.system.id !== "acks") return ui.notifications.error("acks-content | PoC needs the acks system (actor/item types).");

  const actorFolder = await resetFolder("Actor");
  const itemFolder = await resetFolder("Item");

  // One monster — description prose streams into the sheet's description at
  // render time (FMS APPEARANCE field, or core biography without the FMS).
  await Actor.create({
    name: "Griffon (PoC)",
    type: "monster",
    folder: actorFolder.id,
    ...monsterDescData(tagP("mm.griffon")),
  });

  // One character carrying the proficiency page as ability items (+ fake-book dummy).
  const carrier = await Actor.create({ name: "Content Carrier (PoC)", type: "character", folder: actorFolder.id });
  const abilityRecipes = RECIPES.filter((r) => r.kind === "ability");
  // payload.effects = shipped mechanical interpretation (embedded math);
  // the description prose still streams per seat.
  await carrier.createEmbeddedDocuments(
    "Item",
    abilityRecipes.map((r) => ({
      name: r.name,
      type: "ability",
      system: { description: tagP(r.id) },
      effects: r.payload?.effects ?? [],
    })),
  );

  // One page of items as world items (+ fake-book dummy).
  const itemRecipes = RECIPES.filter((r) => r.kind === "item");
  await Item.createDocuments(
    itemRecipes.map((r) => ({ name: `${r.name} (PoC)`, type: "item", folder: itemFolder.id, system: { description: tagP(r.id) } })),
  );

  ui.notifications.info(
    `acks-content | PoC samples created: 2 actors (${abilityRecipes.length} embedded abilities), ${itemRecipes.length} world items — folder "${FOLDER_NAME}".`,
  );
}

/**
 * Audit popout. `allRecipes` and `stubFor` come from module.mjs so dynamic
 * browse-loaded recipes are included and stubs resolve the same way the
 * enricher resolves them.
 */
export async function audit(allRecipes, stubFor) {
  const esc = foundry.utils.escapeHTML ?? ((s) => s);
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;

  const rows = [];
  for (const r of allRecipes) {
    const fake = BOOKS[r.book]?.fake;
    const enriched = await TE.enrichHTML(tagFor(r));
    rows.push(`<tr class="${fake ? "acks-content-fake" : ""}">
      <td><strong>${esc(r.name)}</strong><br><span class="acks-content-cite">${esc(r.cite)}${fake ? " — fake book" : ""}${r.dynamic ? " — browse-loaded" : ""}</span></td>
      <td>${esc(stubFor(r))}</td>
      <td>${enriched}</td>
    </tr>`);
  }

  const content = `<div class="acks-content-audit">
    <p>${game.i18n.localize(`${LANG_PREFIX}.ui.auditIntro`)}</p>
    <table>
      <tr><th></th><th>A — stub + reference (persisted)</th><th>B — this seat, reproduced on demand</th></tr>
      ${rows.join("")}
    </table>
  </div>`;

  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize(`${LANG_PREFIX}.ui.auditTitle`), resizable: true },
    position: { width: 880, height: 640 },
    content,
    ok: { label: game.i18n.localize(`${LANG_PREFIX}.ui.close`) },
  });
}
