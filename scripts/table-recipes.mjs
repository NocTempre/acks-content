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
      // Directed-search rarity modifiers (JJ ~119, all prose): the general-
      // proficiency ranks ladder, its 1d4 level die, the class-proficiency
      // per-rank rule, and the per-level shift. Anchors carry no values.
      specificQualificationMods: {
        shape: "proseValues",
        book: "jj",
        printedPage: 119,
        locate: "a single rank in a specific general proficiency",
        locateBare: true,
        values: [
          { key: "gpRank1", find: "a single rank in a specific general proficiency are", take: "rarityTier" },
          { key: "gpRank2", find: "with two ranks are", take: "rarityTier" },
          { key: "gpRank3", find: "with three ranks are", take: "rarityTier" },
          { key: "gpLevelDie", find: "ranks are uncommon. roll", take: "dice" },
          { key: "gpZeroBand", find: "for each such henchman; on a", take: "band" },
          { key: "gpRollLevelOn", find: "level. on a", take: "int" },
          { key: "gpClassVIPenalty", find: "class vi market, apply a", take: "signedInt" },
          { key: "cpPerRank", find: "is equal to the base class, plus", take: "wordInt" },
          { key: "levelPerAbove1", find: "shift the rarity by", take: "wordInt" },
        ],
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
      // Hireling base morale by role (RR ~166, all prose): specialists
      // default, the named exception groups, spellcaster minimum, the
      // first-level permanent bonus, and the crusader/bladedancer follower
      // score. Which specialist TYPE keys map to which group is consumer
      // code (type-key glue), not page data.
      baseMorale: {
        shape: "proseValues",
        book: "rr",
        printedPage: 166,
        locate: "but rowers and sailors have morale",
        locateBare: true,
        values: [
          { key: "specialistDefault", find: "most specialists have a morale score of", take: "signedInt" },
          { key: "rowersSailors", find: "rowers and sailors have morale of", take: "signedInt" },
          { key: "navigatorsCaptainsScouts", find: "captains, and scouts have morale", take: "signedInt" },
          { key: "marshalsMastersOfficers", find: "mercenary officers have morale", take: "signedInt" },
          { key: "spellcasterMinimum", find: "their minimum morale score is", take: "signedInt" },
          { key: "firstLevelBonus", find: "bonus to morale score when a 0", before: true, span: 24, take: "signedInt" },
          { key: "followerCrusaderBladedancer", find: "followers have a morale score of", take: "signedInt" },
        ],
      },
      // Mercenary-officer base loyalty (RR ~171 prose).
      baseLoyalty: {
        shape: "proseValues",
        book: "rr",
        printedPage: 171,
        locate: "inherent disloyalty",
        locateBare: true,
        values: [{ key: "mercenaryOfficers", find: "officers have a base loyalty of", take: "signedInt" }],
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
      // The RAW occupant system (JJ ~229): WHICH occupant a d100 finds, per
      // building type, with routing to the occupation sub-tables — bands and
      // routing text all read from the page.
      occupationTypes: {
        shape: "gridRows",
        book: "jj",
        printedPage: 229,
        locate: "01-48",
        labelMaxX: 160,
        cellPattern: "rollBand",
        omitNullCells: true,
        cellColumns: [
          { key: "smallCot", x: 168, pattern: "rollBand" },
          { key: "mediumCot", x: 205, pattern: "rollBand" },
          { key: "mediumTownhouse", x: 251, pattern: "rollBand" },
          { key: "largeTownhouse", x: 304, pattern: "rollBand" },
          { key: "generalStreet", x: 352, pattern: "rollBand" },
          { key: "resolve", x: 382, w: 110, pattern: "raw", row: true },
          { key: "special", x: 495, w: 90, pattern: "dashNull", row: true },
        ],
        cellsKey: "bands",
        rows: [
          { key: "laborer", labelRe: "^laborer$" },
          { key: "apprenticeCrafter", labelRe: "^apprentice\\s*crafter" },
          { key: "journeymanCrafter", labelRe: "^journeyman" },
          { key: "masterCrafter", labelRe: "^master\\s*crafter" },
          { key: "apprenticeMerchant", labelRe: "^apprentice\\s*merchant" },
          { key: "licensedMerchant", labelRe: "^licensed" },
          { key: "masterMerchant", labelRe: "^master\\s*merchant" },
          { key: "specialist", labelRe: "^specialist" },
          { key: "hosteller", labelRe: "^hosteller" },
          { key: "entertainer", labelRe: "^entertainer" },
          { key: "thief", labelRe: "^thief" },
          { key: "legionary", labelRe: "^legionary" },
          { key: "mercenary", labelRe: "^mercenary" },
          { key: "fighter", labelRe: "^fighter$" },
          { key: "minorEcclesiastic", labelRe: "^minor\\s*ecclesiastic" },
          { key: "crusader", labelRe: "^crusader" },
          { key: "minorMagician", labelRe: "^minor\\s*magician" },
        ],
        emit: { container: "rows", keyField: "type" },
      },
      // Per-category occupation sub-tables (d100 band → occupation, with the
      // book's own special notes like "25% are mages"). Self-locating like
      // culture blocks; each stitches reading order for long lists (artisan).
      // Every window below is page geometry read off the printings: the JJ
      // mixes half-page pairs (p~229), four quarter tables, and full-width
      // tables whose Mercantile Interest notes wrap (merchant, artisan).
      occupationSubTables: {
        shape: "bandList",
        book: "jj",
        subTables: [
          { id: "laborer", printedPage: 229, anchor: "Laborer Occupation", window: [60, 300], bandWindow: [75, 115], occWindow: [115, 232], specialWindow: [232, 300] },
          { id: "specialist", printedPage: 229, locate: "animal trainer (Wild)", anchor: "Specialist Occupation", window: [300, 585], bandWindow: [330, 365], occWindow: [365, 460], specialWindow: [460, 585] },
          { id: "mercenary", printedPage: 230, locate: "Bowman/slinger", anchor: "Mercenary Occupation", window: [30, 156], bandWindow: [40, 80], occWindow: [80, 156], specialWindow: [156, 157] },
          { id: "entertainer", printedPage: 230, locate: "actor (Journeyman)", anchor: "Entertainer Occupation", window: [156, 289], bandWindow: [163, 204], occWindow: [204, 289], specialWindow: [289, 290] },
          { id: "ecclesiastic", printedPage: 230, locate: "Almsgiver", anchor: "Ecclesiastic Occupation", window: [289, 425], bandWindow: [296, 337], occWindow: [337, 425], specialWindow: [425, 426] },
          { id: "magician", printedPage: 230, anchor: "Magician Occupation", window: [425, 565], bandWindow: [432, 473], occWindow: [473, 565], specialWindow: [565, 566] },
          { id: "merchant", printedPage: 230, locate: "Mercantile Interest", anchor: "Merchant Occupation", window: [40, 585], bandWindow: [50, 97], occWindow: [97, 196], specialWindow: [196, 585] },
          { id: "artisan", printedPage: 231, locate: "Wheelwright", anchor: "Artisan Occupation", window: [40, 585], bandWindow: [75, 122], occWindow: [122, 224], specialWindow: [224, 585] },
          // No hosteller d100 sub-table exists in the printing — hosteller
          // occupants resolve by establishment ("inns are always owned by
          // innkeepers"); street draws reroll them like class-routed rows.
        ],
      },
      // 0th-level occupation → proficiency packages (JJ "Occupations and
      // Proficiencies", four consecutive pages). Row keys are page content
      // (occupation names, lowercased); values are comma token lists like
      // "Profession (merchant), Craft (scribe), Bargaining, Folkways".
      occupationPackages: {
        shape: "harvestPairs",
        book: "jj",
        printedPage: 254,
        locate: "Blacksmith",
        pageSpan: 5,
        column: { xMin: 40, xMax: 545 },
        labelMaxX: 130,
        minTokens: 2,
      },
      // Per-class RESTRICTIONS from the class descriptions' opening lines
      // ("Bladedancers are human women who…"). Each block self-locates its
      // class page; the capture reads the restriction word, never a list of
      // classes. bucket/rarity/race are DERIVED by consumers from the
      // already-imported distribution/rarity tables + class-key adjectives,
      // so they need no recipe here.
      classRestrictions: {
        shape: "proseValues",
        book: "rr",
        valueBlocks: [
          { id: "bladedancer", printedPage: 56, locate: "Bladedancers are", values: [{ key: "sex", find: "bladedancers are human", take: "sexWord" }] },
          { id: "priestess", printedPage: 64, locate: "Priestesses are", values: [{ key: "sex", find: "priestesses are", take: "sexWord" }] },
          { id: "witch", printedPage: 76, locate: "witches, however, are", values: [{ key: "sex", find: "witches, however, are", take: "sexWord" }] },
          // NO warlock alignment: the RR states it CONDITIONALLY ("If
          // chaotic, the warlock can create necromantic servants") — the
          // class is not alignment-bound in this printing, so nothing is
          // extracted and the alignment-openness shift stays inert.
        ],
        emit: { path: ["classes"] },
      },
      // Culture name lists (RR "People of Aurëpos" + BTA for dwarves). Each
      // block is SELF-LOCATING: its anchor (the list's first male name — a
      // short-label page anchor) finds the page, the print column, and the
      // start row, so stacked two-column culture blocks never cross-match.
      // NAMES are extracted data; label/patronym-template/race are
      // structural assists; appearance PROSE is never touched.
      cultures: {
        shape: "nameList",
        book: "rr",
        fields: [
          { key: "male", label: "Male Names:" },
          { key: "female", label: "Female Names:" },
          { key: "surnames", label: "Surnames:" },
        ],
        blocks: [
          { cultureId: "auran", printedPage: 502, anchor: "Aurëus", meta: { label: "Tirenean (Auran)", surnameStyle: "hereditary" } },
          { cultureId: "celdorean", printedPage: 496, anchor: "Ardumanish", meta: { label: "Celdorean", patronym: { male: "{parent}apur", female: "{parent}adar" } } },
          { cultureId: "dwarven", book: "bta", printedPage: 21, anchor: "Arsic", meta: { label: "Dwarven (Meniri/Jutting)", surnameStyle: "hereditary", race: "dwarf" } },
          { cultureId: "elven", printedPage: 496, anchor: "Aodan", meta: { label: "Elven (Argollëan)", patronym: { male: "Mag {parent}", female: "Ni {parent}" }, race: "elf" } },
          { cultureId: "jutlandic", printedPage: 497, anchor: "Asmund", meta: { label: "Jutlandic", patronym: { male: "{parent}sson", female: "{parent}dottir" } } },
          { cultureId: "kemeshi", printedPage: 498, anchor: "Ankhopten", meta: { label: "Kemeshi" } },
          { cultureId: "krysean", printedPage: 498, anchor: "Aibekeres", meta: { label: "Krysean", patronym: { male: "{parent}", female: "{parent}" } } },
          { cultureId: "kushtu", printedPage: 498, anchor: "Abimbola", meta: { label: "Kushtu" } },
          { cultureId: "nicean", printedPage: 499, anchor: "Apollonis", meta: { label: "Nicean", patronym: { male: "{parent}ides", female: "{parent}ides" } } },
          { cultureId: "opelenean", printedPage: 499, anchor: "Abedsh", meta: { label: "Opelenean", patronym: { male: "Bar {parent}", female: "Bat {parent}" } } },
          { cultureId: "rornish", printedPage: 500, anchor: "Aeron", meta: { label: "Rornish", patronym: { male: "{parent}", female: "{parent}" } } },
          { cultureId: "shebatean", printedPage: 500, anchor: "Abaddon", meta: { label: "Shebatean", patronym: { male: "Ibn {parent}", female: "Bint {parent}" } } },
          { cultureId: "skysos", printedPage: 501, anchor: "Attila", meta: { label: "Skysos" } },
          { cultureId: "somirean", printedPage: 501, anchor: "Artashumara", meta: { label: "Somirean" } },
          { cultureId: "zaharan", printedPage: 503, anchor: "Ashurdan", meta: { label: "Zaharan", patronym: { male: "Bet-{parent}", female: "Bet-{parent}" }, race: "zaharan" } },
          { cultureId: "thrassian", printedPage: 502, anchor: "Akalamdug", meta: { label: "Thrassian", race: "thrassian" } },
        ],
      },
      // NPC minimum age by class group (JJ ~248): level rows × six labeled
      // trajectory columns. "44+" caps a column; "-" means the trajectory
      // never reaches that level. Which class keys map to which column is
      // consumer interpretation (henchmen), not page data.
      ageByClass: {
        shape: "gridRows",
        book: "jj",
        printedPage: 248,
        locate: "(carouser)",
        locateBare: true,
        labelMaxX: 90,
        minCells: 4,
        cellColumns: [
          { key: "noble", x: 117, pattern: "agePlus" , row: true },
          { key: "magistrate", x: 193, pattern: "agePlus" , row: true },
          { key: "commoner", x: 270, pattern: "agePlus" , row: true },
          { key: "crusader", x: 345, pattern: "agePlus" , row: true },
          { key: "mage", x: 421, pattern: "agePlus" , row: true },
          { key: "thief", x: 498, pattern: "agePlus" , row: true },
        ],
        rows: Array.from({ length: 15 }, (_, i) => ({ key: String(i), labelRe: `^${i}$`, set: { level: i } })),
        emit: { container: "rows", keyField: "level" },
      },
      // 0th-level general proficiency count by race and age band (JJ ~253).
      proficienciesByAge: {
        shape: "gridRows",
        book: "jj",
        printedPage: 253,
        locate: "121+",
        locateBare: true,
        column: { xMin: 40, xMax: 570 }, // page-margin tab letters live at ~x597
        labelMaxX: 125,
        minCells: 4,
        cellColumns: [
          { key: "human", x: 189, pattern: "ageBand" , row: true },
          { key: "dwarf", x: 270, pattern: "ageBand" , row: true },
          { key: "elf", x: 352, pattern: "ageBand" , row: true },
          { key: "nobiran", x: 434, pattern: "ageBand" , row: true },
          { key: "zaharan", x: 517, pattern: "ageBand" , row: true },
        ],
        rows: Array.from({ length: 8 }, (_, i) => ({ key: String(i + 1), labelRe: `^${i + 1}$`, set: { count: i + 1 } })),
        emit: { container: "rows", keyField: "count" },
      },
      // 0th-level NPC hit dice by race × station (JJ ~252).
      hd0: {
        shape: "gridRows",
        book: "jj",
        printedPage: 252,
        locate: "(1 hp)",
        locateBare: true,
        labelMaxX: 140,
        minCells: 3,
        cellColumns: [
          { key: "noncombatant", x: 140, w: 100, pattern: "hdCell" , row: true },
          { key: "commoner", x: 240, w: 90, pattern: "hdCell" , row: true },
          { key: "militia", x: 330, w: 115, pattern: "hdCell" , row: true },
          { key: "fighter1", x: 445, w: 115, pattern: "hdCell" , row: true },
        ],
        rows: [
          { key: "dwarf", labelRe: "^dwarf$" },
          { key: "elf", labelRe: "^elf$" },
          { key: "human", labelRe: "^human$" },
        ],
        emit: { container: "rows", keyField: "race" },
      },
      // BTA dwarven castes — the book states the caste split in prose, not a
      // grid. Anchors carry no values; percentages are read from the page.
      // The Oathsworn share is the book's own remainder (no printed figure).
      dwarvenCastes: {
        shape: "proseValues",
        book: "bta",
        printedPage: 21,
        locate: "of dwarves are Craftborn",
        locateBare: true,
        values: [
          { key: "highbornPct", find: "making up about", take: "pct" },
          { key: "craftbornPct", find: "of dwarves are craftborn", before: true, take: "pct", span: 30 },
          { key: "workbornPct", find: "largest caste", take: "pct" },
        ],
        emit: {
          path: [],
          merge: {
            oathswornPct: null, // remainder of 100 — computed by consumers, never printed
            order: ["highborn", "craftborn", "workborn", "oathsworn"],
            labels: { highborn: "Highborn", craftborn: "Craftborn", workborn: "Workborn", oathsworn: "Oathsworn" },
          },
        },
      },
    },
  },
  // Slavery (JJ ~409-410) — RAW values behind the henchmen `enableSlavery`
  // toggle. Import always materializes the doc; consumers gate USE by the
  // world setting. Common-slave economics are prose; troop prices are a grid.
  slavery: {
    source: { book: "ACKS II Judges Journal", pages: "409-410" },
    gatedBy: "enableSlavery",
    tables: {
      commonSlaves: {
        shape: "proseValues",
        book: "jj",
        printedPage: 409,
        locate: "laborers can be bought in markets",
        locateBare: true,
        values: [
          { key: "laborerCost", find: "slave laborers can be bought in markets at a cost of", take: "gp" },
          { key: "laborerUpkeep", find: "tasks. they cost", take: "gp" },
          { key: "laborerLoyalty", find: "base loyalty scores of", occurrence: 1, take: "signedInt" },
          { key: "laborerConstructionSp", find: "construction rate of", take: "sp" },
          { key: "laborersPerFamily", find: "treat every", take: "int" },
          { key: "domainMoralePct1", find: "population consists of", occurrence: 1, take: "pct" },
          { key: "domainMoralePenalty1", find: "morale is decreased by", occurrence: 1, take: "int" },
          { key: "domainMoralePct2", find: "population consists of", occurrence: 2, take: "pct" },
          { key: "domainMoralePenalty2", find: "morale is decreased by", occurrence: 2, take: "int" },
          { key: "domainMoralePct3", find: "if the domain is", take: "pct" },
          { key: "domainMoralePenalty3", find: "morale is decreased by", occurrence: 3, take: "int" },
          { key: "householdCost", find: "household slaves can be bought in markets at a cost of", take: "gp" },
          { key: "householdUpkeep", find: "each, and cost", take: "gp" },
          { key: "householdLoyalty", find: "base loyalty scores of", occurrence: 2, take: "signedInt" },
          { key: "pleasureCost", find: "pleasure slaves can be bought in markets at a cost of", take: "gpRange" },
          { key: "pleasureUpkeep", find: "pleasure slaves cost", take: "gp" },
          { key: "pleasureMorale", find: "base morale scores of", take: "signedInt" },
          { key: "professionalWageMult", find: "cost of a professional slave is equal to", take: "int" },
          { key: "professionalLess", find: "wages per month, less", take: "gp" },
          { key: "professionalUpkeep", find: "all professional slaves cost", take: "gp" },
          { key: "professionalLoyalty", find: "base loyalty scores of", occurrence: 3, take: "signedInt" },
          { key: "hirelingDisplacement", find: "slaves will replace", occurrence: 1, take: "pct2" },
        ],
      },
      // Slave troop purchase prices by race (JJ ~410) — sparse grid, dashes
      // where a race fields no such troops.
      slaveTroopCosts: {
        shape: "gridRows",
        book: "jj",
        printedPage: 410,
        locate: "19,750",
        locateBare: true,
        labelMaxX: 140,
        minCells: 6,
        cellPattern: "intDash",
        omitNullCells: true,
        cellsKey: "costs",
        cellColumns: [
          { key: "man", x: 152 },
          { key: "dwarf", x: 185 },
          { key: "elf", x: 217 },
          { key: "kobold", x: 253 },
          { key: "goblin", x: 287 },
          { key: "orc", x: 318 },
          { key: "hobgoblin", x: 356 },
          { key: "gnoll", x: 397 },
          { key: "lizardman", x: 438 },
          { key: "bugbear", x: 481 },
          { key: "ogre", x: 518 },
        ],
        rows: [
          { key: "militia", labelRe: "^militia$" },
          { key: "lightInfantry", labelRe: "^light\\s*infantry$" },
          { key: "heavyInfantry", labelRe: "^heavy\\s*infantry$" },
          { key: "slinger", labelRe: "^slinger$" },
          { key: "bowman", labelRe: "^bowman$" },
          { key: "crossbowman", labelRe: "^crossbowman$" },
          { key: "compositeLongbowman", labelRe: "^composite/?\\s*longbowman$" },
          { key: "lightCavalry", labelRe: "^light\\s*cavalry$" },
          { key: "horseArcher", labelRe: "^horse\\s*archers?$" },
          { key: "mediumCavalry", labelRe: "^medium\\s*cavalry$" },
          { key: "heavyCavalry", labelRe: "^heavy\\s*cavalry$" },
          { key: "cataphractCavalry", labelRe: "^cataphract\\s*cavalry$" },
          { key: "camelArcher", labelRe: "^camel\\s*archers?$" },
          { key: "camelLancer", labelRe: "^camel\\s*lancers?$" },
          { key: "warElephant", labelRe: "^war\\s*elephants?$" },
          { key: "mountedCrossbowman", labelRe: "^mounted\\s*crossbowman$" },
          { key: "beastRider", labelRe: "^beast\\s*riders?$" },
        ],
        emit: { container: "rows", keyField: "type" },
      },
      // Slave-soldier upkeep and indoctrination costs (JJ ~410 prose).
      // Acquisition pipelines (own-realm levies, war captives) are realm play
      // and stay book-gated prose.
      soldierRules: {
        shape: "proseValues",
        book: "jj",
        printedPage: 409,
        locate: "Availability of Slave Soldiers",
        locateBare: true,
        pageSpan: 2, // displacement is stated beside common slaves; upkeep/indoctrination overleaf
        values: [
          { key: "upkeep", find: "slave soldiers cost", take: "gp" },
          { key: "ogreUpkeep", find: "(ogres cost", take: "gp" },
          { key: "mercenaryDisplacement", find: "slave soldiers will replace", take: "pct2" },
          { key: "indoctrinationYears", find: "require a", take: "wordInt" },
          { key: "indoctrinationUpkeep", find: "in upkeep per candidate", before: true, take: "gp" },
          { key: "marshalWage", find: "one marshal (", take: "gp" },
          { key: "marshalPer", find: "is required per", take: "int" },
        ],
      },
    },
  },
  // Settlement market class by urban families (RR "Villages, Towns, and
  // Cities", ~352): the label carries the families band, the class column
  // the market class. Monthly-income column is domain revenue — not
  // extracted here (domain-module scope).
  settlement: {
    source: { book: "ACKS II Revised Rulebook", pages: "352" },
    tables: {
      marketClassByFamilies: {
        shape: "pairs",
        book: "rr",
        printedPage: 352,
        locate: "Metropolis (40,000+)",
        locateBare: true,
        column: { xMin: 300, xMax: 585 },
        labelMaxX: 415,
        cellPattern: "romanClass",
        valueKey: "marketClass",
        rows: [
          { key: "smallVillage", labelRe: "^small\\s*village", labelPattern: "familiesBand" },
          { key: "village1", labelRe: "^village\\s*\\(100", labelPattern: "familiesBand" },
          { key: "village2", labelRe: "^village\\s*\\(160", labelPattern: "familiesBand" },
          { key: "largeVillage", labelRe: "^large\\s*village", labelPattern: "familiesBand" },
          { key: "smallTown", labelRe: "^small\\s*town", labelPattern: "familiesBand" },
          { key: "largeTown", labelRe: "^large\\s*town", labelPattern: "familiesBand" },
          { key: "smallCity", labelRe: "^small\\s*city", labelPattern: "familiesBand" },
          { key: "city", labelRe: "^city\\s*\\(", labelPattern: "familiesBand" },
          { key: "largeCity1", labelRe: "^large\\s*city\\s*\\(5,000", labelPattern: "familiesBand" },
          { key: "largeCity2", labelRe: "^large\\s*city\\s*\\(10,000", labelPattern: "familiesBand" },
          { key: "largeCity3", labelRe: "^large\\s*city\\s*\\(15,000", labelPattern: "familiesBand" },
          { key: "metropolis1", labelRe: "^metropolis\\s*\\(20,000", labelPattern: "familiesBand" },
          { key: "metropolis2", labelRe: "^metropolis\\s*\\(40,000", labelPattern: "familiesBand" },
        ],
        emit: { container: "rows", keyField: "label" },
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
