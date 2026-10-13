// Vitest global setup (vitest.config.ts): when vitest was started directly (`npx vitest run <file>`),
// not through test/run-tests.mjs, make the run's temp root here, before the test workers start.
// Under test/run-tests.mjs the root already exists (ROOT_ENV is set) and is used as it is.
import { ROOT_ENV, installTempRoot } from "./temp-root.mjs";

export default function setup(): (() => void) | void {
  if (process.env[ROOT_ENV]) return;
  const { teardown } = installTempRoot();
  return () => void teardown();
}
