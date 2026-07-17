/**
 * Module-owned extra validation, auto-run by the canonical tools/validate.mjs
 * (section 8) so `npm run validate` also enforces acks-content's IP-safety
 * lint. Keep this a thin delegator; the actual checks live in the linters it
 * calls (also exposed as `npm run lint:register`). Exit non-zero on failure.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

// Re-exec so a lint failure's own output surfaces and its non-zero exit
// propagates (execFileSync throws, this process exits non-zero).
execFileSync(process.execPath, [path.join(ROOT, "tools", "lint-register.mjs")], { stdio: "inherit" });
