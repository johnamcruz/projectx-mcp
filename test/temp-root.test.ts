import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";
import { KEEP_ENV, ROOT_ENV, ROOT_PREFIX, inCI, installTempRoot, leaked, listEntries, runInRoot } from "./temp-root.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "pxt-"));

/** A stand-in for `process`: its own env and listeners, and the signals it would have died of. */
function fakeProc(env: NodeJS.ProcessEnv = {}) {
  const ee = new EventEmitter();
  const killed: string[] = [];
  const proc = {
    pid: 4242,
    env,
    on: (e: string, fn: () => void) => ee.on(e, fn),
    once: (e: string, fn: () => void) => ee.once(e, fn),
    removeListener: (e: string, fn: () => void) => ee.removeListener(e, fn),
    listenerCount: (e: string) => ee.listenerCount(e),
    kill: (_pid: number, sig: string) => killed.push(sig),
  };
  return { proc, ee, killed };
}

const quiet = () => {};
/** A node child that makes a dir in its os.tmpdir() and, given a name, one straight in `parent`. */
const nodeArgs = (code: string) => ["-e", code];
const MAKE_TMP = "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'px-child-'))";

describe("test temp root", () => {
  it("puts os.tmpdir(), the helpers' dirs and child processes in the run's root", async () => {
    const root = process.env[ROOT_ENV];
    expect(root, "set by test/run-tests.mjs or the global setup (test/temp-root.ts)").toBeTruthy();
    expect(basename(root!).startsWith(ROOT_PREFIX)).toBe(true);
    expect(tmpdir()).toBe(root);
    expect(realpathSync(tmp()).startsWith(realpathSync(root!) + sep)).toBe(true);
    const { config, client } = await setup();
    expect(realpathSync(dirname(config.journalPath)).startsWith(realpathSync(root!) + sep), "helpers.ts setup()'s journal").toBe(true);
    await client.close();
    expect(execFileSync(process.execPath, ["-p", "require('os').tmpdir()"], { encoding: "utf8" }).trim()).toBe(root);
  });

  it("moves the env's temp dir into a fresh root, then restores it and removes the root", () => {
    const parent = tmp();
    const { proc, ee } = fakeProc({ TMPDIR: "/old", A: "1" });
    const { root, env, teardown } = installTempRoot({ parent, proc, log: quiet });
    expect(dirname(root)).toBe(parent);
    expect(basename(root).startsWith(`${ROOT_PREFIX}4242-`)).toBe(true);
    expect(proc.env).toEqual({ TMPDIR: root, TMP: root, TEMP: root, [ROOT_ENV]: root, A: "1" });
    expect(env).toEqual(proc.env);
    mkdirSync(join(root, "px-x", "deep"), { recursive: true });
    expect(teardown()).toEqual([]);
    expect(existsSync(root)).toBe(false);
    expect(proc.env).toEqual({ TMPDIR: "/old", A: "1" });
    expect(readdirSync(parent)).toEqual([]);
    expect(ee.eventNames()).toEqual([]);
  });

  it("KEEP_TEST_TMP=1 keeps the root, prints its path, and the kept root is no leak", () => {
    const parent = tmp();
    const logs: string[] = [];
    const { proc } = fakeProc({ [KEEP_ENV]: "1", CI: "true" });
    const { root, teardown } = installTempRoot({ parent, proc, log: (m: string) => logs.push(m) });
    expect(teardown()).toEqual([]);
    expect(existsSync(root)).toBe(true);
    expect(logs.some((m) => m.includes(root) && m.includes(KEEP_ENV))).toBe(true);
  });

  it("in CI any new name left outside the root fails the run, named; earlier ones don't count", () => {
    const parent = tmp();
    mkdirSync(join(parent, "px-old"));
    const { proc } = fakeProc({ CI: "true" });
    const { teardown } = installTempRoot({ parent, proc, log: quiet });
    mkdirSync(join(parent, "AbC123nanoid"));
    expect(() => teardown()).toThrow(/left 1 new entry outside its root .*AbC123nanoid/);
  });

  it("outside CI (or CI=false) a leak is a warning: another run may share the tmpdir", () => {
    for (const env of [{}, { CI: "false" }, { CI: "0" }]) {
      const parent = tmp();
      const logs: string[] = [];
      const { proc } = fakeProc(env);
      const { teardown } = installTempRoot({ parent, proc, log: (m: string) => logs.push(m) });
      mkdirSync(join(parent, "pxj-new"));
      expect(teardown()).toEqual(["pxj-new"]);
      expect(logs.some((m) => m.startsWith("warning") && m.includes("pxj-new"))).toBe(true);
    }
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    it(`global setup: ${sig} removes the root and, with no other handler, ends the process by the signal`, () => {
      const parent = tmp();
      const { proc, ee, killed } = fakeProc();
      const { root } = installTempRoot({ parent, proc, log: quiet });
      ee.emit(sig);
      expect(existsSync(root)).toBe(false);
      expect(killed).toEqual([sig]);
      expect(ee.eventNames()).toEqual([]);
    });
  }

  it("global setup: a signal another handler takes care of is left to it; an exit removes the root too", () => {
    const parent = tmp();
    const { proc, ee, killed } = fakeProc();
    ee.on("SIGINT", () => {});
    const { root } = installTempRoot({ parent, proc, log: quiet });
    ee.emit("SIGINT");
    expect(existsSync(root)).toBe(false);
    expect(killed).toEqual([]);
    const second = installTempRoot({ parent, proc, log: quiet });
    ee.emit("exit");
    expect(existsSync(second.root)).toBe(false);
  });

  it("runner: the command and its children make their temp dirs in the root; it is removed; the status is kept", async () => {
    const parent = tmp();
    const { proc } = fakeProc({ ...process.env, CI: "true", [KEEP_ENV]: "" });
    const ok = await runInRoot(process.execPath, nodeArgs(`process.stdout.write(${MAKE_TMP})`), { parent, proc, log: quiet, stdio: "ignore" });
    expect(ok.status).toBe(0);
    expect(readdirSync(parent)).toEqual([]);
    const failed = await runInRoot(process.execPath, nodeArgs(`${MAKE_TMP}; process.exit(3)`), { parent, proc, log: quiet, stdio: "ignore" });
    expect(failed.status).toBe(3);
    expect(readdirSync(parent)).toEqual([]);
    const missing = await runInRoot(join(parent, "no-such-command"), [], { parent, proc, log: quiet, stdio: "ignore" });
    expect(missing.status).toBe(1);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("runner: a dir made outside the root fails the run in CI", async () => {
    const parent = tmp();
    const logs: string[] = [];
    const { proc } = fakeProc({ ...process.env, CI: "1", [KEEP_ENV]: "" });
    const code = `require('fs').mkdirSync(require('path').join(${JSON.stringify(parent)}, 'stray'))`;
    const r = await runInRoot(process.execPath, nodeArgs(code), { parent, proc, log: (m: string) => logs.push(m), stdio: "ignore" });
    expect(r.status).toBe(1);
    expect(logs.some((m) => m.includes("stray"))).toBe(true);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    it(`runner: ${sig} is passed to the command; the root is removed once it exits`, async () => {
      const parent = tmp();
      const { proc, ee } = fakeProc({ ...process.env, [KEEP_ENV]: "" });
      const run = runInRoot(process.execPath, nodeArgs(`${MAKE_TMP}; setTimeout(() => {}, 30000)`), { parent, proc, log: quiet, stdio: "ignore" });
      const root = join(parent, readdirSync(parent)[0]);
      const deadline = Date.now() + 10000;
      while (readdirSync(root).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      ee.emit(sig);
      const r = await run;
      expect(r.status).toBe(1);
      expect(r.root).toBe(root);
      expect(readdirSync(parent)).toEqual([]);
      expect(ee.listenerCount(sig)).toBe(0);
    });
  }

  it("listEntries, leaked and inCI", () => {
    const parent = tmp();
    mkdirSync(join(parent, "px-a"));
    mkdirSync(join(parent, "x"));
    const before = listEntries(parent);
    expect(before).toEqual(["px-a", "x"]);
    mkdirSync(join(parent, "anything"));
    mkdirSync(join(parent, "kept"));
    expect(leaked(parent, before, ["kept"])).toEqual(["anything"]);
    expect(listEntries(join(parent, "missing"))).toEqual([]);
    for (const v of ["true", "TRUE", "1", " true "]) expect(inCI({ CI: v })).toBe(true);
    for (const v of [undefined, "", "false", "0", "no"]) expect(inCI({ CI: v })).toBe(false);
  });
});
