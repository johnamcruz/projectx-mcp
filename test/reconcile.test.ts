import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { PostOptions } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { Journal } from "../src/journal.js";
import { ReconcileLock, Reconciler, coverage, type Timers } from "../src/reconcile.js";
import { OK, fakeApi, fakeClock } from "./helpers.js";

type Row = Record<string, unknown>;
const MNQ = "CON.F.US.MNQ.Z25";
const MES = "CON.F.US.MES.Z25";
const pos = (type: number, size: number, contractId = MNQ) => ({ contractId, type, size });
const stop = (side: number, size = 1, contractId = MNQ, type = 4, id = 50) => ({ id, contractId, side, type, size, status: 1 });

describe("coverage", () => {
  it("a long covered by a sell stop (or trailing stop) for its whole size is covered", () => {
    expect(coverage([pos(1, 2)], [stop(1, 2)])[0]).toMatchObject({ direction: "long", covered: true, stopSize: 2, size: 2 });
    expect(coverage([pos(2, 1)], [stop(0, 1, MNQ, 5)])[0]).toMatchObject({ direction: "short", covered: true });
    expect(coverage([pos(1, 2)], [stop(1, 1, MNQ, 4, 1), stop(1, 1, MNQ, 5, 2)])[0].covered).toBe(true);
  });

  it("a partial cover, a stop on the wrong side, a limit, or another contract's stop is uncovered", () => {
    expect(coverage([pos(1, 2)], [stop(1, 1)])[0]).toMatchObject({ covered: false, stopSize: 1 });
    expect(coverage([pos(1, 1)], [stop(0, 1)])[0].covered).toBe(false);
    expect(coverage([pos(1, 1)], [stop(1, 1, MNQ, 1)])[0].covered).toBe(false);
    expect(coverage([pos(1, 1)], [stop(1, 1, MES)])[0].covered).toBe(false);
  });

  it("no stops at all is uncovered, and flat contracts are not listed", () => {
    expect(coverage([pos(1, 1)], [])[0]).toMatchObject({ covered: false, stopSize: 0 });
    expect(coverage([pos(1, 0), pos(2, 0, MES)], [])).toEqual([]);
  });

  it("an unknown direction is read from stops all on one side (a sell stop means long)", () => {
    expect(coverage([pos(0, 1)], [stop(1, 1)])[0]).toMatchObject({ direction: "long", directionInferred: true, covered: true });
    expect(coverage([pos(0, 1)], [stop(0, 1)])[0]).toMatchObject({ direction: "short", directionInferred: true, covered: true });
    expect(coverage([pos(0, 2)], [stop(1, 1)])[0]).toMatchObject({ direction: "long", covered: false });
    expect(coverage([pos(0, 1)], [stop(1, 1, MNQ, 4, 1), stop(0, 1, MNQ, 4, 2)])[0]).toMatchObject({ direction: null, covered: false });
    expect(coverage([pos(0, 1)], [])[0]).toMatchObject({ direction: null, covered: false });
  });
});

/** A fake broker shared by any number of reconcilers: closeContract flattens, cancel removes the order. */
function broker(init: { positions?: Row[]; orders?: Row[]; accounts?: Record<number, { positions: Row[]; orders: Row[] }> } = {}) {
  const st = {
    positions: init.positions ?? [pos(1, 1)],
    orders: init.orders ?? [],
    failPositions: false,
    failOrders: false,
    closeFails: false,
    /** Called on each Order/searchOpen of account 1 with its 1-based count; may change the state. */
    onOrdersRead: null as null | ((n: number) => void),
    ordersReads: 0,
  };
  const other = init.accounts ?? {};
  const routes = {
    "/api/Position/searchOpen": (b: any) =>
      st.failPositions ? { success: false, errorCode: 1, errorMessage: null } : { ...OK, positions: b.accountId === 1 ? st.positions : (other[b.accountId]?.positions ?? []) },
    "/api/Order/searchOpen": (b: any) => {
      if (b.accountId === 1) {
        st.ordersReads++;
        st.onOrdersRead?.(st.ordersReads);
      }
      return st.failOrders ? { success: false, errorCode: 1, errorMessage: null } : { ...OK, orders: b.accountId === 1 ? st.orders : (other[b.accountId]?.orders ?? []) };
    },
    "/api/Position/closeContract": (b: any) => {
      if (st.closeFails) return { success: false, errorCode: 6, errorMessage: "halted" };
      st.positions = st.positions.filter((p) => p.contractId !== b.contractId);
      return { ...OK };
    },
    "/api/Order/cancel": (b: any) => {
      st.orders = st.orders.filter((o) => o.id !== b.orderId);
      return { ...OK };
    },
  };
  return { st, routes };
}

function fakeTimers() {
  const t = { registered: [] as number[], cancelled: 0, fn: null as null | (() => void) };
  const timers: Timers = {
    every: (ms, fn) => {
      t.registered.push(ms);
      t.fn = fn;
      return "handle";
    },
    cancel: () => void t.cancelled++,
  };
  return { t, timers };
}

/** 10:00 Chicago on a Tuesday: the trading day started at 17:00 Chicago the day before. */
const T0 = Date.parse("2026-03-10T15:00:00Z");
const DAY_START = Date.parse("2026-03-09T22:00:00Z");

/** An order entry as place_order or modify_order writes it (either copy: they share the journal). */
const sent = (journal: Journal, accountId: number, contractId: string, t: number, kind: "order_sent" | "order_placed" = "order_sent") =>
  journal.add({ ts: new Date(t).toISOString(), kind, text: "test order", accountId, contractId });

async function make(
  o: {
    env?: Record<string, string>;
    b?: ReturnType<typeof broker>;
    dir?: string;
    clock?: ReturnType<typeof fakeClock>;
    pid?: number;
    client?: any;
    /** Own orders to journal first: [account, contract, time]. Default: account 1 on MNQ a minute before T0. */
    orders?: Array<[number, string, number]>;
  } = {},
) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "pxr-"));
  const config = loadConfig({
    PROJECTX_USERNAME: "trader",
    PROJECTX_API_KEY: "secret-key",
    PROJECTX_TRADING_ENABLED: "true",
    PROJECTX_JOURNAL_PATH: join(dir, "journal.jsonl"),
    ...o.env,
  });
  const b = o.b ?? broker();
  const api = fakeApi(b.routes);
  const clock = o.clock ?? fakeClock(T0);
  const journal = new Journal(config.journalPath);
  // Appended in time order, as the server writes them.
  for (const [acct, cid, t] of [...(o.orders ?? [[1, MNQ, T0 - 60_000]])].sort((x, y) => x[2] - y[2])) await sent(journal, acct, cid, t);
  const warnings: string[] = [];
  const { t, timers } = fakeTimers();
  const rec = new Reconciler({
    config, client: o.client ?? api, journal, now: clock.now, sleep: clock.sleep, warn: (l) => void warnings.push(l), timers,
    pid: o.pid, isAlive: () => true,
  });
  return { rec, api, b, clock, journal, warnings, t, dir, config };
}

const closes = (api: ReturnType<typeof fakeApi>) => api.bodiesFor("/api/Position/closeContract");

describe("Reconciler", () => {
  it("leaves a covered position alone", async () => {
    const { rec, api, clock } = await make({ b: broker({ orders: [stop(1)] }) });
    await rec.cycle();
    clock.t += 30_000;
    const r = await rec.cycle();
    expect(r.uncovered).toEqual([]);
    expect(closes(api)).toHaveLength(0);
  });

  it("acts only after two uncovered checks at least the grace period apart, then flattens, journals an exit and warns once", async () => {
    const { rec, api, clock, journal, warnings, b } = await make({ b: broker({ orders: [{ id: 9, contractId: MNQ, side: 1, type: 1, size: 1 }] }) });
    expect((await rec.cycle()).flattened).toEqual([]);
    clock.t += 14_000;
    expect((await rec.cycle()).flattened).toEqual([]);
    expect(closes(api)).toHaveLength(0);
    clock.t += 1_000;
    const r = await rec.cycle();
    expect(r.flattened).toEqual([{ accountId: 1, contractId: MNQ, status: "flat" }]);
    expect(closes(api)).toEqual([{ accountId: 1, contractId: MNQ }]);
    // The leg is cancelled only once flat.
    expect(api.bodiesFor("/api/Order/cancel")).toEqual([{ accountId: 1, orderId: 9 }]);
    expect(b.st.positions).toEqual([]);
    const [entry] = await journal.read({ kind: "exit" });
    expect(entry).toMatchObject({ accountId: 1, contractId: MNQ, tags: ["reconcile", "unprotected"] });
    expect(entry.text).toMatch(/flattened unprotected long position of 1 on CON.F.US.MNQ.Z25.*-> flat/);
    expect(warnings).toEqual([entry.text]);
  });

  it("a check that sees the position covered ends the streak", async () => {
    const { rec, api, clock, b } = await make();
    await rec.cycle();
    clock.t += 10_000;
    b.st.orders = [stop(1)];
    await rec.cycle();
    clock.t += 10_000;
    b.st.orders = [];
    await rec.cycle(); // first sighting of a new streak
    expect(closes(api)).toHaveLength(0);
    clock.t += 15_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
  });

  it("uses the grace period from PROJECTX_RECONCILE_GRACE_SECONDS", async () => {
    const { rec, api, clock } = await make({ env: { PROJECTX_RECONCILE_GRACE_SECONDS: "60" }, orders: [[1, MNQ, T0 - 120_000]] });
    await rec.cycle();
    clock.t += 59_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(0);
    clock.t += 1_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
  });

  it("only checks this server's own trades: a contract or account with no order entry today is never flattened", async () => {
    const b = broker({ positions: [pos(1, 1), pos(1, 1, MES)], accounts: { 2: { positions: [pos(1, 1)], orders: [] } } });
    // MES on account 1 was traded 25 h ago (before the trading day and the 24 h window); account 2 never.
    const { rec, api, clock } = await make({ b, orders: [[1, MNQ, T0 - 60_000], [1, MES, T0 - 25 * 3600_000]] });
    const r = await rec.cycle();
    expect(r.accounts).toEqual([1]);
    expect(r.uncovered.map((c) => c.contractId)).toEqual([MNQ]);
    clock.t += 30_000;
    await rec.cycle();
    expect(closes(api)).toEqual([{ accountId: 1, contractId: MNQ }]);
    expect(api.calls.every((c) => c.body.accountId === 1)).toBe(true);
    clock.t += 300_000;
    await rec.cycle();
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
  });

  it("with no order entries today reads nothing", async () => {
    const { rec, api } = await make({ orders: [] });
    expect((await rec.cycle()).accounts).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("an order_placed entry counts as an own trade too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxr-"));
    await sent(new Journal(join(dir, "journal.jsonl")), 1, MNQ, T0 - 60_000, "order_placed");
    const { rec, api, clock } = await make({ dir, orders: [] });
    await rec.cycle();
    clock.t += 30_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
  });

  it("an order on that contract within the grace, from either copy, suppresses the flatten", async () => {
    const { rec, api, clock, dir } = await make();
    await rec.cycle();
    // The other copy (same journal) sent an order 10 s later; another contract's order does not count.
    const other = new Journal(join(dir, "journal.jsonl"));
    await sent(other, 1, MNQ, clock.t + 10_000);
    await sent(other, 1, MES, clock.t + 25_000);
    clock.t += 20_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(0);
    clock.t += 5_000; // the order is now 15 s old
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
  });

  it.each(["failPositions", "failOrders"] as const)("does nothing when a read fails (%s)", async (flag) => {
    const { rec, api, clock, b } = await make();
    b.st[flag] = true;
    await rec.cycle();
    clock.t += 30_000;
    const r = await rec.cycle();
    expect(r.unreadable).toEqual([1]);
    expect(closes(api)).toHaveLength(0);
  });

  it("does nothing when the journal cannot be read", async () => {
    const { rec, api, clock, journal, warnings } = await make();
    const realRead = journal.readSince.bind(journal);
    journal.readSince = async () => {
      throw new Error("EIO");
    };
    await rec.cycle();
    clock.t += 30_000;
    await rec.cycle();
    expect(api.calls).toHaveLength(0);
    // Warned once, not every cycle; warned again only after a good read.
    expect(warnings).toEqual(["reconcile: cannot read the journal (EIO); no checks until it can be read"]);
    journal.readSince = realRead;
    await rec.cycle();
    journal.readSince = async () => {
      throw new Error("EIO");
    };
    await rec.cycle();
    expect(warnings).toHaveLength(2);
  });

  it("a read failure is not a check: it neither acts nor ends the streak", async () => {
    const { rec, api, clock, b } = await make();
    await rec.cycle();
    clock.t += 20_000;
    b.st.failOrders = true;
    await rec.cycle();
    expect(closes(api)).toHaveLength(0);
    b.st.failOrders = false;
    clock.t += 1_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
  });

  it("re-reads right before closing: skips a contract now covered", async () => {
    const { rec, api, clock, b } = await make();
    await rec.cycle();
    clock.t += 30_000;
    b.st.onOrdersRead = (n) => {
      if (n === 3) b.st.orders = [stop(1)]; // the stop shows up between the check and the close
    };
    await rec.cycle();
    expect(b.st.ordersReads).toBe(3);
    expect(closes(api)).toHaveLength(0);
  });

  it("re-reads right before closing: skips a contract now flat, and skips when the re-read fails", async () => {
    const flat = await make();
    await flat.rec.cycle();
    flat.clock.t += 30_000;
    flat.b.st.onOrdersRead = (n) => {
      if (n === 2) flat.b.st.positions = []; // after the check's position read: the re-read sees flat
    };
    await flat.rec.cycle();
    expect(closes(flat.api)).toHaveLength(0);

    const broken = await make();
    await broken.rec.cycle();
    broken.clock.t += 30_000;
    broken.b.st.onOrdersRead = (n) => {
      if (n === 3) broken.b.st.failOrders = true;
    };
    await broken.rec.cycle();
    expect(closes(broken.api)).toHaveLength(0);
    // The streak survives a failed re-read: the next good check acts.
    broken.b.st.failOrders = false;
    broken.b.st.onOrdersRead = null;
    broken.clock.t += 30_000;
    await broken.rec.cycle();
    expect(closes(broken.api)).toHaveLength(1);
  });

  it("a failed close journals a note (not an exit), and backs that contract off for 5 minutes", async () => {
    const { rec, api, clock, b, journal, warnings } = await make();
    b.st.closeFails = true;
    await rec.cycle();
    clock.t += 30_000;
    expect((await rec.cycle()).flattened).toEqual([{ accountId: 1, contractId: MNQ, status: "still_open" }]);
    expect(await journal.read({ kind: "exit" })).toEqual([]);
    const [note] = await journal.read({ tag: "reconcile" });
    expect(note).toMatchObject({ kind: "note", tags: ["reconcile", "unprotected"], contractId: MNQ });
    expect(note.text).toMatch(/^reconcile: close failed: still_open/);
    expect(warnings).toEqual([note.text]);
    // Seen uncovered again on the next checks, but not retried until the backoff ends.
    for (let i = 0; i < 9; i++) {
      clock.t += 30_000;
      await rec.cycle();
    }
    expect(closes(api)).toHaveLength(1);
    clock.t += 30_000; // 5 min after the failed close
    await rec.cycle();
    expect(closes(api)).toHaveLength(2);
  });

  it("a close with no reply backs off 1, 2, then 5 minutes; a definitive refusal waits 5", async () => {
    const { rec, api, clock, b, journal } = await make();
    let mode: "timeout" | "refuse" = "timeout";
    b.routes["/api/Position/closeContract"] = (() => {
      if (mode === "refuse") return { success: false, errorCode: 6, errorMessage: "halted" };
      throw new Error("timed out");
    }) as never;
    await rec.cycle();
    const tries: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < 200 && tries.length < 5; i++) {
      clock.t += 10_000;
      const before = closes(api).length;
      if (tries.length === 3) mode = "refuse";
      const start = clock.t;
      await rec.cycle();
      if (closes(api).length > before) tries.push({ start, end: clock.t });
    }
    // From the end of one failed close to the next try: 1, 2, 5 min after no reply, then 5 min after a refusal.
    const gaps = tries.slice(1).map((x, i) => x.start - tries[i].end);
    const want = [60_000, 120_000, 300_000, 300_000];
    gaps.forEach((g, i) => {
      expect(g).toBeGreaterThanOrEqual(want[i]);
      expect(g).toBeLessThan(want[i] + 10_000);
    });
    const notes = (await journal.read({ tag: "reconcile" })).map((e) => e.text.match(/next try in ([\d.]+) min/)?.[1]);
    expect(notes).toEqual(["1", "2", "5", "5", "5"]);
    // The streak was seen again in between, but never acted on early.
    expect(tries).toHaveLength(5);
  });

  it("legs_left is not a failed close: a distinct note, no backoff, and the legs are cancelled again while flat", async () => {
    const { rec, api, clock, b, journal, warnings } = await make({ b: broker({ orders: [{ id: 9, contractId: MNQ, side: 1, type: 1, size: 1 }] }) });
    let cancelOk = false;
    const cancel = b.routes["/api/Order/cancel"];
    b.routes["/api/Order/cancel"] = ((body: any) => (cancelOk ? cancel(body) : { success: false, errorCode: 5, errorMessage: "busy" })) as never;
    await rec.cycle();
    clock.t += 30_000;
    expect((await rec.cycle()).flattened).toEqual([{ accountId: 1, contractId: MNQ, status: "legs_left" }]);
    const [note] = await journal.read({ tag: "reconcile" });
    expect(note.kind).toBe("note");
    expect(note.text).toMatch(/^reconcile: flat; legs left: 9;/);
    expect(warnings).toEqual([note.text]);
    expect(await journal.read({ kind: "exit" })).toEqual([]);
    // Next cycle: still flat, so the leftover leg is cancelled again (just that one).
    cancelOk = true;
    clock.t += 30_000;
    await rec.cycle();
    expect(api.bodiesFor("/api/Order/cancel").map((x) => x.orderId)).toEqual([9, 9]);
    expect(b.st.orders).toEqual([]);
    clock.t += 30_000;
    await rec.cycle();
    expect(api.bodiesFor("/api/Order/cancel")).toHaveLength(2);
    // No backoff: a new uncovered position there is handled on the normal schedule.
    b.st.positions = [pos(1, 1)];
    await rec.cycle();
    clock.t += 15_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(2);
  });

  /** A flatten that leaves leg 9 behind (its cancel fails), so the next cycles retry it once cancelOk is set. */
  async function legsLeftSetup(extra: Parameters<typeof make>[0] = {}) {
    const m = await make({ b: broker({ orders: [{ id: 9, contractId: MNQ, side: 1, type: 1, size: 1 }] }), ...extra });
    const ctl = { cancelOk: false };
    const cancel = m.b.routes["/api/Order/cancel"];
    m.b.routes["/api/Order/cancel"] = ((body: any) => (ctl.cancelOk ? cancel(body) : { success: false, errorCode: 5, errorMessage: "busy" })) as never;
    await m.rec.cycle();
    m.clock.t += 30_000;
    expect((await m.rec.cycle()).flattened[0].status).toBe("legs_left");
    ctl.cancelOk = true;
    m.clock.t += 30_000;
    return { ...m, ctl };
  }
  const cancelled = (api: ReturnType<typeof fakeApi>) => api.bodiesFor("/api/Order/cancel").map((x) => x.orderId);

  it("the leg retry cancels only the remembered legs: a new resting entry on the flat contract survives", async () => {
    const { rec, api, b } = await legsLeftSetup();
    b.st.orders.push({ id: 55, contractId: MNQ, side: 0, type: 1, size: 1 });
    await rec.cycle();
    expect(cancelled(api)).toEqual([9, 9]);
    expect(b.st.orders.map((o) => o.id)).toEqual([55]);
  });

  it("the leg retry cancels nothing when this copy no longer holds the lock", async () => {
    const { rec, api, dir, clock } = await legsLeftSetup();
    const realHold = rec.lock.hold.bind(rec.lock);
    rec.lock.hold = () => {
      const held = realHold();
      writeFileSync(join(dir, "reconcile.lock"), JSON.stringify({ pid: 999, token: "other", heartbeat: clock.t }));
      return held;
    };
    await rec.cycle();
    expect(cancelled(api)).toEqual([9]);
  });

  it("the leg retry does not touch an account outside PROJECTX_ALLOWED_ACCOUNT_IDS", async () => {
    const { rec, api, config } = await legsLeftSetup();
    config.allowedAccountIds = [2];
    await rec.cycle();
    expect(cancelled(api)).toEqual([9]);
  });

  it("remembers only legs whose cancel failed, never an order first seen in the flatten's final read", async () => {
    const { rec, api, clock, b } = await make({ b: broker({ orders: [{ id: 9, contractId: MNQ, side: 1, type: 1, size: 1 }] }) });
    const cancel = b.routes["/api/Order/cancel"];
    b.routes["/api/Order/cancel"] = ((body: any) => {
      const r = cancel(body);
      b.st.orders.push({ id: 60, contractId: MNQ, side: 0, type: 1, size: 1 }); // a new entry lands right then
      return r;
    }) as never;
    await rec.cycle();
    clock.t += 30_000;
    expect((await rec.cycle()).flattened[0].status).toBe("legs_left");
    b.routes["/api/Order/cancel"] = cancel as never;
    clock.t += 30_000;
    await rec.cycle();
    expect(cancelled(api)).toEqual([9]);
    expect(b.st.orders.map((o) => o.id)).toEqual([60]);
  });

  it("leftover legs are not cancelled once a position reopens on that contract", async () => {
    const { rec, api, clock, b } = await make({ b: broker({ orders: [{ id: 9, contractId: MNQ, side: 1, type: 4, size: 1 }, { id: 8, contractId: MNQ, side: 1, type: 1, size: 1 }] }) });
    let cancelOk = false;
    const cancel = b.routes["/api/Order/cancel"];
    b.routes["/api/Order/cancel"] = ((body: any) => (cancelOk ? cancel(body) : { success: false, errorCode: 5, errorMessage: "busy" })) as never;
    b.st.orders = [{ id: 8, contractId: MNQ, side: 1, type: 1, size: 1 }];
    await rec.cycle();
    clock.t += 30_000;
    await rec.cycle();
    cancelOk = true;
    b.st.positions = [pos(1, 1)];
    b.st.orders.push(stop(1, 1, MNQ, 4, 77));
    clock.t += 30_000;
    await rec.cycle();
    expect(api.bodiesFor("/api/Order/cancel").map((x) => x.orderId)).toEqual([8]);
  });

  it("keeps an overnight hold in scope: the window is the trading day or the last 24 h, whichever is longer", async () => {
    // 20 h before T0 is before the 17:00 Chicago start but inside 24 h.
    const { rec, api, clock } = await make({ orders: [[1, MNQ, T0 - 20 * 3600_000]] });
    expect((await rec.cycle()).accounts).toEqual([1]);
    clock.t += 30_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
    expect(DAY_START).toBeGreaterThan(T0 - 20 * 3600_000);
  });

  it("on the 25-hour day (DST ends) the trading day reaches back further than 24 h, and stays the window", async () => {
    // 16:30 CST on 2026-11-01: the trading day began 24.5 h earlier (17:00 CDT on Oct 31).
    const now = Date.parse("2026-11-01T22:30:00Z");
    const { rec } = await make({ clock: fakeClock(now), orders: [[1, MNQ, now - 24.25 * 3600_000]] });
    expect((await rec.cycle()).accounts).toEqual([1]);
  });

  it("drops the streak of a pair that leaves the window, so a later order starts a new one", async () => {
    const DAY = 24 * 3600_000;
    const { rec, api, clock, journal } = await make({ orders: [[1, MNQ, T0 - DAY + 10_000]] });
    await rec.cycle(); // in scope: first sighting at T0
    clock.t += 30_000; // the order is now 24 h + 20 s old
    expect((await rec.cycle()).accounts).toEqual([]);
    expect(closes(api)).toHaveLength(0);
    await sent(journal, 1, MNQ, clock.t + 1_000);
    clock.t += 20_000;
    await rec.cycle(); // back in scope: a new first sighting, not the old one
    expect(closes(api)).toHaveLength(0);
    clock.t += 15_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
  });

  it("re-checks the journal tail right before the close: an order sent meanwhile wins", async () => {
    const { rec, api, clock, b, config } = await make();
    await rec.cycle();
    clock.t += 30_000;
    b.st.onOrdersRead = (n) => {
      // The other copy journals an order while this copy re-reads the account.
      if (n === 3) appendFileSync(config.journalPath, JSON.stringify({ ts: new Date(clock.t).toISOString(), kind: "order_sent", text: "x", accountId: 1, contractId: MNQ }) + "\n");
    };
    await rec.cycle();
    expect(closes(api)).toHaveLength(0);
  });

  it("does not close when the journal tail cannot be re-read", async () => {
    const { rec, api, clock, journal } = await make();
    await rec.cycle();
    clock.t += 30_000;
    const real = journal.readSince.bind(journal);
    let calls = 0;
    journal.readSince = async (since: number) => {
      if (++calls === 2) throw new Error("EIO");
      return real(since);
    };
    await rec.cycle();
    expect(closes(api)).toHaveLength(0);
  });

  it("does not re-flatten on the next cycle: a position that shows up again starts a new streak", async () => {
    const { rec, api, clock, b } = await make();
    await rec.cycle();
    clock.t += 30_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
    b.st.positions = [pos(1, 1)];
    clock.t += 30_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(1);
    clock.t += 30_000;
    await rec.cycle();
    expect(closes(api)).toHaveLength(2);
  });

  it("gives each account's reads their own deadline, so a slow account does not starve the next", async () => {
    const b = broker({ accounts: { 2: { positions: [], orders: [] } } });
    const clock = fakeClock(T0);
    const api = fakeApi(b.routes);
    const client = {
      post: async (path: string, body: any, opts?: PostOptions) => {
        if (body.accountId === 1) clock.t += 3_000; // account 1 answers slowly
        return api.post(path, body, opts);
      },
    };
    const { rec } = await make({ b, clock, client, orders: [[1, MNQ, T0 - 60_000], [2, MNQ, T0 - 60_000]] });
    await rec.cycle();
    const acct2 = api.calls.filter((c) => c.body.accountId === 2);
    expect(acct2).toHaveLength(2);
    for (const c of acct2) expect(c.opts.timeoutMs).toBe(3_000);
  });

  it("never flattens an account outside PROJECTX_ALLOWED_ACCOUNT_IDS (assertTradingAllowed)", async () => {
    const { rec, api, clock } = await make({ env: { PROJECTX_ALLOWED_ACCOUNT_IDS: "2" } });
    await rec.cycle();
    clock.t += 30_000;
    const r = await rec.cycle();
    expect(r.uncovered).toHaveLength(1);
    expect(closes(api)).toHaveLength(0);
  });

  it("flattens a position of unknown direction with no stops, and leaves one alone that one-sided stops cover", async () => {
    const covered = await make({ b: broker({ positions: [pos(0, 1)], orders: [stop(1)] }) });
    await covered.rec.cycle();
    covered.clock.t += 30_000;
    await covered.rec.cycle();
    expect(closes(covered.api)).toHaveLength(0);

    const bare = await make({ b: broker({ positions: [pos(0, 1)] }) });
    await bare.rec.cycle();
    bare.clock.t += 30_000;
    await bare.rec.cycle();
    expect(closes(bare.api)).toHaveLength(1);
    expect((await bare.journal.read({ kind: "exit" }))[0].text).toMatch(/unknown-direction/);
  });

  it("flattens a partially covered position", async () => {
    const { rec, api, clock } = await make({ b: broker({ positions: [pos(1, 2)], orders: [stop(1, 1)] }) });
    await rec.cycle();
    clock.t += 30_000;
    await rec.cycle();
    expect(closes(api)).toEqual([{ accountId: 1, contractId: MNQ }]);
  });

  it("gives every read a deadline", async () => {
    const { rec, api, clock } = await make();
    await rec.cycle();
    for (const c of api.calls) {
      expect(c.opts.deadline).toBeLessThanOrEqual(clock.t + 8_000);
      expect(c.opts.timeoutMs).toBeLessThanOrEqual(3_000);
    }
  });

  it("two reconcilers on one lock directory flatten exactly once; the one without the lock reads nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxr-"));
    const b = broker();
    const clock = fakeClock(T0);
    const one = await make({ dir, b, clock, pid: 100 });
    const two = await make({ dir, b, clock, pid: 200, orders: [] });
    const r1 = await one.rec.cycle();
    const r2 = await two.rec.cycle();
    expect([r1.holdsLock, r2.holdsLock]).toEqual([true, false]);
    clock.t += 30_000;
    await two.rec.cycle();
    await one.rec.cycle();
    expect(closes(one.api)).toHaveLength(1);
    expect(closes(two.api)).toHaveLength(0);
    expect(two.api.calls).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(dir, "reconcile.lock"), "utf8"))).toMatchObject({ pid: 100 });
  });

  it("the copy without the lock keeps trying to take it, and acts once the holder is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxr-"));
    const b = broker();
    const clock = fakeClock(T0);
    const one = await make({ dir, b, clock, pid: 100 });
    const two = await make({ dir, b, clock, pid: 200, orders: [] });
    await one.rec.cycle();
    expect((await two.rec.cycle()).holdsLock).toBe(false);
    await one.rec.stop();
    expect((await two.rec.cycle()).holdsLock).toBe(true);
    clock.t += 30_000;
    await two.rec.cycle();
    expect(closes(two.api)).toHaveLength(1);
  });

  it("a reconciler that lost its lock to a takeover does not flatten", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxr-"));
    const clock = fakeClock(T0);
    const one = await make({ dir, clock });
    await one.rec.cycle();
    clock.t += 30_000;
    // Another copy took the lock over between this copy's refresh and its flatten.
    const realHold = one.rec.lock.hold.bind(one.rec.lock);
    one.rec.lock.hold = () => {
      const held = realHold();
      writeFileSync(join(dir, "reconcile.lock"), JSON.stringify({ pid: 999, token: "other", heartbeat: clock.t }));
      return held;
    };
    const r = await one.rec.cycle();
    expect(r.holdsLock).toBe(true);
    expect(closes(one.api)).toHaveLength(0);
  });

  it("shutdown releases the lock and stops the timer; a copy that never held it leaves the lock alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxr-"));
    const clock = fakeClock(T0);
    const one = await make({ dir, clock });
    const two = await make({ dir, clock, orders: [] });
    expect(one.rec.start()).toBe(true);
    await one.rec.stop();
    expect(one.t.cancelled).toBe(1);
    expect(one.rec.started).toBe(false);
    expect(existsSync(join(dir, "reconcile.lock"))).toBe(false);
    expect((await two.rec.cycle()).holdsLock).toBe(true);
    await one.rec.stop();
    expect(existsSync(join(dir, "reconcile.lock"))).toBe(true);
  });

  it("runs the first check at start, then on the interval; a second start is a no-op", async () => {
    const { rec, t, api } = await make({ env: { PROJECTX_RECONCILE_SECONDS: "20" } });
    expect(rec.start()).toBe(true);
    expect(t.registered).toEqual([20_000]);
    expect(rec.start()).toBe(false);
    t.fn!(); // fires while the first check still runs: skipped
    await rec.stop();
    expect(api.bodiesFor("/api/Position/searchOpen")).toHaveLength(1);
  });

  it("raises an interval under 5 s to 5 s and says so on stderr", async () => {
    const { rec, t, warnings, config } = await make({ env: { PROJECTX_RECONCILE_SECONDS: "1" } });
    expect(rec.intervalSeconds).toBe(5);
    expect(rec.start()).toBe(true);
    expect(t.registered).toEqual([5_000]);
    expect(warnings[0]).toBe("reconcile: PROJECTX_RECONCILE_SECONDS=1 is below the minimum; using 5 s");
    expect(rec.lock.path).toBe(join(config.journalPath, "..", "reconcile.lock"));
    await rec.stop();
    const ok = await make({ env: { PROJECTX_RECONCILE_SECONDS: "5" } });
    ok.rec.start();
    await ok.rec.stop();
    expect(ok.warnings).toEqual([]);
  });

  it.each([
    [{ PROJECTX_TRADING_ENABLED: "false" }],
    [{ PROJECTX_RECONCILE_SECONDS: "0" }],
  ])("starts no timer with %o", async (env) => {
    const { rec, t, api } = await make({ env });
    expect(rec.enabled).toBe(false);
    expect(rec.start()).toBe(false);
    expect(t.registered).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("does nothing in a cycle when trading is disabled", async () => {
    const { rec, api } = await make({ env: { PROJECTX_TRADING_ENABLED: "false" } });
    expect(await rec.cycle()).toMatchObject({ accounts: [], holdsLock: false });
    expect(api.calls).toHaveLength(0);
  });

  it("never lets a cycle overlap the one still running", async () => {
    const b = broker();
    const api = fakeApi(b.routes);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = {
      post: async (path: string, body: unknown, opts?: PostOptions) => {
        await gate;
        return api.post(path, body, opts);
      },
    };
    const { rec } = await make({ b, client });
    const first = rec.cycle();
    expect(await rec.cycle()).toMatchObject({ skipped: "overlap" });
    release();
    await first;
    expect(api.bodiesFor("/api/Position/searchOpen")).toHaveLength(1);
    expect((await rec.cycle()).skipped).toBeUndefined();
  });

  it("a cycle that throws is reported and the next one still runs", async () => {
    const { rec, warnings } = await make();
    const realHold = rec.lock.hold.bind(rec.lock);
    rec.lock.hold = () => {
      throw new Error("disk full");
    };
    expect((await rec.cycle()).accounts).toEqual([]);
    expect(warnings).toEqual(["reconcile: cycle failed: disk full"]);
    rec.lock.hold = realHold;
    expect((await rec.cycle()).accounts).toEqual([1]);
  });
});

describe("Reconciler defaults", () => {
  const setupDir = async (env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "pxd-"));
    const config = loadConfig({ PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k", PROJECTX_TRADING_ENABLED: "true", PROJECTX_JOURNAL_PATH: join(dir, "j", "journal.jsonl"), ...env });
    const journal = new Journal(config.journalPath);
    await journal.add({ kind: "order_sent", text: "x", accountId: 1, contractId: MNQ, ts: new Date(Date.now() - 60_000).toISOString() });
    return { dir, config, journal };
  };

  it("uses real timers and a lock next to the journal, and stops cleanly", async () => {
    const { dir, config, journal } = await setupDir();
    const api = fakeApi(broker({ orders: [stop(1)] }).routes);
    const rec = new Reconciler({ config, client: api, journal });
    expect(rec.lock.path).toBe(join(dir, "j", "reconcile.lock"));
    expect(rec.start()).toBe(true);
    expect(rec.started).toBe(true);
    await rec.stop();
    expect(api.bodiesFor("/api/Position/searchOpen")).toHaveLength(1);
    expect(existsSync(rec.lock.path)).toBe(false);
  });

  it("warns on stderr by default", async () => {
    const { config, journal } = await setupDir();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rec = new Reconciler({ config, client: fakeApi({}), journal });
    rec.lock.hold = () => {
      throw new Error("disk full");
    };
    await rec.cycle();
    expect(spy).toHaveBeenCalledWith("[projectx-mcp] reconcile: cycle failed: disk full");
    spy.mockRestore();
  });

  it("polls with a real sleep while the flatten waits for flat, and survives a journal write failure", async () => {
    const { config, journal } = await setupDir({ PROJECTX_RECONCILE_GRACE_SECONDS: "0" });
    const b = broker();
    let afterClose = 0;
    const api = fakeApi({
      ...b.routes,
      "/api/Position/searchOpen": () => ({ ...OK, positions: b.st.positions.length || afterClose++ ? b.st.positions : [pos(1, 1)] }),
    });
    journal.add = async () => {
      throw new Error("read-only disk");
    };
    const warnings: string[] = [];
    const rec = new Reconciler({ config, client: api, journal, warn: (l) => void warnings.push(l), isAlive: () => true });
    await rec.cycle();
    const r = await rec.cycle();
    expect(r.flattened).toEqual([{ accountId: 1, contractId: MNQ, status: "flat" }]);
    expect(api.bodiesFor("/api/Position/searchOpen").length).toBeGreaterThanOrEqual(5);
    expect(warnings).toHaveLength(1);
  });
});

describe("ReconcileLock", () => {
  const path = () => join(mkdtempSync(join(tmpdir(), "pxl-")), "sub", "reconcile.lock");

  it("is exclusive while fresh, refreshes its heartbeat, and releases", () => {
    const clock = fakeClock(5_000_000);
    const p = path();
    const a = new ReconcileLock(p, 90_000, { now: clock.now, pid: 1, isAlive: () => true });
    const b = new ReconcileLock(p, 90_000, { now: clock.now, pid: 2, isAlive: () => true });
    expect(a.hold()).toBe(true);
    expect(b.hold()).toBe(false);
    clock.t += 60_000;
    expect(a.hold()).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8"))).toMatchObject({ pid: 1, heartbeat: clock.t });
    clock.t += 60_000; // 60 s after the refresh: still fresh
    expect(b.hold()).toBe(false);
    a.release();
    expect(existsSync(p)).toBe(false);
    expect(b.hold()).toBe(true);
  });

  it("takes over a lock whose heartbeat is older than 3x the interval", () => {
    const clock = fakeClock(5_000_000);
    const p = path();
    const a = new ReconcileLock(p, 90_000, { now: clock.now, pid: 1, isAlive: () => true });
    const b = new ReconcileLock(p, 90_000, { now: clock.now, pid: 2, isAlive: () => true });
    expect(a.hold()).toBe(true);
    clock.t += 90_000;
    expect(b.hold()).toBe(false);
    clock.t += 1;
    expect(b.hold()).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).pid).toBe(2);
    // The old holder sees the file is no longer its own.
    expect(a.mine()).toBe(false);
    expect(a.hold()).toBe(false);
    a.release();
    expect(existsSync(p)).toBe(true);
  });

  it("release() does not unlink a lock it no longer owns", () => {
    const clock = fakeClock(5_000_000);
    const p = path();
    const a = new ReconcileLock(p, 90_000, { now: clock.now, pid: 1, isAlive: () => true });
    expect(a.hold()).toBe(true);
    clock.t += 90_001;
    expect(new ReconcileLock(p, 90_000, { now: clock.now, pid: 2, isAlive: () => true }).hold()).toBe(true);
    a.release(); // still thinks it holds it: must check the file first
    expect(JSON.parse(readFileSync(p, "utf8")).pid).toBe(2);
  });

  it("takes over a lock whose pid is dead", () => {
    const clock = fakeClock(5_000_000);
    const p = path();
    expect(new ReconcileLock(p, 90_000, { now: clock.now, pid: 1 }).hold()).toBe(true);
    const b = new ReconcileLock(p, 90_000, { now: clock.now, pid: 2, isAlive: (pid) => pid !== 1 });
    expect(b.hold()).toBe(true);
  });

  it("uses the real pid check by default: this process is alive", () => {
    const clock = fakeClock(5_000_000);
    const p = path();
    expect(new ReconcileLock(p, 90_000, { now: clock.now }).hold()).toBe(true);
    expect(new ReconcileLock(p, 90_000, { now: clock.now, pid: 12345 }).hold()).toBe(false);
  });

  it("treats a pid that has exited as dead with the real check", () => {
    const clock = fakeClock(5_000_000);
    const p = path();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    expect(new ReconcileLock(p, 90_000, { now: clock.now, pid: dead }).hold()).toBe(true);
    expect(new ReconcileLock(p, 90_000, { now: clock.now }).hold()).toBe(true);
  });

  it("judges an unreadable lock file by its age", () => {
    const clock = fakeClock(Date.now());
    const p = path();
    const a = new ReconcileLock(p, 90_000, { now: clock.now, pid: 1, isAlive: () => true });
    a.hold();
    writeFileSync(p, "{half");
    clock.t = statSync(p).mtimeMs; // measure age from the file's own mtime, not the wall clock
    const b = new ReconcileLock(p, 90_000, { now: clock.now, pid: 2, isAlive: () => true });
    expect(b.hold()).toBe(false);
    clock.t += 90_001;
    expect(b.hold()).toBe(true);
  });
});
