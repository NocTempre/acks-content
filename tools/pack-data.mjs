/**
 * Module-owned compendium document content, consumed by the synced
 * tools/build-packs.mjs harness.
 *
 * One pack: macros wrapping the acksContent api, so a GM clicks instead of
 * typing console calls. Ids carry the declared "acksc" prefix and are exactly
 * 16 alphanumerics; _stats timestamps are FIXED so rebuilds are byte-identical
 * (no pack churn).
 *
 * `_id` IS IDENTITY — never change one. A new id on an existing macro gives
 * every world that already imported the pack a duplicate. Rename freely; the id
 * stays. `sort` groups them: 100s set this seat up, 200s import from the
 * cookbook, 300s are tools, 400s demonstrate the language model.
 */

// Fixed epoch: 2026-07-17T00:00:00Z. Never change casually — churns packs.
const STATS = { coreVersion: "14", createdTime: 1784332800000, modifiedTime: 1784332800000 };

const GUARD = `const api = globalThis.acksContent;
if (!api) return ui.notifications.warn("acks-content | module not ready (is it enabled?).");
`;

function macro(id, name, img, command, sort = 0) {
  return {
    _id: id,
    _key: `!macros!${id}`,
    name,
    type: "script",
    img,
    scope: "global",
    command,
    folder: null,
    sort,
    ownership: { default: 2 },
    flags: {},
    _stats: { ...STATS },
  };
}

function buildMacros() {
  return [
    /* --- 100s: set this seat up. What a new user does first. --- */
    macro("ackscMacConnect0", "Connect Your Book (this seat)", "icons/svg/book.svg", GUARD + `api.connectBook();`, 100),
    macro("ackscMacStatus00", "Book Status (this seat)", "icons/svg/chest.svg", GUARD + `api.bookStatus();`, 110),
    macro("ackscMacClear000", "Forget Books (this seat)", "icons/svg/blind.svg", GUARD + `api.forgetBooks();`, 120),

    /* --- 200s: import from the cookbook. --- */
    macro(
      "ackscMacTables00",
      "Cookbook — Import Rules Tables (GM)",
      "icons/svg/coins.svg",
      GUARD +
        `if (!api.cookbookImportTables) return ui.notifications.warn("acks-content | table import needs a newer module build.");
api.cookbookImportTables();`,
      190,
    ),
    macro("ackscMacCookbook", "Cookbook — Import Monsters (GM)", "icons/svg/mystery-man.svg", GUARD + `api.cookbookImport();`, 200),
    macro(
      "ackscMacMonsAll0",
      "Cookbook — Import ALL Monsters (GM)",
      "icons/svg/aura.svg",
      GUARD + `api.cookbookImportMonsters();`,
      205,
    ),
    macro(
      "ackscMacAbilBrw0",
      "Cookbook — Browse & Import Abilities (GM)",
      "icons/svg/book.svg",
      GUARD + `api.cookbookImportAbilitiesDialog();`,
      210,
    ),
    macro(
      "ackscMacAbilAll0",
      "Cookbook — Import ALL Abilities (GM)",
      "icons/svg/upgrade.svg",
      GUARD + `api.cookbookImportAbilities();`,
      220,
    ),
    macro(
      "ackscMacAbilUpd0",
      "Cookbook — Update Abilities in World (GM)",
      "icons/svg/regen.svg",
      GUARD + `api.cookbookUpdateAbilities();`,
      230,
    ),
    macro(
      "ackscMacAbilCmp0",
      "Cookbook — Fill Companion Slots (GM)",
      "icons/svg/pawprint.svg",
      GUARD + `api.cookbookFillCompanions();`,
      240,
    ),
    macro(
      "ackscMacTblDocs0",
      "Cookbook — Create Foundry Tables from Import (GM)",
      "icons/svg/d20-grey.svg",
      `const svc = globalThis.acksLib?.services?.get?.("ruledata-import");
if (!svc?.materializeDocs) return ui.notifications.warn("acks-content | the ruledata provider does not offer materializeDocs — update acks-location.");
const r = await svc.materializeDocs();
ui.notifications.info(\`acks-content | \${r.exported} table(s) written as Foundry documents, \${r.placeholders} placeholder(s) for expected-but-missing tables.\`);`,
      250,
    ),

    /* --- 300s: tools. --- */
    macro("ackscMacBrowse00", "Browse & Load a Page (GM)", "icons/svg/direction.svg", GUARD + `api.browseAndLoad();`, 300),
    macro("ackscMacStats000", "Apply Stats from Book (GM)", "icons/svg/combat.svg", GUARD + `api.applyStats();`, 310),
    macro("ackscMacCkDebug0", "Cookbook — Debug Raw Extraction (GM)", "icons/svg/eye.svg", GUARD + `api.cookbookDebug();`, 320),

  ];
}

export const packs = {
  macros: buildMacros,
};
