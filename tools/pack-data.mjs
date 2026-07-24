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

/**
 * Compendium folders. Same identity rule as macros: `_id` is forever (a new id
 * re-imports as a second folder), and it carries the "acksc" prefix the
 * namespacing gate enforces on every pack document.
 */
function folder(id, name, sort) {
  return {
    _id: id,
    _key: `!folders!${id}`,
    name,
    type: "Macro",
    folder: null,
    sorting: "m",
    sort,
    description: "",
    ownership: { default: 0 },
    flags: {},
    _stats: { ...STATS },
  };
}

const FOLDERS = {
  setup: "ackscFldSetup000",
  import: "ackscFldImport00",
  abilities: "ackscFldAbils000",
  tools: "ackscFldTools000",
};

function macro(id, name, img, command, sort = 0, folderId = null) {
  return {
    _id: id,
    _key: `!macros!${id}`,
    name,
    type: "script",
    img,
    scope: "global",
    command,
    folder: folderId,
    sort,
    ownership: { default: 2 },
    flags: {},
    _stats: { ...STATS },
  };
}

function buildMacros() {
  return [
    /* Folders group the macros into the order a GM actually uses them. Folder
       ids are identity too — renaming a folder is free, re-issuing its id is
       not (every world that imported the pack would gain a second one). */
    folder(FOLDERS.setup, "1 \u00b7 Your Book", 100),
    folder(FOLDERS.import, "2 \u00b7 Import Content", 200),
    folder(FOLDERS.abilities, "3 \u00b7 Abilities & Equipment", 300),
    folder(FOLDERS.tools, "4 \u00b7 Tools & Maintenance", 400),

    /* --- 1 · Your Book: what a new seat does first. --- */
    macro("ackscMacConnect0", "Connect Your Book (this seat)", "icons/svg/book.svg", GUARD + `api.connectBook();`, 100, FOLDERS.setup),
    macro(
      "ackscMacReconn00",
      "Reconnect Remembered Books (this seat)",
      "icons/svg/paralysis.svg",
      GUARD +
        `if (!api.reconnectBooks) return ui.notifications.warn("acks-content | reconnecting needs a newer module build.");
api.reconnectBooks();`,
      105,
      FOLDERS.setup,
    ),
    macro("ackscMacStatus00", "Book Status (this seat)", "icons/svg/chest.svg", GUARD + `api.bookStatus();`, 110, FOLDERS.setup),
    macro("ackscMacClear000", "Forget Books (this seat)", "icons/svg/blind.svg", GUARD + `api.forgetBooks();`, 120, FOLDERS.setup),

    /* --- 2 · Import Content: cookbook -> world documents. --- */
    macro(
      "ackscMacCookbook",
      "Import Monsters & NPCs \u2014 choose from a list (GM)",
      "icons/svg/mystery-man.svg",
      GUARD + `api.cookbookImport();`,
      200,
      FOLDERS.import,
    ),
    macro(
      "ackscMacMonsAll0",
      "Import ALL Monsters & NPCs (GM)",
      "icons/svg/aura.svg",
      GUARD + `api.cookbookImportMonsters();`,
      210,
      FOLDERS.import,
    ),
    macro(
      "ackscMacAdvJourn",
      "Import Location Journals (GM)",
      "icons/svg/book.svg",
      GUARD +
        `if (!api.cookbookImportJournals) return ui.notifications.warn("acks-content | location journals need a newer module build.");
api.cookbookImportJournals();`,
      220,
      FOLDERS.import,
    ),
    macro(
      "ackscMacAdvTable",
      "Import Adventure Roll Tables (GM)",
      "icons/svg/d20-grey.svg",
      GUARD +
        `if (!api.cookbookImportRollTables) return ui.notifications.warn("acks-content | adventure roll tables need a newer module build.");
api.cookbookImportRollTables();`,
      230,
      FOLDERS.import,
    ),
    macro(
      "ackscMacTables00",
      "Import Rules Tables (GM)",
      "icons/svg/coins.svg",
      GUARD +
        `if (!api.cookbookImportTables) return ui.notifications.warn("acks-content | table import needs a newer module build.");
api.cookbookImportTables();`,
      240,
      FOLDERS.import,
    ),
    macro(
      "ackscMacTblDocs0",
      "Create Foundry Tables from Rules Import (GM)",
      "icons/svg/d20-grey.svg",
      `const svc = globalThis.acksLib?.services?.get?.("ruledata-import");
if (!svc?.materializeDocs) return ui.notifications.warn("acks-content | the ruledata provider does not offer materializeDocs \u2014 update acks-location.");
const r = await svc.materializeDocs();
ui.notifications.info(\`acks-content | \${r.exported} table(s) written as Foundry documents, \${r.placeholders} placeholder(s) for expected-but-missing tables.\`);`,
      250,
      FOLDERS.import,
    ),

    /* --- 3 · Abilities & Equipment: the shared item library. --- */
    macro(
      "ackscMacAbilBrw0",
      "Browse & Import Abilities (GM)",
      "icons/svg/book.svg",
      GUARD + `api.cookbookImportAbilitiesDialog();`,
      300,
      FOLDERS.abilities,
    ),
    macro(
      "ackscMacAbilAll0",
      "Import ALL Abilities (GM)",
      "icons/svg/upgrade.svg",
      GUARD + `api.cookbookImportAbilities();`,
      310,
      FOLDERS.abilities,
    ),
    macro(
      "ackscMacEquipAll",
      "Import ALL Equipment (GM)",
      "icons/svg/item-bag.svg",
      GUARD +
        `if (!api.importAllEquipment) return ui.notifications.warn("acks-content | equipment import needs a newer module build.");
const r = await api.importAllEquipment();
ui.notifications.info(\`acks-content | equipment: \${r.created} created, \${r.total} in the cookbook.\`);`,
      320,
      FOLDERS.abilities,
    ),
    macro(
      "ackscMacAbilUpd0",
      "Update Abilities in World (GM)",
      "icons/svg/regen.svg",
      GUARD + `api.cookbookUpdateAbilities();`,
      330,
      FOLDERS.abilities,
    ),
    macro(
      "ackscMacAbilCmp0",
      "Fill Companion Slots (GM)",
      "icons/svg/pawprint.svg",
      GUARD + `api.cookbookFillCompanions();`,
      340,
      FOLDERS.abilities,
    ),

    /* --- 4 · Tools & Maintenance. --- */
    macro(
      "ackscMacOrganize",
      "Organize Cookbook Documents (GM)",
      "icons/svg/sort.svg",
      GUARD +
        `if (!api.cookbookOrganize) return ui.notifications.warn("acks-content | organizing needs a newer module build.");
api.cookbookOrganize();`,
      400,
      FOLDERS.tools,
    ),
    macro("ackscMacBrowse00", "Browse & Load a Page (GM)", "icons/svg/direction.svg", GUARD + `api.browseAndLoad();`, 410, FOLDERS.tools),
    macro("ackscMacStats000", "Apply Stats from Book (GM)", "icons/svg/combat.svg", GUARD + `api.applyStats();`, 420, FOLDERS.tools),
    macro("ackscMacCkDebug0", "Debug Raw Extraction (GM)", "icons/svg/eye.svg", GUARD + `api.cookbookDebug();`, 430, FOLDERS.tools),
  ];
}

export const packs = {
  macros: buildMacros,
};
