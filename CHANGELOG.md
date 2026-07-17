# Changelog

## 0.3.2

- **Attacks reworked into modes.** The Attacks and Damage lines are now parsed
  into aligned *alternatives* ("1 weapon **or** 2 claws + bite"), and names pair
  correctly with their damage within each mode. Fixes monsters whose names and
  damage were mismatched (lizardman, thrassian, redcap …) and recovers dropped
  alternative attacks (e.g. a dragon turtle's `36d6` breath). Imported actors
  get one weapon item per attack, with alternate modes tagged (mode 0 equipped).

## 0.3.1

- **QA cleanup pass** (8-agent audit of all 280 MM entries against raw
  extraction). Fixed at the root, clearing the dominant defect classes:
  - wrapped stat values no longer bleed across fields (Vision/Senses/
    Proficiencies/Treasure/XP now correct; `xp` no longer nulls out);
  - double-struck section headings de-duplicated (no more
    `…GriffonGriffon Encounters` in raw fields or garbled body tables);
  - flat and "by weapon" attacks now produce weapon items (most humanoids);
  - negative attack throws keep their sign; `1d6×10`-style damage kept whole;
  - `(1,000 st.)` and comma-bearing magic effects no longer mis-split.
- Facing-page spoils recovered for several monsters (Attercop Demonic,
  Vampire, Kraken, …) via per-entry extraction assists.
- 11 real variant monsters added (Beastman tribes, Lycanthrope forms); ~400
  magic-property / proficiency / type tokens promoted into the registers.
- New GM tool **"Cookbook — Debug Raw Extraction"**: inspect the exact
  executor output for any entry (`acksContent.cookbookDebug()`).
- Dragon/Cacodemon/Elemental (table-template families) intentionally deferred.

## 0.3.0

- **The Cookbook**: a shipped, IP-free extraction database covering the whole
  ACKS II Monstrous Manual — 280 monster entries compiled from the book's own
  structure into explicit, geometry-addressed instructions (no prose, no
  values; your own PDF supplies everything at your table).
- New dumb executor (`scripts/executor.mjs`): replays cookbook instructions
  against the seat's connected book — including damage **quality from the
  printed icon color** (red = extraordinary), spoils, proficiencies, and art.
- New GM macro **"Cookbook — Import Monsters"**: filterable picker over all
  cookbook entries; imports build full monster actors from YOUR copy. Actors
  carry only `@PdfText` page tags; descriptions reveal lazily per seat.
- Offline authoring pipeline (dev-only, not shipped): register + compiler +
  verify with line-coverage residue accounting; see docs/RECIPES.md and
  docs/COOKBOOK.md.

## 0.2.0

- PoC 5 import fixes: damage decoder from legend glyphs, biography prose
  streaming, treasure, scoped apply, auto-fill on sample creation.

## 0.1.0

- Initial scaffold from acks-module-template.
