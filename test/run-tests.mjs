#!/usr/bin/env node
// `npm test` / `npm run coverage`: vitest run inside one temp root for the run (test/temp-root.mjs),
// made before vitest starts and removed when it exits. Arguments go to `vitest run`.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInRoot } from "./temp-root.mjs";

const vitest = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "vitest", "vitest.mjs");
const { status } = await runInRoot(process.execPath, [vitest, "run", ...process.argv.slice(2)]);
process.exit(status);
