// lib/dispatcher.mjs — One isolated agent process per (dispute, round).
//
// The monitor tick (`monitor.mjs --dispatch`) calls reconcile() once per
// minute. For every known draw with pending agent work it guarantees that
// AT MOST ONE agent process is alive, using a per-draw claim file as the
// registry:
//
//   ${WORKDIR}/dossiers/<D>-r<R>/agent.claim.json   — live claim (pid, startedAt)
//   ${WORKDIR}/dossiers/<D>-r<R>/agent-runs.jsonl   — append-only run history
//   ${WORKDIR}/dossiers/<D>-r<R>/agent-run-<ts>.log — stdout/stderr of one run
//   ${WORKDIR}/dossiers/<D>-r<R>/agent-usage.json   — written by the agent CLI
//
// Crash-safe ordering: the claim is written BEFORE the child is spawned. An
// orphan claim (placeholder pid 0, or a dead pid) is released on the next
// tick; a double spawn is never possible while a claim with a live pid exists.
//
// All side effects go through injectable `deps` so the algorithm is testable
// without any real agent binary.

import {
  existsSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  appendFileSync, mkdirSync, openSync, closeSync,
} from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";

import { dossierDir, pendingWork } from "../helpers/dossier-status.mjs";
import { getHarness } from "./harness.mjs";

export const CLAIM_FILE = "agent.claim.json";
export const RUNS_FILE = "agent-runs.jsonl";
export const USAGE_FILE = "agent-usage.json";

const LOG_TAIL_LINES = 20;
const LOG_TAIL_CHARS = 1500;

// ------------------------------------------------------------ pending work --

/**
 * Decide, for each known draw, whether an agent still has work to do.
 * Reuses the exact predicate shared with the cron gate view.
 *
 * @param {Array<{disputeID: string, roundID: number, dispute: object|null}>} draws
 * @param {{ workdir: string }} opts
 * @returns {Array<{disputeID: string, roundID: number, dir: string, pending: boolean, phaseHint: "A"|"B"|null}>}
 */
export function computePendingWork(draws, { workdir }) {
  return draws.map((g) => {
    const dir = dossierDir(workdir, g.disputeID, g.roundID);
    const work = pendingWork(g.dispute, dir);
    return { disputeID: String(g.disputeID), roundID: Number(g.roundID), dir, pending: work.pending, phaseHint: work.phaseHint };
  });
}

// ---------------------------------------------------------- claim registry --

export function readClaim(dir) {
  const p = `${dir}/${CLAIM_FILE}`;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** Atomic write (tmp + rename) so a crash mid-write never leaves a torn claim. */
export function writeClaim(dir, claim) {
  mkdirSync(dir, { recursive: true });
  const p = `${dir}/${CLAIM_FILE}`;
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(claim, null, 2) + "\n");
  renameSync(tmp, p);
}

export function releaseClaim(dir) {
  try { unlinkSync(`${dir}/${CLAIM_FILE}`); } catch { /* already gone */ }
}

/**
 * True when a process with this pid exists. pid <= 0 is never alive
 * (process.kill(0, ...) would signal the whole process group).
 * EPERM means the process exists but belongs to another user: alive.
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "EPERM") return true;
    return false; // ESRCH or anything else: not alive
  }
}

// ------------------------------------------------------------ run history --

export function appendRun(dir, entry) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(`${dir}/${RUNS_FILE}`, JSON.stringify(entry) + "\n");
}

export function readRuns(dir) {
  const p = `${dir}/${RUNS_FILE}`;
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Timestamp (ms) of the last spawn attempt (`spawned` or `spawn-failed`), or null. */
export function lastSpawnAt(dir) {
  const runs = readRuns(dir);
  for (let i = runs.length - 1; i >= 0; i--) {
    if ((runs[i].event === "spawned" || runs[i].event === "spawn-failed") && runs[i].ts) return Date.parse(runs[i].ts);
  }
  return null;
}

// ------------------------------------------------------------------ utils --

function logTail(logFile) {
  if (!logFile || !existsSync(logFile)) return "";
  let text = "";
  try { text = readFileSync(logFile, "utf8"); } catch { return ""; }
  const lines = text.trimEnd().split("\n").slice(-LOG_TAIL_LINES);
  let tail = lines.join("\n");
  if (tail.length > LOG_TAIL_CHARS) tail = "…" + tail.slice(-LOG_TAIL_CHARS);
  return tail;
}

function compactTs(iso) {
  return iso.replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

/** Default spawner: detached child, stdout/stderr appended to `logFile`. */
export function defaultSpawn({ bin, args, cwd, env, logFile }) {
  const fd = openSync(logFile, "a");
  try {
    const child = nodeSpawn(bin, args, { detached: true, stdio: ["ignore", fd, fd], cwd, env });
    // ENOENT/EACCES arrive asynchronously; log them instead of crashing the tick.
    child.on("error", (err) => {
      try { appendFileSync(logFile, `spawn error: ${err.code ?? err.message} for ${bin}\n`); } catch { /* best effort */ }
    });
    child.unref();
    if (!child.pid) return { pid: 0, error: `no pid returned for ${bin}` };
    return { pid: child.pid };
  } finally {
    closeSync(fd);
  }
}

/** Signal the whole process group (detached child = group leader); fall back to the pid. */
function defaultKill(pid, signal) {
  try { process.kill(-pid, signal); } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

// -------------------------------------------------------------- reconcile --

/**
 * One dispatcher tick.
 *
 * @param {Array<{disputeID: string, roundID: number, dispute: object|null}>} draws
 * @param {{ WORKDIR: string, HARNESS?: string, AGENT_BIN?: string, AGENT_ARGS?: string[],
 *           MAX_PARALLEL_AGENTS?: number, AGENT_SPAWN_COOLDOWN_S?: number, AGENT_TIMEOUT_S?: number,
 *           AGENT_KILL_GRACE_S?: number }} cfg
 * @param {{ spawn?: Function, now?: () => number, isPidAlive?: (pid: number) => boolean,
 *           killPid?: (pid: number, signal: "SIGTERM"|"SIGKILL") => void,
 *           renderPrompt?: (ctx: {dispute: string, round: number}) => string }} deps
 * @returns {string[]} human-readable event lines (empty = silent tick)
 */
export function reconcile(draws, cfg, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const alive = deps.isPidAlive ?? isPidAlive;
  const killPid = deps.killPid ?? defaultKill;
  const spawn = deps.spawn ?? defaultSpawn;
  const renderPrompt = deps.renderPrompt
    ?? ((ctx) => getHarness(cfg.HARNESS || "hermes").renderSkill(cfg, ctx));

  const bin = cfg.AGENT_BIN || "hermes";
  const baseArgs = cfg.AGENT_ARGS || ["-z"];
  const maxParallel = cfg.MAX_PARALLEL_AGENTS ?? 2;
  const cooldownMs = (cfg.AGENT_SPAWN_COOLDOWN_S ?? 300) * 1000;
  const timeoutMs = (cfg.AGENT_TIMEOUT_S ?? 300) * 1000;
  const killGraceMs = (cfg.AGENT_KILL_GRACE_S ?? 60) * 1000;

  const lines = [];
  const tickNow = now();
  const nowIso = new Date(tickNow).toISOString();
  const work = computePendingWork(draws, { workdir: cfg.WORKDIR });

  // Pass 1 — reconcile existing claims (timeouts, dead pids) and count the
  // agents that are still alive after cleanup.
  let aliveCount = 0;
  const claimState = new Map(); // dir -> "alive" | null
  for (const w of work) {
    const claim = readClaim(w.dir);
    if (!claim) { claimState.set(w.dir, null); continue; }
    const label = `dispute ${w.disputeID} round ${w.roundID}`;
    const startedMs = Date.parse(claim.startedAt) || 0;

    if (alive(claim.pid)) {
      // A live pid always counts toward the limit and never gets a sibling;
      // a timed-out agent keeps its claim until the pid is actually gone.
      aliveCount++;
      claimState.set(w.dir, "alive");
      if (claim.terminating) {
        const sentMs = Date.parse(claim.killSentAt) || 0;
        if (!claim.killEscalatedAt && tickNow - sentMs >= killGraceMs) {
          killPid(claim.pid, "SIGKILL");
          writeClaim(w.dir, { ...claim, killEscalatedAt: nowIso });
          appendRun(w.dir, { ts: nowIso, pid: claim.pid, event: "kill-escalated" });
          lines.push(`escalated to SIGKILL for ${label} (pid ${claim.pid}) after grace ${killGraceMs / 1000}s`);
        }
      } else if (tickNow - startedMs > timeoutMs) {
        killPid(claim.pid, "SIGTERM");
        writeClaim(w.dir, { ...claim, terminating: true, killSentAt: nowIso });
        appendRun(w.dir, { ts: nowIso, pid: claim.pid, event: "kill-sent" });
        lines.push(`sent SIGTERM to agent for ${label} (pid ${claim.pid}) after ${Math.round((tickNow - startedMs) / 1000)}s > timeout ${cfg.AGENT_TIMEOUT_S ?? 300}s`);
      }
      continue;
    }

    // Claim exists but pid is dead (or placeholder 0): release and report.
    releaseClaim(w.dir);
    const event = claim.pid > 0 ? (claim.terminating ? "killed-timeout" : "finished") : "orphan-released";
    appendRun(w.dir, { ts: nowIso, pid: claim.pid, event });
    if (event === "finished") {
      const tail = logTail(claim.logFile);
      lines.push(`agent for ${label} finished (pid ${claim.pid})${tail ? " — " + tail : ""}`);
    } else if (event === "killed-timeout") {
      lines.push(`agent for ${label} killed after timeout (pid ${claim.pid})`);
    } else {
      lines.push(`released orphan claim for ${label} (no live pid)`);
    }
    claimState.set(w.dir, null);
  }

  // Pass 2 — spawn for pending draws without a live claim.
  for (const w of work) {
    if (!w.pending || claimState.get(w.dir) === "alive") continue;
    const label = `dispute ${w.disputeID} round ${w.roundID}`;

    const last = lastSpawnAt(w.dir);
    if (last != null && tickNow - last < cooldownMs) continue; // cooldown: silent

    if (aliveCount >= maxParallel) {
      lines.push(`max parallel agents reached (${maxParallel}), ${label} queued`);
      continue;
    }

    const startedAt = new Date(tickNow).toISOString();
    const logFile = `${w.dir}/agent-run-${compactTs(startedAt)}.log`;
    const usagePath = `${w.dir}/${USAGE_FILE}`;
    const prompt = renderPrompt({ dispute: w.disputeID, round: w.roundID });

    // Claim FIRST (placeholder pid), then spawn, then record the real pid.
    const claim = { pid: 0, startedAt, dispute: w.disputeID, round: w.roundID, phaseHint: w.phaseHint, logFile };
    writeClaim(w.dir, claim);
    let pid = 0, error = null;
    try {
      ({ pid = 0, error = null } = spawn({
        bin,
        args: [...baseArgs, prompt, "--usage-file", usagePath],
        cwd: cfg.WORKDIR,
        env: {
          ...process.env,
          KLEROS_AGENT_DISPUTE: w.disputeID,
          KLEROS_AGENT_ROUND: String(w.roundID),
          KLEROS_AGENT_USAGE_FILE: usagePath,
        },
        logFile,
      }) ?? {});
    } catch (e) { error = e.message; }
    if (!pid || pid <= 0) {
      // Failed spawn: release the claim, keep the attempt on record so the
      // cooldown throttles retries, and never count it as a live agent.
      releaseClaim(w.dir);
      appendRun(w.dir, { ts: startedAt, pid: 0, event: "spawn-failed", error: error ?? "no pid" });
      lines.push(`failed to spawn agent for ${label}: ${error ?? "no pid"}`);
      continue;
    }
    writeClaim(w.dir, { ...claim, pid });
    appendRun(w.dir, { ts: startedAt, pid, event: "spawned", phaseHint: w.phaseHint });
    aliveCount++;
    lines.push(`spawned agent for ${label} (pid ${pid}, phase ${w.phaseHint})`);
  }

  return lines;
}
