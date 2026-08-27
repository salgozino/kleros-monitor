#!/usr/bin/env node
// phase-c-executor.mjs — deterministic, NO-LLM executor for Kleros voting.
//
// Runs every minute via cron (no_agent OR as the cron script). Reads the
// already-decided verdict (verdict.md) + on-chain state, and performs the
// on-chain action when the period is right. NEVER reasons, NEVER decides a
// choice — that is Fase B (the LLM). This is pure state-machine logic.
//
// Logic:
//   - For each known draw (dispute/round in monitor state):
//       * Read verdict.md -> { choice, dispute, round, votes }
//       * If missing -> skip (Fase B hasn't decided yet; do nothing)
//       * kleros-juror status -> current period + actionRequired
//       * period === commit(1) && not yet committed -> commit --broadcast
//       * period === vote(2)   && committed && not yet revealed -> reveal --broadcast
//       * else -> nothing this tick
//   - Anti-duplicate: always run `status` first; never re-commit/re-reveal.
//     The CLI itself refuses (ALREADY_COMMITTED / WRONG_PERIOD), but we
//     pre-check to avoid even attempting.
//
// Safety: simulate is the default; only --broadcast sends. This script is
// invoked WITH --broadcast by the cron job (the human already approved the
// on-chain action when the LLM wrote verdict.md).

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

// Parse verdict.md for the decided choice + ids.
// Expected: a line like "CHOICE: 2" and a header block with dispute/round/votes.
function readVerdict(dispute, round) {
  const p = `${WORKDIR}/dossiers/${dispute}-r${round}/verdict.md`;
  if (!existsSync(p)) return null;
  const txt = readFileSync(p, "utf8");
  const choiceM = txt.match(/CHOICE:\s*(\d+)/i);
  const votesM = txt.match(/VOTES:\s*([\d,]+)/i);
  const roundM = txt.match(/ROUND:\s*(\d+)/i);
  const disputeM = txt.match(/DISPUTE:\s*(\d+)/i);
  if (!choiceM) return null;
  return {
    choice: Number(choiceM[1]),
    votes: votesM ? votesM[1] : null,
    round: roundM ? Number(roundM[1]) : round,
    dispute: disputeM ? disputeM[1] : dispute,
  };
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

// Map each element through Number(), sort ascending.
// Only call on already-split, non-empty-guarded input — never directly on a possibly-empty string.
function sortNums(arr) {
  return arr.map(Number).sort((a, b) => a - b);
}

// Deep-equal check for two sorted numeric arrays.
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
    const votes = st.seen[key].join(",");
    const v = readVerdict(dispute, round);
    if (!v || v.votes == null) {
      log(`draw ${key}: no verdict.md yet (Fase B pending) — skip`);
      continue;
    }
    const status = klerosStatus(dispute, round, v.votes);
    if (status.parseError) { log(`draw ${key}: status error ${status.parseError}`); continue; }
    const period = status.period;
    const actionReq = status.actionRequired;

    // Vote-safety guard: cross-validate CHOICE/VOTES against on-chain truth and
    // dossier ruling range before any on-chain call. Fail-closed on all failure modes.
    const onchainArr = st.seen[key];
    if (onchainArr.length === 0) {
      const reason = "empty on-chain vote set";
      console.log(`🛑 HALT dispute ${dispute} r${round}: ${reason}. expected(on-chain)=n/a actual(verdict.md)=n/a. NO on-chain action taken. Operator: verify verdict.md/dossier then re-run.`);
      log(`draw ${key}: HALT — ${reason}`);
      continue;
    }
    const onchain = sortNums(onchainArr);
    const declaredStr = (v.votes || "").trim();
    const declared = declaredStr === "" ? [] : sortNums(declaredStr.split(","));
    const answers = readTemplateAnswers(dispute, round);
    if (answers === null) {
      const reason = "ruling range unavailable";
      console.log(`🛑 HALT dispute ${dispute} r${round}: ${reason}. expected(on-chain)=n/a actual(verdict.md)=n/a. NO on-chain action taken. Operator: verify verdict.md/dossier then re-run.`);
      log(`draw ${key}: HALT — ${reason}`);
      continue;
    }
    if (v.choice < 0 || v.choice > answers.length) {
      const reason = `CHOICE out of range [0..${answers.length}]`;
      console.log(`🛑 HALT dispute ${dispute} r${round}: ${reason}. expected(on-chain)=n/a actual(verdict.md)=${v.choice}. NO on-chain action taken. Operator: verify verdict.md/dossier then re-run.`);
      log(`draw ${key}: HALT — ${reason}`);
      continue;
    }
    if (!arraysEqual(onchain, declared)) {
      const reason = "VOTES mismatch";
      console.log(`🛑 HALT dispute ${dispute} r${round}: ${reason}. expected(on-chain)=${onchain.join(",")} actual(verdict.md)=${declared.join(",")}. NO on-chain action taken. Operator: verify verdict.md/dossier then re-run.`);
      log(`draw ${key}: HALT — ${reason} expected=${onchain.join(",")} actual=${declared.join(",")}`);
      continue;
    }

    if (period === "commit" && (actionReq === "commit" || actionReq === "commit_or_reveal")) {
      log(`draw ${key}: COMMIT choice=${v.choice} broadcast=${BROADCAST}`);
      const r = klerosCommit(dispute, round, v.votes, v.choice);
      log(`draw ${key}: commit result ${JSON.stringify(r.json || r.simJson).slice(0, 200)}`);
      // Print to stdout ONLY when an on-chain action was taken (notify user).
      console.log(`✅ COMMITTED dispute ${dispute} r${round} choice ${v.choice} (broadcast=${BROADCAST})`);
    } else if (period === "vote" && actionReq === "reveal") {
      log(`draw ${key}: REVEAL choice=${v.choice} broadcast=${BROADCAST}`);
      const r = klerosReveal(dispute, round, v.votes, v.choice);
      log(`draw ${key}: reveal result ${JSON.stringify(r.json || r.simJson).slice(0, 200)}`);
      // Print to stdout ONLY when an on-chain action was taken (notify user).
      console.log(`✅ REVEALED dispute ${dispute} r${round} choice ${v.choice} (broadcast=${BROADCAST})`);
    } else {
      log(`draw ${key}: period=${period} actionReq=${actionReq} — wait`);
    }
  }
}

try { main(); } catch (e) { log(`ERROR ${e.message || e}`); process.exitCode = 1; }
