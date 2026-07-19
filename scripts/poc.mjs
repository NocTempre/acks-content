/**
 * World-document creation for browse-loaded recipes.
 *
 * Persists only @PdfText tags, never prose: the tag resolves per seat at
 * render time from that seat's own extraction.
 *
 * This file was the PoC driver — a fixed sample set and an audit popout
 * contrasting the two language options. Both were demonstrations of a
 * question the cookbook has since answered in production, and were removed
 * 2026-07-19 along with the fake book they leaned on.
 */
const FOLDER_NAME = "ACKS Content PoC";
const tagFor = (recipe) => `@PdfText[${recipe.id}]{${recipe.cite}}`;

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

