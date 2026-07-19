# Changelog

## 0.12.0

Four defects, all found by auditing a single entry (JJ Acrobatics) and all
systemic.

- **Ten entries were losing their opening sentence.** Where the PDF emits a
  run-in heading as `Acrobatics` + `: The character is trained to…`, the colon
  and the whole first line share one run. Dropping that run to remove the
  heading took the sentence with it. The recipe now records how many leading
  CHARACTERS of that run are heading — a count, never the text — and the rest
  survives. 10 → 0.
- **249 entries carried a class list in their description.** A JJ power closes
  with "[Beastmaster, Cultist of Atlach-Nacha, …]", which is the CONTAINER's
  business: an ability does not know who may take it. Stripped. 249 → 0.
- **Throws that improve with level were read as flat.** "A proficiency throw of
  18+ … reduces by 1 per level" was stored as a permanent 18+, losing the entire
  progression. Now a per-level value, with the step negative however the book
  phrases the improvement.
- **Limitations were never classified at all.** An encumbrance ceiling and an
  armour-weight restriction now materialize as `limitation` effects. Only shapes
  that reduce to a VALUE are taken — restrictions the books state as prose stay
  in the lazy description on purpose, because copying the sentence into a flag
  would put book text where a seat without the book could read it.

## 0.11.0

- **Build costs are no longer baked into the module.** "Counts as 2 1/2 custom
  powers" is a number printed on the page, and 31 of them were being resolved
  offline and shipped — exactly what this pipeline exists to prevent. The
  PATTERN now ships as vocabulary and the number is read from the reader's own
  prose at runtime, like every other value. Verified identical to the values
  that used to ship, and now finds 36 (a cross-reference derives its own from
  the text it shares). The IP lint gained a validated allowance for regex
  locators so it does not mistake one for prose — the allowance only applies to
  strings that actually look like a pattern.
- **Abilities now drive the system's own fields, so they do something.** A
  classified proficiency throw fills `roll` / `rollType` / `rollTarget`, which
  the core sheet already knows how to roll, and a prerequisite fills
  `requirements`. Previously every mechanic lived in a module flag that nothing
  in the game read. A level ladder resolves at 1st level on the shared item;
  the sheet shows the whole ladder.

## 0.10.0

- **The combat proficiencies are abilities, and generals upgrade them.** Weapons,
  Armor and Fighting Styles are the three axes a class is rated on, not inert
  rules text — the tell is that general proficiencies raise them. Armor Training
  moves armor one weight category, Martial Training adds a weapon group, and
  Fighting Style Specialization requires a style you already have and
  specializes it. Each is written against the axis's CAPABILITY, so the upgrade
  finds it however the character holds it.
- **A cross-reference inherits its target's authored mechanics.** It already
  read the target's prose, so anything the prose scan could classify came
  through — but a prerequisite, companion slot or progression column the chef
  authored on the target did not. Those are equally part of the shared
  capability and now carry over, with the alias's own specs always winning.
  Latent until now (only one alias had such a target, and it had its own copy).

## 0.9.0

- **Thief skills finally have their numbers.** All thirteen carried no mechanics
  at all, and the reason was not a bad extraction: their target numbers are not
  in their entries. Every one is a column of a single grid on RR p.33, and the
  entries only describe what the skill does. A new `progression` op reads one
  column of that grid — the recipe ships which column and which rows, the
  numbers materialize from the reader's own book like everything else — so eight
  skills now carry a full level-1-to-14 proficiency throw, verified cell for
  cell against the printed table.
- A sweep of both books confirms this was the **only** such table: no other page
  puts several ability names over a numeric grid.

## 0.8.0

- **Prerequisites are structured.** Seven abilities state a requirement the page
  spells out — the five spore powers need Necrosporing, Eldritch Warrior needs
  Eldritch Talent (or to already be an eldritch caster), Conduit to the Esoteric
  needs a familiar. Each is written against the CAPABILITY, so whichever entry a
  character took to get it satisfies the gate.
- **Structure no longer waits for the book.** A chef-authored effect that points
  at no number — a prerequisite, a companion slot, a reroll rule — is pure
  structure the cookbook already states, so it now applies without a connected
  book. Anything that reads a value from the page still waits for the page.
- **Prune button.** Ten definitions were withdrawn in 0.7.0 as harvest phantoms,
  and any world that imported before then still holds the items they created,
  pointing at nothing. Prune lists them and removes them once you confirm —
  never silently. Update reports the count.
- Classified effects 63%; 74% of definitions carry some structured data
  (effects, build cost, capability or classification). The remainder is prose
  describing a capability with no number in it: across all 119 of them there are
  38 signed numbers, and most of those are the build cost already captured.

## 0.7.1

- Reverts the compiled `packs/` to the v0.6.0 build. 0.7.0 was committed while a
  Foundry world was running and swept up LevelDB bookkeeping again; `packs/_source`
  did not change, so the macros in 0.7.0 are correct either way.

## 0.7.0

- **Ten phantom abilities removed.** The JJ prints some headings without spaces
  ("ChosenWeapon:"), and the harvest had read the tail of ten of them as
  abilities in their own right — "Weapon", "Animal", "Proficiency", "Powers" and
  six more. Each duplicated an entry that already existed. They also poisoned
  name-matching: "Proficiency" as an ability name matched 201 other entries.
  Thirteen surviving entries had kept the spaceless spelling as their display
  name and now read properly ("Totem Animal", "Chosen Weapon").
- **Capabilities.** An alias and its target now declare the capability they
  share, so a prerequisite written against that capability is satisfied by
  whichever of them the character actually took. 103 entries carry one.
- **RR p.35 "Hideout" extracts correctly** — the last bad entry. Its prose spans
  a page half that a table below splits into two columns, and it ends at that
  table rather than at a heading, so the recipe now states its own column band
  and floor. Two general fixes came out of it: a heading's superscript ordinal
  ("9th") no longer leaks into the description, and a block ending at a heading
  that HAS such an ordinal no longer swallows that heading.
- **Every definition now extracts cleanly**: 460 entries, 0 errors, 0 expect
  mismatches, 0 empty descriptions, 0 unresolved cross-references. Classified
  effects 62%.
- Update's name-matching resolves a collision by what the world actually holds
  before falling back to the category preference — if only one of the same-named
  candidates has been imported, that is not a guess.

## 0.6.0

- **Browse & Import Abilities.** There was no way to import a *selection* of
  abilities — only all of them, or nothing. This adds the picker the monster
  import has always had: filter by category and name, "select shown", hide the
  ones already in the world, and markers for cross-references, retired content
  and what you already have. Reachable from the Items sidebar and a macro.
  It works without a connected book, and says so: abilities always import with
  their name, classification and page reference, and the mechanics arrive when
  someone who owns the book imports or updates.
- **Macro pack revised.** The macros were still the PoC set, numbered in a
  tutorial order that no longer matched how the module is used, with nothing for
  abilities at all. They are now grouped and named for what they do — set up
  your seat, import from the cookbook, tools, demos — and four ability macros
  are added. Existing macro ids are unchanged, so a world that already imported
  the pack gets renames rather than duplicates. The compendium is now "ACKS
  Content — Macros".
- **No more 404s on load.** The runtime probed for a cookbook file per book id
  and 404'd for every book without one (`rr.json`, `jj.json`, `cw.json`). The
  compiler now writes `cookbook/index.json` naming exactly what it produced, and
  the runtime loads from that.
- README rewritten around actual usage rather than the PoC walkthrough.

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
