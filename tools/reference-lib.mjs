/**
 * Where the LOCAL reference PDFs live, and whether this machine has them.
 *
 * Dev-harness only. The library is licensed material: it is never committed,
 * never shipped, and never present in CI — so every tool that reads it must be
 * able to say "not here" and skip cleanly rather than fail. Kept in one place
 * so the compiler, the acceptance gate and the drift check cannot disagree
 * about which printing they are reading.
 */
import fs from "node:fs";

export const LIB = "C:\\Proj\\acks-reference\\ACKSII";
export const LIB_AX = "C:\\Proj\\acks-reference\\AX";

/** Book id -> the exact printing the register's page numbers were read from. */
export const FILES = {
  rr: `${LIB}\\ACKSII_Revised_Rulebook_DIGITAL_FINAL_r10_2nd_Printing.pdf`,
  jj: `${LIB}\\ACKSII_Judges_Journal_DIGITAL_FINAL_r9_2nd_Printing.pdf`,
  mm: `${LIB}\\ACKSII_Monstrous_Manual_DIGITAL_FINAL_r7_2nd_Printing.pdf`,
  ax2: `${LIB_AX}\\AX2_Secrets_of_the_Nethercity_-_Bookmarked.pdf`,
  ax3: `${LIB_AX}\\AX3_Capital_of_the_Borderlands.pdf`,
};

/**
 * True only when EVERY book is readable. A partial library still lets the
 * compiler do useful per-book work, but it cannot reproduce the whole cookbook
 * — so the drift check needs the stricter question, not "some book is here".
 */
export const referenceComplete = () => Object.values(FILES).every((f) => fs.existsSync(f));
