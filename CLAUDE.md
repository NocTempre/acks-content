# Content Streamer (PoC) (acks-content)

Foundry VTT module for the ACKS II system (`acks`), part of the NocTempre ACKS
module family. Canonical conventions and shared toolchain:
`C:\Proj\acks-module-template` — read its `docs/TOOLCHAIN.md` before changing
build/release plumbing.

## Layout

- `scripts/` — ESM runtime, entry `scripts/module.mjs`; `templates/` — .hbs;
  `styles/`; `lang/en.json` — flat i18n keys prefixed `ACKS-CONTENT.`
- `packs/_source/` — JSON pack sources (committed) → compiled LevelDB in
  `packs/` (committed and shipped; binary — protected by `.gitattributes`,
  never weaken it)
- `tools/` — dev harness. `build-packs.mjs` and `validate.mjs` are **synced
  from acks-module-template — never hand-edit**; change the template, then run
  `/acks-sync-toolchain`. `pack-data.mjs` (and data files it re-exports) are
  module-owned.
- Canonical ACKS II rules extract: `C:\Proj\acks-rules\acks-content\RULES.md`
  — **LOCAL-ONLY, never committed or shipped** (licensed book text; purged
  from repo history 2026-07-16). Cite it instead of re-deriving rules.
  `docs/MODEL.md` — design decisions (original content, stays in-repo).
- `ruledata/` (if present) — runtime-fetched JSON rule content; ships in the zip.

## Commands

- `npm install` once, then `npm run build:packs` and `npm run validate`
  (`npm test` where `tools/test-logic.mjs` exists).
- After a local build with unchanged sources, discard LevelDB timestamp churn:
  `git restore packs/ && git clean -fd packs/`. Commit rebuilt packs only when
  `packs/_source` actually changed.
- Foundry dev install (junction, not copy):
  `New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\FoundryVTT\Data\modules\acks-content" -Target "C:\Proj\acks-content"`
## Live testing

`C:\Proj\acks-rules\TEST_ENVIRONMENT.md` defines this machine's local Foundry
test server (URL, world, users, and the API calls that drive it). Read it
before live-testing. It is LOCAL-ONLY and machine-specific — **never commit
its contents, or any port / world id / user name / password, to any repo.**
If the file is absent, this machine has no test server: skip live testing and
say so, rather than improvising one.

`validate` and `npm test` run against **mocked** Foundry globals — they check
your assumptions, not Foundry's behaviour. Every module-breaking bug in this
family got through a green offline suite and was caught only live. So before
release, and whenever you change a runtime surface:

1. Confirm the dev install is a junction to this working tree (above), so what
   you test is what you ship.
2. **Shut down any running world before pack work** — a running world holds
   LevelDB locks on `packs/`, and `build:packs` / `git restore` / `git clean`
   will fail on the LOG files. Order: shut down → build packs → launch → test.
3. Enable the module in the test world and check: it reaches `ready` with **no
   console errors** (check `init`, `setup`, and `ready` — a throw in one leaves
   the rest silently dead); every registered setting appears AND gates
   something; every shipped macro runs; each declared compendium opens; and
   **the feature you changed, exercised end-to-end through the UI**. For Active
   Effects, sheets, and drag-and-drop, verify the write landed on the target
   field — not merely that the code ran.
4. Shut the world down before committing: it releases the pack locks, and
   runtime LOG/MANIFEST churn must never be committed.

Report what you exercised and name what you could not reach. "Live-verified"
with no list is not a result.

## Release

1. Bump `module.json` version; update changelog if present.
2. Build + validate + test.
3. **Live-verify (above). This is a go-live gate** — skip only if this machine
   defines no test environment, and state that in the release report.
4. Commit, `git tag v<version>` (must equal module.json version), push branch
   + tag.
5. Confirm publication with BOUNDED polls — **never `gh run watch`, it hangs**:
   `gh release view v<version> --json assets` ~30s apart, capped ~5 min. Then
   verify `https://github.com/NocTempre/acks-content/releases/latest/download/module.json`
   shows the new version. The `/acks-release` skill walks all of this.

## Conventions

- Branch `main`; tags `v<semver>`.
- `compatibility` minimum 14 / verified 14.364; system `acks` minimum 14.
- Every `relationships.requires` entry carries a `reason` and
  `compatibility.minimum` (lib-wrapper for wrapping, socketlib for GM-routed
  writes).
- Declare a pack in `module.json` only once it has content.
- Namespacing (validate-enforced): globals/custom hooks/HB helpers start with
  the camelCased module id; top-level pack `_id`s start with the
  `flags["acks-content"].idPrefix` key; lang keys with `ACKS-CONTENT.`;
  CSS classes with `acks-content-`.
- Design doctrine: **reuse → extend → enhance → invent** — reuse core system
  documents; extend only via `flags["acks-content"]`; enhance with alternate
  sheets/wrappers; invent nothing the system provides (see docs/MODEL.md).
