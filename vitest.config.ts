import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // One temp root per run, removed at the end (KEEP_TEST_TMP=1 keeps it).
    globalSetup: ["test/temp-root.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      // index.ts only wires real dependencies together and starts a process.
      exclude: ["src/index.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { lines: 90, functions: 90, branches: 80 },
    },
  },
});
