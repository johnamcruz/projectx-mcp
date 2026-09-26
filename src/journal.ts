import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const JOURNAL_KINDS = ["plan", "entry", "exit", "review", "lesson", "note", "order_placed", "order_blocked"] as const;
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

/**
 * Append-only JSONL journal. This is the model's long-term memory across
 * sessions: plans, rationales, reviews, and lessons learned.
 */
export class Journal {
  constructor(readonly path: string) {}

  async add(entry: Omit<JournalEntry, "ts">): Promise<JournalEntry> {
    const full: JournalEntry = { ts: new Date().toISOString(), ...entry };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(full) + "\n", "utf8");
    return full;
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
