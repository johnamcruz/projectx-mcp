import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Journal } from "../src/journal.js";

describe("Journal", () => {
  it("appends and filters entries", async () => {
    const j = new Journal(join(mkdtempSync(join(tmpdir(), "pxj-")), "nested", "journal.jsonl"));
    expect(await j.read()).toEqual([]);
    await j.add({ kind: "plan", text: "fade the open", contractId: "A" });
    await j.add({ kind: "lesson", text: "never move the stop away", tags: ["discipline"] });
    await j.add({ kind: "lesson", text: "size down after two losses" });
    expect((await j.read({ kind: "lesson" })).map((e) => e.text)).toEqual(["never move the stop away", "size down after two losses"]);
    expect(await j.read({ tag: "discipline" })).toHaveLength(1);
    expect(await j.read({ contractId: "A" })).toHaveLength(1);
    expect((await j.read({ limit: 1 }))[0].text).toBe("size down after two losses");
  });
});
