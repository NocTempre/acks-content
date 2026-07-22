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

// Class-trajectory percentages (JJ "Leveled NPCs by Percentage"): a level
// column and six class-weight columns. The reference collapses runs of equal
// levels into ranges; emitting one row per level (minLevel==maxLevel) resolves
// identically in henchmen's `.find(level in [min,max])` lookup.
const CLASS_PCT_ROWS = Array.from({ length: 15 }, (_, L) => ({
  key: L,
  labelRe: `^${L}$`,
  set: { minLevel: L, maxLevel: L },
}));

// Mercenary Troop Type (RR): label + five race wage columns (dash = the book
// prices no such troops) + morale. Reference keys mirror the availability
// grid's troop ids; wolf/boar riders are beastman entries priced per race.
const MERC_WAGE_ROWS = [
  { key: "peasant", labelRe: "^peasant" },
  { key: "lightInfantry", labelRe: "^light infantry" },
  { key: "heavyInfantry", labelRe: "^heavy infantry" },
  { key: "slinger", labelRe: "^slinger" },
  { key: "bowman", labelRe: "^bowmen|^bowman" },
  { key: "compositeBowman", labelRe: "^composite" },
  { key: "crossbowman", labelRe: "^crossbow" },
  { key: "longbowman", labelRe: "^longbow" },
  { key: "lightCavalry", labelRe: "^light\\s*cavalry" },
  { key: "mountedCrossbowman", labelRe: "^mounted\\s*crossbow" },
  { key: "horseArcher", labelRe: "^horse archer" },
  { key: "mediumCavalry", labelRe: "^medium\\s*cavalry" },
  { key: "heavyCavalry", labelRe: "^heavy\\s*cavalry" },
  { key: "cataphractCavalry", labelRe: "^cataphract" },
  { key: "camelArcher", labelRe: "^camel archer" },
  { key: "camelLancer", labelRe: "^camel lancer" },
  { key: "warElephant", labelRe: "^war elephant" },
  { key: "wolfRider", labelRe: "^wolf\\s*rider" },
  { key: "boarRider", labelRe: "^boar\\s*rider" },
];


// Specialist availability (RR): ~44 rows, drop-caps and en dashes throughout —
// every multi-word label uses \\s* and [–-] (the space between a drop-cap and
// its word vanishes when runs join).
const D = "\\s*[–-]\\s*";
const SPECIALIST_ROWS = [
  ["alchemist", "^alchemist"],
  ["animalTrainerCommon", `^animal\\s*trainer${D}common`],
  ["animalTrainerWild", `^animal\\s*trainer${D}wild`],
  ["animalTrainerGiant", `^animal\\s*trainer${D}giant`],
  ["animalTrainerFantastic", `^animal\\s*trainer${D}fantastic`],
  ["armorer", "^armorer"],
  ["artisanCommon", "^artisan \\(common\\)"],
  ["artisanUncommon", "^artisan \\(uncommon\\)"],
  ["artisanRare", "^artisan \\(rare\\)"],
  ["artillerist", "^artillerist"],
  ["copyist", "^copyist"],
  ["creatureHandlerDomestic", `^creature\\s*handler${D}`],
  ["creatureHandlerWild", `^creature\\s*handler${D}wild`],
  ["creatureHandlerGiant", `^creature\\s*handler${D}giant`],
  ["creatureHandlerFantastic", `^creature\\s*handler${D}fantastic`],
  ["engineer", "^engineer"],
  ["healer", "^healer$"],
  ["healerPhysicker", `^healer${D}physicker`],
  ["healerChirurgeon", `^healer${D}chirurgeon`],
  ["laborerSkilled", `^laborer${D}skilled`],
  ["laborerUnskilled", `^laborer${D}unskilled`],
  ["lawyer", "^lawyer"],
  ["marinerCaptain", `^mariner${D}captain`],
  ["marinerMaster", `^mariner${D}master`],
  ["marinerNavigator", `^mariner${D}navigator`],
  ["marinerSailor", `^mariner${D}sailor`],
  ["marinerRower", `^mariner${D}rower`],
  ["marshalLightInfantry", `^marshal${D}light`],
  ["marshalBowHeavyInfLightCav", `^marshal${D}bow`],
  ["marshalHeavyCavHorseArcher", `^marshal${D}heavy`],
  ["marshalCataphract", `^marshal${D}cataphract`],
  ["mercOfficerLieutenant", `^mercenary\\s*officer${D}lieutenant`],
  ["mercOfficerCaptain", `^mercenary\\s*officer${D}captain`],
  ["mercOfficerColonel", `^mercenary\\s*officer${D}colonel`],
  ["mercOfficerGeneral", `^mercenary\\s*officer${D}general`],
  ["quartermaster", "^quartermaster"],
  ["ruffianCarouser", `^ruffian${D}carouser`],
  ["ruffianFootpad", `^ruffian${D}footpad`],
  ["ruffianReciter", `^ruffian${D}reciter`],
  ["ruffianSlayer", `^ruffian${D}slayer`],
  ["ruffianSpy", `^ruffian${D}spy`],
  ["ruffianThug", `^ruffian${D}thug`],
  ["sage", "^sage"],
  ["scout", "^scout"],
  ["siegeEngineer", "^siege\\s*engineer"],
  ["translator", "^translator"],
  ["writerRank1", `^writer${D}rank\\s*1`],
  ["writerRank2", `^writer${D}rank\\s*2`],
  ["writerRank3", `^writer${D}rank\\s*3`],
  ["writerRank4", `^writer${D}rank\\s*4`],
].map(([key, labelRe]) => ({ key, labelRe }));

const RARITY_TIER_ROWS = [
  { key: "ubiquitous", labelRe: "^ubiquitous" },
  { key: "common", labelRe: "^common$" },
  { key: "uncommon", labelRe: "^uncommon" },
  { key: "rare", labelRe: "^rare$" },
  { key: "veryRare", labelRe: "^very\\s*rare" },
  { key: "extremelyRare", labelRe: "^extremely\\s*rare" },
  { key: "legendary", labelRe: "^legendary" },
];

// Short print names on the screen grid → registry class keys.
const CLASS_MAP = {
  Spellsword: "elven spellsword",
  Nightblade: "elven nightblade",
  Craftpriest: "dwarven craftpriest",
  Vaultguard: "dwarven vaultguard",
  Ruinguard: "zaharan ruinguard",
  Wonderworker: "nobiran wonderworker",
};

export const TABLE_RECIPES = {
  rarity: {
    source: { book: "ACKS II Judges Journal 118-119 + Judges Screen" },
    tables: {
      classRarityTables: {
        shape: "pairs",
        book: "js",
        printedPage: 18,
        locate: "Ubiquitous",
        column: { xMin: 0, xMax: 300 },
        startAfter: "Classes",
        labelMaxX: 84,
        cellPattern: "refListLower",
        rows: RARITY_TIER_ROWS,
        emit: {
          path: ["variants", "default", "tiers"],
          merge: { variants: { default: { label: "ACKS-HENCHMEN.rarityTable.default" } } },
        },
      },
      rarityAvailability: {
        shape: "gridRows",
        book: "jj",
        printedPage: 118,
        locate: "2d8",
        labelMaxX: 135,
        minCells: 4,
        marketCells: 6,
        cellPattern: "raw",
        rows: RARITY_TIER_ROWS,
        emit: { container: "rows", keyField: "rarity" },
      },
      randomHenchmanLevel: {
        shape: "pairs",
        book: "js",
        printedPage: 18,
        locate: "Random Henchman Level",
        column: { xMin: 460, xMax: 620 },
        labelMaxX: 550,
        cellPattern: "int",
        valueKey: "level",
        rows: [
          { key: 0, labelRe: "lower", labelPattern: "rollBand" },
          { key: 1, labelRe: "^11", labelPattern: "rollBand" },
          { key: 2, labelRe: "^17", labelPattern: "rollBand" },
          { key: 3, labelRe: "^19", labelPattern: "rollBand" },
        ],
        emit: { container: "rows", merge: { formula: "1d20" } },
      },
      classDistribution: {
        shape: "bandGrid",
        book: "js",
        printedPage: 18,
        locate: "1d100",
        column: { xMin: 0, xMax: 460 },
        labelMaxX: 78,
        headerMark: "1d100",
        cellColumns: [
          { key: "arcane", x: 97 },
          { key: "thief", x: 171 },
          { key: "divine", x: 240 },
          { key: "fighter", x: 312 },
          { key: "explorer", x: 368 },
          { key: "venturer", x: 413 },
        ],
        classMap: CLASS_MAP,
        rows: [
          { key: 0, labelRe: "^1\\s*[-–]\\s*40" },
          { key: 1, labelRe: "^41" },
          { key: 2, labelRe: "^61" },
          { key: 3, labelRe: "^81" },
          { key: 4, labelRe: "^91\\s*[-–]\\s*94" },
          { key: 5, labelRe: "^95" },
          { key: 6, labelRe: "^97" },
          { key: 7, labelRe: "^99" },
        ],
      },
    },
  },
  wages: {
    source: { book: "ACKS II Revised Rulebook", pages: "166-171" },
    tables: {
      henchmanWageByLevel: {
        shape: "pairs",
        book: "rr",
        printedPage: 168,
        locate: "Henchmen Monthly Wage",
        cellPattern: "int",
        // Two side-by-side ladder halves; the facing column's prose sits
        // right of x~300 and is excluded by the part bounds.
        parts: [
          { column: { xMin: 50, xMax: 168 }, labelMaxX: 100, rows: [0,1,2,3,4,5,6,7].map((L) => ({ key: String(L), labelRe: `^${L}$` })) },
          { column: { xMin: 170, xMax: 300 }, labelMaxX: 215, rows: [8,9,10,11,12,13,14].map((L) => ({ key: String(L), labelRe: `^${L}$` })) },
        ],
        emit: { wrap: "byLevel" },
      },
      signingBonus: {
        shape: "gridRows",
        book: "js",
        printedPage: 18,
        locate: "Signing Bonus (Bribery)",
        column: { xMin: 240, xMax: 520 },
        labelMaxX: 315,
        cellKeys: ["1", "2", "3"],
        cellPattern: "wagePeriod",
        rows: [
          { key: "proficient", labelRe: "^proficient$" },
          { key: "nonProficient", labelRe: "^non[–-]?\\s*proficient" },
        ],
      },
      mercenaryWages: {
        shape: "gridRows",
        book: "rr",
        printedPage: 169,
        locate: "Gp Wage per Month",
        labelMaxX: 385,
        cellColumns: [
          { key: "man", x: 393 },
          { key: "dwarf", x: 422 },
          { key: "elf", x: 450 },
          { key: "goblin", x: 480 },
          { key: "orc", x: 510 },
          { key: "morale", x: 542, row: true },
        ],
        cellsKey: "wages",
        cellPattern: "intDash",
        omitNullCells: true,
        rows: MERC_WAGE_ROWS,
        emit: { container: "rows", keyField: "type" },
      },
    },
  },
  people: {
    source: { book: "ACKS II Judges Journal", pages: "245-257" },
    tables: {
      classPercentages: {
        shape: "gridRows",
        book: "jj",
        printedPage: 247,
        locate: "Leveled NPCs by Percentage",
        labelMaxX: 160,
        cellKeys: ["fighter", "crusader", "thief", "mage", "explorer", "venturer"],
        cellsKey: "weights",
        cellPattern: "int",
        rows: CLASS_PCT_ROWS,
        emit: { container: "rows" },
      },
      // Auran (Tirenean) name lists — the empire's default culture. Names are
      // DATA (persist); the appearance PROSE stays book-gated. Located on the
      // unique Auran surname so the two-column page can't confuse cultures.
      cultures: {
        shape: "nameList",
        book: "rr",
        printedPage: 504,
        locate: "Amadorus",
        column: { xMin: 300, xMax: 545 },
        fields: [
          { key: "male", label: "Male Names:" },
          { key: "female", label: "Female Names:" },
          { key: "surnames", label: "Surnames:" },
        ],
        emit: { wrapCulture: { cultureId: "auran", label: "Tirenean (Auran)", surnameStyle: "hereditary" } },
      },
    },
  },
  availability: {
    source: { book: "ACKS II Revised Rulebook", pages: "162-165, 172" },
    tables: {
      searchFees: {
        shape: "pairs",
        book: "rr",
        printedPage: 162,
        locate: "1d6+15gp",
        column: { xMin: 50, xMax: 290 },
        labelMaxX: 95,
        cellPattern: "diceFormula",
        rows: [
          { key: "1", labelRe: "^I$" },
          { key: "2", labelRe: "^II$" },
          { key: "3", labelRe: "^III$" },
          { key: "4", labelRe: "^IV$" },
          { key: "5", labelRe: "^V$" },
          { key: "6", labelRe: "^VI$" },
        ],
        emit: { wrap: "byMarketClass" },
      },
      specialistAvailability: {
        shape: "gridRows",
        book: "rr",
        printedPage: 165,
        locate: "Artisan (common)",
        labelMaxX: 235,
        marketCells: 6,
        cellPattern: "raw",
        trailing: [{ key: "wage", pattern: "gpPerUnit", expand: true }],
        rows: SPECIALIST_ROWS,
        emit: { container: "rows", keyField: "type" },
      },
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
