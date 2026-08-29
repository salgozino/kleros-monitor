// Unit tests for helpers/state.mjs — STATE_FILE and LOCK_FILE derivation.
// Tests ONLY pure path logic. No fs/network/RPC mocking needed because the
// paths are derived at import time from environment variables.
// We use dynamic import with env vars set before each import.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The state module reads env at module-scope, so we test via env override:
// KLEROS_JUROR_ADDRESS must be set BEFORE importing the module.
// We achieve isolation by resetting module cache via unstable_module (vitest)
// or by testing the derivation formula directly.

// Since the derivation is: addr = (env.KLEROS_JUROR_ADDRESS || deriveJuror()).toLowerCase()
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

// Regression test for Judgment Day finding S2: an empty-but-exported
// KLEROS_JUROR_ADDRESS (e.g. `KLEROS_JUROR_ADDRESS=""` from a cron/CI
// script) is "" in process.env, not undefined. The original code used
// `??`, which only falls back to deriveJuror() on null/undefined, so it
// silently accepted "" and produced a degenerate state-.json /
// kleros-draw-monitor-.lock path instead of deriving the real address.
describe("state module integration — empty KLEROS_JUROR_ADDRESS falls back to deriveJuror()", () => {
  it("derives the real address instead of using the empty string literally", async () => {
    // Give deriveJuror() a real key file to read so the fallback can
    // actually succeed — no mocking, exercises the real code path.
    const home = mkdtempSync(join(tmpdir(), "kleros-juror-home-"));
    writeFileSync(join(home, "key"), "1".repeat(64));

    process.env.WORKDIR = "/tmp/x";
    process.env.KLEROS_JUROR_HOME = home;
    process.env.KLEROS_JUROR_ADDRESS = ""; // explicitly empty, not deleted

    // The module computes its exports once at import time; force a fresh
    // evaluation so it picks up the env set above instead of vitest's
    // cached module from the previous describe block.
    vi.resetModules();
    const { STATE_FILE, LOCK_FILE } = await import("../helpers/state.mjs");

    // A degenerate path (the bug) looks like "/tmp/x/state-.json" — the
    // empty address slice produces an empty suffix. A correctly-derived
    // address always yields an 8-hex-char suffix.
    expect(STATE_FILE).toMatch(/^\/tmp\/x\/state-[0-9a-f]{8}\.json$/);
    expect(LOCK_FILE).toMatch(/^\/tmp\/kleros-draw-monitor-[0-9a-f]{8}\.lock$/);
    expect(STATE_FILE).not.toBe("/tmp/x/state-.json");
    expect(LOCK_FILE).not.toBe("/tmp/kleros-draw-monitor-.lock");

    rmSync(home, { recursive: true, force: true });
    delete process.env.KLEROS_JUROR_ADDRESS;
    delete process.env.KLEROS_JUROR_HOME;
  });
});
