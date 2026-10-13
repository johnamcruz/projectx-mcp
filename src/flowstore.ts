/**
 * Recorded order flow on disk, in PROJECTX_FLOW_DIR. Only the recorder writes:
 *   <contract>.csv    `ISO-time,buy_volume,sell_volume`, no header, one row per complete minute
 *   <contract>.jsonl  the full minute row (with volume at price and print sizes)
 * MCP servers read the tails back (bounded, asynchronously): the JSONL for the
 * requested window, the small CSV rows back to the session start for the
 * cumulative delta. A last line without its newline is a partial write and is
 * never read as data.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, truncateSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { csvLine, parseRecordLine, recordLine, type MinuteRecord } from "./orderflow.js";

/** The file name stem for a contract: anything outside [A-Za-z0-9._-] becomes `_`. */
export const flowFileStem = (contractId: string) => contractId.replace(/[^A-Za-z0-9._-]/g, "_");

export const flowFiles = (dir: string, contractId: string) => ({
  csv: join(dir, `${flowFileStem(contractId)}.csv`),
  jsonl: join(dir, `${flowFileStem(contractId)}.jsonl`),
});

/** Most bytes a backfill read takes from the end of a file per call. */
export const TAIL_MAX_BYTES = 8 * 1024 * 1024;
const CHUNK = 256 * 1024;

/** Minute start (ms) of a CSV or JSONL line; null when the line is not one. */
export function lineTime(line: string): number | null {
  const s = line.trim();
  if (!s) return null;
  let t: number;
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as { t?: unknown };
      t = typeof o.t === "string" ? Date.parse(o.t) : NaN;
    } catch {
      return null;
    }
  } else t = Date.parse(s.split(",")[0]);
  return Number.isFinite(t) ? t : null;
}

export interface TailResult {
  /** Complete lines, newest first. */
  lines: string[];
  /** The byte cap stopped the read before `stop` did or the file start was reached. */
  truncated: boolean;
  /** Whether the file ends with a newline (false: its last line is a partial write, left out of `lines`). */
  endsWithNewline: boolean;
  /** Bytes up to and including the last newline (where a partial last line starts); -1 when the read cap stopped before it was found. */
  completeBytes: number;
}

/**
 * Splits chunks read backwards from the end of a file into complete lines,
 * newest first. A trailing line without its newline is dropped (a partial
 * write), and so is a line whose start was not read.
 */
class TailSplitter {
  private carry = Buffer.alloc(0);
  private first = true;
  endsWithNewline = true;
  completeBytes = 0;

  constructor(private readonly size: number) {}

  /** Feed the chunk that starts at byte `pos`; returns its complete lines, newest first. */
  push(chunk: Buffer, pos: number): string[] {
    let all = Buffer.concat([chunk, this.carry]);
    if (this.first) {
      this.first = false;
      this.endsWithNewline = all.length === 0 || all[all.length - 1] === 0x0a;
      if (!this.endsWithNewline) {
        const nl = all.lastIndexOf(0x0a);
        if (nl < 0) {
          // No newline yet: the whole chunk belongs to the partial line.
          this.carry = Buffer.alloc(0);
          this.pendingPartial = pos > 0;
          this.completeBytes = pos > 0 ? -1 : 0;
          return [];
        }
        this.completeBytes = pos + nl + 1;
        all = all.subarray(0, nl + 1);
      } else this.completeBytes = this.size;
    } else if (this.pendingPartial) {
      const nl = all.lastIndexOf(0x0a);
      if (nl < 0) {
        if (pos === 0) {
          this.pendingPartial = false;
          this.completeBytes = 0;
        }
        return [];
      }
      this.pendingPartial = false;
      this.completeBytes = pos + nl + 1;
      all = all.subarray(0, nl + 1);
    }
    const cut = pos > 0 ? all.indexOf(0x0a) : -1;
    // Everything before the first newline may be a partial line: keep it for the next (earlier) chunk.
    this.carry = cut >= 0 ? all.subarray(0, cut) : pos > 0 ? all : Buffer.alloc(0);
    const text = cut >= 0 ? all.subarray(cut + 1).toString("utf8") : pos > 0 ? "" : all.toString("utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .reverse();
  }

  private pendingPartial = false;
}

/** Read a file backwards, newest complete line first, until `stop(line)` says so or `maxBytes` were read. */
export function readTailLines(path: string, stop: (line: string) => boolean, maxBytes = TAIL_MAX_BYTES): TailResult {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const split = new TailSplitter(size);
    const lines: string[] = [];
    const result = (truncated: boolean): TailResult => ({ lines, truncated, endsWithNewline: split.endsWithNewline, completeBytes: split.completeBytes });
    let pos = size;
    while (pos > 0) {
      if (size - pos >= maxBytes) return result(true);
      const len = Math.min(CHUNK, pos, maxBytes - (size - pos));
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      for (const line of split.push(buf, pos)) {
        lines.push(line);
        if (stop(line)) return result(false);
      }
    }
    return result(false);
  } finally {
    closeSync(fd);
  }
}

/** readTailLines without blocking the event loop (the MCP servers' reads). */
export async function readTailLinesAsync(path: string, stop: (line: string) => boolean, maxBytes = TAIL_MAX_BYTES): Promise<TailResult> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const split = new TailSplitter(size);
    const lines: string[] = [];
    const result = (truncated: boolean): TailResult => ({ lines, truncated, endsWithNewline: split.endsWithNewline, completeBytes: split.completeBytes });
    let pos = size;
    while (pos > 0) {
      if (size - pos >= maxBytes) return result(true);
      const len = Math.min(CHUNK, pos, maxBytes - (size - pos));
      pos -= len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      for (const line of split.push(buf, pos)) {
        lines.push(line);
        if (stop(line)) return result(false);
      }
    }
    return result(false);
  } finally {
    await fh.close();
  }
}

/** The last minute a file holds (its last complete line with a time), whether it ends with a newline, and where its complete part ends. */
export function lastRecorded(path: string): { t: number | null; endsWithNewline: boolean; completeBytes: number } {
  try {
    let t: number | null = null;
    const r = readTailLines(path, (line) => (t = lineTime(line)) !== null, 1024 * 1024);
    return { t, endsWithNewline: r.endsWithNewline, completeBytes: r.completeBytes };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { t: null, endsWithNewline: true, completeBytes: 0 };
    throw e;
  }
}

export interface RecordedRead {
  records: MinuteRecord[];
  truncated: boolean;
  error: string | null;
}

async function readRecordedFile(path: string, from: number, to: number, parse: (line: string) => MinuteRecord | null, maxBytes: number): Promise<RecordedRead> {
  try {
    const { lines, truncated } = await readTailLinesAsync(path, (line) => (lineTime(line) ?? Infinity) < from, maxBytes);
    const records = lines
      .map(parse)
      .filter((r): r is MinuteRecord => r !== null && r.t >= from && r.t <= to)
      .sort((a, b) => a.t - b.t);
    return { records, truncated, error: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { records: [], truncated: false, error: null };
    return { records: [], truncated: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Recorded complete minutes in [from, to], oldest first, from the JSONL tail (never more than maxBytes). */
export function readRecorded(dir: string, contractId: string, from: number, to = Infinity, maxBytes = TAIL_MAX_BYTES): Promise<RecordedRead> {
  return readRecordedFile(flowFiles(dir, contractId).jsonl, from, to, parseRecordLine, maxBytes);
}

/** A CSV row (`ISO,bv,sv`) as a recorded record with buy/sell volume only. */
export function parseCsvLine(line: string): MinuteRecord | null {
  const [ts, bvs, svs, extra] = line.trim().split(",");
  const t = Date.parse(ts);
  const bv = Number(bvs);
  const sv = Number(svs);
  if (extra !== undefined || !Number.isFinite(t) || bvs === "" || svs === "" || !Number.isFinite(bv) || !Number.isFinite(sv)) return null;
  return { t, bv, sv, volume: bv + sv, trades: 0, vwap: null, high: null, low: null, maxPrint: null, sizes: [], vap: [], ofiQuote: null, bookImbalance: null, badTimestamps: 0, sidelessVolume: 0, complete: true, source: "recorded" };
}

/** Recorded buy/sell volume per complete minute in [from, to] from the small CSV rows (for the cumulative delta). */
export function readRecordedCsv(dir: string, contractId: string, from: number, to = Infinity, maxBytes = TAIL_MAX_BYTES): Promise<RecordedRead> {
  return readRecordedFile(flowFiles(dir, contractId).csv, from, to, parseCsvLine, maxBytes);
}

/**
 * Appends complete minutes to the CSV and the JSONL, each minute once: it
 * remembers the last minute in each file (read from its last complete line on
 * first use, so a restart never duplicates) and skips anything not newer. A
 * partial last line (a write cut short) is truncated away first, never
 * extended. A write error is caught and warned once per file.
 */
export class FlowWriter {
  private readonly last = new Map<string, number | null>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly largePrint: number,
    private readonly warn: (line: string) => void,
  ) {}

  private append(path: string, t: number, line: string): void {
    try {
      let lastT = this.last.get(path);
      if (lastT === undefined) {
        const r = lastRecorded(path);
        if (!r.endsWithNewline) {
          if (r.completeBytes < 0) throw new Error("its partial last line is longer than the read cap; fix the file by hand");
          truncateSync(path, r.completeBytes);
          this.warn(`order flow: ${path} ended in a partial line; truncated it to its last complete row`);
        }
        lastT = r.t;
        this.last.set(path, lastT);
      }
      if (lastT !== null && t <= lastT) return;
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(path, `${line}\n`);
      this.last.set(path, t);
      this.warned.delete(path);
    } catch (e) {
      // Forget the cached state so the next write re-reads the file's end.
      this.last.delete(path);
      if (this.warned.has(path)) return;
      this.warned.add(path);
      this.warn(`order flow: cannot write ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  write(contractId: string, r: MinuteRecord): void {
    if (!r.complete) return;
    const files = flowFiles(this.dir, contractId);
    this.append(files.csv, r.t, csvLine(r));
    this.append(files.jsonl, r.t, recordLine(r, this.largePrint));
  }
}
