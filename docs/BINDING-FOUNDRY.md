# Foundry engine binding (stub — defined separately from the cookbook)

Original design content (in-repo). The cookbook (`docs/COOKBOOK.md`) is an
engine-agnostic database; **this** document owns everything Foundry-specific.
The two are versioned independently: this binding declares
`consumes: acks-cookbook/1`. The engine can change (Foundry versions, rewrites,
other VTTs) while cookbooks stay valid.

## Responsibilities of the binding (none of these live in the cookbook)

- **Routing:** register kind → Foundry document plan. `kind.monster` → Actor
  type `monster` (+ embedded weapon/ability Items); `kind.monsterLegacy` (AX
  appendix blocks) → the same Actor surface via a stats translation, deferring
  to the entry `meta.revisedBy` names when that book is open on this seat;
  `kind.npc` → Actor from the parsed statline (values persist in world fields,
  ability scores/gear notes in `flags["acks-content"].npc`, proficiencies
  through the ability-provider tiers); `kind.location` → JournalEntry page
  (one JournalEntry per `meta.group`, body = lazy `@PdfText` tag + creature
  links from the seat-extracted creature lookups — pin the page to a scene to
  attach it to the map); `kind.rolltable` → RollTable (ranges from shipped
  section structure, row text materialized at import into the GM's world — the
  hand-typed-table equivalence — formula from the page's dice locator, else
  derived mechanically from ranges starting at 1); notes → JournalEntry (the
  "memorial wall"); definitions → tooltip/`@PdfText` targets. Unrouted kinds
  default to JournalEntry — routing coverage may lag capture without losing
  anything.
- **Field mapping:** executor output → `system.*` paths (the successor of
  `scripts/stats-map.mjs`). E.g. `stats.armorClass` → `system.aac.value`,
  save class+level → the saves LUT, attacks → weapon Items with
  `flags.acks-monsters.*` (damageType/naturalWeapon/extraordinary from the
  executor's `{key, ref}` triples and glyphColor result).
- **UI:** the `@PdfText` enricher, lazy tooltip resolution through the node
  graph (citing book for values, defining book for descriptor prose, stubs
  otherwise), concept→examples surfacing, the audit dialog.
- **Possession model:** per-seat book connection, fingerprint gate,
  session-memory prose, world persistence of GM-imported values (allowed there
  — the hand-typed equivalence; never in the cookbook).

## Contract with the executor

The binding embeds the dumb executor (`scripts/executor.mjs`) and calls it per
node id; it receives extract JSON and builds documents from it. The binding
must treat executor stubs/misses as renderable states (stub + citation), never
errors. No binding code may re-derive content the executor didn't produce.

*(To be expanded when the module runtime is rewired from the PoC recipes to the
cookbook. The PoC's enricher/audit/import flows are the prototypes.)*
