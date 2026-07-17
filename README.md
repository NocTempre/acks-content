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
