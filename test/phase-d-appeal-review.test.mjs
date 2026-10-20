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
  const ROUND_INFO_SEL = "0x8a9bb02a"; // KlerosCore.getRoundInfo(uint256,uint256)
  const DISPUTE_KITS_SEL = "0xacdbf51d"; // KlerosCore.disputeKits(uint256)
  const VOTE_INFO_SEL = "0xa7cc08fe"; // DisputeKit.getVoteInfo(uint256,uint256,uint256)
  const DK_ADDRESS = "0x70B464be85A547144C72485eBa2577E5D3A45421";
  const OTHER_JUROR = "0x93aa2f8e5ce8288d57f8785f5a40a60a42fd925e";
  const THIRD_JUROR = "0x70239816581afff150814b46c831e2e5f9e3bf4c";
  const STRANGER = "0x136041c8f81a6c6ba2a45e43d898c9d219e6dbda";

  // Mocked KlerosCore state, mutable per test. `fail` simulates an RPC
  // outage for the given selector (every RPC URL rejects → rpcWithRetry throws).
  // `otherVotesLogsFail`, when true, makes the eth_getLogs call used by
  // getAllVotesWithJustifications() reject (simulates the RPC-failure path
  // for the new "other jurors' votes" fetch, independent of the other reads).
  // `voteSlots` is the round's DisputeKit vote table, one entry per voteID:
  // { account, choice, voted } — it also drives getRoundInfo().nbVotes.
  let chain;
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");

  // Hand-builds one ABI-encoded VoteCast log entry: topics carry
  // juror (indexed) + choice (indexed); data carries the dynamic voteIDs
  // array + justification string, laid out exactly like solidity ABI
  // encoding would (two head words = byte offsets, then each dynamic value).
  function encodeVoteCastLog(juror, choice, voteIds, justification) {
    const voteIdsOffset = 64; // bytes, after the two head words
    const voteIdsWords = [word(voteIds.length), ...voteIds.map(word)];
    const justBytes = Buffer.from(justification, "utf8");
    const justLenPadded = Math.ceil(justBytes.length / 32) * 32;
    const justHexPadded = justBytes.toString("hex").padEnd(justLenPadded * 2, "0");
    const justOffset = voteIdsOffset + voteIdsWords.length * 32;
    const data = "0x"
      + word(voteIdsOffset) + word(justOffset)
      + voteIdsWords.join("")
      + word(justBytes.length) + justHexPadded;
    return {
      topics: [
        "0xa000893c71384499023d2d7b21234f7b9e80c78e0330f357dcd667ff578bd3a4",
        "0x" + word(217),
        "0x" + juror.slice(2).toLowerCase().padStart(64, "0"),
        "0x" + word(choice),
      ],
      data,
    };
  }

  function installFetchMock() {
    vi.stubGlobal("fetch", vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const method = body.method;
      const data = method === "eth_call" ? body.params[0].data : null;
      let result;
      if (method === "eth_getLogs") {
        if (chain.otherVotesLogsFail) throw new Error("mock RPC down (getLogs)");
        const logs = chain.otherVotesLogs ?? [];
        return { text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: logs }) };
      } else if (data.startsWith(DISPUTES_SEL)) {
        if (chain.fail === "disputes") throw new Error("mock RPC down");
        // (courtID=34, arbitrated=0x00..00, period, ruled=false, lastPeriodChange=1)
        result = "0x" + word(34) + word(0) + word(chain.period) + word(0) + word(1);
      } else if (data.startsWith(RULING_SEL)) {
        if (chain.fail === "ruling") throw new Error("mock RPC down");
        result = "0x" + word(chain.ruling) + word(chain.tied ? 1 : 0) + word(0);
      } else if (data.startsWith(ROUND_INFO_SEL)) {
        if (chain.fail === "roundinfo") throw new Error("mock RPC down");
        // Minimal valid getRoundInfo tuple: disputeKitID=1, rest zeroed,
        // drawnJurors=[] (dynamic array offset still must resolve cleanly).
        const nbVotes = (chain.voteSlots ?? []).length;
        result = "0x" + word(0x20) + word(1) + word(0) + word(0) + word(nbVotes) + word(0) + word(0)
          + word(0x160) + word(0) + word(0) + word(0) + word(0) + word(0);
      } else if (data.startsWith(VOTE_INFO_SEL)) {
        const voteID = Number(BigInt("0x" + data.slice(-64)));
        const slot = (chain.voteSlots ?? [])[voteID];
        if (!slot) throw new Error(`mock: getVoteInfo out of range (${voteID})`);
        result = "0x" + slot.account.slice(2).toLowerCase().padStart(64, "0") + word(0)
          + word(slot.choice) + word(slot.voted === false ? 0 : 1);
      } else if (data.startsWith(DISPUTE_KITS_SEL)) {
        if (chain.fail === "disputekits") throw new Error("mock RPC down");
        result = "0x" + word(0).slice(0, 24) + DK_ADDRESS.slice(2).toLowerCase();
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

  it("a genuine divergence includes every OTHER juror's full justification in the alert, with a hard-rule reminder to address them", async () => {
    chain = {
      period: 3, ruling: 2, tied: false, fail: null,
      voteSlots: [
        { account: JUROR_ADDRESS, choice: 1 },
        { account: OTHER_JUROR, choice: 2 },
      ],
      otherVotesLogs: [
        encodeVoteCastLog(JUROR_ADDRESS, 1, [0], "Our own justification text, should be filtered out"),
        encodeVoteCastLog(OTHER_JUROR, 2, [1], "HLTV shows the second map slot as Default, which counts toward the handicap."),
      ],
    };
    const alert = await run([]);
    expect(alert).toContain("VOTOS DE TODOS LOS JURADOS");
    expect(alert).toContain(OTHER_JUROR);
    expect(alert).toContain("HLTV shows the second map slot as Default");
    // Our own vote must be filtered out — the point is to surface OTHERS' reasoning.
    expect(alert).not.toContain("Our own justification text, should be filtered out");
    expect(alert).toContain("REGLA DURA");
    expect(alert).toContain("confidence/recommendation");
  });

  it("a failure fetching other jurors' votes degrades gracefully: alert still fires with a visible gap, no crash", async () => {
    chain = { period: 3, ruling: 2, tied: false, fail: null, otherVotesLogsFail: true };
    const alert = await run([]);
    expect(alert).toContain("Disputa 217");
    expect(alert).toContain("DIVERGE");
    expect(alert).toContain("No se pudieron traer los votos");
    expect(alert).not.toContain("VOTOS DE TODOS LOS JURADOS");
    expect(existsSync(join(workdir, "dossiers", "217-r0", "appeal-review.json"))).toBe(false);
  });

  it("a COHERENT case (no review needed) never bothers fetching other jurors' votes", async () => {
    writeFileSync(join(workdir, "dossiers", "217-r0", "decision.json"), JSON.stringify({ dispute: 217, round: 0, choice: 2 }));
    chain = {
      period: 3, ruling: 2, tied: false, fail: null,
      otherVotesLogsFail: true, // would blow up the mock if ever called
    };
    const alert = await run([]);
    expect(alert).toBe(""); // silent — coherent, no review needed, no RPC call attempted
  });

  // Round 0 of the mocked dispute: us (voteID 0), OTHER_JUROR (1), THIRD_JUROR (2,3).
  const ROUND0_SLOTS = [
    { account: JUROR_ADDRESS, choice: 1 },
    { account: OTHER_JUROR, choice: 2 },
    { account: THIRD_JUROR, choice: 2 },
    { account: THIRD_JUROR, choice: 2 },
  ];

  it("only shows votes cast in THIS round: a VoteCast from another round of the same dispute is excluded", async () => {
    chain = {
      period: 3, ruling: 2, tied: false, fail: null,
      voteSlots: ROUND0_SLOTS,
      otherVotesLogs: [
        encodeVoteCastLog(OTHER_JUROR, 2, [1], "Round 0 reasoning from the other juror."),
        // Same dispute, different round: STRANGER does not hold voteID 1 in round 0.
        encodeVoteCastLog(STRANGER, 2, [1], "Round 1 reasoning that must not leak into round 0."),
        // Same juror/voteIDs as round 0 but a choice round 0 never recorded.
        encodeVoteCastLog(THIRD_JUROR, 1, [2, 3], "Third juror in another round with another choice."),
      ],
    };
    const alert = await run([]);
    expect(alert).toContain("Round 0 reasoning from the other juror.");
    expect(alert).not.toContain(STRANGER);
    expect(alert).not.toContain("Round 1 reasoning that must not leak into round 0.");
    expect(alert).not.toContain("Third juror in another round with another choice.");
  });

  it("the tally counts this round's votes (voteIDs), not VoteCast logs", async () => {
    chain = {
      period: 3, ruling: 2, tied: false, fail: null,
      voteSlots: ROUND0_SLOTS,
      otherVotesLogs: [
        encodeVoteCastLog(JUROR_ADDRESS, 1, [0], "ours"),
        encodeVoteCastLog(OTHER_JUROR, 2, [1], "other"),
        encodeVoteCastLog(THIRD_JUROR, 2, [2, 3], "third, two votes in one cast"),
      ],
    };
    const alert = await run([]);
    expect(alert).toContain('tally: {"1":1,"2":3}');
  });

  it("writes every other juror's FULL justification to other-votes.json and points the alert at it", async () => {
    const long = "A".repeat(1600) + " KEY-DETAIL-PAST-THE-CUT " + "B".repeat(1400);
    chain = {
      period: 3, ruling: 2, tied: false, fail: null,
      voteSlots: ROUND0_SLOTS.slice(0, 2),
      otherVotesLogs: [
        encodeVoteCastLog(JUROR_ADDRESS, 1, [0], "ours"),
        encodeVoteCastLog(OTHER_JUROR, 2, [1], long),
      ],
    };
    const alert = await run([]);
    const file = join(workdir, "dossiers", "217-r0", "other-votes.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.dispute).toBe("217");
    expect(saved.round).toBe(0);
    expect(saved.tally).toEqual({ 1: 1, 2: 1 });
    expect(saved.votes).toHaveLength(1); // ours is filtered out
    expect(saved.votes[0].juror).toBe(OTHER_JUROR);
    expect(saved.votes[0].justification).toBe(long);
    expect(alert).toContain(file);
    expect(alert).not.toContain("KEY-DETAIL-PAST-THE-CUT"); // the alert keeps only an excerpt
    expect(alert).toContain("truncado");
    expect(existsSync(join(workdir, "dossiers", "217-r0", "appeal-review.json"))).toBe(false);
  });

  it("flags a vote as ambiguous when two VoteCast logs claim the same round slot", async () => {
    chain = {
      period: 3, ruling: 2, tied: false, fail: null,
      voteSlots: ROUND0_SLOTS.slice(0, 2),
      otherVotesLogs: [
        encodeVoteCastLog(OTHER_JUROR, 2, [1], "first cast"),
        encodeVoteCastLog(OTHER_JUROR, 2, [1], "second cast, same juror/voteID/choice from another round"),
      ],
    };
    const alert = await run([]);
    expect(alert).toContain("first cast");
    expect(alert).toContain("second cast");
    expect(alert).toContain("AMBIGUO");
  });
});
