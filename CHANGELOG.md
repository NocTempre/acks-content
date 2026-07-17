# Changelog

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
