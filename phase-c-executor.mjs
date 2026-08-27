#!/usr/bin/env node
// phase-c-executor.mjs — deterministic, NO-LLM executor for Kleros voting.
//
// Runs every minute via cron (no_agent OR as the cron script). Reads the
// already-decided choice (decision.json) + on-chain state, and performs the
// on-chain action when the period is right. NEVER reasons, NEVER decides a
// choice — that is Fase B (the LLM). This is pure state-machine logic.
//
// Logic:
//   - For each known draw (dispute/round in monitor state):
//       * Read decision.json -> { dispute, round, choice }
//       * If missing -> skip (Fase B hasn't decided yet; do nothing)
//       * Vote IDs ALWAYS come from monitor state (on-chain-derived via
//         getRoundInfo), never from Fase B's output — decision.json has no
//         votes field on purpose, so a hand-written vote id can never end up
//         driving an on-chain action. This replaces the older verdict.md
//         VOTES-vs-on-chain cross-check with something stronger: there is no
//         longer a second, possibly-wrong votes source to cross-check at all.
//       * kleros-juror status -> current period + actionRequired
//       * Vote-safety guard: CHOICE must be inside the dossier's actual
//         ruling range (0..answers.length from template.json) before any
//         on-chain call. Fail-closed: if the range can't be determined, halt
//         rather than let an out-of-range choice through.
//       * period === commit(1) && not yet committed -> commit --broadcast
//       * period === vote(2)   && committed && not yet revealed -> reveal --broadcast
//       * else -> nothing this tick
//   - Anti-duplicate: always run `status` first; never re-commit/re-reveal.
//     The CLI itself refuses (ALREADY_COMMITTED / WRONG_PERIOD), but we
//     pre-check to avoid even attempting.
//
// verdict.md (same dossier dir) is passed to --justification on reveal and
// is emitted VERBATIM in the public on-chain VoteCast event — this script
// never reads or parses it, only points the CLI at the file path. Fase B is
// responsible for keeping it clean public markdown only (no session ids, no
// machine-parseable headers): whatever is in that file goes on-chain as-is.
//
// Safety: simulate is the default; only --broadcast sends. This script is
// invoked WITH --broadcast by the cron job (the human already approved the
// on-chain action when the LLM wrote decision.json + verdict.md).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const VIEM = "/usr/local/lib/node_modules/kleros-juror-cli/node_modules/viem";
const { encodeFunctionData, decodeFunctionResult } = require(VIEM);

const WORKDIR = "/root/kleros-monitor";
// Broadcast is controlled by env var (scheduler passes no CLI args reliably).
const BROADCAST = process.env.PHASE_C_BROADCAST === "1";

const CORE = "0x991d2df165670b9cac3B022f4B68D65b664222ea";
const JUROR = "0x606D2DD4Ca178349b327Ed7ACacf68058bd748Bc".toLowerCase();
// Derived from JUROR (not hardcoded) so it can never drift out of sync with
// monitor.mjs's own STATE_FILE if the juror address ever changes.
const STATE_FILE = `${WORKDIR}/state-${JUROR.slice(2, 10)}.json`;

function log(msg) {
  // Write ONLY to the log file, never stdout — the cron scheduler delivers
  // stdout to Telegram, so any console.log becomes noise on every tick.
  // Silent ticks (no draws) must produce zero stdout.
  const line = `${new Date().toISOString()} ${msg}`;
  try {
    mkdirSync(`${WORKDIR}/logs`, { recursive: true });
    writeFileSync(`${WORKDIR}/logs/phase-c.log`, line + "\n", { flag: "a" });
  } catch {}
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}

// Reads dossiers/D-R/decision.json -> { dispute, round, choice }. Votes are
// intentionally NOT read from here — they always come from monitor state
// (the caller's local `votes`, itself derived from on-chain drawnJurors).
// Cross-checks dispute/round against the folder identity so a stray/copied
// decision.json from another dispute can never get acted on by mistake.
function readDecision(dispute, round) {
  const p = `${WORKDIR}/dossiers/${dispute}-r${round}/decision.json`;
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    if (typeof d.choice !== "number") return null;
    if (String(d.dispute) !== String(dispute) || Number(d.round) !== Number(round)) {
      log(`draw ${dispute}/${round}: decision.json dispute/round mismatch (${d.dispute}/${d.round}) — refusing to act`);
      return null;
    }
    return d;
  } catch { return null; }
}

// Read template.json answers array from the dossier for a given dispute/round.
// Returns the top-level `answers` array (non-empty) on success.
// Returns null on: file missing, JSON parse error, missing `answers`, non-array, or empty array.
// Never throws.
function readTemplateAnswers(dispute, round) {
  const p = `${WORKDIR}/dossiers/${dispute}-r${round}/template.json`;
  try {
    const txt = readFileSync(p, "utf8");
    const obj = JSON.parse(txt);
    if (!Array.isArray(obj.answers) || obj.answers.length === 0) return null;
    return obj.answers;
  } catch {
    return null;
  }
}

function klerosStatus(dispute, round, votes) {
  const args = ["status", "--dispute", String(dispute), "--round", String(round), "--votes", votes];
  try {
    const out = execFileSync("kleros-juror", args, { encoding: "utf8", timeout: 60_000 });
    return JSON.parse(out);
  } catch (e) {
    const msg = e.stdout || e.stderr || e.message || "";
    try { return JSON.parse(msg); } catch { return { parseError: msg.slice(0, 200) }; }
  }
}

function klerosCommit(dispute, round, votes, choice) {
  const base = ["commit", "--dispute", String(dispute), "--round", String(round), "--votes", votes, "--choice", String(choice)];
  const sim = execFileSync("kleros-juror", [...base], { encoding: "utf8", timeout: 90_000 });
  const simJson = JSON.parse(sim);
  if (!BROADCAST) return { broadcast: false, simJson };
  const out = execFileSync("kleros-juror", [...base, "--broadcast"], { encoding: "utf8", timeout: 90_000 });
  return { broadcast: true, json: JSON.parse(out) };
}

function klerosReveal(dispute, round, votes, choice) {
  const verdictPath = `${WORKDIR}/dossiers/${dispute}-r${round}/verdict.md`;
  const base = ["reveal", "--dispute", String(dispute), "--round", String(round), "--votes", votes, "--choice", String(choice), "--justification", `@${verdictPath}`];
  const sim = execFileSync("kleros-juror", [...base], { encoding: "utf8", timeout: 90_000 });
  const simJson = JSON.parse(sim);
  if (!BROADCAST) return { broadcast: false, simJson };
  const out = execFileSync("kleros-juror", [...base, "--broadcast"], { encoding: "utf8", timeout: 90_000 });
  return { broadcast: true, json: JSON.parse(out) };
}

function main() {
  const st = loadState();
  if (!st || !st.seen || Object.keys(st.seen).length === 0) {
    // Silent: nothing to do, don't notify (watchdog pattern).
    return;
  }
  for (const key of Object.keys(st.seen)) {
    const [dispute, round] = key.split("/");
    const onchainVotes = st.seen[key];
    const votes = onchainVotes.join(",");
    const v = readDecision(dispute, round);
    if (!v) {
      log(`draw ${key}: no decision.json yet (Fase B pending) — skip`);
      continue;
    }
    const status = klerosStatus(dispute, round, votes);
    if (status.parseError) { log(`draw ${key}: status error ${status.parseError}`); continue; }
    const period = status.period;
    const actionReq = status.actionRequired;

    // Vote-safety guard: cross-validate CHOICE against the dossier's actual
    // ruling range before any on-chain call. Fail-closed on all failure modes.
    // NOTE: this used to ALSO cross-check VOTES (monitor state vs. whatever
    // the LLM declared in verdict.md's VOTES line) — that check is gone on
    // purpose, not by oversight: decision.json never carries a votes field at
    // all anymore, so there is no second, possibly-wrong source left to
    // disagree with `votes` above. CHOICE range is a fully separate risk (the
    // LLM picking a ruling id that doesn't exist for this dispute) and stays
    // guarded exactly as before.
    if (onchainVotes.length === 0) {
      const reason = "empty on-chain vote set";
      console.log(`🛑 HALT dispute ${dispute} r${round}: ${reason}. NO on-chain action taken. Operator: verify dossier/state then re-run.`);
      log(`draw ${key}: HALT — ${reason}`);
      continue;
    }
    const answers = readTemplateAnswers(dispute, round);
    if (answers === null) {
      const reason = "ruling range unavailable";
      console.log(`🛑 HALT dispute ${dispute} r${round}: ${reason}. NO on-chain action taken. Operator: verify dossier then re-run.`);
      log(`draw ${key}: HALT — ${reason}`);
      continue;
    }
    if (v.choice < 0 || v.choice > answers.length) {
      const reason = `CHOICE out of range [0..${answers.length}]`;
      console.log(`🛑 HALT dispute ${dispute} r${round}: ${reason}. actual(decision.json)=${v.choice}. NO on-chain action taken. Operator: verify decision.json then re-run.`);
      log(`draw ${key}: HALT — ${reason} actual=${v.choice}`);
      continue;
    }

    if (period === "commit" && (actionReq === "commit" || actionReq === "commit_or_reveal")) {
      log(`draw ${key}: COMMIT choice=${v.choice} broadcast=${BROADCAST}`);
      const r = klerosCommit(dispute, round, votes, v.choice);
      log(`draw ${key}: commit result ${JSON.stringify(r.json || r.simJson).slice(0, 200)}`);
      // Print to stdout ONLY when an on-chain action was taken (notify user).
      console.log(`✅ COMMITTED dispute ${dispute} r${round} choice ${v.choice} (broadcast=${BROADCAST})`);
    } else if (period === "vote" && actionReq === "reveal") {
      log(`draw ${key}: REVEAL choice=${v.choice} broadcast=${BROADCAST}`);
      const r = klerosReveal(dispute, round, votes, v.choice);
      log(`draw ${key}: reveal result ${JSON.stringify(r.json || r.simJson).slice(0, 200)}`);
      // Print to stdout ONLY when an on-chain action was taken (notify user).
      console.log(`✅ REVEALED dispute ${dispute} r${round} choice ${v.choice} (broadcast=${BROADCAST})`);
    } else {
      log(`draw ${key}: period=${period} actionReq=${actionReq} — wait`);
    }
  }
}

try { main(); } catch (e) { log(`ERROR ${e.message || e}`); process.exitCode = 1; }
