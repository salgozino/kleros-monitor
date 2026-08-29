#!/usr/bin/env node
// kleros-draw-monitor — detects if OUR juror address has been drawn in a
// Kleros Court V2 dispute (Arbitrum One).
//
// How it works:
//   1. Incrementally scans KlerosCore `Draw(address indexed, uint256 indexed, uint256, uint256)`
//      logs filtered by our juror address (topic1).
//   2. Groups hits by (disputeID, roundID) and cross-checks on-chain round data
//      (getRoundInfo) to derive our exact vote IDs.
//   3. Prints an alert (with ready-to-run kleros-juror commands) ONLY when a new
//      draw appears. Silence = nothing new. Designed for a 5-minute watchdog cron
//      in no-agent mode: stdout IS the alert, empty stdout stays silent.
//
// Safety: never touches the private key, never broadcasts anything. Read-only.

import { existsSync, readFileSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { encodeFunctionData, decodeFunctionResult, keccak256, stringToHex } from "viem";

import { CORE, RPC_URLS, WORKDIR } from "./config.mjs";
import { TOPIC_DRAW, PERIOD_NAMES, INIT_LOOKBACK_BLOCKS } from "./constants.mjs";
import { deriveJuror } from "./address.mjs";
import ROUND_ABI from "./abis/round.mjs";
import { rpc, rpcAny, rpcWithRetry, getLogs } from "./helpers/rpc.mjs";
import { loadState, saveState, acquireLock, releaseLock } from "./helpers/state.mjs";
import { sleep, fmtDate, hex } from "./helpers/utils.mjs";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------- config ---
// KLEROS_JUROR_ADDRESS exists ONLY for testing (simulate another juror).
const juror = (process.env.KLEROS_JUROR_ADDRESS ?? deriveJuror()).toLowerCase();
const initLookback = Number(process.env.INIT_LOOKBACK_BLOCKS || INIT_LOOKBACK_BLOCKS);

// --------------------------------------------------------- chain reads -----
async function getRoundInfo(disputeID, round) {
  const data = encodeFunctionData({ abi: ROUND_ABI, args: [BigInt(disputeID), BigInt(round)] });
  const res = await rpcWithRetry("eth_call", [{ to: CORE, data }, "latest"]);
  return decodeFunctionResult({ abi: ROUND_ABI, data: res });
}

// disputes(): the deployed proxy returns the 5 STATIC leading fields as flat words:
// (uint96 courtID, address arbitrated, uint8 period, bool ruled, uint256 lastPeriodChange)
// (the dynamic Round[] tail is truncated out by the ABI encoder for this accessor shape)
async function getDisputeHeader(disputeID) {
  const sel = keccak256(stringToHex("disputes(uint256)")).slice(0, 10);
  const arg = BigInt(disputeID).toString(16).padStart(64, "0");
  const res = await rpcWithRetry("eth_call", [{ to: CORE, data: sel + arg }, "latest"]);
  const b = res.replace(/^0x/, "");
  if (b.length < 64 * 5) throw new Error(`disputes(${disputeID}): unexpected returndata length ${b.length / 2}`);
  const w = [];
  for (let i = 0; i < 5; i++) w.push(BigInt("0x" + b.slice(i * 64, (i + 1) * 64)));
  return {
    courtID: w[0].toString(),
    arbitrated: "0x" + w[1].toString(16).padStart(40, "0").slice(-40),
    period: Number(w[2]),
    ruled: w[3] !== 0n,
    lastPeriodChange: w[4],
  };
}

// ------------------------------------------------------------- getLogs -----
async function fetchDrawLogs(fromBlock, toBlock) {
  const params = [{
    address: CORE,
    topics: [
      TOPIC_DRAW,
      "0x" + juror.toLowerCase().replace(/^0x/, "").padStart(64, "0"), // our address
      null, // any dispute
    ],
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
  }];
  const logs = await rpcWithRetry("eth_getLogs", params);
  const out = [];
  for (const lg of logs) {
    const data = lg.data.replace(/^0x/, "");
    out.push({
      disputeID: BigInt(lg.topics[2]).toString(),
      roundID: Number(BigInt("0x" + data.slice(0, 64))),
      voteID: Number(BigInt("0x" + data.slice(64, 128))),
      txHash: lg.transactionHash,
      blockNumber: parseInt(lg.blockNumber, 16),
    });
  }
  return out;
}

// Scans [fromBlock..toBlock] with adaptive chunk sizes (public RPCs cap ranges).
async function scanRange(fromBlock, toBlock) {
  const events = [];
  let chunk = 50_000; // arb1.arbitrum.io accepted 50k fine; halves on failure
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const hi = Math.min(cursor + chunk - 1, toBlock);
    try {
      const evs = await fetchDrawLogs(cursor, hi);
      events.push(...evs);
      cursor = hi + 1;
      chunk = Math.min(chunk * 2, 200_000);
    } catch {
      chunk = Math.floor(chunk / 2);
      if (chunk < 5_000) throw new Error(`eth_getLogs keeps failing at block ${cursor}`);
    }
  }
  return events;
}

// ------------------------------------------------------------ rendering ----
// Optional enrichment via @kleros/agentkit (official Kleros read-only CLI):
// adds deadline, juror count and human-readable ruling options to the alert.
// Best-effort: if the binary is missing or slow, we alert anyway.
async function enrichViaAgentkit(disputeID) {
  try {
    const { stdout } = await execFile("kleros", ["dispute", "get", String(disputeID), "--chain", "arbitrum-one", "--format", "json"], { timeout: 45_000 });
    const parsed = JSON.parse(stdout);
    const it = parsed?.items?.[0];
    if (!it) return null;
    const opts = (it.rulingOptions || [])
      .map((o) => `${o.value}=${o.title}`)
      .slice(0, 6)
      .join(" | ");
    return {
      deadline: it.deadline || null,
      jurorCount: it.round?.jurorCount ?? null,
      status: it.status || null,
      rulingLabel: typeof it.ruling === "number" || typeof it.ruling === "string" ? it.rulingLabel : null,
      options: opts || null,
    };
  } catch {
    return null;
  }
}

function renderAlert(groups, isNewMap, opts = {}) {
  const lines = [];
  lines.push("⚖️ SORTEO EN KLEROS COURT V2 ⚖️");
  lines.push("");
  // NOTE: this text is the hash input for the cron monitor_script gate.
  // It MUST be byte-stable within a single (dispute, round, period) state so
  // identical situations suppress the agent, and only real transitions wake it.
  // No timestamps, no "nuevo/conocido" tags, no live-majority fields here.
  for (const g of groups.sort((a, b) => Number(a.disputeID) - Number(b.disputeID))) {
    lines.push(`━━━ Disputa ${g.disputeID} · Ronda ${g.roundID} ━━━`);
    lines.push(`Votos nuestros : ${g.voteIDs.join(", ")}`);
    if (!g.dispute) {
      lines.push("(no se pudo leer el estado on-chain de la disputa en este momento)");
      lines.push("");
      continue;
    }
    lines.push(`Período actual : ${PERIOD_NAMES[g.dispute.period] ?? "?"} (${g.dispute.period})`);
    lines.push(`Corte          : ${g.dispute.courtID}   |   Ruled: ${g.dispute.ruled ? "sí" : "no"}`);
    lines.push(`Arbitrable     : ${g.dispute.arbitrated}`);
    // NOTE: lastPeriodChange is a timestamp and changes every tick — but it is
    // EXCLUDED from the monitor gate hash (see renderGateView below). Only
    // dispute/round/period identity drives wake/suppress decisions.
    if (g.enrich) {
      const e = g.enrich;
      if (e.jurorCount != null) lines.push(`Jurors en ronda: ${e.jurorCount} (votos nuestros: ${g.voteIDs.length})`);
      if (e.deadline) lines.push(`Deadline del período: ${new Date(e.deadline).toISOString().replace("T", " ").slice(0, 16)} UTC`);
      if (e.options) lines.push(`Opciones de voto: ${e.options}`);
      // Live majority deliberately omitted from gate text (changes as votes land,
      // would re-wake the agent mid-period without any new actionable state).
    }
    for (const e of g.events) lines.push(`Draw tx        : https://arbiscan.io/tx/${e.txHash}`);
    const votesArg = g.voteIDs.join(",");
    lines.push("");
    lines.push(`Siguiente paso (decidir el voto ANTES de actuar):`);
    lines.push(`  kleros-juror status --dispute ${g.disputeID} --round ${g.roundID} --votes ${votesArg}`);
    if (!g.dispute.ruled && g.dispute.period === 0)
      lines.push("⏱️ Estamos en EVIDENCE — con corte 34 esto dura ~10 min, MUY corto. Empezá a leer el dossier YA (no esperes a commit). No commitees todavía: el período no lo permite. Dejá el veredicto redactado y listo para el próximo tick.");
    if (!g.dispute.ruled && g.dispute.period === 1)
      lines.push("⏳ Estamos en COMMIT: la ventana suele ser CORTA (~45 min). Decidí y commiteá ya.");
    if (!g.dispute.ruled && g.dispute.period === 2)
      lines.push("⏳ Estamos en VOTE: corré `kleros-juror status` YA — te dice si hay que revelar y el deadline exacto.");
    if (g.dispute.period === 4 || g.dispute.ruled)
      lines.push("ℹ️ La disputa ya está ejecutada/cerrada: solo registro informativo.");
    lines.push("");
  }
  if (opts.footer) { lines.push(opts.footer); lines.push(""); }
  return lines.join("\n");
}

// --------------------------------------------------------------- main ------
export async function main(argv = process.argv.slice(2)) {
  const statusOnly = argv.includes("--status");
  const gateMode = argv.includes("--gate");

  const headHex = await rpcWithRetry("eth_blockNumber", []);
  const head = parseInt(headHex, 16);

  let state = loadState();
  let firstRun = false;
  if (!state) {
    firstRun = true;
    state = { lastBlock: Math.max(0, head - initLookback), seen: {} };
  }

  // Status mode is read-only: report what we already know, enriched live.
  if (statusOnly) {
    console.log(`# kleros-draw-monitor · juror ${juror}`);
    console.log(`# bloque escaneado hasta: ${state.lastBlock} | head actual: ${head}`);
    const keys = Object.keys(state.seen);
    console.log(`# sorteos conocidos: ${keys.length}`);
    if (!keys.length) { console.log("# sin sorteos registrados todavía."); return; }
    const groups = [];
    for (const k of keys) {
      const [d, r] = k.split("/");
      const g = { disputeID: d, roundID: Number(r), voteIDs: state.seen[k], events: [] };
      try { g.dispute = await getDisputeHeader(d); } catch { g.dispute = null; }
      groups.push(g);
    }
    const noneNew = new Map(keys.map((k) => [k, false]));
    process.stdout.write(renderAlert(groups, noneNew));
    return;
  }

  const events = await scanRange(state.lastBlock + (firstRun ? 0 : 1), head);

  // Group by dispute/round.
  const byKey = new Map();
  for (const e of events) {
    const k = `${e.disputeID}/${e.roundID}`;
    if (!byKey.has(k)) byKey.set(k, { disputeID: e.disputeID, roundID: e.roundID, voteSet: new Set(), events: [] });
    const g = byKey.get(k);
    g.voteSet.add(e.voteID);
    g.events.push(e);
  }

  // Enrich + verify vote IDs against getRoundInfo (source of truth).
  const groups = [];
  for (const g of byKey.values()) {
    const [dispute, roundInfo] = await Promise.all([getDisputeHeader(g.disputeID), getRoundInfo(g.disputeID, g.roundID)]);
    // Derive our vote IDs from drawnJurors order (authoritative).
    const derived = [];
    (roundInfo.drawnJurors || []).forEach((addr, i) => {
      if (addr.toLowerCase() === juror.toLowerCase()) derived.push(i);
    });
    g.voteIDs = derived.length ? derived : [...g.voteSet].sort((a, b) => a - b);
    g.nbVotes = Number(roundInfo.nbVotes);
    g.dispute = dispute;
    groups.push(g);
  }

  // Which keys are NEW?
  const isNewMap = new Map();
  const fresh = [];
  for (const g of groups) {
    const k = `${g.disputeID}/${g.roundID}`;
    const prev = state.seen[k];
    if (!prev) { isNewMap.set(k, true); fresh.push(g); continue; }
    const newVotes = g.voteIDs.filter((v) => !prev.includes(v));
    if (newVotes.length) { isNewMap.set(k, true); fresh.push(g); }
    else isNewMap.set(k, false);
  }

  // Re-alert while a KNOWN draw (from persisted state) sits inside an actionable
  // window (un-ruled + commit=1 or vote=2): a missed alert must never cost us a
  // case. Incremental scans don't re-see old draws, so we check them explicitly.
  const alreadyAlerted = new Set(fresh.map((g) => `${g.disputeID}/${g.roundID}`));
  for (const k of Object.keys(state.seen)) {
    if (alreadyAlerted.has(k)) continue;
    const [d, r] = k.split("/");
    try {
      const dispute = await getDisputeHeader(d);
      if (!dispute.ruled && (dispute.period === 1 || dispute.period === 2)) {
        fresh.push({ disputeID: d, roundID: Number(r), voteIDs: state.seen[k], events: [], dispute });
      }
    } catch { /* transient RPC failure on one dispute must not kill the tick */ }
  }

  // Best-effort enrichment (agentkit) only for what we are about to alert on.
  for (const g of fresh) {
    g.enrich = await enrichViaAgentkit(g.disputeID);
  }

  // Persist state BEFORE printing (crash-safety: prefer re-alert over losing one).
  for (const g of groups) state.seen[`${g.disputeID}/${g.roundID}`] = g.voteIDs;
  state.lastBlock = head;
  saveState(state);

  if (fresh.length === 0) {
    // Silent success: nothing new. (Watchdog convention.)
    return;
  }

  const footer = firstRun
    ? "(escaneo inicial: sorteos históricos encontrados dentro de la ventana de búsqueda)"
    : undefined;
  if (!gateMode) process.stdout.write(renderAlert(fresh, isNewMap, { footer }));
}

// ------------------------------------------------------- cron monitor gate --
// When the cron job runs this file as its monitor_script, Hermes hashes the
// ENTIRE stdout: UNCHANGED output suppresses the agent tick entirely, CHANGED
// output wakes the agent with a diff. The full alert above contains volatile
// fields (deadlines rendered from agentkit, draw tx lists, footers), so the
// gate must hash a STABLE VIEW keyed only by actionable identity:
//   (disputeID, roundID, period, ruled) per known draw.
// Same view twice in a row -> silent no-op tick (no agent, no tokens).
// Any transition (new draw, commit->vote, vote->appeal, ruled) -> agent wakes.
function renderGateView(fresh) {
  const lines = fresh.map((g) => {
    const period = g.dispute?.period ?? "?";
    const ruled = g.dispute?.ruled ? 1 : 0;
    // While a draw is in an active voting period (commit=1 / vote=2) and the
    // Fase B output (decision.json) is still missing, keep re-waking the agent
    // on a fixed cadence so a transient LLM/provider failure (e.g. HTTP 503)
    // cannot strand the dispute. The `retry` suffix rotates every 5 minutes
    // (deterministic, no per-second timestamp) so the gate hash changes roughly
    // once per window, forcing a re-run, but stays stable enough to avoid
    // spending tokens every single tick. Once decision.json exists the suffix
    // becomes `done` and the view stabilizes -> agent suppressed (work done).
    const dir = `${WORKDIR}/dossiers/${g.disputeID}-r${g.roundID}`;
    const hasDecision = existsSync(`${dir}/decision.json`);
    // A draw is "work pending" (keep re-waking the agent) while EITHER:
    //   - it is in commit/vote (period 1/2) and Fase B (decision.json) is
    //     still missing, OR
    //   - it is in evidence (period 0) and the dossier is not yet built
    //     (no manifest, or chunkCount===0) so Fase A (download) must retry.
    // The `retry` suffix rotates every 5 minutes (deterministic, no per-second
    // timestamp) so the gate hash changes roughly once per window, forcing a
    // re-run, but stays stable enough to avoid spending tokens every tick.
    // Once the relevant work is done the suffix becomes `done` and the view
    // stabilizes -> agent suppressed (work done).
    const manifestPath = `${dir}/manifest.json`;
    let dossierBuilt = false;
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf8"));
        dossierBuilt = (m.chunkCount || 0) > 0;
      } catch { dossierBuilt = false; }
    }
    const faseAPending = period === 0 && !dossierBuilt;
    const faseBPending = (period === 1 || period === 2) && !hasDecision;
    const pending = faseAPending || faseBPending;
    const retry = pending ? ` retry=${Math.floor(Date.now() / 300000) % 1000}` : " done";
    return `dispute=${g.disputeID} round=${g.roundID} period=${period} ruled=${ruled}${retry}`;
  });
  lines.sort();
  return lines.join("\n");
}

// Standalone execution guard — runs when invoked directly via `node monitor.mjs`.
if (import.meta.url === new URL(process.argv[1], "file://").href) {
  acquireLock();
  const standaloneArgv = process.argv.slice(2);
  const standaloneGate = standaloneArgv.includes("--gate");

  main(standaloneArgv)
    .then(async () => {
      // --gate: cron monitor_script mode. main() already computed `fresh` but it
      // is scoped inside; re-derive the gate view from persisted state instead.
      if (!standaloneGate) return;
      const st = loadState();
      if (!st || Object.keys(st.seen).length === 0) {
        console.log("no-known-draws");
        return;
      }
      const fresh = [];
      for (const k of Object.keys(st.seen)) {
        const [d, r] = k.split("/");
        let dispute = null;
        try { dispute = await getDisputeHeader(d); } catch {}
        fresh.push({ disputeID: d, roundID: Number(r), voteIDs: st.seen[k], dispute });
      }
      // Only actionable states belong in the gate view. A draw is actionable if:
      //   - it is in an active period (evidence=0, commit=1, vote=2), OR
      //   - its dossier is NOT yet complete (chunkCount===0 / no manifest), meaning
      //     Fase A (download) is still in progress and must keep retrying each tick.
      // A draw in appeal/execution with a complete dossier is NOT actionable
      // (nothing to do). This keeps the agent waking until evidence is downloaded.
      const actionable = fresh.filter((g) => {
        if (!g.dispute || g.dispute.ruled) return false;
        if (g.dispute.period === 0 || g.dispute.period === 1 || g.dispute.period === 2) return true;
        // period 3 (appeal) or 4 (execution): actionable only if dossier incomplete
        const dir = `${WORKDIR}/dossiers/${g.disputeID}-r${g.roundID}`;
        const manifestPath = `${dir}/manifest.json`;
        if (!existsSync(manifestPath)) return true;
        try {
          const m = JSON.parse(readFileSync(manifestPath, "utf8"));
          return (m.chunkCount || 0) === 0;
        } catch { return true; }
      });
      process.stdout.write(actionable.length ? renderGateView(actionable) : "no-actionable-draws");
    })
    .catch((e) => {
      console.error(`[kleros-draw-monitor] ERROR: ${e.message || e}`);
      process.exitCode = 1;
    })
    .finally(() => {
      // Release the single-instance lock no matter how the run ended.
      releaseLock();
    });
}
