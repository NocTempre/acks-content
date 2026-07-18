# Changelog

## 0.5.2

- Reverts the compiled `packs/` back to the v0.5.0 build. 0.5.1 accidentally
  shipped LevelDB bookkeeping churn (log rotation and manifest renumbering)
  written by a Foundry world that was running during the commit. The pack
  CONTENT was identical either way — `packs/_source` did not change — so 0.5.1
  works; this just stops the noise from being carried forward.

## 0.5.1

- The Item directory buttons now appear on first load. The sidebar renders
  before this module is ready, so its hook missed that first pass and the
  buttons only showed up after something else re-rendered the directory.
- **Update adopts monster stat-block proficiencies.** A stat block writes
  "climbing 6+", which is the Climbing proficiency with its target number
  attached; the trailing throw is now stripped before matching, so the copies
  embedded on monsters get adopted instead of skipped.
- **Same-named abilities no longer adopt at random.** Fourteen names are both a
  proficiency and a class power (Alertness, Climbing, Swimming, Loremastery…).
  Update now prefers the proficiency — what a stat block or a hand-made ability
  almost always means — logs every ambiguous match to the console, and reports
  the count, rather than silently taking whichever was indexed first.

## 0.5.0

- **Cross-referenced abilities are their own entries.** A name the books list
  whose rules text is printed under another entry used to redirect away and mint
  nothing. It now gets a real ability: the recipe carries a pre-baked pointer to
  *where* that text lives, so it extracts, classifies and displays like any
  other — it just does not stack with the entry it shares the passage with.
  Finding the text needs the book; the pointer is page coordinates, so it ships
  safely. 68 of these, all resolving (was 64 resolving, 4 dangling).
- **Import Abilities / Update Abilities buttons** in the Item directory (GM
  only). Import is deduped — running it twice reuses items rather than
  duplicating them. Update refreshes every ability in the world, *including the
  copies on actors*, and adopts hand-made or older ones by matching their name.
  Both are safe to re-run.
- **Companion slots.** An ability that confers a creature now carries a slot for
  it. When the recipe names a monster entry and that book is connected, the
  actor is imported and linked; otherwise the slot stays empty for a GM to fill,
  or for `cookbookFillCompanions()` to fill once the book loads. Abilities whose
  creature is *built* rather than named (a totem animal, a familiar chosen from
  a list) keep an empty slot by design.
- **Rerolls are structured**, not prose: which throw, how many rolls, and which
  result stands — with the direction of "better" following the throw itself.
- Classified effects rose from 51% to **61%** of entries, mostly because a
  cross-reference now reads its target's prose.
- Extraction fixes: three cross-references whose target name wraps mid-phrase
  are now hand-linked by the recipe, and a phantom entry the harvest created by
  splitting one heading across two lines is gone (470 definitions, was 471).

## 0.4.0

- **Proficiencies, powers and skills extract from your books.** Three new
  cookbooks — `proficiencies`, `powers`, `skills` — covering the Revised
  Rulebook proficiency list, thief skills, the combat proficiency rules, and
  the whole Judges Journal custom power index. 471 definitions compile; a seat
  with the books imports 407 ability items (the rest are "see X" cross
  references, which redirect to their target instead of minting a duplicate).
  Cookbooks are named for *what* they extract, not which book prints it, so a
  power introduced in a supplement lands in the same file.
- **Mechanics are shared, prose stays gated.** An imported ability carries its
  structured effects in world data — usable and visible to everyone at the
  table — while the literal rules text remains a lazy `@PdfText` descriptor
  that only renders for a seat with the book loaded. Effects are classified at
  extraction time against a shipped vocabulary; nothing about a given ability's
  mechanics is baked into the module.
- **Abilities are shared objects, not copies.** A monster or class that names a
  proficiency now binds the one shared ability rather than generating its own,
  so the same proficiency is one item no matter how many stat blocks cite it.
- **Retired content is ingested and flagged, never dropped.** 173 conversion
  mappings from the ACKS II compatibility guidance are applied automatically:
  renamed content resolves silently to its current name; removed content
  imports with a caution and names its successor; content that predates ACKS II
  imports with an informational note. Items and magic are deliberately left
  unresolved for now.
- Needs `acks-abilities` (and its `acks-lib`) to display the imported
  mechanics; without them the items still import, just without the sheet.
- Extraction fixes behind the above: definitions now follow their text across
  column and page breaks, headings split by the PDF are re-joined per column,
  the vertical chapter tabs no longer leak into prose, and superscripts stay on
  their own line.

## 0.3.7

- **Type-inherent defenses (ACKS type rules).** The MM states type-wide
  immunities — "all undead / constructs are immune to enchantment effects,
  necrotic and poisonous damage"; "all plants…"; "oozes… enchantment". These
  are now authored once on the creature-type nodes (cited) and applied to every
  creature of that type, unioned with its own description scan. So an undead
  that doesn't restate its immunities still gets them.
- Defense prose scan tightened: a clause stops at the next defense verb /
  contrast word, so "immune to X and resistant to Y" no longer leaks Y's
  mundane/extraordinary flags into X; added the "electric" damage synonym.

## 0.3.6

- **Defenses materialize from your book, not baked lists.** Immunities /
  resistances / susceptibilities are read at extraction time from each
  monster's own description prose against a shipped keyword vocabulary
  (damage types + a defense-effect list) — so Death Charger, Skeleton, Wraith
  etc. tick their immunity boxes on import. Nothing about which defenses apply
  is shipped; a bookless seat gets none (the GM who owns the book imports them).
- **True N/A vs 0.** A printed "N/A" value (mindless-undead morale) is kept
  distinct from 0 — the field is left blank and flagged instead of showing a
  misleading "always flees" morale of 0.

## 0.3.5

- **Attacks: "1 or 2" is a count, not two modes.** A bare-number attack part
  ("1 or 2 hooves") is now read as a count range for one attack instead of
  spawning phantom weapons — fixes the common animal multi-attack line.
- **Ecology market values match the sheet schema.** Untrained values import as
  numbers into Adult/Juvenile/Baby; trained values import as the role rows the
  sheet expects (e.g. War Mount 315gp + Workbeast 40gp); reproduction young
  type maps foals/pups/etc. to Live Young.
- **Per-entry attack override.** Rare attack grammars the generic parser can't
  handle get a chef `assists.attacks` normalized routine string, rather than
  more branching in the parser.

## 0.3.4

- **Full Monster Sheet tabs now populate on import.** The binding maps the
  executed extraction onto the FMS extras schema:
  - *Classification*: type checkboxes (compound types tick both), sub-type,
    size, mass (stone + lbs), HD count/bonus/asterisks, saves-as class+level,
    normal/max load, vision checkboxes + lightless range, other senses, and
    per-mode movement speeds.
  - *Ecology*: expedition speed, supply cost, training months/modifier, battle
    ratings (individual + unit), lifespan age thresholds, reproduction
    (count/young type/oviparous), untrained market values (adult/juvenile/
    baby), trained value, encounter nouns (wandering/lair) + lair chance.
  - *Defenses & Magic*: conservative scan of the entry's own formulaic prose
    ("immune to enchantment effects, necrotic damage…") fills immunity/
    resistance/susceptibility damage types and effects, plus "casts spells as
    an Nth-level X" spellcasting.

## 0.3.3

- **Description sections.** Paragraphs are classified by the book's own run-in
  headings (Combat / Ecology / Encounter / Special Rules / Lair …) at compile
  time — 286 of 287 entries label themselves — and imported actors now route
  each section to the matching Full Monster Sheet field (Appearance, Combat,
  Ecology, Encounter, Lore, Notes) with its own lazy `@PdfText[id#section]`
  tag instead of dumping everything into Appearance.
- **Spoils fixed book-wide:** fractional-only weights (`4/6 st`) were rejected
  by the component parser, silently emptying most spoils lists (e.g. Death
  Charger). All weight forms now parse.
- Divider mini-headings ("… Secondary Characteristics", "… Encounters") no
  longer pollute stat fields (smallcaps-aware detection, shipped drop fixes).

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
