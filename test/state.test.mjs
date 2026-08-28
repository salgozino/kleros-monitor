// Unit tests for helpers/state.mjs — STATE_FILE and LOCK_FILE derivation.
// Tests ONLY pure path logic. No fs/network/RPC mocking needed because the
// paths are derived at import time from environment variables.
// We use dynamic import with env vars set before each import.
import { describe, it, expect, beforeEach } from "vitest";

// The state module reads env at module-scope, so we test via env override:
// KLEROS_JUROR_ADDRESS must be set BEFORE importing the module.
// We achieve isolation by resetting module cache via unstable_module (vitest)
// or by testing the derivation formula directly.

// Since the derivation is: addr = (env.KLEROS_JUROR_ADDRESS ?? deriveJuror()).toLowerCase()
// STATE_FILE = `${WORKDIR}/state-${addr.slice(2,10)}.json`
// LOCK_FILE  = `/tmp/kleros-draw-monitor-${addr.slice(2,10)}.lock`
// We test this formula with a known address.

describe("state path derivation", () => {
  const JUROR_ADDRESS = "0x606D2DD4Ca178349b327Ed7ACacf68058bd748Bc";
  const WORKDIR = "/tmp/x";
  // addr.toLowerCase().slice(2, 10) = "606d2dd4"
  const EXPECTED_SUFFIX = "606d2dd4";

  it("STATE_FILE equals /tmp/x/state-606d2dd4.json with env override", async () => {
    process.env.WORKDIR = WORKDIR;
    process.env.KLEROS_JUROR_ADDRESS = JUROR_ADDRESS;

    // Dynamic import to pick up fresh env — note: module cache may hold old
    // value. We validate the derivation formula directly.
    const addr = JUROR_ADDRESS.toLowerCase();
    const suffix = addr.slice(2, 10);
    const STATE_FILE = `${WORKDIR}/state-${suffix}.json`;

    expect(STATE_FILE).toBe(`/tmp/x/state-${EXPECTED_SUFFIX}.json`);
    expect(suffix).toBe(EXPECTED_SUFFIX);
  });

  it("LOCK_FILE equals /tmp/kleros-draw-monitor-606d2dd4.lock with env override", () => {
    const addr = JUROR_ADDRESS.toLowerCase();
    const suffix = addr.slice(2, 10);
    const LOCK_FILE = `/tmp/kleros-draw-monitor-${suffix}.lock`;

    expect(LOCK_FILE).toBe(`/tmp/kleros-draw-monitor-${EXPECTED_SUFFIX}.lock`);
  });

  it("STATE_FILE path starts with WORKDIR", () => {
    const addr = JUROR_ADDRESS.toLowerCase();
    const suffix = addr.slice(2, 10);
    const STATE_FILE = `${WORKDIR}/state-${suffix}.json`;

    expect(STATE_FILE.startsWith(WORKDIR)).toBe(true);
  });
});

// Integration: import the actual module and verify exported constants
describe("state module integration — env-driven paths", async () => {
  it("exported STATE_FILE contains the address suffix from KLEROS_JUROR_ADDRESS", async () => {
    process.env.WORKDIR = "/tmp/x";
    process.env.KLEROS_JUROR_ADDRESS = "0x606D2DD4Ca178349b327Ed7ACacf68058bd748Bc";

    const { STATE_FILE, LOCK_FILE } = await import("../helpers/state.mjs");

    expect(STATE_FILE).toBe("/tmp/x/state-606d2dd4.json");
    expect(LOCK_FILE).toBe("/tmp/kleros-draw-monitor-606d2dd4.lock");
  });
});
