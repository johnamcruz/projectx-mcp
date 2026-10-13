import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
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

  it("writes ts first on each line", async () => {
    const j = new Journal(join(mkdtempSync(join(tmpdir(), "pxj-")), "journal.jsonl"));
    await j.add({ kind: "note", text: "x", ts: "2026-03-10T15:00:00.000Z" });
    expect(readFileSync(j.path, "utf8")).toMatch(/^\{"ts":"2026-03-10T15:00:00.000Z","kind":"note"/);
  });

  it("readSince returns the window oldest first, across chunk boundaries, skipping garbage", async () => {
    const j = new Journal(join(mkdtempSync(join(tmpdir(), "pxj-")), "journal.jsonl"));
    expect(await j.readSince(0)).toEqual([]);
    const t0 = Date.parse("2026-03-10T15:00:00Z");
    for (let i = 0; i < 20; i++) await j.add({ kind: "note", text: `entry ${i} ${"é".repeat(i)}`, ts: new Date(t0 + i * 60_000).toISOString() });
    appendFileSync(j.path, "{torn line\n");
    // An old-format line (ts last) still counts.
    appendFileSync(j.path, JSON.stringify({ kind: "note", text: "old format", ts: new Date(t0 + 20 * 60_000).toISOString() }) + "\n");
    for (const chunk of [7, 64, 1 << 16]) {
      const got = await j.readSince(t0 + 15 * 60_000, chunk);
      expect(got.map((e) => e.text)).toEqual([15, 16, 17, 18, 19].map((i) => `entry ${i} ${"é".repeat(i)}`).concat("old format"));
    }
  });

  it("readSince stops at the first line older than the window (plus slack) instead of reading the whole file", async () => {
    const j = new Journal(join(mkdtempSync(join(tmpdir(), "pxj-")), "journal.jsonl"));
    const t0 = Date.parse("2026-03-10T15:00:00Z");
    // A recent entry at the very start, then an old one, then the window: the scan must not reach the start.
    await j.add({ kind: "note", text: "unreachable", ts: new Date(t0 + 3600_000).toISOString() });
    await j.add({ kind: "note", text: "old", ts: new Date(t0 - 3600_000).toISOString() });
    // Slightly out of order (within the 5 min slack) is still found.
    await j.add({ kind: "note", text: "late append", ts: new Date(t0 - 60_000 + 1).toISOString() });
    await j.add({ kind: "note", text: "in window", ts: new Date(t0).toISOString() });
    // Appended last but 30 s older than the window: skipped, and the scan goes on past it (slack).
    await j.add({ kind: "note", text: "older, appended last", ts: new Date(t0 - 90_000).toISOString() });
    expect((await j.readSince(t0 - 60_000, 16)).map((e) => e.text)).toEqual(["late append", "in window"]);
  });

  it("readSince does not let a stale line in the middle hide newer lines before it", async () => {
    const j = new Journal(join(mkdtempSync(join(tmpdir(), "pxj-")), "journal.jsonl"));
    const t0 = Date.parse("2026-03-10T15:00:00Z");
    await j.add({ kind: "note", text: "A", ts: new Date(t0).toISOString() });
    await j.add({ kind: "note", text: "stale", ts: new Date(t0 - 86_400_000).toISOString() });
    await j.add({ kind: "note", text: "B", ts: new Date(t0 + 1_000).toISOString() });
    expect((await j.readSince(t0 - 60_000)).map((e) => e.text)).toEqual(["A", "B"]);
  });

  it("readSince stops after 50 old lines in a row, not before", async () => {
    const t0 = Date.parse("2026-03-10T15:00:00Z");
    const build = async (oldLines: number) => {
      const j = new Journal(join(mkdtempSync(join(tmpdir(), "pxj-")), "journal.jsonl"));
      await j.add({ kind: "note", text: "beyond", ts: new Date(t0).toISOString() });
      for (let i = 0; i < oldLines; i++) await j.add({ kind: "note", text: `old ${i}`, ts: new Date(t0 - 86_400_000).toISOString() });
      await j.add({ kind: "note", text: "window", ts: new Date(t0).toISOString() });
      return (await j.readSince(t0 - 60_000)).map((e) => e.text);
    };
    expect(await build(49)).toEqual(["beyond", "window"]);
    expect(await build(50)).toEqual(["window"]);
  });

  it("readSince counts only consecutive old lines: a new line in between restarts the run", async () => {
    const t0 = Date.parse("2026-03-10T15:00:00Z");
    const j = new Journal(join(mkdtempSync(join(tmpdir(), "pxj-")), "journal.jsonl"));
    const old = async (n: number) => {
      for (let i = 0; i < n; i++) await j.add({ kind: "note", text: "old", ts: new Date(t0 - 86_400_000).toISOString() });
    };
    await j.add({ kind: "note", text: "beyond", ts: new Date(t0).toISOString() });
    await old(30);
    await j.add({ kind: "note", text: "mid", ts: new Date(t0).toISOString() });
    await old(30);
    await j.add({ kind: "note", text: "window", ts: new Date(t0).toISOString() });
    expect((await j.readSince(t0 - 60_000)).map((e) => e.text)).toEqual(["beyond", "mid", "window"]);
  });
});
