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
      "ackscMacAudit000",
      "PoC 3 — Audit: the two language options",
      "icons/svg/eye.svg",
      GUARD + `api.audit();`,
    ),
    macro(
      "ackscMacStatus00",
      "PoC — Cache Status (this seat)",
      "icons/svg/chest.svg",
      GUARD +
        `const cache = game.settings.get("acks-content", "contentCache");
const lines = Object.entries(api.BOOKS).map(([id, book]) => {
  const have = Object.keys(cache?.[id]?.entries ?? {}).length;
  const want = api.RECIPES.filter((r) => r.book === id).length;
  return \`\${book.label}: \${have}/\${want}\${book.fake ? " (fake — always 0)" : ""}\`;
});
ui.notifications.info(\`acks-content cache — \${lines.join(" · ")}\`);
console.log("acks-content cache status:\\n" + lines.join("\\n"));`,
    ),
    macro(
      "ackscMacClear000",
      "PoC — Clear This Seat's Cache",
      "icons/svg/blind.svg",
      GUARD + `api.clearCache();`,
    ),
  ];
}

export const packs = {
  macros: buildMacros,
};
