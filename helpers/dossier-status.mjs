// helpers/dossier-status.mjs — Single source of truth for "is agent work
// pending on this draw?".
//
// Both the cron gate view (monitor.mjs --gate) and the agent dispatcher
// (lib/dispatcher.mjs) must agree on when a draw still needs an LLM agent.
// Keep the predicate here so the two never drift apart.
//
// Phase A (download) is pending while the dispute is un-ruled and the
// dossier is not built yet (no manifest.json, or chunkCount === 0).
// Phase B (analysis) is pending while the dispute sits in commit (1) or
// vote (2) and decision.json does not exist yet.
// Ruled disputes never have pending work.

import { existsSync, readFileSync } from "node:fs";

/** Directory holding every artifact for one (dispute, round) draw. */
export function dossierDir(workdir, disputeID, roundID) {
  return `${workdir}/dossiers/${disputeID}-r${roundID}`;
}

/** True when manifest.json exists and reports at least one chunk. */
export function dossierBuilt(dir) {
  const manifestPath = `${dir}/manifest.json`;
  if (!existsSync(manifestPath)) return false;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    return (m.chunkCount || 0) > 0;
  } catch {
    return false;
  }
}

/** True when the Phase B output (decision.json) exists. */
export function hasDecision(dir) {
  return existsSync(`${dir}/decision.json`);
}

/**
 * Classify the pending agent work for a draw.
 *
 * @param {{ period?: number, ruled?: boolean } | null | undefined} dispute
 * @param {string} dir - dossier directory for the draw
 * @returns {{ phaseA: boolean, phaseB: boolean, pending: boolean, phaseHint: "A"|"B"|null }}
 */
export function pendingWork(dispute, dir) {
  if (!dispute || dispute.ruled) return { phaseA: false, phaseB: false, pending: false, phaseHint: null };
  const period = dispute.period;
  const phaseA = !dossierBuilt(dir);
  const phaseB = (period === 1 || period === 2) && !hasDecision(dir);
  const pending = phaseA || phaseB;
  return { phaseA, phaseB, pending, phaseHint: phaseA ? "A" : phaseB ? "B" : null };
}
