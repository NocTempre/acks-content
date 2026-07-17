/**
 * Module-owned compendium document content, consumed by the synced
 * tools/build-packs.mjs harness.
 *
 * One pack: PoC testing macros wrapping the acksContent api, so testers click
 * instead of typing console calls. Ids carry the declared "acksc" prefix and
 * are exactly 16 alphanumerics; _stats timestamps are FIXED so rebuilds are
 * byte-identical (no pack churn).
 */

// Fixed epoch: 2026-07-17T00:00:00Z. Never change casually — churns packs.
const STATS = { coreVersion: "14", createdTime: 1784332800000, modifiedTime: 1784332800000 };

const GUARD = `const api = globalThis.acksContent;
if (!api) return ui.notifications.warn("acks-content | module not ready (is it enabled?).");
`;

function macro(id, name, img, command) {
  return {
    _id: id,
    _key: `!macros!${id}`,
    name,
    type: "script",
    img,
    scope: "global",
    command,
    folder: null,
    sort: 0,
    ownership: { default: 2 },
    flags: {},
    _stats: { ...STATS },
  };
}

function buildMacros() {
  return [
    macro(
      "ackscMacSamples0",
      "PoC 1 — Create Sample Actors & Items",
      "icons/svg/mystery-man.svg",
      GUARD + `api.createSamples();`,
    ),
    macro(
      "ackscMacConnect0",
      "PoC 2 — Connect Your Book (this seat)",
      "icons/svg/book.svg",
      GUARD + `api.connectBook();`,
    ),
    macro(
      "ackscMacBrowse00",
      "PoC 3 — Browse & Load a Page (GM)",
      "icons/svg/direction.svg",
      GUARD + `api.browseAndLoad();`,
    ),
    macro(
      "ackscMacAudit000",
      "PoC 4 — Audit: the two language options",
      "icons/svg/eye.svg",
      GUARD + `api.audit();`,
    ),
    macro(
      "ackscMacStats000",
      "PoC 5 — Apply Stats from Book (GM)",
      "icons/svg/combat.svg",
      GUARD + `api.applyStats();`,
    ),
    macro(
      "ackscMacCookbook",
      "Cookbook — Import Monsters (GM)",
      "icons/svg/book.svg",
      GUARD + `api.cookbookImport();`,
    ),
    macro(
      "ackscMacCkDebug0",
      "Cookbook — Debug Raw Extraction (GM)",
      "icons/svg/eye.svg",
      GUARD + `api.cookbookDebug();`,
    ),
    macro(
      "ackscMacStatus00",
      "PoC — Book Status (this seat)",
      "icons/svg/chest.svg",
      GUARD + `api.bookStatus();`,
    ),
    macro(
      "ackscMacClear000",
      "PoC — Forget Books (this seat)",
      "icons/svg/blind.svg",
      GUARD + `api.forgetBooks();`,
    ),
  ];
}

export const packs = {
  macros: buildMacros,
};
