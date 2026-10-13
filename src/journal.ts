import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const JOURNAL_KINDS = ["plan", "entry", "exit", "review", "lesson", "note", "order_placed", "order_blocked", "order_sent"] as const;
/** Kinds that mark an order this server sent: the reconcile's scope and timing come from them. */
export const ORDER_KINDS: readonly JournalKind[] = ["order_sent", "order_placed"];
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export interface JournalEntry {
  ts: string;
  kind: JournalKind;
  text: string;
  accountId?: number;
  contractId?: string;
  orderId?: number;
  tags?: string[];
  data?: unknown;
}

export interface JournalQuery {
  kind?: JournalKind;
  tag?: string;
  contractId?: string;
  since?: string;
  limit?: number;
}

/** How long an order path waits for a journal write (it may land later). */
export const RECORD_CAP_MS = 500;

/** Wait for `p` (success or failure) at most `ms` of wall time; it keeps running after that. */
export function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    p.then(
      () => (clearTimeout(timer), resolve()),
      () => (clearTimeout(timer), resolve()),
    );
  });
}

/** readSince keeps scanning this far past `since`, for entries appended slightly out of order. */
const SINCE_SLACK_MS = 5 * 60_000;
/** readSince stops after this many old lines in a row. */
const OLD_RUN_STOP = 50;
const TS_PREFIX = '{"ts":"';

/** A line's timestamp, from the `{"ts":"…"` prefix when present (no full parse), else from the parsed entry. */
function tsOf(line: string): number | null {
  if (line.startsWith(TS_PREFIX)) {
    const end = line.indexOf('"', TS_PREFIX.length);
    const t = Date.parse(line.slice(TS_PREFIX.length, end));
    if (Number.isFinite(t)) return t;
  }
  try {
    const t = Date.parse((JSON.parse(line) as JournalEntry).ts);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Append-only JSONL journal. This is the model's long-term memory across
 * sessions: plans, rationales, reviews, and lessons learned.
 */
export class Journal {
  constructor(readonly path: string) {}

  /** `ts` defaults to now; callers with an injected clock pass their own. */
  async add(entry: Omit<JournalEntry, "ts"> & { ts?: string }): Promise<JournalEntry> {
    const { ts, ...rest } = entry;
    // ts first on the line: readSince() reads it without parsing the whole entry.
    const full: JournalEntry = { ts: ts ?? new Date().toISOString(), ...rest };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  /**
   * Entries with ts >= sinceMs, oldest first, reading the file backwards from
   * its end in chunks so a large journal is never loaded whole. A line older
   * than sinceMs - SINCE_SLACK_MS is "old"; reading stops only once a whole
   * chunk is old or OLD_RUN_STOP old lines come in a row, so one stale line in
   * the middle never hides newer lines before it.
   */
  async readSince(sinceMs: number, chunkBytes = 64 * 1024): Promise<JournalEntry[]> {
    let fh;
    try {
      fh = await open(this.path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: JournalEntry[] = [];
    const bound = sinceMs - SINCE_SLACK_MS;
    let oldRun = 0;
    try {
      let pos = (await fh.stat()).size;
      let carry = Buffer.alloc(0);
      scan: while (pos > 0) {
        const n = Math.min(chunkBytes, pos);
        pos -= n;
        const buf = Buffer.alloc(n);
        await fh.read(buf, 0, n, pos);
        let data = Buffer.concat([buf, carry]);
        if (pos > 0) {
          // The first piece may be the tail of a line that starts in an earlier chunk.
          const nl = data.indexOf(10);
          if (nl === -1) {
            carry = data;
            continue;
          }
          carry = data.subarray(0, nl);
          data = data.subarray(nl + 1);
        } else carry = Buffer.alloc(0);
        const lines = data.toString("utf8").split("\n");
        let seen = 0;
        let oldInChunk = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line) continue;
          seen++;
          const t = tsOf(line);
          if (t !== null && t < bound) {
            oldInChunk++;
            if (++oldRun >= OLD_RUN_STOP) break scan;
            continue;
          }
          oldRun = 0;
          if (t === null || t < sinceMs) continue;
          try {
            out.push(JSON.parse(line) as JournalEntry);
          } catch {
            // a torn or garbage line
          }
        }
        if (seen > 0 && oldInChunk === seen) break;
      }
    } finally {
      await fh.close();
    }
    return out.reverse();
  }

  async read(q: JournalQuery = {}): Promise<JournalEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const since = q.since ? Date.parse(q.since) : undefined;
    const entries = text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as JournalEntry];
        } catch {
          return [];
        }
      })
      .filter(
        (e) =>
          (!q.kind || e.kind === q.kind) &&
          (!q.tag || e.tags?.includes(q.tag)) &&
          (!q.contractId || e.contractId === q.contractId) &&
          (since === undefined || Date.parse(e.ts) >= since),
      );
    return entries.slice(-(q.limit ?? 50));
  }
}
