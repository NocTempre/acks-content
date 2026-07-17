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

Module code © NocTempre. ACKS II content referenced under Autarch LLC's
compatibility guidelines — see the ACKS II system repository for license texts.

## PoC usage (dev)

1. Enable the module in an `acks` world (junction already in place).
2. Open the "ACKS Content — PoC Macros" compendium and drag the macros to the
   hotbar (or run from the compendium). "PoC 1 — Create Sample Actors & Items"
   (GM) creates the
   "ACKS Content PoC" folders: Griffon (PoC) + Content Carrier (PoC) actors
   and three world items, all carrying only `@PdfText` tags.
3. `acksContent.connectBook()` — pick a book and your local PDF (read in this
   browser only). Re-open sheets: descriptions gain "📖 Show book text".
4. `acksContent.audit()` — GM-whispered card contrasting language option A
   (persisted stub + reference) with B (reproduced on demand per seat).
5. The two Codex of Whispers entries are INTENTIONAL FAKES — they demo the
   missing-book path and can never resolve.
6. "PoC 5 — Apply Stats from Book" (GM, after PoC 1+2 with MM connected):
   parses the monster stat block from your PDF into the world actor (AC, HD,
   saves via F-band, morale, XP, alignment, movement, appearing, attacks);
   unmapped labels stored raw under flags.acks-content. Browse-loaded (PoC 3)
   monsters get stats automatically. Combat Reflexes demonstrates a shipped
   mechanical payload: +1 initiative Active Effect alongside streamed prose.
7. Engine regression vs the local library: `node tools/dev-extract-check.mjs`
   (dev-only; requires C:\Proj\acks-reference).
