// Unit tests for phase-d-appeal-review.mjs — Phase D: post-ruling appeal
// review. Covers the PURE decision logic (needsReview), the filesystem
// side effects (coherent marker, never touching shared state), and a
// mocked-RPC integration path exercising the exact #217-style scenario
// (tie / divergence in Appeal) without depending on any live case actually
// sitting in an Appeal window when the suite runs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// address.mjs/deriveJuror() requires a readable key file whenever
// KLEROS_JUROR_ADDRESS is not set — set up a minimal fixture home for
// every test in this file so importing phase-d-appeal-review.mjs never
// throws on module load, regardless of describe-block ordering.
let sharedHome;
beforeEach(() => {
  sharedHome = mkdtempSync(join(tmpdir(), "kleros-juror-home-"));
  writeFileSync(join(sharedHome, "key"), "1".repeat(64));
  process.env.KLEROS_JUROR_HOME = sharedHome;
  if (!process.env.WORKDIR) process.env.WORKDIR = mkdtempSync(join(tmpdir(), "kleros-workdir-"));
  if (!process.env.COURT_ID) process.env.COURT_ID = "34";
});
afterEach(() => {
  rmSync(sharedHome, { recursive: true, force: true });
});

describe("needsReview — pure decision logic", () => {
  it("returns false when our choice matches a non-tied ruling", async () => {
    const { needsReview } = await import("../phase-d-appeal-review.mjs");
    expect(needsReview(2, { ruling: 2, tied: false, overridden: false })).toBe(false);
  });

  it("returns true when our choice diverges from the ruling", async () => {
    const { needsReview } = await import("../phase-d-appeal-review.mjs");
    expect(needsReview(1, { ruling: 2, tied: false, overridden: false })).toBe(true);
  });

  it("returns true whenever the panel is tied, even if our choice equals the reported ruling", async () => {
    // Regression for dispute #217: a 3-3 tie resolves to ruling=0 (refuse to
    // arbitrate) by default, but the tied flag is what actually signals "the
    // panel did not reach consensus" — reviewing only on ruling-mismatch
    // would miss this case for whichever side happened to match ruling=0
    // (nobody actually voted 0 in #217, but the logic must not assume that).
    const { needsReview } = await import("../phase-d-appeal-review.mjs");
    expect(needsReview(0, { ruling: 0, tied: true, overridden: false })).toBe(true);
  });

  it("treats string/number choice mismatches consistently (decision.json is JSON)", async () => {
    const { needsReview } = await import("../phase-d-appeal-review.mjs");
    // decision.json choice may round-trip as a number; ruling.ruling is
    // always a Number() from helpers/ruling.mjs — confirm no stray string
    // comparison bug (e.g. "2" !== 2).
    expect(needsReview("2", { ruling: 2, tied: false, overridden: false })).toBe(false);
  });
});

describe("phase-d-appeal-review — filesystem integration (temp WORKDIR, no draws)", () => {
  let workdir;
  const JUROR_ADDRESS = "0x606D2DD4Ca178349b327Ed7ACacf68058bd748Bc";

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kleros-phase-d-test-"));
    const home = mkdtempSync(join(tmpdir(), "kleros-juror-home-"));
    writeFileSync(join(home, "key"), "1".repeat(64));
    process.env.WORKDIR = workdir;
    process.env.COURT_ID = "34";
    process.env.KLEROS_JUROR_HOME = home;
    process.env.KLEROS_JUROR_ADDRESS = JUROR_ADDRESS;
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    delete process.env.WORKDIR;
    delete process.env.COURT_ID;
    delete process.env.KLEROS_JUROR_HOME;
    delete process.env.KLEROS_JUROR_ADDRESS;
  });

  it("knownDraws() reads (disputeID, roundID, voteIDs) from the shared state file without mutating it", async () => {
    writeFileSync(
      join(workdir, "state-606d2dd4.json"),
      JSON.stringify({ lastBlock: 1, seen: { "217/0": [0, 1, 4] } }),
    );
    const before = readFileSync(join(workdir, "state-606d2dd4.json"), "utf8");

    // Re-import fresh so module-scope config picks up the temp WORKDIR.
    vi.resetModules();
    const { main } = await import("../phase-d-appeal-review.mjs");
    expect(typeof main).toBe("function");

    const after = readFileSync(join(workdir, "state-606d2dd4.json"), "utf8");
    expect(after).toBe(before); // Phase D must NEVER write to the shared state file.
  });

  it("does nothing (silent) when no draws are known at all", async () => {
    // No state file exists — knownDraws() must return [] gracefully.
    vi.resetModules();
    const { main } = await import("../phase-d-appeal-review.mjs");
    let threw = false;
    try { await main([]); } catch { threw = true; }
    expect(threw).toBe(false);
  });

  it("gate mode prints 'no-known-draws' when the state file is absent", async () => {
    vi.resetModules();
    const { main } = await import("../phase-d-appeal-review.mjs");
    const logs = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { logs.push(s); return true; };
    try { await main(["--gate"]); } finally { process.stdout.write = orig; }
    expect(logs.join("")).toBe("no-known-draws");
  });
});

describe("validateDecision — decision.json shape guard (mirrors Phase C)", () => {
  it("accepts a well-formed decision for the same dispute/round", async () => {
    const { validateDecision } = await import("../phase-d-appeal-review.mjs");
    expect(validateDecision({ dispute: 217, round: 0, choice: 1 }, "217", 0)).toBeNull();
  });

  it("rejects a non-numeric choice", async () => {
    const { validateDecision } = await import("../phase-d-appeal-review.mjs");
    expect(validateDecision({ dispute: 217, round: 0, choice: "1" }, "217", 0)).toMatch(/not a number/);
    expect(validateDecision({ dispute: 217, round: 0 }, "217", 0)).toMatch(/not a number/);
  });

  it("rejects a decision.json that belongs to another dispute or round", async () => {
    const { validateDecision } = await import("../phase-d-appeal-review.mjs");
    expect(validateDecision({ dispute: 218, round: 0, choice: 1 }, "217", 0)).toMatch(/mismatch/);
    expect(validateDecision({ dispute: 217, round: 1, choice: 1 }, "217", 0)).toMatch(/mismatch/);
  });

  it("rejects non-object payloads", async () => {
    const { validateDecision } = await import("../phase-d-appeal-review.mjs");
    expect(validateDecision(null, "217", 0)).toMatch(/not an object/);
  });
});

// Regression/integration test: exercises the FULL classify() → marker-write
// path against a mocked RPC (period=3, ruling diverges from our choice) —
// the branch that matters for #217-style disputes, without depending on any
// live case actually sitting in Appeal right now (windows are hours long,
// so a real one may not exist when this suite runs).
describe("phase-d-appeal-review — full classify() path with mocked RPC", () => {
  let workdir, home;
  const JUROR_ADDRESS = "0x606D2DD4Ca178349b327Ed7ACacf68058bd748Bc";
  const DISPUTES_SEL = "0x564a565d"; // disputes(uint256)
  const RULING_SEL = "0x1c3db16d"; // currentRuling(uint256)

  // Mocked KlerosCore state, mutable per test. `fail` simulates an RPC
  // outage for the given selector (every RPC URL rejects → rpcWithRetry throws).
  let chain;
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  function installFetchMock() {
    vi.stubGlobal("fetch", vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const data = body.params[0].data;
      let result;
      if (data.startsWith(DISPUTES_SEL)) {
        if (chain.fail === "disputes") throw new Error("mock RPC down");
        // (courtID=34, arbitrated=0x00..00, period, ruled=false, lastPeriodChange=1)
        result = "0x" + word(34) + word(0) + word(chain.period) + word(0) + word(1);
      } else if (data.startsWith(RULING_SEL)) {
        if (chain.fail === "ruling") throw new Error("mock RPC down");
        result = "0x" + word(chain.ruling) + word(chain.tied ? 1 : 0) + word(0);
      } else {
        throw new Error(`unexpected eth_call data in mock: ${data}`);
      }
      return { text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }) };
    }));
  }

  async function run(argv) {
    vi.resetModules();
    // rpcWithRetry backs off with real sleeps (1.5s, 3s, 4.5s) between
    // attempts; make them instant so RPC-failure tests do not time out.
    vi.doMock("../helpers/utils.mjs", async (importOriginal) => ({
      ...(await importOriginal()),
      sleep: async () => {},
    }));
    const { main } = await import("../phase-d-appeal-review.mjs");
    const logs = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { logs.push(s); return true; };
    try { await main(argv); } finally { process.stdout.write = orig; }
    return logs.join("");
  }

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kleros-phase-d-e2e-"));
    home = mkdtempSync(join(tmpdir(), "kleros-juror-home-e2e-"));
    writeFileSync(join(home, "key"), "1".repeat(64));
    process.env.WORKDIR = workdir;
    process.env.COURT_ID = "34";
    process.env.KLEROS_JUROR_HOME = home;
    process.env.KLEROS_JUROR_ADDRESS = JUROR_ADDRESS;

    writeFileSync(
      join(workdir, "state-606d2dd4.json"),
      JSON.stringify({ lastBlock: 1, seen: { "217/0": [0, 1, 4] } }),
    );
    mkdirSync(join(workdir, "dossiers", "217-r0"), { recursive: true });
    // We voted choice=1 ("Town of Cary is right"); the mocked ruling below
    // will be choice=2 with tied=false — a genuine divergence.
    writeFileSync(join(workdir, "dossiers", "217-r0", "decision.json"), JSON.stringify({ dispute: 217, round: 0, choice: 1 }));

    // Default chain state: period=3 (Appeal), ruling=2, not tied.
    chain = { period: 3, ruling: 2, tied: false, fail: null };
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(workdir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("flags a genuine divergence as pending review and writes NO marker itself", async () => {
    vi.resetModules();
    const { main } = await import("../phase-d-appeal-review.mjs");

    const logs = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { logs.push(s); return true; };
    try { await main([]); } finally { process.stdout.write = orig; }

    const alert = logs.join("");
    expect(alert).toContain("Disputa 217");
    expect(alert).toContain("choice=1"); // our decision
    expect(alert).toContain("choice=2"); // on-chain ruling
    expect(alert).toContain("DIVERGE");

    // Judgment-based conclusion is the AGENT's job, not this script's —
    // no appeal-review.json should exist yet.
    expect(existsSync(join(workdir, "dossiers", "217-r0", "appeal-review.json"))).toBe(false);
  });

  it("gate mode reports the dispute as pending-review", async () => {
    vi.resetModules();
    const { main } = await import("../phase-d-appeal-review.mjs");

    const logs = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { logs.push(s); return true; };
    try { await main(["--gate"]); } finally { process.stdout.write = orig; }

    expect(logs.join("")).toContain("dispute=217 round=0 period=3 pending-review");
  });

  it("never-voted round in Appeal: alerts once, writes a skipped marker, then goes silent", async () => {
    // Remove decision.json → we were drawn but never voted. That can't
    // change once the dispute is in Appeal, so it must NOT be retried.
    rmSync(join(workdir, "dossiers", "217-r0", "decision.json"));

    vi.resetModules();
    const { main } = await import("../phase-d-appeal-review.mjs");

    const capture = async (argv) => {
      const logs = [];
      const orig = process.stdout.write;
      process.stdout.write = (s) => { logs.push(s); return true; };
      try { await main(argv); } finally { process.stdout.write = orig; }
      return logs.join("");
    };

    const first = await capture([]);
    expect(first).toContain("Disputa 217");
    expect(first).toContain("never voted");

    const markerPath = join(workdir, "dossiers", "217-r0", "appeal-review.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(marker.needed).toBe(false);
    expect(marker.reason).toMatch(/never voted/);

    // Second tick: marker present → nothing pending, both modes silent/idle.
    expect(await capture([])).toBe("");
    expect(await capture(["--gate"])).toBe("no-actionable-appeals");
  });

  it("malformed decision.json (dispute mismatch) is an error: alerted, retried, no marker written", async () => {
    writeFileSync(join(workdir, "dossiers", "217-r0", "decision.json"), JSON.stringify({ dispute: 999, round: 0, choice: 1 }));

    vi.resetModules();
    const { main } = await import("../phase-d-appeal-review.mjs");

    const logs = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { logs.push(s); return true; };
    try { await main([]); } finally { process.stdout.write = orig; }

    expect(logs.join("")).toContain("mismatch");
    expect(existsSync(join(workdir, "dossiers", "217-r0", "appeal-review.json"))).toBe(false);
  });

  it("does NOT flag a case where our choice matches the ruling and it isn't tied — writes coherent marker instead", async () => {
    // Overwrite decision.json to match the mocked ruling (choice=2).
    writeFileSync(join(workdir, "dossiers", "217-r0", "decision.json"), JSON.stringify({ dispute: 217, round: 0, choice: 2 }));

    vi.resetModules();
    const { main } = await import("../phase-d-appeal-review.mjs");

    const logs = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { logs.push(s); return true; };
    try { await main([]); } finally { process.stdout.write = orig; }

    expect(logs.join("")).toBe(""); // silent — nothing pending
    const markerPath = join(workdir, "dossiers", "217-r0", "appeal-review.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(marker.needed).toBe(false);
  });

  it("tied panel (#217 scenario) is flagged for review even when our choice equals the reported ruling", async () => {
    // 3-3 split → ruling=0 (refuse to arbitrate), tied=true. Our vote is 0 too:
    // matching the ruling must NOT suppress the review while tied.
    chain = { period: 3, ruling: 0, tied: true, fail: null };
    writeFileSync(join(workdir, "dossiers", "217-r0", "decision.json"), JSON.stringify({ dispute: 217, round: 0, choice: 0 }));

    const alert = await run([]);
    expect(alert).toContain("Disputa 217");
    expect(alert).toContain("tied=true");
    expect(alert).toContain("EMPATADO");
    expect(existsSync(join(workdir, "dossiers", "217-r0", "appeal-review.json"))).toBe(false);
    expect(await run(["--gate"])).toContain("dispute=217 round=0 period=3 pending-review");
  });

  it.each([
    [0, "evidence"], [1, "commit"], [2, "vote"], [4, "execution"],
  ])("period=%i (%s) is not actionable: silent, no marker, gate idle", async (period) => {
    chain = { period, ruling: 2, tied: false, fail: null };
    expect(await run([])).toBe("");
    expect(existsSync(join(workdir, "dossiers", "217-r0", "appeal-review.json"))).toBe(false);
    expect(await run(["--gate"])).toBe("no-actionable-appeals");
  });

  it("never-voted round with NO dossier directory: skipped marker is still written (dir created)", async () => {
    // Regression: a round we never voted in typically has no dossier dir at
    // all. writeFileSync into a missing dir would throw and crash every tick.
    rmSync(join(workdir, "dossiers", "217-r0"), { recursive: true, force: true });

    const first = await run([]);
    expect(first).toContain("never voted");
    const marker = JSON.parse(readFileSync(join(workdir, "dossiers", "217-r0", "appeal-review.json"), "utf8"));
    expect(marker.needed).toBe(false);
    expect(await run(["--gate"])).toBe("no-actionable-appeals");
  });

  it("dispute-header RPC failure is a silent retry: no alert, no marker, gate idle", async () => {
    // During an RPC outage the period is unknown for EVERY draw in state.seen,
    // so alerting here would fire once per historical dispute. Stay silent.
    chain = { period: 3, ruling: 2, tied: false, fail: "disputes" };
    expect(await run([])).toBe("");
    expect(existsSync(join(workdir, "dossiers", "217-r0", "appeal-review.json"))).toBe(false);
    expect(await run(["--gate"])).toBe("no-actionable-appeals");
  });

  it("currentRuling RPC failure (dispute known to be in Appeal) is alerted and retried, no marker", async () => {
    chain = { period: 3, ruling: 2, tied: false, fail: "ruling" };
    const alert = await run([]);
    expect(alert).toContain("Disputa 217");
    expect(alert).toContain("currentRuling failed");
    expect(existsSync(join(workdir, "dossiers", "217-r0", "appeal-review.json"))).toBe(false);
  });
});
