import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlowWriter, flowFileStem, flowFiles, lastRecorded, lineTime, parseCsvLine, readRecorded, readRecordedCsv, readTailLines, readTailLinesAsync } from "../src/flowstore.js";
import { MINUTE_MS, addPrint, newBucket, recordLine, recordOf, type MinuteRecord } from "../src/orderflow.js";

const M0 = Date.UTC(2026, 9, 12, 14, 30);
const C = "CON.F.US.MNQ.Z26";
const iso = (t: number) => new Date(t).toISOString();
const dir = () => mkdtempSync(join(tmpdir(), "pxflow-"));

function minute(t: number, bv: number, sv: number, complete = true): MinuteRecord {
  const b = newBucket(t);
  if (bv) addPrint(b, { t, price: 100, size: bv, side: "buy" });
  if (sv) addPrint(b, { t, price: 100.25, size: sv, side: "sell" });
  return recordOf(b, complete);
}

describe("flow files", () => {
  it("sanitizes the contract id into the file name", () => {
    expect(flowFileStem("CON.F.US/MNQ Z26:x")).toBe("CON.F.US_MNQ_Z26_x");
    expect(flowFiles("/d", C)).toEqual({ csv: join("/d", `${C}.csv`), jsonl: join("/d", `${C}.jsonl`) });
  });

  it("reads the time of a CSV or JSONL line", () => {
    expect(lineTime(`${iso(M0)},1,2`)).toBe(M0);
    expect(lineTime(JSON.stringify({ t: iso(M0) }))).toBe(M0);
    expect(lineTime("{bad")).toBeNull();
    expect(lineTime("   ")).toBeNull();
    expect(lineTime("x,1,2")).toBeNull();
  });
});

describe("FlowWriter", () => {
  it("writes complete minutes as `ISO-time,buy_volume,sell_volume` with no header, plus the full JSONL row", () => {
    const d = dir();
    const w = new FlowWriter(d, 10, () => {});
    w.write(C, minute(M0, 12, 3));
    w.write(C, minute(M0 + MINUTE_MS, 0, 0));
    w.write(C, minute(M0 + 2 * MINUTE_MS, 1, 1, false)); // incomplete: never written
    const f = flowFiles(d, C);
    expect(readFileSync(f.csv, "utf8")).toBe(`${iso(M0)},12,3\n${iso(M0 + MINUTE_MS)},0,0\n`);
    const rows = readFileSync(f.jsonl, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ t: iso(M0), bv: 12, sv: 3, delta: 9, largeBuyVolume: 12, largeSellVolume: 0, complete: true, vap: [[100, 0, 12], [100.25, 3, 0]] });
  });

  it("never duplicates a minute, also across a restart", () => {
    const d = dir();
    new FlowWriter(d, 10, () => {}).write(C, minute(M0, 1, 0));
    const again = new FlowWriter(d, 10, () => {});
    again.write(C, minute(M0, 1, 0));
    again.write(C, minute(M0 - MINUTE_MS, 5, 0));
    again.write(C, minute(M0 + MINUTE_MS, 2, 0));
    again.write(C, minute(M0 + MINUTE_MS, 2, 0));
    const f = flowFiles(d, C);
    expect(readFileSync(f.csv, "utf8").trim().split("\n")).toEqual([`${iso(M0)},1,0`, `${iso(M0 + MINUTE_MS)},2,0`]);
    expect(readFileSync(f.jsonl, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("truncates a partial last line (a write cut short) instead of keeping it as data", () => {
    const d = dir();
    const f = flowFiles(d, C);
    // The row was `...,120,45`; the write stopped after `120,4`, which still parses as a row.
    writeFileSync(f.csv, `${iso(M0)},1,0\n${iso(M0 + MINUTE_MS)},120,4`);
    expect(lastRecorded(f.csv)).toMatchObject({ t: M0, endsWithNewline: false });
    const warnings: string[] = [];
    new FlowWriter(d, 10, (l) => void warnings.push(l)).write(C, minute(M0 + MINUTE_MS, 120, 45));
    expect(readFileSync(f.csv, "utf8")).toBe(`${iso(M0)},1,0\n${iso(M0 + MINUTE_MS)},120,45\n`);
    expect(warnings[0]).toMatch(/partial line; truncated/);
    // A file holding only a partial line is truncated to empty.
    writeFileSync(f.jsonl, `{"t":"${iso(M0)}","bv"`);
    new FlowWriter(d, 10, () => {}).write(C, minute(M0 + 2 * MINUTE_MS, 1, 1));
    expect(readFileSync(f.jsonl, "utf8").split("\n")).toHaveLength(2);
    expect(JSON.parse(readFileSync(f.jsonl, "utf8")).bv).toBe(1);
  });

  it("refuses to write after a partial line longer than the read cap, warning once", () => {
    const d = dir();
    const f = flowFiles(d, C);
    writeFileSync(f.csv, `${iso(M0)},1,0\n${"x".repeat(1024 * 1024 + 10)}`);
    const warnings: string[] = [];
    new FlowWriter(d, 10, (l) => void warnings.push(l)).write(C, minute(M0 + MINUTE_MS, 1, 0));
    expect(warnings.some((w) => /longer than the read cap/.test(w))).toBe(true);
    expect(readFileSync(f.csv, "utf8").endsWith("x")).toBe(true);
  });

  it("catches write errors and warns once per file", () => {
    const d = dir();
    const blocker = join(d, "file");
    writeFileSync(blocker, "x");
    const warnings: string[] = [];
    const w = new FlowWriter(join(blocker, "sub"), 10, (l) => void warnings.push(l));
    expect(() => {
      w.write(C, minute(M0, 1, 0));
      w.write(C, minute(M0 + MINUTE_MS, 1, 0));
    }).not.toThrow();
    expect(warnings).toHaveLength(2); // the CSV and the JSONL, once each
    expect(warnings[0]).toMatch(/cannot write .*\.csv/);
  });
});

describe("tail reads", () => {
  it("reads lines newest first, never a partial first line, and stops at maxBytes", async () => {
    const d = dir();
    const p = join(d, "f.txt");
    const lines = Array.from({ length: 50_000 }, (_, i) => `line-${i}`);
    writeFileSync(p, `${lines.join("\n")}\n`);
    const all = readTailLines(p, () => false);
    expect(all.lines).toHaveLength(50_000);
    expect(all.lines[0]).toBe("line-49999");
    expect(all.lines[49_999]).toBe("line-0");
    expect(all.truncated).toBe(false);
    const stop = readTailLines(p, (l) => l === "line-49000");
    expect(stop.lines).toHaveLength(1000);
    const capped = readTailLines(p, () => false, 1000);
    expect(capped.truncated).toBe(true);
    expect(capped.lines.length).toBeLessThan(150); // about 1000 bytes of ~10-byte lines
    const cappedAsync = await readTailLinesAsync(p, () => false, 1000);
    expect(cappedAsync.truncated).toBe(true);
    expect(cappedAsync.lines.length).toBeLessThan(150);
    expect(capped.lines.every((l) => /^line-\d+$/.test(l))).toBe(true);
  });

  it("lastRecorded: last timed line and trailing newline; nothing for a missing file", () => {
    const d = dir();
    const p = join(d, "x.csv");
    expect(lastRecorded(p)).toEqual({ t: null, endsWithNewline: true, completeBytes: 0 });
    writeFileSync(p, `${iso(M0)},1,0\ngarbage\n${iso(M0 + MINUTE_MS)},2,0`);
    expect(lastRecorded(p)).toEqual({ t: M0, endsWithNewline: false, completeBytes: `${iso(M0)},1,0\ngarbage\n`.length });
    writeFileSync(p, `${iso(M0)},1,0\n`);
    expect(lastRecorded(p)).toEqual({ t: M0, endsWithNewline: true, completeBytes: `${iso(M0)},1,0\n`.length });
    expect(() => lastRecorded(d)).toThrow();
  });

  it("never returns a partial last line, also when it spans chunks", async () => {
    const d = dir();
    const p = join(d, "f.txt");
    writeFileSync(p, `a\nb\n${"y".repeat(600_000)}`);
    expect(readTailLines(p, () => false)).toMatchObject({ lines: ["b", "a"], endsWithNewline: false, completeBytes: 4 });
    expect(await readTailLinesAsync(p, () => false)).toMatchObject({ lines: ["b", "a"], completeBytes: 4 });
    writeFileSync(p, "z".repeat(600_000));
    expect(readTailLines(p, () => false)).toMatchObject({ lines: [], completeBytes: 0 });
    expect(readTailLines(p, () => false, 1000)).toMatchObject({ lines: [], completeBytes: -1, truncated: true });
  });

  it("readRecordedCsv reads the small CSV rows (buy/sell volume) back to `from`", async () => {
    const d = dir();
    const w = new FlowWriter(d, 10, () => {});
    for (let i = 0; i < 5; i++) w.write(C, minute(M0 + i * MINUTE_MS, i + 1, 1));
    const r = await readRecordedCsv(d, C, M0 + 2 * MINUTE_MS, M0 + 3 * MINUTE_MS);
    expect(r.records.map((x) => [x.t, x.bv, x.sv, x.source, x.complete])).toEqual([
      [M0 + 2 * MINUTE_MS, 3, 1, "recorded", true],
      [M0 + 3 * MINUTE_MS, 4, 1, "recorded", true],
    ]);
    expect(parseCsvLine("x,1,2")).toBeNull();
    expect(parseCsvLine(`${iso(M0)},1`)).toBeNull();
    expect(parseCsvLine(`${iso(M0)},1,2,3`)).toBeNull();
    expect(parseCsvLine(`${iso(M0)},a,2`)).toBeNull();
  });

  it("readRecorded returns complete minutes since `from`, reading only the tail", async () => {
    const d = dir();
    const f = flowFiles(d, C);
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < 2000; i++) appendFileSync(f.jsonl, `${recordLine(minute(M0 + i * MINUTE_MS, i, 1), 10)}\n`);
    appendFileSync(f.jsonl, "not json\n");
    const r = await readRecorded(d, C, M0 + 1990 * MINUTE_MS);
    expect(r.error).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.records.map((x) => x.bv)).toEqual([1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999]);
    expect(r.records[0].source).toBe("recorded");
    // Bounded: a small byte cap stops early instead of reading the whole file.
    const capped = await readRecorded(d, C, M0, Infinity, 4096);
    expect(capped.truncated).toBe(true);
    expect(capped.records.length).toBeLessThan(20);
    expect(capped.records[capped.records.length - 1].bv).toBe(1999);
    expect(await readRecorded(d, "NONE", M0)).toEqual({ records: [], truncated: false, error: null });
    mkdirSync(flowFiles(d, "DIR").jsonl);
    expect((await readRecorded(d, "DIR", M0)).error).toBeTruthy();
    // Bounded to the requested window.
    expect((await readRecorded(d, C, M0 + 10 * MINUTE_MS, M0 + 12 * MINUTE_MS)).records.map((x) => x.bv)).toEqual([10, 11, 12]);
  });
});
