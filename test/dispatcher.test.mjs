// test/dispatcher.test.mjs — Unit tests for lib/dispatcher.mjs and
// helpers/dossier-status.mjs.
//
// Every test runs against a fresh temp WORKDIR and stubbed deps (spawn, now,
// isPidAlive, killPid). No real agent binary is ever executed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computePendingWork, readClaim, writeClaim, releaseClaim, isPidAlive,
  readRuns, lastSpawnAt, reconcile, CLAIM_FILE, RUNS_FILE,
} from "../lib/dispatcher.mjs";
import { pendingWork, dossierBuilt, hasDecision, dossierDir } from "../helpers/dossier-status.mjs";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-09-11T10:00:00.000Z");
const SEC = 1000;

let workdir;
beforeEach(() => { workdir = mkdtempSync(join(tmpdir(), "kleros-dispatcher-")); });
afterEach(() => { rmSync(workdir, { recursive: true, force: true }); });

function draw(disputeID, roundID, period, ruled = false) {
  return { disputeID: String(disputeID), roundID, dispute: { period, ruled } };
}

function dirOf(d, r) { return dossierDir(workdir, d, r); }

function writeManifest(d, r, chunkCount) {
  const dir = dirOf(d, r);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ chunkCount }));
}

function writeDecision(d, r) {
  const dir = dirOf(d, r);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "decision.json"), JSON.stringify({ dispute: d, round: r, choice: 1 }));
}

function baseCfg(over = {}) {
  return {
    WORKDIR: workdir,
    HARNESS: "hermes",
    AGENT_BIN: "fake-agent",
    AGENT_ARGS: ["-z"],
    MAX_PARALLEL_AGENTS: 2,
    AGENT_SPAWN_COOLDOWN_S: 300,
    AGENT_TIMEOUT_S: 1800,
    ...over,
  };
}

/** Stub deps: spawn returns increasing pids and records calls. */
function makeDeps(over = {}) {
  let nextPid = 1000;
  const spawn = vi.fn(() => ({ pid: ++nextPid }));
  const alivePids = new Set();
  return {
    spawn,
    alivePids,
    now: () => T0,
    isPidAlive: (pid) => alivePids.has(pid),
    killPid: vi.fn(),
    ...over,
  };
}

// ── pending-work predicate ───────────────────────────────────────────────────

describe("pendingWork — shared predicate", () => {
  it("period 0 with no manifest -> phase A pending", () => {
    const w = pendingWork({ period: 0, ruled: false }, dirOf(1, 0));
    expect(w).toMatchObject({ phaseA: true, phaseB: false, pending: true, phaseHint: "A" });
  });

  it("period 0 with manifest chunkCount 0 -> phase A pending", () => {
    writeManifest(1, 0, 0);
    expect(dossierBuilt(dirOf(1, 0))).toBe(false);
    expect(pendingWork({ period: 0, ruled: false }, dirOf(1, 0)).phaseHint).toBe("A");
  });

  it("period 1, dossier built, no decision -> phase B pending", () => {
    writeManifest(1, 0, 3);
    const w = pendingWork({ period: 1, ruled: false }, dirOf(1, 0));
    expect(w).toMatchObject({ phaseA: false, phaseB: true, pending: true, phaseHint: "B" });
  });

  it("period 2 with decision.json -> not pending", () => {
    writeManifest(1, 0, 3);
    writeDecision(1, 0);
    expect(hasDecision(dirOf(1, 0))).toBe(true);
    expect(pendingWork({ period: 2, ruled: false }, dirOf(1, 0)).pending).toBe(false);
  });

  it("ruled dispute -> never pending", () => {
    expect(pendingWork({ period: 1, ruled: true }, dirOf(1, 0)).pending).toBe(false);
  });

  it("period 3 with built dossier -> not pending", () => {
    writeManifest(1, 0, 2);
    expect(pendingWork({ period: 3, ruled: false }, dirOf(1, 0)).pending).toBe(false);
  });

  it("null dispute header -> not pending", () => {
    expect(pendingWork(null, dirOf(1, 0)).pending).toBe(false);
  });

  it("computePendingWork maps draws to dossier dirs", () => {
    writeManifest(2, 1, 5);
    const out = computePendingWork([draw(1, 0, 0), draw(2, 1, 4)], { workdir });
    expect(out[0]).toMatchObject({ disputeID: "1", roundID: 0, dir: dirOf(1, 0), pending: true, phaseHint: "A" });
    expect(out[1]).toMatchObject({ disputeID: "2", roundID: 1, pending: false, phaseHint: null });
  });
});

// ── claim registry primitives ────────────────────────────────────────────────

describe("claim registry", () => {
  it("writeClaim / readClaim / releaseClaim round-trip atomically", () => {
    const dir = dirOf(9, 0);
    expect(readClaim(dir)).toBeNull();
    writeClaim(dir, { pid: 42, startedAt: "x", dispute: "9", round: 0, phaseHint: "A", logFile: "l" });
    expect(readClaim(dir)).toMatchObject({ pid: 42, dispute: "9" });
    expect(existsSync(join(dir, CLAIM_FILE + ".tmp"))).toBe(false);
    releaseClaim(dir);
    expect(readClaim(dir)).toBeNull();
    releaseClaim(dir); // idempotent
  });

  it("isPidAlive: current process alive, pid 0 / negative / garbage never alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
    expect(isPidAlive(2 ** 22 - 1)).toBe(false); // max Linux pid, virtually never in use
  });

  it("lastSpawnAt reads the latest spawned entry only", () => {
    const dir = dirOf(9, 0);
    expect(lastSpawnAt(dir)).toBeNull();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RUNS_FILE), [
      JSON.stringify({ ts: "2026-09-11T09:00:00.000Z", pid: 1, event: "spawned" }),
      JSON.stringify({ ts: "2026-09-11T09:30:00.000Z", pid: 1, event: "finished" }),
      "not json",
    ].join("\n") + "\n");
    expect(lastSpawnAt(dir)).toBe(Date.parse("2026-09-11T09:00:00.000Z"));
    expect(readRuns(dir)).toHaveLength(2);
  });

  it("lastSpawnAt treats spawn-failed as a spawn attempt", () => {
    const dir = dirOf(9, 0);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RUNS_FILE), [
      JSON.stringify({ ts: "2026-09-11T09:00:00.000Z", pid: 1, event: "spawned" }),
      JSON.stringify({ ts: "2026-09-11T09:40:00.000Z", pid: 0, event: "spawn-failed", error: "ENOENT" }),
    ].join("\n") + "\n");
    expect(lastSpawnAt(dir)).toBe(Date.parse("2026-09-11T09:40:00.000Z"));
  });
});

// ── reconcile ────────────────────────────────────────────────────────────────

describe("reconcile — spawning", () => {
  it("no claim + pending -> spawns once, claim has real pid, runs log has spawned", () => {
    const deps = makeDeps();
    const lines = reconcile([draw(5, 0, 0)], baseCfg(), deps);

    expect(deps.spawn).toHaveBeenCalledTimes(1);
    const claim = readClaim(dirOf(5, 0));
    expect(claim).toMatchObject({ pid: 1001, dispute: "5", round: 0, phaseHint: "A" });
    expect(claim.startedAt).toBe(new Date(T0).toISOString());
    expect(claim.logFile).toMatch(/agent-run-2026-09-11T10-00-00Z\.log$/);

    const runs = readRuns(dirOf(5, 0));
    expect(runs).toEqual([{ ts: new Date(T0).toISOString(), pid: 1001, event: "spawned", phaseHint: "A" }]);
    expect(lines).toEqual(["spawned agent for dispute 5 round 0 (pid 1001, phase A)"]);
  });

  it("spawn receives bin, args (prompt + --usage-file), cwd and per-draw env", () => {
    const deps = makeDeps();
    reconcile([draw(5, 2, 1)], baseCfg(), deps);
    const call = deps.spawn.mock.calls[0][0];
    expect(call.bin).toBe("fake-agent");
    expect(call.args[0]).toBe("-z");
    expect(call.args[1]).toContain("ASSIGNED DRAW: dispute 5, round 2");
    expect(call.args[1]).not.toMatch(/\{\{[^}]+\}\}/);
    expect(call.args.slice(2)).toEqual(["--usage-file", join(dirOf(5, 2), "agent-usage.json")]);
    expect(call.cwd).toBe(workdir);
    expect(call.env.KLEROS_AGENT_DISPUTE).toBe("5");
    expect(call.env.KLEROS_AGENT_ROUND).toBe("2");
    expect(call.env.KLEROS_AGENT_USAGE_FILE).toBe(join(dirOf(5, 2), "agent-usage.json"));
    expect(call.logFile).toBe(readClaim(dirOf(5, 2)).logFile);
  });

  it("claim file exists (placeholder pid 0) BEFORE spawn is called", () => {
    const seen = [];
    const deps = makeDeps({
      spawn: vi.fn(() => {
        seen.push(readClaim(dirOf(5, 0)));
        return { pid: 777 };
      }),
    });
    reconcile([draw(5, 0, 0)], baseCfg(), deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pid: 0, dispute: "5", round: 0 });
    expect(readClaim(dirOf(5, 0)).pid).toBe(777);
  });

  it("two pending draws -> two spawns with distinct prompts bound to their own dispute", () => {
    const deps = makeDeps();
    const lines = reconcile([draw(11, 0, 0), draw(22, 0, 1)], baseCfg(), deps);
    expect(deps.spawn).toHaveBeenCalledTimes(2);
    const p1 = deps.spawn.mock.calls[0][0].args[1];
    const p2 = deps.spawn.mock.calls[1][0].args[1];
    expect(p1).not.toBe(p2);
    expect(p1).toContain("dispute 11, round 0");
    expect(p1).not.toContain("dispute 22");
    expect(p2).toContain("dispute 22, round 0");
    expect(p2).not.toContain("dispute 11");
    expect(lines).toHaveLength(2);
    expect(readClaim(dirOf(11, 0)).phaseHint).toBe("A");
    expect(readClaim(dirOf(22, 0)).phaseHint).toBe("A"); // dossier missing -> A first
  });

  it("no pending work -> no spawn, no lines", () => {
    writeManifest(5, 0, 3);
    writeDecision(5, 0);
    const deps = makeDeps();
    expect(reconcile([draw(5, 0, 2), draw(6, 0, 1, true)], baseCfg(), deps)).toEqual([]);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(readClaim(dirOf(5, 0))).toBeNull();
  });

  it("renderPrompt dep can be stubbed", () => {
    const deps = makeDeps({ renderPrompt: (ctx) => `PROMPT ${ctx.dispute}/${ctx.round}` });
    reconcile([draw(5, 1, 0)], baseCfg(), deps);
    expect(deps.spawn.mock.calls[0][0].args[1]).toBe("PROMPT 5/1");
  });
});

describe("reconcile — alive claim", () => {
  it("claim with alive pid -> NO spawn across repeated ticks, silent", () => {
    const deps = makeDeps();
    reconcile([draw(5, 0, 0)], baseCfg(), deps);
    deps.alivePids.add(1001);
    deps.spawn.mockClear();

    const lines = [];
    for (let i = 0; i < 3; i++) lines.push(...reconcile([draw(5, 0, 0)], baseCfg(), deps));

    expect(deps.spawn).toHaveBeenCalledTimes(0);
    expect(lines).toEqual([]);
    expect(readClaim(dirOf(5, 0)).pid).toBe(1001);
  });

  /** Spawn at T0, mark pid alive, then tick past the timeout with limit 1 and a second pending draw. */
  function spawnThenTimeout(cfg = baseCfg({ MAX_PARALLEL_AGENTS: 1 })) {
    const deps = makeDeps();
    reconcile([draw(5, 0, 0)], cfg, deps);
    deps.alivePids.add(1001);
    deps.spawn.mockClear();
    const t1 = T0 + 1801 * SEC;
    const lines = reconcile([draw(5, 0, 0), draw(6, 0, 0)], cfg, { ...deps, now: () => t1 });
    return { deps, cfg, t1, lines };
  }

  it("timeout -> SIGTERM sent, claim marked terminating, NO spawn, still counts toward the limit", () => {
    const { deps, lines } = spawnThenTimeout();
    expect(deps.killPid).toHaveBeenCalledWith(1001, "SIGTERM");
    expect(readClaim(dirOf(5, 0))).toMatchObject({ pid: 1001, terminating: true, killSentAt: new Date(T0 + 1801 * SEC).toISOString() });
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(readRuns(dirOf(5, 0)).map((r) => r.event)).toEqual(["spawned", "kill-sent"]);
    expect(lines).toEqual([
      expect.stringMatching(/^sent SIGTERM to agent for dispute 5 round 0 \(pid 1001\)/),
      "max parallel agents reached (1), dispute 6 round 0 queued",
    ]);
  });

  it("terminating claim past grace with pid alive -> SIGKILL escalated once, still no spawn", () => {
    const { deps, cfg, t1 } = spawnThenTimeout();
    deps.killPid.mockClear();
    const lines = reconcile([draw(5, 0, 0)], cfg, { ...deps, now: () => t1 + 30 * SEC }); // within grace: silent
    expect(lines).toEqual([]);
    const lines2 = reconcile([draw(5, 0, 0)], cfg, { ...deps, now: () => t1 + 60 * SEC });
    expect(deps.killPid).toHaveBeenCalledTimes(1);
    expect(deps.killPid).toHaveBeenCalledWith(1001, "SIGKILL");
    expect(lines2[0]).toMatch(/^escalated to SIGKILL for dispute 5 round 0/);
    expect(readClaim(dirOf(5, 0))).toMatchObject({ terminating: true, killEscalatedAt: new Date(t1 + 60 * SEC).toISOString() });
    reconcile([draw(5, 0, 0)], cfg, { ...deps, now: () => t1 + 120 * SEC }); // no second escalation
    expect(deps.killPid).toHaveBeenCalledTimes(1);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(readRuns(dirOf(5, 0)).map((r) => r.event)).toEqual(["spawned", "kill-sent", "kill-escalated"]);
  });

  it("terminating claim whose pid died -> released, killed-timeout, respawn only after cooldown since spawned", () => {
    const { deps, cfg, t1 } = spawnThenTimeout(baseCfg({ MAX_PARALLEL_AGENTS: 1, AGENT_TIMEOUT_S: 60, AGENT_SPAWN_COOLDOWN_S: 3600 }));
    deps.alivePids.delete(1001);
    const lines = reconcile([draw(5, 0, 0)], cfg, { ...deps, now: () => t1 + 60 * SEC }); // T0+1861s < cooldown
    expect(readClaim(dirOf(5, 0))).toBeNull();
    expect(readRuns(dirOf(5, 0)).map((r) => r.event)).toEqual(["spawned", "kill-sent", "killed-timeout"]);
    expect(lines).toEqual(["agent for dispute 5 round 0 killed after timeout (pid 1001)"]);
    expect(deps.spawn).not.toHaveBeenCalled();

    const lines2 = reconcile([draw(5, 0, 0)], cfg, { ...deps, now: () => T0 + 3601 * SEC });
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(lines2).toEqual(["spawned agent for dispute 5 round 0 (pid 1002, phase A)"]);
  });
});

describe("reconcile — spawn failure", () => {
  it.each([
    ["returns pid 0", () => ({ pid: 0, error: "ENOENT" })],
    ["throws", () => { throw new Error("ENOENT"); }],
  ])("spawn stub %s -> claim released, spawn-failed logged, not counted as alive", (_n, impl) => {
    const spawn = vi.fn().mockImplementationOnce(impl).mockImplementation(() => ({ pid: 2000 }));
    const deps = makeDeps({ spawn });
    const lines = reconcile([draw(5, 0, 0), draw(6, 0, 0)], baseCfg({ MAX_PARALLEL_AGENTS: 1 }), deps);
    expect(readClaim(dirOf(5, 0))).toBeNull();
    expect(readRuns(dirOf(5, 0))).toEqual([{ ts: new Date(T0).toISOString(), pid: 0, event: "spawn-failed", error: "ENOENT" }]);
    expect(lines[0]).toBe("failed to spawn agent for dispute 5 round 0: ENOENT");
    expect(lines[1]).toBe("spawned agent for dispute 6 round 0 (pid 2000, phase A)"); // slot was not consumed
    // Cooldown applies to the failed attempt too.
    expect(reconcile([draw(5, 0, 0)], baseCfg(), { ...deps, now: () => T0 + 60 * SEC })).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe("reconcile — dead claim", () => {
  function spawnThenDie(deps) {
    reconcile([draw(5, 0, 0)], baseCfg(), deps);
    // pid 1001 not in alivePids -> dead on next tick
    writeFileSync(readClaim(dirOf(5, 0)).logFile, "line1\nline2\nVERDICT_READY\n");
    deps.spawn.mockClear();
  }

  it("dead pid within cooldown -> released, finished logged with log tail, NO respawn", () => {
    const deps = makeDeps();
    spawnThenDie(deps);

    const lines = reconcile([draw(5, 0, 0)], baseCfg(), { ...deps, now: () => T0 + 60 * SEC });

    expect(readClaim(dirOf(5, 0))).toBeNull();
    expect(readRuns(dirOf(5, 0)).map((r) => r.event)).toEqual(["spawned", "finished"]);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("agent for dispute 5 round 0 finished (pid 1001)");
    expect(lines[0]).toContain("VERDICT_READY");
  });

  it("dead pid after cooldown -> released and respawned in the same tick", () => {
    const deps = makeDeps();
    spawnThenDie(deps);

    const lines = reconcile([draw(5, 0, 0)], baseCfg(), { ...deps, now: () => T0 + 301 * SEC });

    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(lines[0]).toMatch(/finished/);
    expect(lines[1]).toMatch(/^spawned agent for dispute 5 round 0 \(pid 1002/);
    expect(readClaim(dirOf(5, 0)).pid).toBe(1002);
    expect(readRuns(dirOf(5, 0)).map((r) => r.event)).toEqual(["spawned", "finished", "spawned"]);
  });

  it("stale claim on a draw with no pending work -> cleaned up, no spawn", () => {
    const deps = makeDeps();
    spawnThenDie(deps);
    writeManifest(5, 0, 3);
    writeDecision(5, 0);

    const lines = reconcile([draw(5, 0, 2)], baseCfg(), { ...deps, now: () => T0 + 3600 * SEC });

    expect(deps.spawn).not.toHaveBeenCalled();
    expect(readClaim(dirOf(5, 0))).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/finished/);
  });

  it("orphan claim with placeholder pid 0 -> released as orphan", () => {
    writeClaim(dirOf(5, 0), { pid: 0, startedAt: new Date(T0).toISOString(), dispute: "5", round: 0, phaseHint: "A", logFile: "" });
    const deps = makeDeps();
    const lines = reconcile([draw(5, 0, 0)], baseCfg(), deps);
    expect(lines[0]).toBe("released orphan claim for dispute 5 round 0 (no live pid)");
    expect(readRuns(dirOf(5, 0))[0].event).toBe("orphan-released");
    // No prior `spawned` entry -> no cooldown -> respawn allowed.
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("reconcile — parallelism limit", () => {
  it("MAX_PARALLEL_AGENTS=1 with two pending draws -> second queued with a line", () => {
    const deps = makeDeps();
    const cfg = baseCfg({ MAX_PARALLEL_AGENTS: 1 });
    const lines = reconcile([draw(1, 0, 0), draw(2, 0, 0)], cfg, deps);

    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      "spawned agent for dispute 1 round 0 (pid 1001, phase A)",
      "max parallel agents reached (1), dispute 2 round 0 queued",
    ]);
    expect(readClaim(dirOf(2, 0))).toBeNull();
  });

  it("counts already-alive claims from previous ticks toward the limit", () => {
    const deps = makeDeps();
    const cfg = baseCfg({ MAX_PARALLEL_AGENTS: 1 });
    reconcile([draw(1, 0, 0)], cfg, deps);
    deps.alivePids.add(1001);
    deps.spawn.mockClear();

    const lines = reconcile([draw(1, 0, 0), draw(2, 0, 0)], cfg, deps);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(lines).toEqual(["max parallel agents reached (1), dispute 2 round 0 queued"]);
  });
});

// ── renderGateView (monitor.mjs export) ──────────────────────────────────────

describe("renderGateView — exported from monitor.mjs", () => {
  let home;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kleros-juror-home-"));
    writeFileSync(join(home, "key"), "1".repeat(64));
    process.env.KLEROS_JUROR_HOME = home;
    process.env.WORKDIR = workdir;
    process.env.COURT_ID = "34";
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("produces sorted, stable lines keyed by dispute/round/period/ruled", async () => {
    const { renderGateView, actionableDraws } = await import("../monitor.mjs");
    writeManifest(3, 0, 2);
    writeDecision(3, 0);
    const draws = [draw(10, 0, 0), draw(3, 0, 2), draw(7, 1, 3, true)];
    const now = 300000 * 42; // retry window 42

    const view = renderGateView(draws, { now, workdir });
    expect(view.split("\n")).toEqual([
      "dispute=10 round=0 period=0 ruled=0 retry=42",
      "dispute=3 round=0 period=2 ruled=0 done",
      "dispute=7 round=1 period=3 ruled=1 done",
    ]);
    // Same input, same window -> byte-identical (gate hash stability).
    expect(renderGateView(draws, { now, workdir })).toBe(view);
    // Ruled draws are filtered out before the view in real runs.
    expect(actionableDraws(draws).map((g) => g.disputeID)).toEqual(["10", "3"]);
  });

  it("main() rejects --gate together with --dispatch", async () => {
    const { main } = await import("../monitor.mjs");
    await expect(main(["--gate", "--dispatch"])).rejects.toThrow(/mutually exclusive/);
  });
});
