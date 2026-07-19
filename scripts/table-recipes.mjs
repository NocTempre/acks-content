/**
 * Table extraction recipes — geometry + patterns only, NEVER values (docs/
 * COOKBOOK.md, docs/RECIPES.md). Each entry says which book/page a ruledata
 * table lives on, where the row labels stop and the cells begin, which rows to
 * claim (by label regex), and how to parse each cell. The dice, numbers and
 * wages are read from the reader's own PDF at import time and persist only in
 * their world. Page numbers are cited (printed); the executor locates the PDF
 * page by header text, tolerating the front-matter offset.
 *
 * `docs` groups recipes by ruledata document id; the binding assembles each
 * document from its tables and imports it via the acks-lib ruledata-import
 * contract at world priority.
 */

// Henchman/mercenary availability rows share the RR market-class grid: a label
// column, six market-class cells (dice strings kept raw), and — for henchmen —
// a trailing monthly wage the reference table also carries.
const HENCH_ROWS = [0, 1, 2, 3, 4].map((n) => ({ key: n, labelRe: `(^|\\D)${n}\\D*level` }));

const MERC_ROWS = [
  { key: "lightInfantry", labelRe: "light infantry" },
  { key: "heavyInfantry", labelRe: "heavy infantry" },
  { key: "slinger", labelRe: "slinger" },
  { key: "bowman", labelRe: "(^|[^s])bowman" },
  { key: "crossbowman", labelRe: "^e?crossbowman|[^d ]crossbowman" },
  { key: "compositeBowmanLongbowman", labelRe: "composite bowman", set: { eitherOr: true } },
  { key: "lightCavalry", labelRe: "light\\s*cavalry" },
  { key: "mountedCrossbowman", labelRe: "mounted\\s*crossbowman" },
  { key: "horseArcher", labelRe: "horse archer" },
  { key: "mediumCavalry", labelRe: "medium\\s*cavalry" },
  { key: "heavyCavalry", labelRe: "heavy\\s*cavalry" },
  { key: "cataphractCavalry", labelRe: "cataphract\\s*cavalry" },
  { key: "camelArcher", labelRe: "camel archer", set: { desert: true } },
  { key: "camelLancer", labelRe: "camel lancer", set: { desert: true } },
  { key: "warElephant", labelRe: "war elephant" },
  { key: "beastRider", labelRe: "beast\\s*rider" },
];

export const TABLE_RECIPES = {
  availability: {
    source: { book: "ACKS II Revised Rulebook", pages: "162-165, 172" },
    tables: {
      henchmanAvailability: {
        shape: "gridRows",
        book: "rr",
        printedPage: 164,
        locate: "Hireling (Henchmen) Availability by Market Class",
        labelMaxX: 120,
        marketCells: 6,
        cellPattern: "raw",
        trailing: [{ key: "wage", pattern: "int" }],
        rows: HENCH_ROWS,
        emit: { container: "rows", keyField: "level" },
      },
      mercenaryAvailability: {
        shape: "gridRows",
        book: "rr",
        printedPage: 164,
        locate: "Hireling (Mercenary) Availability by Market Class",
        labelMaxX: 150,
        marketCells: 6,
        cellPattern: "raw",
        rows: MERC_ROWS,
        emit: { container: "rows", keyField: "type" },
      },
    },
  },
};
