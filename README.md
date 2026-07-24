# ACKS II — Content Streamer (PoC)

Streams book prose from the user's own ACKS II PDFs into Foundry at render time — per-client, bring-your-own-book. PoC.

A Foundry VTT module that extends the
[ACKS II game system](https://github.com/AutarchLLC/foundryvtt-acks-core).

## Installation

In Foundry: **Install Module** → paste the manifest URL:

```
https://github.com/NocTempre/acks-content/releases/latest/download/module.json
```

## Requirements

- Foundry VTT v14+
- ACKS II system (`acks`) v14+

## Development

```
npm install
npm run build:packs   # rebuild compendium packs from packs/_source
npm run validate      # syntax / templates / JSON / packs / i18n checks
```

Releases are cut by pushing a `v<version>` tag matching `module.json`; GitHub
Actions builds and publishes `module.zip` + `module.json`.

This repo follows the shared ACKS module toolchain — see
`acks-module-template/docs/TOOLCHAIN.md` for conventions.

## License

**Code:** © NocTempre — proprietary; all rights reserved except as granted to
Autarch LLC under the **ACKS II App License**. This module is **not** open source
or Open Game Content, and no license is granted to copy, redistribute, or reuse
its code. See [`LICENSE`](LICENSE).

**ACKS II content** is used under the **ACKS II App License**. ACKS, ACKS II, and
Adventurer Conqueror King System are trademarks of **Autarch LLC**. This app
streams prose only from PDFs the user already owns; it publishes no ACKS II
content itself.

**Unofficial** — this is an unofficial fan module, not published or endorsed by
Autarch LLC.

**Registration #:** _[pending registration]_

**Requires:** legitimate copies of the ACKS II publications whose prose you
stream (e.g. the ACKS II core rules, Judges Journal, Monstrous Manual) —
_[confirm exact publication title(s)]_. You supply your own PDFs; the app is
free to use and is not a substitute for the books.

## Usage

Enable the module in an `acks` world, then open the **"ACKS Content — Macros"**
compendium. They are ordered by what you do first.

**Set up your seat.** `Connect Your Book` picks a book and your local PDF (read
in this browser only, never uploaded). Re-open a sheet afterwards and its
description gains "📖 Show book text". `Book Status` says which books this seat
can read; `Forget Books` drops the remembered locations and this session's prose.

Where each book lives is remembered **on this device**, so joining again offers
them back: books that can reopen themselves do, silently, and anything else is
listed in a **Reconnect your books** dialog — one control per book, because
browsers grant file permission one file at a time. `Reconnect Remembered Books`
runs that pass again if you dismissed it. On browsers that cannot reopen a file
at all (Firefox, or any seat on an insecure `http://` origin), the file's *name*
is what gets remembered, and the dialog offers a picker with that name beside
it. The prose itself is never stored, on any path.

**Import content.** `Cookbook — Import Monsters` and `Cookbook — Browse & Import
Abilities` open pickers; `Import ALL Abilities` takes the lot. Abilities import
**with or without a connected book** — without one you get the name,
classification and page reference, and the rules text and mechanics arrive once
someone who owns the book imports or updates. `Update Abilities in World`
re-runs that over everything already imported, including the copies embedded on
actors, and adopts hand-made abilities by matching their name. `Fill Companion
Slots` links companion abilities to their creature once the citing book is open.

The same three ability actions also sit at the top of a GM's Items sidebar.

**Equipment.** `Cookbook — Import ALL Equipment` generates the Revised
Rulebook's equipment-description corpus (adventuring gear, clothing, animals,
structures, vehicles — 147 entries, RR PDF pp. 144-154) as world items in the
ACKS Cookbook folder. The same bring-your-own-book posture applies: every seat
gets the item with name, icon, and citation; the descriptor text reveals from
your own connected PDF. Costs and weights are page values — they ship as
nothing and materialize per entry as chef-authored locators land (entries are
`unaudited` until then; the printed table governs). With ACKS Equipment
enabled, generated carrying gear (backpacks, sacks, the adventurer's harness,
the bowquiver) is annotated with its RAW capacities on import.

**Tools.** `Browse & Load a Page`; `Apply Stats from Book` (parses a monster
stat block from your PDF into the world actor — AC, HD, saves via F-band,
morale, XP, alignment, movement, appearing, attacks; unmapped labels are stored
raw under `flags.acks-content`, and browse-loaded monsters get stats
automatically); and `Cookbook — Debug Raw Extraction`, which shows exactly what
the executor read, so a bad import can be traced to the recipe rather than the
binding.

**Demos.** `Create Sample Actors & Items` builds the "ACKS Content PoC" folders
— Griffon and Content Carrier actors plus three world items, all carrying only
`@PdfText` tags. Combat Reflexes there demonstrates a shipped mechanical
payload: a +1 initiative Active Effect alongside streamed prose. `Audit: the two
language options` contrasts the persisted stub with the text reproduced on
demand. The two Codex of Whispers entries are INTENTIONAL FAKES — they
demonstrate the missing-book path and can never resolve.

Engine regression against the local library: `node tools/dev-extract-check.mjs`
(dev-only; requires `C:\Proj\acks-reference`).
