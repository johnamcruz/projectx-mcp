import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { flowFiles } from "../src/flowstore.js";
import { MINUTE_MS } from "../src/orderflow.js";
import { FlowRecorder, RecorderError, keepAliveTimers, recorderSettings, type RecorderDeps } from "../src/recorder.js";
import { OK, fakeApi, fakeClock, fakeFlowHub } from "./helpers.js";

const M0 = Date.UTC(2026, 9, 12, 14, 30);
const S = Date.UTC(2026, 9, 12, 22, 0); // 17:00 CT
const Z = "CON.F.US.MNQ.Z26";
const H = "CON.F.US.MNQ.H27";
const iso = (t: number) => new Date(t).toISOString();

const config = (env: Record<string, string> = {}) =>
  loadConfig({ PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k", PROJECTX_FLOW_SYMBOLS: "MNQ", PROJECTX_FLOW_DIR: mkdtempSync(join(tmpdir(), "pxrec-")), ...env });

function make(o: Partial<RecorderDeps> & { dir?: string; start?: number; active?: () => string } = {}) {
  const cfg = config(o.dir ? { PROJECTX_FLOW_DIR: o.dir } : {});
  const hub = Object.assign(fakeFlowHub(), { closed: 0, close: async () => void hub.closed++ });
  const clock = fakeClock(o.start ?? M0 + 10_000);
  const active = o.active ?? (() => Z);
  const api = fakeApi({ "/api/Contract/search": () => ({ ...OK, contracts: [{ id: active(), activeContract: true }] }) });
  const fns = new Map<number, () => void>();
  let n = 0;
  const warnings: string[] = [];
  const fatal: string[] = [];
  const rec = new FlowRecorder({
    config: cfg,
    client: api,
    hub,
    now: clock.now,
    warn: (l) => void warnings.push(l),
    timers: { every: (_ms, fn) => (fns.set(++n, fn), n), cancel: (h) => void fns.delete(h as number) },
    isAlive: () => true,
    onFatal: (m) => void fatal.push(m),
    ...o,
  });
  // The quote feed's session volume follows the prints the test pushes, so quiet minutes are genuinely quiet.
  const vol = new Map<string, number>();
  const pushTrade = hub.trade;
  hub.trade = (id: string, data: unknown) => {
    for (const it of Array.isArray(data) ? data : [data]) {
      if (it && typeof (it as any).volume === "number" && [0, 1].includes((it as any).type)) vol.set(id, (vol.get(id) ?? 1000) + (it as any).volume);
    }
    pushTrade(id, data);
  };
  /** A busy market: a quote for every subscribed contract every `step` ms, with a recorder cycle each time. */
  const pump = async (until: number, step = 2_000) => {
    while (clock.t < until) {
      clock.t = Math.min(until, clock.t + step);
      for (const id of rec.feed.contracts()) hub.quote(id, { lastPrice: 100, volume: vol.get(id) ?? 1000 });
      await rec.cycle();
    }
  };
  return { rec, hub, clock, api, fns, warnings, fatal, pump, dir: cfg.flowDir! };
}

describe("recorder settings", () => {
  it("needs PROJECTX_FLOW_SYMBOLS and PROJECTX_FLOW_DIR", () => {
    const base = { PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k" };
    expect(() => recorderSettings(loadConfig(base))).toThrow(/--record-flow needs PROJECTX_FLOW_SYMBOLS and PROJECTX_FLOW_DIR/);
    expect(() => recorderSettings(loadConfig({ ...base, PROJECTX_FLOW_SYMBOLS: "MNQ" }))).toThrow(RecorderError);
    expect(() => recorderSettings(loadConfig({ ...base, PROJECTX_FLOW_DIR: "/x" }))).toThrow(/needs PROJECTX_FLOW_SYMBOLS\b/);
    expect(() => recorderSettings(loadConfig({ ...base, PROJECTX_FLOW_DIR: "/x", PROJECTX_FLOW_SYMBOLS: "A,B,C", PROJECTX_FLOW_MAX_CONTRACTS: "2" }))).toThrow(/at most 2/);
    expect(recorderSettings(loadConfig({ ...base, PROJECTX_FLOW_DIR: "/x", PROJECTX_FLOW_SYMBOLS: "mnq, mes" }))).toEqual({ symbols: ["MNQ", "MES"], dir: "/x" });
  });
});

describe("FlowRecorder", () => {
  it("uses a timer that keeps the process alive (it serves nothing else)", () => {
    const h = keepAliveTimers.every(60_000, () => {}) as ReturnType<typeof setInterval>;
    expect(h.hasRef()).toBe(true);
    keepAliveTimers.cancel(h);
  });

  it("subscribes the symbols' active contracts, writes complete minutes, and shuts down cleanly", async () => {
    const { rec, hub, fns, dir, pump } = make();
    await rec.start();
    expect(existsSync(join(dir, "recorder.lock"))).toBe(true);
    expect(hub.subscribes()).toEqual([`trades:${Z}`, `depth:${Z}`, `quotes:${Z}`]);
    expect(fns.size).toBe(1);
    await pump(M0 + 70_000);
    hub.trade(Z, { price: 100, volume: 4, type: 0, timestamp: iso(M0 + 70_000) });
    await pump(M0 + 80_000);
    hub.trade(Z, [{ price: 100, volume: 1, type: 1, timestamp: iso(M0 + 80_000) }]);
    await pump(M0 + 3 * MINUTE_MS + 12_000);
    const f = flowFiles(dir, Z);
    // The first (partial) minute is never written; complete ones are, zero-trade ones included.
    expect(readFileSync(f.csv, "utf8")).toBe(`${iso(M0 + MINUTE_MS)},4,1\n${iso(M0 + 2 * MINUTE_MS)},0,0\n`);
    expect(readFileSync(f.jsonl, "utf8").trim().split("\n")).toHaveLength(2);
    await rec.stop();
    await rec.stop();
    expect(fns.size).toBe(0);
    expect(hub.closed).toBe(1);
    expect(hub.listeners.size).toBe(0);
    expect(existsSync(join(dir, "recorder.lock"))).toBe(false);
    await rec.cycle(); // after stop: nothing
  });

  it("does not duplicate minutes across a restart", async () => {
    const first = make();
    await first.rec.start();
    await first.pump(M0 + 3 * MINUTE_MS + 12_000);
    await first.rec.stop();
    // The same minutes again (a replay of the same period), then new ones.
    const second = make({ dir: first.dir });
    await second.rec.start();
    await second.pump(M0 + 5 * MINUTE_MS + 12_000);
    await second.rec.stop();
    const csv = readFileSync(flowFiles(first.dir, Z).csv, "utf8").trim().split("\n").map((l) => l.split(",")[0]);
    expect(csv).toEqual([iso(M0 + MINUTE_MS), iso(M0 + 2 * MINUTE_MS), iso(M0 + 3 * MINUTE_MS), iso(M0 + 4 * MINUTE_MS)]);
    expect(new Set(csv).size).toBe(csv.length);
  });

  it("keeps retrying a symbol's contract whose subscribe failed (never gives it up)", async () => {
    const { rec, hub, pump } = make();
    hub.fail = (kind) => (kind === "trades" ? new Error("hub busy") : null);
    await rec.start();
    expect(rec.feed.contracts()).toEqual([Z]);
    hub.fail = () => null;
    await pump(M0 + 20_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.feed.coverage(Z).tradesLive).toBe(true);
    await rec.stop();
  });

  it("is single-instance: a second recorder on the same directory refuses to start", async () => {
    const first = make();
    await first.rec.start();
    const second = make({ dir: first.dir });
    await expect(second.rec.start()).rejects.toThrow(/Another flow recorder is running: .*recorder\.lock is held/);
    expect(second.hub.calls).toEqual([]);
    await first.rec.stop();
    await second.rec.start();
    await second.rec.stop();
  });

  it("takes over a stale lock whose process is gone", async () => {
    const { dir } = make();
    writeFileSync(join(dir, "recorder.lock"), JSON.stringify({ pid: 999999, token: "old", heartbeat: M0 }));
    const r = make({ dir, isAlive: () => false });
    await r.rec.start();
    expect(JSON.parse(readFileSync(join(dir, "recorder.lock"), "utf8")).token).not.toBe("old");
    await r.rec.stop();
  });

  it("stops without writing when it loses its lock", async () => {
    const { rec, clock, dir, fatal, warnings, pump, hub } = make();
    await rec.start();
    await pump(M0 + 2 * MINUTE_MS + 9_000); // minute 1 is not final yet (it settles at end + 10 s)
    clock.t += 2_000;
    hub.quote(Z, { lastPrice: 1 });
    writeFileSync(join(dir, "recorder.lock"), JSON.stringify({ pid: 1, token: "other", heartbeat: clock.t }));
    await rec.cycle();
    expect(fatal).toHaveLength(1);
    expect(warnings.some((w) => /lost .*recorder\.lock/.test(w))).toBe(true);
    expect(existsSync(flowFiles(dir, Z).csv)).toBe(false);
    // The other process's lock is left alone.
    expect(JSON.parse(readFileSync(join(dir, "recorder.lock"), "utf8")).token).toBe("other");
  });

  it("switches to the new contract at the trading-day start after a roll", async () => {
    let active = Z;
    const { rec, hub, dir, pump } = make({ start: S - 3 * MINUTE_MS - 50_000, active: () => active });
    await rec.start();
    active = H;
    await pump(S + 5_000);
    expect(rec.feed.contracts()).toEqual([H]);
    expect(hub.calls.filter(([op]) => op === "unsubscribe").map(([, , id]) => id)).toEqual([Z, Z, Z]);
    expect(hub.subscribes("trades")).toEqual([`trades:${Z}`, `trades:${H}`]);
    // The old contract's final minutes were written before it was dropped (the last one is decided only after 17:00).
    expect(readFileSync(flowFiles(dir, Z).csv, "utf8").trim().split("\n").at(-1)).toMatch(new RegExp(`^${iso(S - 2 * MINUTE_MS)}`));
    await rec.stop();
  });
});
