import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VECTOR_SCHEMA, expectedResults, runVector, type Vector } from "./vectors.js";

const DIR = join(import.meta.dirname, "..", "vectors");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Vector;

describe("golden order-flow vectors", () => {
  it("ship the four documented scenarios, each with expectations for every call", () => {
    expect(files).toEqual(["bars-and-session.json", "book-fields.json", "completeness.json", "trade-fields.json"]);
    for (const f of files) {
      const v = load(f);
      expect(v.schema).toBe(VECTOR_SCHEMA);
      expect(`${v.name}.json`).toBe(f);
      expect(expectedResults(v).length).toBeGreaterThan(0);
      expect(expectedResults(v).every((e) => e !== undefined)).toBe(true);
      // Steps never go back in time.
      expect(v.steps.every((s, i) => i === 0 || s.at >= v.steps[i - 1].at)).toBe(true);
    }
  });

  for (const f of files) {
    it(`today's code reproduces ${f} exactly`, async () => {
      const v = load(f);
      expect(await runVector(v)).toEqual(expectedResults(v));
    });
  }

  it("the runner refuses an unknown schema and a step back in time", async () => {
    const v = load("trade-fields.json");
    await expect(runVector({ ...v, schema: "other/1" as never })).rejects.toThrow(/unknown vector schema/);
    await expect(runVector({ ...v, steps: [v.steps[1], v.steps[0]] })).rejects.toThrow(/goes back in time/);
  });
});
