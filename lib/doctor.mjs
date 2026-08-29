// lib/doctor.mjs — kleros-monitor environment health checks.
//
// Runs 7 sequential checks and reports PASS / WARN / FAIL / SKIPPED.
// Each FAIL includes a `cta` (call-to-action) string.
// Exit code is non-zero if any check is FAIL.
//
// Usage (via bin/kleros-monitor.mjs):
//   kleros-monitor doctor           # human-readable table
//   kleros-monitor doctor --json    # JSON array to stdout

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, execSync } from "node:child_process";

// Minimum kleros-juror version that supports --home.
const MIN_KLEROS_JUROR_VERSION = "0.1.0";

// Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b.
function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Run all doctor checks. Returns an array of check result objects.
 * @returns {Array<{name: string, status: "PASS"|"WARN"|"FAIL"|"SKIPPED", detail?: string, cta?: string}>}
 */
export async function runChecks() {
  const results = [];
  let configLoaded = false;
  let cfg = null;

  // -------------------------------------------------------------------
  // Check 1: Config loads without throw
  // -------------------------------------------------------------------
  try {
    const mod = await import("../config.mjs");
    cfg = {
      WORKDIR: mod.WORKDIR,
      KLEROS_JUROR_HOME: mod.KLEROS_JUROR_HOME,
    };
    configLoaded = true;
    results.push({ name: "config loads", status: "PASS", detail: `WORKDIR=${cfg.WORKDIR}` });
  } catch (e) {
    results.push({
      name: "config loads",
      status: "FAIL",
      detail: e.message,
      cta: "Create a .env file with WORKDIR, COURT_ID, and KLEROS_JUROR_HOME set. Run `cp .env.example .env` then fill in your values.",
    });
  }

  // -------------------------------------------------------------------
  // Check 2: Key file exists at $KLEROS_JUROR_HOME/key
  // -------------------------------------------------------------------
  if (!configLoaded) {
    results.push({ name: "key file exists", status: "SKIPPED", detail: "prereq check 1 failed" });
  } else {
    const keyPath = join(cfg.KLEROS_JUROR_HOME, "key");
    if (existsSync(keyPath)) {
      results.push({ name: "key file exists", status: "PASS", detail: keyPath });
    } else {
      results.push({
        name: "key file exists",
        status: "FAIL",
        detail: `Not found: ${keyPath}`,
        cta: `Create the key file at ${keyPath} containing your private key (hex, with or without 0x prefix).`,
      });
    }
  }

  // -------------------------------------------------------------------
  // Check 3: Key file has mode 0o600
  // -------------------------------------------------------------------
  const keyExistsResult = results.find((r) => r.name === "key file exists");
  if (!keyExistsResult || keyExistsResult.status !== "PASS") {
    results.push({ name: "key file mode 0o600", status: "SKIPPED", detail: "prereq check 2 failed" });
  } else {
    const keyPath = join(cfg.KLEROS_JUROR_HOME, "key");
    try {
      const mode = statSync(keyPath).mode & 0o777;
      if (mode === 0o600) {
        results.push({ name: "key file mode 0o600", status: "PASS", detail: `mode=${mode.toString(8)}` });
      } else {
        results.push({
          name: "key file mode 0o600",
          status: "FAIL",
          detail: `Current mode: ${mode.toString(8)}`,
          cta: `Run: chmod 600 ${keyPath}`,
        });
      }
    } catch (e) {
      results.push({
        name: "key file mode 0o600",
        status: "FAIL",
        detail: e.message,
        cta: `Check permissions on ${join(cfg.KLEROS_JUROR_HOME, "key")}.`,
      });
    }
  }

  // -------------------------------------------------------------------
  // Check 4: `which kleros-juror` resolves
  // -------------------------------------------------------------------
  let klerosJurorPath = null;
  try {
    klerosJurorPath = execSync("which kleros-juror", { encoding: "utf8" }).trim();
    results.push({ name: "kleros-juror in PATH", status: "PASS", detail: klerosJurorPath });
  } catch {
    results.push({
      name: "kleros-juror in PATH",
      status: "FAIL",
      detail: "kleros-juror not found in PATH",
      cta: "Install kleros-juror-cli: `npm install -g kleros-juror-cli` (or via volta).",
    });
  }

  // -------------------------------------------------------------------
  // Check 5: kleros-juror --version >= MIN_KLEROS_JUROR_VERSION (WARN, not FAIL)
  // -------------------------------------------------------------------
  if (!klerosJurorPath) {
    results.push({ name: `kleros-juror >= ${MIN_KLEROS_JUROR_VERSION}`, status: "SKIPPED", detail: "prereq check 4 failed" });
  } else {
    try {
      const ver = execFileSync("kleros-juror", ["--version"], { encoding: "utf8" }).trim();
      if (compareSemver(ver, MIN_KLEROS_JUROR_VERSION) >= 0) {
        results.push({ name: `kleros-juror >= ${MIN_KLEROS_JUROR_VERSION}`, status: "PASS", detail: `version=${ver}` });
      } else {
        results.push({
          name: `kleros-juror >= ${MIN_KLEROS_JUROR_VERSION}`,
          status: "WARN",
          detail: `version=${ver}, minimum=${MIN_KLEROS_JUROR_VERSION}`,
          cta: `Upgrade kleros-juror-cli to >= ${MIN_KLEROS_JUROR_VERSION} to get --home support.`,
        });
      }
    } catch (e) {
      results.push({
        name: `kleros-juror >= ${MIN_KLEROS_JUROR_VERSION}`,
        status: "WARN",
        detail: `Could not read version: ${e.message.slice(0, 80)}`,
        cta: `Ensure kleros-juror-cli >= ${MIN_KLEROS_JUROR_VERSION} is installed.`,
      });
    }
  }

  // -------------------------------------------------------------------
  // Check 6: `which kleros` resolves
  // -------------------------------------------------------------------
  try {
    const klerosPath = execSync("which kleros", { encoding: "utf8" }).trim();
    results.push({ name: "kleros (agentkit) in PATH", status: "PASS", detail: klerosPath });
  } catch {
    results.push({
      name: "kleros (agentkit) in PATH",
      status: "FAIL",
      detail: "kleros not found in PATH",
      cta: "Install @kleros/agentkit: follow the installation docs at https://github.com/kleros/agentkit.",
    });
  }

  // -------------------------------------------------------------------
  // Check 7: Arbitrum One RPC responds (eth_blockNumber)
  // -------------------------------------------------------------------
  const RPC_URL = cfg?.RPC_URLS?.[0] ?? "https://arb1.arbitrum.io/rpc";
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 });
    const resp = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.result) throw new Error("no result in response");
    const blockNum = parseInt(json.result, 16);
    results.push({ name: "Arbitrum One RPC responds", status: "PASS", detail: `block=${blockNum} via ${RPC_URL}` });
  } catch (e) {
    results.push({
      name: "Arbitrum One RPC responds",
      status: "FAIL",
      detail: `${RPC_URL}: ${e.message}`,
      cta: "Check your network connection or set RPC_URLS in .env to a working Arbitrum One endpoint.",
    });
  }

  return results;
}

/**
 * Print results as a human-readable table to stdout.
 * @param {Array} results
 */
function printTable(results) {
  const STATUS_ICON = { PASS: "✅", WARN: "⚠️ ", FAIL: "❌", SKIPPED: "⏭️ " };
  console.log("\nkleros-monitor doctor\n");
  for (const r of results) {
    const icon = STATUS_ICON[r.status] ?? "  ";
    const line = `${icon} [${r.status.padEnd(7)}] ${r.name}`;
    console.log(line);
    if (r.detail) console.log(`          ${r.detail}`);
    if (r.cta) console.log(`          → ${r.cta}`);
  }
  console.log();
}

/**
 * Run doctor and handle output + exit code.
 * @param {string[]} argv
 */
export async function runDoctor(argv = []) {
  const jsonMode = argv.includes("--json");
  const results = await runChecks();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  } else {
    printTable(results);
  }

  const hasFail = results.some((r) => r.status === "FAIL");
  if (hasFail) process.exitCode = 1;
}
