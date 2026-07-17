/**
 * PoC drivers: load sample documents INTO ACTORS/ITEMS (persisting only
 * @PdfText tags — never prose), and the audit chat card contrasting the two
 * language options:
 *   A — persisted stub + page reference (what ships; what a bookless seat sees)
 *   B — the tag, enriched per viewing client: with a connected book, "show
 *       book text" reproduces the passage on demand; without one, B renders
 *       exactly as A. The message persists tags only.
 */
import { MODULE_ID, LANG_PREFIX } from "./constants.mjs";
import { RECIPES, recipeById } from "./recipes.mjs";
import { BOOKS } from "./books.mjs";

const FOLDER_NAME = "ACKS Content PoC";
const tagP = (id) => `<p>@PdfText[${id}]{${recipeById(id).cite}}</p>`;

async function resetFolder(type) {
  const existing = game.folders.find((f) => f.type === type && f.name === FOLDER_NAME);
  if (existing) await existing.delete({ deleteSubfolders: true, deleteContents: true });
  return Folder.create({ name: FOLDER_NAME, type });
}

export async function createSamples() {
  if (!game.user.isGM) return ui.notifications.warn("acks-content | GM only.");
  if (game.system.id !== "acks") return ui.notifications.error("acks-content | PoC needs the acks system (actor/item types).");

  const actorFolder = await resetFolder("Actor");
  const itemFolder = await resetFolder("Item");

  // One monster — description prose streams into the biography at render time.
  await Actor.create({
    name: "Griffon (PoC)",
    type: "monster",
    folder: actorFolder.id,
    system: { details: { biography: tagP("mm.griffon") } },
  });

  // One character carrying the proficiency page as ability items (+ fake-book dummy).
  const carrier = await Actor.create({ name: "Content Carrier (PoC)", type: "character", folder: actorFolder.id });
  const abilityRecipes = RECIPES.filter((r) => r.kind === "ability");
  await carrier.createEmbeddedDocuments(
    "Item",
    abilityRecipes.map((r) => ({ name: r.name, type: "ability", system: { description: tagP(r.id) } })),
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

export async function audit() {
  const esc = foundry.utils.escapeHTML ?? ((s) => s);
  const rows = RECIPES.map((r) => {
    const stub = game.i18n.localize(`${LANG_PREFIX}.pdftext.${r.id}`);
    const fake = BOOKS[r.book]?.fake;
    return `<tr class="${fake ? "acks-content-fake" : ""}">
      <td><strong>${esc(r.name)}</strong><br><span class="acks-content-cite">${esc(r.cite)}${fake ? " — fake book" : ""}</span></td>
      <td>${esc(stub)}</td>
      <td>@PdfText[${r.id}]{${esc(r.cite)}}</td>
    </tr>`;
  }).join("");

  const content = `<div class="acks-content-audit">
    <h3>${game.i18n.localize(`${LANG_PREFIX}.ui.auditTitle`)}</h3>
    <p>${game.i18n.localize(`${LANG_PREFIX}.ui.auditIntro`)}</p>
    <table>
      <tr><th></th><th>A — stub + reference (persisted)</th><th>B — reproduced on demand (per seat)</th></tr>
      ${rows}
    </table>
  </div>`;

  return ChatMessage.create({ content, whisper: [game.user.id] });
}
