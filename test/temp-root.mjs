// One temporary root per test run, so a run leaves nothing in the system temporary directory.
//
// `npm test` and `npm run coverage` run test/run-tests.mjs: it makes the root under the system
// temporary directory, points TMPDIR (TMP, TEMP) at it BEFORE vitest starts (vitest's own cache dirs
// land in it too), runs vitest, and removes the root when vitest exits: on success, on failure, and
// after a SIGINT or SIGTERM (passed on to vitest). `npx vitest run <file>` makes its own root in the
// global setup (test/temp-root.ts) instead, which works the same once vitest has started.
// KEEP_TEST_TMP=1 keeps the root and prints its path. Every name in the parent is noted before the
// run; a new one afterwards is a leak: it fails the run in CI (nothing else shares the temporary
// directory there) and is a warning locally, since another run at the same time may have made it.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** The root's name: <tmp>/projectx-mcp-tests-<pid>-<random>. */
export const ROOT_PREFIX = "projectx-mcp-tests-";
/** Set to the run's root, for the tests that check they are inside it (and so a nested setup reuses it). */
export const ROOT_ENV = "PX_TEST_TMP_ROOT";
export const KEEP_ENV = "KEEP_TEST_TMP";
const ENV_KEYS = ["TMPDIR", "TMP", "TEMP", ROOT_ENV];
const SIGNALS = ["SIGINT", "SIGTERM"];

/** CI set to true or 1 (any case). */
export const inCI = (env = process.env) => /^(true|1)$/i.test(String(env.CI ?? "").trim());

/** Every name in `parent`, sorted ([] when it can't be read). */
export function listEntries(parent) {
  try {
    return readdirSync(parent).sort();
  } catch {
    return [];
  }
}

/** Names in `parent` not in `before`, but `except`. */
export function leaked(parent, before, except = []) {
  const had = new Set([...before, ...except]);
  return listEntries(parent).filter((n) => !had.has(n));
}

const stderr = (m) => process.stderr.write(`${m}\n`);

/**
 * Makes the run's root under `parent` and moves the temporary directory of `proc.env` into it.
 * Returns the root, `env` (the env a child process gets) and `teardown`: restore the env, remove the
 * root (or keep it), then check the parent for new names (throw when strict, else warn). With
 * `signals` (the global setup), a SIGINT or SIGTERM removes the root and, when nothing else handles
 * the signal, ends the process by it; an exit removes it too.
 *
 * @param {{ parent?: string, proc?: any, log?: (m: string) => void, strict?: boolean, signals?: boolean }} [opts]
 */
export function installTempRoot(opts = {}) {
  const proc = opts.proc ?? process;
  const parent = opts.parent ?? tmpdir();
  const log = opts.log ?? stderr;
  const keep = proc.env[KEEP_ENV] === "1";
  const strict = opts.strict ?? inCI(proc.env);
  const before = listEntries(parent);
  const root = mkdtempSync(join(parent, `${ROOT_PREFIX}${proc.pid}-`));
  const saved = ENV_KEYS.map((k) => [k, proc.env[k]]);
  for (const k of ENV_KEYS) proc.env[k] = root;
  const env = { ...proc.env };

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    for (const [k, v] of saved) {
      if (v === undefined) delete proc.env[k];
      else proc.env[k] = v;
    }
    if (keep) {
      log(`${KEEP_ENV}=1: kept the test temp root ${root}`);
      return;
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      log(`could not remove the test temp root ${root}: ${e.message}`);
    }
  };
  const onSignal = {};
  const unhook = () => {
    proc.removeListener("exit", remove);
    for (const [sig, fn] of Object.entries(onSignal)) proc.removeListener(sig, fn);
  };
  proc.once("exit", remove);
  if (opts.signals !== false) {
    for (const sig of SIGNALS) {
      onSignal[sig] = () => {
        unhook();
        remove();
        if (proc.listenerCount(sig) === 0) proc.kill(proc.pid, sig);
      };
      proc.once(sig, onSignal[sig]);
    }
  }

  const teardown = () => {
    unhook();
    remove();
    const left = leaked(parent, before, keep ? [basename(root)] : []);
    if (!left.length) return [];
    const what = `${left.length} new entr${left.length === 1 ? "y" : "ies"} outside its root in ${parent}: ${left.slice(0, 10).join(", ")}`;
    if (strict) throw new Error(`the test run left ${what}`);
    log(`warning: the test run (or another run at the same time) left ${what}`);
    return left;
  };
  return { root, env, teardown };
}

/**
 * Runs `command args` inside a fresh root (installTempRoot on `proc`), passing a SIGINT or SIGTERM to
 * `proc` on to it; once it exits, tears the root down. Resolves to the exit status: the command's,
 * 1 when it was killed or could not start, or when a leak fails the run.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ parent?: string, proc?: any, log?: (m: string) => void, strict?: boolean, stdio?: any }} [opts]
 */
export function runInRoot(command, args, opts = {}) {
  const proc = opts.proc ?? process;
  const log = opts.log ?? stderr;
  const { root, env, teardown } = installTempRoot({ ...opts, proc, log, signals: false });
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: opts.stdio ?? "inherit", env });
    const forward = {};
    for (const sig of SIGNALS) {
      forward[sig] = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill(sig);
      };
      proc.on(sig, forward[sig]);
    }
    let finished = false;
    const done = (status) => {
      if (finished) return;
      finished = true;
      for (const sig of SIGNALS) proc.removeListener(sig, forward[sig]);
      let leftover = [];
      try {
        leftover = teardown();
      } catch (e) {
        log(e.message);
        status = status || 1;
      }
      resolve({ status, root, leaked: leftover });
    };
    child.on("error", (e) => {
      log(`could not start ${command}: ${e.message}`);
      done(1);
    });
    child.on("exit", (code, signal) => done(signal || code === null ? 1 : code));
  });
}
