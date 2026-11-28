// Generate the large benchmark session. Usage:
//   node --experimental-strip-types scripts/generate-session.ts <small|large|huge> <outputDir> [cwd]
// Prints the session file path and its statistics as JSON.
import { mkdirSync, statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendBigSession, SIZES, type BigSessionSize } from "../test/fixtures/big-session.ts";

const [sizeName = "large", output = "tmp/bench-session", cwd = process.cwd()] = process.argv.slice(2);
if (!(sizeName in SIZES)) throw new Error(`Unknown size ${sizeName}; use ${Object.keys(SIZES).join(", ")}`);
mkdirSync(output, { recursive: true });
const manager = SessionManager.create(cwd, output);
const started = Date.now();
const stats = appendBigSession(manager, SIZES[sizeName as BigSessionSize]);
const file = manager.getSessionFile()!;
console.log(JSON.stringify({ size: sizeName, file, bytes: statSync(file).size, generatedMs: Date.now() - started, ...stats }));
