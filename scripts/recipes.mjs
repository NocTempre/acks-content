/**
 * PoC recipe set: WHERE prose lives, never the prose itself. Each recipe is a
 * pointer (book, 1-based PDF page, heading anchor) plus how the heading is
 * typeset:
 *   mode "display" — large display heading (TrajanPro, >=12pt): proficiencies,
 *                    monster entries.
 *   mode "runin"   — 9pt bold run-in entry ("Grappling Hook:"); the extractor
 *                    self-calibrates the bold font from the matched heading,
 *                    so no font names are hardcoded.
 *
 * The i18n stub for recipe `id` lives at "ACKS-CONTENT.pdftext.<id>" and is
 * what any seat without the connected book sees (sparse text + citation).
 */

export const RECIPES = [
  // One monster (Monstrous Manual)
  { id: "mm.griffon", book: "mm", page: 171, mode: "display", heading: "GRIFFON", cite: "MM PDF p. 171", kind: "monster", name: "Griffon" },

  // One page of proficiencies (Revised Rulebook, PDF p. 110)
  // payload = the modules' MECHANICAL interpretation (embedded math — ships;
  // it is not in the book and cannot be extracted). Demo: +1 initiative.
  {
    id: "prof.combatReflexes", book: "rr", page: 110, mode: "display", heading: "Combat Reflexes",
    cite: "RR PDF p. 110", kind: "ability", name: "Combat Reflexes",
    payload: {
      effects: [
        {
          name: "Combat Reflexes",
          img: "icons/svg/aura.svg",
          transfer: true,
          disabled: false,
          changes: [{ key: "system.initiative.mod", mode: 2, value: "1", priority: 20 }],
        },
      ],
    },
  },
  { id: "prof.blindFighting", book: "rr", page: 110, mode: "display", heading: "Blind Fighting", cite: "RR PDF p. 110", kind: "ability", name: "Blind Fighting" },
  { id: "prof.berserkergang", book: "rr", page: 110, mode: "display", heading: "Berserkergang", cite: "RR PDF p. 110", kind: "ability", name: "Berserkergang" },
  { id: "prof.combatFerocity", book: "rr", page: 110, mode: "display", heading: "Combat Ferocity", cite: "RR PDF p. 110", kind: "ability", name: "Combat Ferocity" },

  // One page of items (Revised Rulebook, PDF p. 145 — run-in entries)
  { id: "item.grapplingHook", book: "rr", page: 145, mode: "runin", heading: "Grappling Hook:", cite: "RR PDF p. 145", kind: "item", name: "Grappling Hook" },
  { id: "item.herbWolfsbane", book: "rr", page: 145, mode: "runin", heading: "Herb, Wolfsbane:", cite: "RR PDF p. 145", kind: "item", name: "Herb, Wolfsbane" },
  { id: "item.holyBook", book: "rr", page: 145, mode: "runin", heading: "Holy Book:", cite: "RR PDF p. 145", kind: "item", name: "Holy Book" },

  // Intentional dummies — the FAKE book (missing-book demo; can never resolve)
  { id: "fake.shadowCant", book: "cw", page: 42, mode: "display", heading: "Shadow Cant", cite: "CW PDF p. 42 (fake)", kind: "ability", name: "Shadow Cant (fake-book demo)" },
  { id: "fake.whisperglass", book: "cw", page: 77, mode: "runin", heading: "Whisperglass Vial:", cite: "CW PDF p. 77 (fake)", kind: "item", name: "Whisperglass Vial (fake-book demo)" },
];

export const recipesForBook = (bookId) => RECIPES.filter((r) => r.book === bookId);
export const recipeById = (id) => RECIPES.find((r) => r.id === id);
