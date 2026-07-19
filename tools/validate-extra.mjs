/**
 * Module-owned extra validation, auto-run by the canonical tools/validate.mjs
 * (section 9) so `npm run validate` also enforces the checks specific to
 * acks-content. Keep this a thin delegator; the actual checks live in the tools
 * it calls. Exit non-zero on failure.
 *
 *   lint-register       IP + schema lint of register/ and cookbook/. No PDFs,
 *                       runs everywhere including CI (`npm run lint:register`).
 *   check-cookbook-drift  Is the committed cookbook/ what register/ compiles
 *                       to? Needs the local reference PDFs and skips cleanly
 *                       without them, so it gates the authoring machines only.
 *
 * Cheapest and most universal first: a register that fails its lint should say
 * so in a second, not after a 40s recompile.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

// Re-exec so each check's own output surfaces and its non-zero exit propagates
// (execFileSync throws, this process exits non-zero). Sequential and
// fail-fast: a drift report is noise while the register itself is broken.
for (const tool of ["lint-register.mjs", "check-cookbook-drift.mjs"]) {
  execFileSync(process.execPath, [path.join(ROOT, "tools", tool)], { stdio: "inherit" });
}
