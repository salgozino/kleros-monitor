// Shared state helpers — loadState, saveState, acquireLock.
// STATE_FILE and LOCK_FILE are derived from WORKDIR + JUROR (not exported constants).

import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { WORKDIR, JUROR } from "../constants.mjs";

// Use env override for JUROR address (mirrors monitor.mjs test-mode support).
const jurorAddr = (process.env.KLEROS_JUROR_ADDRESS || JUROR).toLowerCase();
const STATE_FILE = `${WORKDIR}/state-${jurorAddr.slice(2, 10)}.json`;
const LOCK_FILE = `/tmp/kleros-draw-monitor-${jurorAddr.slice(2, 10)}.lock`;

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
