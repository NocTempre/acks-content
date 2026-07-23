# Changelog

## 0.31.0

Actor art for the adventure books — chef-audited, not guessed:

- **JPEG2000 decoding**: the AX books embed every image as JPX, which the
  vendored pdf.js can only decode through wasm; `vendor/wasm/` now ships the
  openjpeg/jbig2/qcms decoders and the module points the worker at them. This
  is what makes AX page images extractable at all (and fixes any future
  feature that touches AX pixels).
- **Audited associations**: every candidate image on the NPC and monster
  pages was extracted and visually reviewed. The placement heuristic turned
  out to structurally select the parchment slabs behind the stat blocks
  (real portraits stand beside the text), so automatic association is
  retired; art now ships only on entries whose association a review
  confirmed — currently Gabriol Eirenikos and Aghilas of the Imperial
  Vanguard, whose portraits import onto their actors (image + token). The
  AX2 appendix prints no per-monster illustrations, so its actors correctly
  ship none. More associations can land one `assists.artName` at a time as
  pages are reviewed.
- Art instructions now ship the placement box beside the XObject name, with
  a page-render crop as fallback for seats whose wasm decoding fails.
- `connectBookUrl` art path and deferred-import art both honor the shipped
  association.

## 0.30.0

The AX2/AX3 NPC and roll-table sweep — location journals stay at the pilot
slice by request; people and dice are now complete:

- **49 named NPCs across AX3**: every resident with a printed stat block in
  all eight districts — the Faunus syndicate (Liber, Hesta, Aranth,
  Megaravicos), the Sand & Bones four, three gladiatorial lanistas and four
  named veterans, the Solar Citadel clergy, the Tower of Knowledge wizards
  (Regent Aurëus, Provost Mentenus, Clitus, Inspector Mara), the Temple
  district clergy, the Eclipse Hideout six, the Lake councilors and death
  cult, the Prefectural household — plus the full Imperial Vanguard five.
  Quick/full page splits merge per entry; prose bounds are held by
  register-driven sibling stops and statline auto-stops.
- **17 more roll tables**: all seven district special-encounter lists
  (1d10, after-dark rows included), the d100 City and Undercity Encounter
  tables, Random Borderlands Rumors (d30), Rumors of Cyfaraun and the
  judge's behind-the-rumor table (one printed truth may cover several rolls
  — comma-grouped dies become multiple ranges), Random Irritating Rumors,
  AX2's wall-grave occupants, mummy-reaction, and both magic-item tables.
  Grid machinery learned centered die columns, split/multi-page grids, and
  fused "8: text" list anchors.
- **All 14 AX2 New Monsters headings → 24 entries** with per-variant stats
  (mechanical cobras, faewyrds, undead bone golems, ALL EIGHT animal
  mummies, animated statues). Per-entry defer rulings: the animated statues
  and the Sarcophagal Worm (verified stat-identical) import their ACKS II
  MM revisions when that book is open; the undead bone golems were ruled
  distinct from the MM's construct bone golem and extract from AX2.
- Deferred imports now skip when the world already holds the target entry.

## 0.29.0

AX2 (Secrets of the Nethercity) and AX3 (Capital of the Borderlands) join the
cookbook — the first adventure books, with four new kinds and their bindings:

- **Location journals** (`kind.location`): keyed areas import as JournalEntry
  pages (one journal per complex/district, one page per key) whose prose stays
  a lazy `@PdfText` tag — pin a page to a scene to attach it to the map. AX2's
  inline `[MONSTER]`/`[LORE]`/`[LOOT]`/… icons become prose sections, and each
  quick-stat label emits a creature link.
- **Defer-to-ACKS-II**: a new `creature` register maps printed names onto the
  entry the seat should use — renames ruled by the conversion registry
  (Carcass Scavenger → Carrion Horror) — and appendix monsters reprinted in
  the MM (`meta.revisedBy`) import the MM version whenever that book is open,
  falling back to the AX block otherwise.
- **NPC actors** (`kind.npc`): the new `statline` executor pattern parses the
  era's inline quick-stat blocks (class/level, ability scores, AC/HD/hp/
  attacks/saves, proficiencies, equipment) even when prose and block sit on
  different pages; proficiencies resolve through the ability-provider tiers
  into embedded items; scores and gear notes persist in
  `flags["acks-content"].npc`.
- **Adventure roll tables** (`kind.rolltable`): grid tables (the 4-column
  wandering-monster spread) and numbered-list tables (district special
  encounters) import as RollTables — ranges are shipped structure, row text
  materializes from the seat's book, the formula reads off the page (2d10) or
  derives mechanically from ranges starting at 1 (1d20).
- **Legacy monster blocks** (`kind.monsterLegacy`): ACKS I label-column stat
  blocks (with variant columns) bind onto the same monster-actor surface.
- New GM macros: *Import Location Journals*, *Import Adventure Roll Tables*.
  `connectBookUrl(bookId, url)` joins the api for hosted/staged PDFs.
- Pilot coverage: AX2 entrance caves A1–A4, both Nethercity table sets, four
  appendix monsters; AX3 Old District (keys 1–14U, Argollëan Family, City
  Watch, two resident NPCs, special encounters) and Gabriol Eirenikos of the
  NPC Party. The remaining ~500 entries follow the same recipes in sweep
  batches.

## 0.24.1

- Add the `url` field to the manifest (GitHub repo link), matching the rest of
  the family.

## 0.24.0

Six new oracle-verified table recipes (23/23 green): NPC age-by-class,
0th-level hit dice, proficiency count by race/age, BTA dwarven castes, and
the optional slavery doc (common-slave economics, the 17×11 slave-troop
grid, soldier upkeep/indoctrination). New `proseValues` extraction shape
reads values the book states in running prose — anchor phrases never carry
values. Point-column binding is nearest-run-wins so footnote glyphs cannot
displace real cells.

## 0.16.0

The release where a live import found what offline checks could not.

### Fixed from a real mass import

- **An unparseable stat is a skipped monster, not a crash.** `int` could
  return NaN — `/(-?[\d,]+)/` matches punctuation with no digit in it, so a
  morale printed "N/A when controlled, +4 otherwise" parsed the comma to
  `parseInt("")`. NaN is `typeof "number"`, so it slid past every guard and
  first surfaced inside `Actor.create`. And because Foundry *reports* a
  validation failure and returns undefined rather than throwing, the next line
  raised a TypeError three frames away that buried the real error. One
  monster in 287; it fired twice per occurrence and hid its own cause.
- **Apply Stats reaches cookbook monsters, and actors with no token.** It
  required a selected token — an imported bestiary is mostly actors nobody has
  dragged out — and resolved names against the dozen PoC recipes, so it could
  not touch *any* cookbook monster either way. It now targets open sheets too,
  and asks an imported actor which entry it came from instead of guessing.
- **Book status counts the cookbook.** It measured `allRecipes()` against
  `proseMem`, both of which predate the cookbook, so a seat holding the whole
  MM saw a denominator of a dozen and a numerator stuck at zero. Now MM 287 /
  RR 133 / JJ 327.
- **A description stub clears when its book arrives.** The tag resolves per
  render, so a sheet drawn before connecting kept telling the reader to do the
  thing they had just done.
- **Connect says which books are open**, and `restoreBooks` stopped swallowing
  every failure — "it didn't reconnect" and "there was nothing to reconnect"
  were indistinguishable from outside.

### Monsters

- **Token size follows the printed size class.** A Gigantic monster on a 1×1
  token is wrong before anyone reads a stat.
- **Import all monsters**, from the browser or a new macro. Both skip what is
  already imported, so pressing either twice tops up rather than duplicating —
  which matters because a monster import always creates, and two actors
  claiming one cookbook id make anything resolving by id pick arbitrarily.
- **Stat-block proficiencies find the ability the world already has**, in
  three tiers: reuse the world item, else build from the cookbook, else mint a
  namesake. 69 of the registry's 70 tokens have no ref, so nearly every
  monster used to mint an empty namesake while the definition sat unreachable.

### Icons

- **Every RR ability has one**: 120 proficiencies and 13 skills, hand-picked,
  every path verified against a real install. Optional game-icons.net upgrades
  where core has nothing — Acrobatics, Blind Fighting, Caving and Mapping all
  scored *nothing* in core — always with a core fallback beneath, so a seat
  without the pack sees a duller icon and never a broken one.

### Extraction

- **Locators reach every numeric effect field**, not just `value`. `amount`,
  `range`, `casterLevelDelta`, `choose` and `times` were unreachable, which
  made every percentage and rate mechanic in both books unwritable.
- **Scoping specs for eight reaction proficiencies** (Diplomacy, Intimidation,
  Seduction, Mystic Aura, Beast Friendship, Folkways, Bargaining, Bribery),
  carrying which tone a bonus is limited to and which targets it applies
  against. Without them an imported Diplomacy is +1 on *every* reaction roll.
  Needs acks-lib ≥ 0.6.0.
- **Audit packages carry page geometry** — line boxes, columns, table
  candidates, and each line's raw unjoined runs, because the compiler joins
  runs *without* spaces and the package joins them *with*, so a pattern that
  works when you read it fails when it compiles.
- **Validate catches a cookbook that lags its register**, after the shipped
  0.15.0 cookbook was found doing exactly that.

### Removed

- The PoC demos and the fake "Codex of Whispers" book. The missing-book path
  they demonstrated is now the ordinary case. **Worlds that imported the demo
  macros keep them** — Foundry does not delete on compendium removal.

## 0.15.0

The release where extracted mechanics stop presenting as the book's ruling
until someone has read them against the printed page.

### The audit gate

- **Unverified mechanics are marked as such.** A register entry gains
  `audited: "<date>"` only after a chef reads its FULL materialized output
  against the page — bounds, effects, rolls, limitations. Everything else binds
  with `extras.unaudited`, and the abilities sheet says "Machine-classified —
  not yet chef-audited." Wrong-but-plausible output is the danger this exists
  for: Blind Fighting prints a −2 that is a net *bonus* because it replaces a
  −4, and no scan can know that. Every build prints the burn-down; this release
  ships **16/120 proficiencies and 1/13 skills signed**. Needs
  acks-abilities ≥ 0.5.0 to show the notice.
- **Scans locate; recipes interpret.** `docs/RECIPES.md` gains the principles
  that make it enforceable, the load-bearing one being: never generalize a fix
  across entries. The commit that built this gate then violated it — a sampled
  audit found one entry missing `repeatable` and the fix shipped as a regex over
  every entry's body text. All twelve matches were true, which is exactly what
  hid the damage: six state an unextracted per-rank progression in the very
  sentence matched, and the pattern's passive-voice requirement silently missed
  thirteen more. A ~52% false-negative rate reporting complete success. The
  inference is gone; `metaCandidates` now REPORTS in both directions and the
  register always wins.
- **Per-entry recipes displace scan output.** A recipe may state structure and
  carry LOCATORS — short patterns that find a value in the reader's own copy —
  but never a value read off the page. Nothing about your book ships in this
  module; it materializes per seat, as before.

### What the chefs found

- **Authored effects now REPLACE the scan, as authored rolls already did.**
  Effects were concatenated, so a chef could add a missing effect but never
  correct a wrong one — re-authoring shipped it twice. All six chefs reported
  this independently and several withheld correct recipes because of it, which
  is how a tier is supposed to fail. Two live defects it was hiding are fixed:
  Trapfinding's +2 applied to EVERY proficiency throw where the page names two,
  and Berserkergang shipped a −2 AC as permanent where the page gates every
  mechanic on being enraged.
- **25 chef-authored recipes merged, 0 rejected.** Alchemy has four correctly
  labelled rank ladders (was three wrong-but-plausible, one carrying a rank-2
  value under a rank-1 label); Adventuring five labelled rolls (was zero);
  Climbing its −10 with the real printed condition; Listening one paragraph
  instead of three. Every one was re-executed against a reference PDF by
  `tools/merge-recipes.mjs` — a subagent's own verification claim is never taken
  as evidence.
- **The `rolls` recipe op.** An entry can state each throw it offers with its
  own locator, rank/level ladder and condition, replacing a scan that guessed
  labels from surrounding prose and sometimes named a roll "Each".

### Monsters

- **Import all monsters, in one press.** The monster browser gains "Select all"
  / "Select shown" / "Clear" with a live count and a check against entries this
  world already has, matching the ability browser; a new *Cookbook — Import ALL
  Monsters* macro does the whole book without opening the list. Both skip what
  is already imported, so pressing either twice tops up rather than duplicating
  — worth having, because a monster import always creates and two actors
  claiming one cookbook id make anything that resolves by id (a companion slot)
  pick between them arbitrarily. Reading a whole book takes minutes, so it
  confirms the count first and reports progress while it runs.

- **Monster proficiencies find the ability the world already has.** A stat-block
  token resolved through one channel only — an authored registry `ref` — and 69
  of the 70 tokens in that registry have no ref yet, so nearly every monster
  minted a fresh, empty namesake ability. Resolution is now three tiers: reuse
  the world item already standing for the definition, else build it from the
  shipped cookbook, else mint the namesake as before. The name index spans
  proficiencies, powers AND skills, so a monster can reference a class power;
  the 14 names that are both (Alertness, Climbing, Acrobatics…) resolve to
  whichever the world actually imported, and only a real guess is reported.
- **A monster's own printed throw target now reaches the ability.** The block
  writes "climbing 6+"; the 6 was extracted and then dropped, so the ability
  showed the definition's generic ladder resolved at 1st level. That was
  invisible while the tiers above effectively never fired.

### Also

- `rollScan` no longer invents labels or scales. Naming a roll is recipe work;
  a scan that guessed produced "Each" as often as anything useful.
- `executor.mjs` contained two literal NUL bytes from a thousands-comma
  sentinel, which made git and grep treat the whole file as binary — no diffs,
  no search. Replaced with unicode escapes.

**Known rough edge:** the 25 merged recipes are *correct* but not *signed* —
merging and signing are deliberately separate, and the burn-down counts only
signatures. Roughly 89 RR entries cannot be expressed with today's recipe
vocabulary (percentage and rate values have no locator target, effects have no
breakpoint ladder); those entries bind as unaudited machine drafts and say so.
The JJ powers have not been swept at all.

## 0.14.0

- **Abilities extract EVERY roll they offer, not one.** Animal Husbandry
  diagnoses, cures, cures serious injury and extracts venom; a single target
  could only hold one of those. Each throw is now captured separately with the
  label its sentence gives it and, where the book writes one, its rank ladder
  (`18+ / 14+ / 10+`). Needs acks-abilities ≥ 0.4.0 to display them.
- **Three more entries stop at their table.** The RR sets a rank-progression
  table at the foot of a column below the last entry in it; with no heading
  after that entry the body ran to the page bottom, swallowed the table, and
  then flowed into the next column and absorbed the neighbouring proficiency.
  Animal Husbandry was eating the whole Animal Training table. 7 → 4 affected
  (the remaining four title their tables differently).

**Known rough edge:** roll LABELS come from a prose heuristic and several read
badly ("Each attempt"), and coverage is partial — Animal Husbandry yields two of
its four rolls. Per-entry roll recipes are the fix and are not written yet.

## 0.13.0

**A number's meaning is contextual, and the effect scan was ignoring context.**
Blind Fighting reads "suffers only a -2 penalty on attack throws … instead of
the base -4". Scanned for a number and a target alone that stored a -2 penalty,
when the ability is really a net +2 — a wrong mechanic that looks right, which
is worse than none.

- Every candidate modifier is now judged against the SENTENCE it came from.
  A number that is a die face ("on an unmodified roll of 1"), a voided penalty
  ("does not suffer", "nor is his speed reduced"), or the opponent's penalty is
  DROPPED rather than recorded wrongly. One that supersedes a default is marked
  `replace`. Six wrong modifiers removed; the opponent-penalty misreadings halved.
- **Situational bonuses now say they are situational.** 85 modifiers were stored
  as though they always applied — "+4 on attack throws" is only while ambushing,
  "+2 on reaction rolls" only when negotiating. The scan cannot state the
  circumstance without copying the sentence, so it marks the effect situational
  and leaves the circumstance to the description. The sheet shows the qualifier.
- **Blind Fighting is authored as a recipe**, since no scan can read it: a
  conditional replacement of a worse default, plus two penalties it negates
  outright. Its numbers still materialize from the reader's book.
- Fixed: a spec value resolved through `from` was emitted as a bare number
  instead of a LevelValue object, so it could not satisfy the ability schema.

## 0.12.1

- Reverts the compiled `packs/` to the v0.11.0 build; 0.12.0 swept up LevelDB
  churn again. `packs/_source` did not change, so 0.12.0's macros are correct.
  Root cause, finally: shutting the WORLD down is not enough — the Foundry
  desktop application keeps running and keeps the module's pack open, so the
  files churn whatever the world is doing.

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
