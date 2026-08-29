// Shared state helpers — loadState, saveState, acquireLock, releaseLock.
//
// STATE_FILE and LOCK_FILE are derived from WORKDIR (from config.mjs) and
// the juror address (from KLEROS_JUROR_ADDRESS env override or deriveJuror()).
//
// Using KLEROS_JUROR_ADDRESS as an env override avoids a key-file read in
// contexts where the address is already known (e.g. tests, cron jobs).
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { WORKDIR } from "../config.mjs";
import { deriveJuror } from "../address.mjs";

// Prefer an explicit env override; fall back to deriving from the key file.
// deriveJuror() is called lazily — whenever KLEROS_JUROR_ADDRESS is absent OR
// empty. Use ||, not ??: a var exported empty by a cron/CI script (e.g.
// KLEROS_JUROR_ADDRESS="") is "" in process.env, not undefined, so ?? would
// silently skip the fallback and derive a degenerate state/lock path instead
// of the real juror address.
const jurorAddr = (process.env.KLEROS_JUROR_ADDRESS || deriveJuror()).toLowerCase();

export const STATE_FILE = `${WORKDIR}/state-${jurorAddr.slice(2, 10)}.json`;
export const LOCK_FILE = `/tmp/kleros-draw-monitor-${jurorAddr.slice(2, 10)}.lock`;

export function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}

export function saveState(st) {
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, STATE_FILE);
}

// Single-instance lock (stale locks older than 10 min are removed).
let lockFd = null;
export function acquireLock() {
  try {
    lockFd = openSync(LOCK_FILE, "wx");
  } catch {
    let age = Infinity;
    try { age = Date.now() - statSync(LOCK_FILE).mtimeMs; } catch {}
    if (age < 600_000) process.exit(0); // another run is alive; stay silent
    try { unlinkSync(LOCK_FILE); } catch {}
    try { lockFd = openSync(LOCK_FILE, "wx"); } catch { process.exit(0); }
  }
}

// Release the single-instance lock. Safe to call even if acquireLock was never called.
export function releaseLock() {
  try { closeSync(lockFd); } catch {}
  try { unlinkSync(LOCK_FILE); } catch {}
}
