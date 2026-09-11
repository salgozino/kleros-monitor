#!/usr/bin/env node
// phase-d-appeal-review.mjs — Phase D: post-ruling appeal review.
//
// Trigger: ONLY when a dispute we were drawn in (and voted on) enters the
// Appeal period (period===3) on-chain. Execution (period===4) is too late —
// the appeal window is already closed, so it is explicitly NOT actionable.
//
// What it does:
//   1. Reads the shared draw-monitor state (read-only — this script never
//      writes state-<addr>.json, that belongs to Phase A/B).
//   2. For each known dispute/round sitting in Appeal, reads our own
//      decision.json (Phase B's recorded choice) and the CURRENT provisional
//      ruling on-chain (KlerosCore.currentRuling).
//   2b. If there is no decision.json at all (drawn but never voted), that
//      fact is final once the dispute is in Appeal: writes a "skipped"
//      marker and alerts exactly once. A failed dispute-header read (RPC)
//      is silently retried next tick; a failed currentRuling read or a
//      malformed decision.json is alerted and retried, never marked.
//   3. If our choice matches the ruling AND it isn't tied, nothing to review:
//      writes a lightweight "coherent" marker (deterministic, no judgment
//      involved) so the gate stops re-checking this dispute every tick.
//   4. If our choice DIVERGES from the ruling, OR the ruling is tied
//      (which resolves to "refuse to arbitrate" by default — see dispute
//      #217), that is a judgment call: the script prints full context so an
//      LLM-driven agent can re-read the evidence, weigh a possible appeal,
//      and report a confidence level. The agent — NOT this script — writes
//      dossiers/D-R/appeal-review.json once its review is done (same
//      separation of concerns as decision.json in Phase B: deterministic
//      code never records a judgment-based conclusion).
//
// Safety: read-only. Never touches the private key, never broadcasts
// anything, never calls fundAppeal. Financing an appeal is always a manual,
// explicit decision by the human operator — this script only informs it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { WORKDIR } from "./config.mjs";
import { PERIOD_NAMES } from "./constants.mjs";
import { loadState } from "./helpers/state.mjs";
import { getDisputeHeader } from "./helpers/dispute.mjs";
import { getCurrentRuling } from "./helpers/ruling.mjs";

function dossierDir(disputeID, roundID) {
  return `${WORKDIR}/dossiers/${disputeID}-r${roundID}`;
}
function markerPath(disputeID, roundID) {
  return `${dossierDir(disputeID, roundID)}/appeal-review.json`;
}
function decisionPath(disputeID, roundID) {
  return `${dossierDir(disputeID, roundID)}/decision.json`;
}

// Pure decision logic, exported for unit testing without any I/O:
// given our recorded choice and the on-chain ruling snapshot, decides
// whether a judgment-based review is required. A tie always requires
// review (it resolves to "refuse to arbitrate" by default — see dispute
// #217 — regardless of what any individual juror voted).
export function needsReview(ourChoice, ruling) {
  if (ruling.tied) return true;
  return Number(ruling.ruling) !== Number(ourChoice);
}

// Mirrors phase-c-executor.mjs's readDecision() guard: decision.json must
// carry a numeric choice and identify the same dispute/round it sits under,
// so a stray file copied from another dossier can never be compared.
// Returns an error string, or null when the shape is valid.
export function validateDecision(decision, disputeID, roundID) {
  if (!decision || typeof decision !== "object") return "decision.json is not an object";
  if (typeof decision.choice !== "number") return `decision.json choice is not a number (got ${JSON.stringify(decision.choice)})`;
  if (String(decision.dispute) !== String(disputeID) || Number(decision.round) !== Number(roundID)) {
    return `decision.json dispute/round mismatch (${decision.dispute}/${decision.round}) — refusing to compare`;
  }
  return null;
}

// Loads every known (disputeID, roundID) we were drawn in, from the SHARED
// state file (read-only). Does not mutate it.
function knownDraws() {
  const state = loadState();
  if (!state || !state.seen) return [];
  return Object.keys(state.seen).map((k) => {
    const [disputeID, roundID] = k.split("/");
    return { disputeID, roundID: Number(roundID), voteIDs: state.seen[k] };
  });
}

// Classifies one known draw. Returns null if not in Appeal, or if already
// marked (either "coherent" or "reviewed"). Otherwise returns a status
// object describing what the deterministic layer could establish.
async function classify(draw) {
  const { disputeID, roundID } = draw;
  if (existsSync(markerPath(disputeID, roundID))) return null; // already handled

  // A failed header read is a transient RPC problem, and at this point we do
  // not even know whether the dispute is in Appeal. Alerting here would fire
  // once per historical draw in state.seen during any RPC outage, so stay
  // silent: no marker is written, the draw is simply re-checked next tick.
  let dispute;
  try {
    dispute = await getDisputeHeader(disputeID);
  } catch {
    return null;
  }
  if (dispute.period !== 3) return null; // only Appeal is actionable here

  if (!existsSync(decisionPath(disputeID, roundID))) {
    // We were drawn but never recorded a decision. Once the dispute is in
    // Appeal that can no longer change (the vote window is closed), so
    // retrying every tick is pointless. Mark it as skipped (deterministic
    // fact, no judgment involved) and surface it exactly once.
    const reason = "no decision.json found — we never voted in this round";
    writeSkippedMarker(disputeID, roundID, reason);
    return { disputeID, roundID, dispute, skipped: reason };
  }
  let decision;
  try {
    decision = JSON.parse(readFileSync(decisionPath(disputeID, roundID), "utf8"));
  } catch (e) {
    return { disputeID, roundID, dispute, error: `decision.json unreadable: ${e.message || e}` };
  }
  // Same shape check Phase C applies before acting: a malformed or
  // mismatched decision.json is an operator problem, so it stays an error
  // (re-alerted each tick until fixed) rather than being silently compared.
  const shapeError = validateDecision(decision, disputeID, roundID);
  if (shapeError) return { disputeID, roundID, dispute, error: shapeError };

  let ruling;
  try {
    ruling = await getCurrentRuling(disputeID);
  } catch (e) {
    return { disputeID, roundID, dispute, decision, error: `currentRuling failed: ${e.message || e}` };
  }

  const reviewNeeded = needsReview(decision.choice, ruling);
  return { disputeID, roundID, dispute, decision, ruling, reviewNeeded };
}

// Both markers may be the first file ever written under this dossier (a
// never-voted round usually has no dossier directory at all), so create it.
function writeMarker(disputeID, roundID, payload) {
  mkdirSync(dossierDir(disputeID, roundID), { recursive: true });
  writeFileSync(markerPath(disputeID, roundID), JSON.stringify(payload, null, 2));
}

function writeCoherentMarker(disputeID, roundID, ruling, decision) {
  writeMarker(disputeID, roundID, {
    reviewed: true,
    needed: false,
    reason: "our choice matched the current ruling and it is not tied",
    ourChoice: decision.choice,
    ruling: ruling.ruling,
    tied: ruling.tied,
    checkedAt: new Date().toISOString(),
  });
}

// Written when we never voted in this round: nothing to review, and the
// fact cannot change once the dispute is in Appeal, so the gate must stop
// re-checking it. Deterministic — no judgment involved.
function writeSkippedMarker(disputeID, roundID, reason) {
  writeMarker(disputeID, roundID, {
    reviewed: true,
    needed: false,
    reason,
    checkedAt: new Date().toISOString(),
  });
}

function renderWorkerAlert(pending) {
  const lines = [];
  lines.push("🔎 REVISIÓN POST-RULING (posible apelación) — Kleros Court V2 🔎");
  lines.push("");
  for (const p of pending.sort((a, b) => Number(a.disputeID) - Number(b.disputeID))) {
    lines.push(`━━━ Disputa ${p.disputeID} · Ronda ${p.roundID} ━━━`);
    if (p.error) {
      lines.push(`⚠️ ${p.error}`);
      lines.push("");
      continue;
    }
    if (p.skipped) {
      lines.push(`⏭️ ${p.skipped}`);
      lines.push("   Esta disputa entró en Apelación sin voto nuestro — no hay nada que revisar.");
      lines.push("   Queda marcada; no se vuelve a avisar.");
      lines.push("");
      continue;
    }
    lines.push(`Período actual : ${PERIOD_NAMES[p.dispute.period]} (${p.dispute.period})`);
    lines.push(`Nuestra decisión (decision.json): choice=${p.decision.choice}`);
    lines.push(`Ruling actual on-chain           : choice=${p.ruling.ruling}  tied=${p.ruling.tied}`);
    lines.push(`Dossier: ${dossierDir(p.disputeID, p.roundID)}`);
    lines.push(`Verdict publicado: ${dossierDir(p.disputeID, p.roundID)}/verdict.md`);
    lines.push("");
    if (p.ruling.tied) {
      lines.push("⚖️ El panel quedó EMPATADO — por default resuelve en 'refuse to arbitrate'.");
    } else {
      lines.push("⚖️ El ruling actual DIVERGE de nuestro voto.");
    }
    lines.push("");
    lines.push("Próximo paso (esto lo hacés VOS, el agente, no un script):");
    lines.push("  1. Releé el dossier completo. Si hay evidencia escaneada sin texto");
    lines.push("     extraído (ver manifest.json → warnings), hacé OCR antes de concluir");
    lines.push("     (pdftoppm + tesseract, ver skill kleros-onchain-data / sesión #217).");
    lines.push("  2. Da tu nivel de confianza honesto sobre si el ruling actual es incorrecto");
    lines.push("     y si vale la pena recomendar financiar una apelación.");
    lines.push("  3. Escribí tu conclusión en:");
    lines.push(`     ${markerPath(p.disputeID, p.roundID)}`);
    lines.push('     Formato: {"reviewed": true, "needed": true, "confidence": "...",');
    lines.push('               "recommendation": "appeal" | "no-appeal", "reasoning": "..."}');
    lines.push("  4. Avisá a Koki por Telegram con tu conclusión y el tiempo restante de la");
    lines.push("     ventana de apelación (NO financiés nada vos mismo — la decisión y la tx");
    lines.push("     son suyas, siempre).");
    lines.push("");
  }
  return lines.join("\n");
}

// Stable gate view: only dispute/round/period identity + whether a review is
// still pending (no judgment-derived fields, no timestamps beyond a 5-minute
// retry bucket) so identical situations suppress the agent and only real
// transitions (new dispute entering Appeal, marker written) wake it.
function renderGateView(pending) {
  const lines = pending.map((p) => {
    const retry = ` retry=${Math.floor(Date.now() / 300000) % 1000}`;
    return `dispute=${p.disputeID} round=${p.roundID} period=3 pending-review${retry}`;
  });
  lines.sort();
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const gateMode = argv.includes("--gate");

  const draws = knownDraws();
  if (!draws.length) {
    if (gateMode) process.stdout.write("no-known-draws");
    return;
  }

  const results = [];
  for (const d of draws) {
    const c = await classify(d);
    if (c) results.push(c);
  }

  // Deterministic housekeeping: mark disputes where our choice already
  // matches the (non-tied) ruling. This requires no judgment — pure
  // chain-data comparison — so the script itself may write this marker.
  const pending = [];
  for (const r of results) {
    // error: transient (RPC) or operator-fixable — retried next tick.
    // skipped: marker already written, alerted exactly once (this tick).
    if (r.error || r.skipped) { pending.push(r); continue; }
    if (!r.reviewNeeded) {
      writeCoherentMarker(r.disputeID, r.roundID, r.ruling, r.decision);
      continue;
    }
    pending.push(r);
  }

  if (gateMode) {
    process.stdout.write(pending.length ? renderGateView(pending) : "no-actionable-appeals");
    return;
  }

  if (pending.length === 0) return; // silent tick — watchdog convention
  process.stdout.write(renderWorkerAlert(pending));
}

// Standalone execution guard.
if (import.meta.url === new URL(process.argv[1], "file://").href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`[phase-d-appeal-review] ERROR: ${e.message || e}`);
    process.exitCode = 1;
  });
}
