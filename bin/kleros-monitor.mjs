#!/usr/bin/env node
// bin/kleros-monitor.mjs — Single entry point for the kleros-monitor CLI.
//
// Subcommands:
//   monitor | watch        — scan for new draws (kleros-draw-monitor)
//   dispatch               — alias for `monitor --dispatch` (one agent per draw)
//   dossier | evidence-download — build evidence dossier for a dispute
//   vote-executor          — run the deterministic vote executor
//   doctor                 — run environment health checks
//   skill                  — harness skill generation utilities
//
// All flags after the subcommand are forwarded to the respective main().
//
// Usage:
//   kleros-monitor [monitor|watch] [flags]
//   kleros-monitor dispatch
//   kleros-monitor dossier <disputeID> [round] [flags]
//   kleros-monitor evidence-download <disputeID> [round] [flags]
//   kleros-monitor vote-executor [flags]
//   kleros-monitor doctor [--json]
//   kleros-monitor skill generate --dispute <id> --round <n> [--harness <name>] [--stdout]
//   kleros-monitor --help | -h

const USAGE = `
Usage: kleros-monitor <subcommand> [flags]

Subcommands:
  monitor, watch           Scan for new draws (Kleros Draw Monitor).
                           Flags: --status, --gate, --dispatch
                           (--gate and --dispatch are mutually exclusive)
  dispatch                 Alias for \`monitor --dispatch\`: scan, then spawn one
                           isolated agent per (dispute, round) with pending work.
                           Empty stdout = nothing happened this tick.
  dossier, evidence-download
                           Build evidence dossier for a dispute.
                           Args: <disputeID> [round]
  vote-executor            Run the deterministic vote executor.
                           Env: PHASE_C_BROADCAST=1 to broadcast on-chain.
  doctor                   Run environment health checks.
                           Flags: --json
  skill generate           Render the verdict-skill prompt for ONE draw and write
                           it to \$WORKDIR/veredict-skill.md (or print with --stdout).
                           Required: --dispute <id> --round <n>
                           Options: --harness <name> (default: hermes), --stdout

Options:
  --help, -h               Show this help and exit.
`.trim();

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case "monitor":
  case "watch": {
    if (rest.includes("--dispatch")) {
      // --dispatch needs the standalone guard in monitor.mjs for the lock +
      // stdout contract, so re-exec the module directly (same as `dispatch`).
      const { execFileSync } = await import("node:child_process");
      const { fileURLToPath } = await import("node:url");
      const monitorPath = fileURLToPath(new URL("../monitor.mjs", import.meta.url));
      try {
        execFileSync(process.execPath, [monitorPath, "--dispatch", ...rest.filter(a => a !== "--dispatch")], { stdio: "inherit" });
      } catch (err) {
        process.exit(typeof err.status === "number" ? err.status : 1);
      }
    } else {
      const { main } = await import("../monitor.mjs");
      await main(rest);
    }
    break;
  }

  case "dispatch": {
    // Standalone guard in monitor.mjs owns the lock + stdout contract, so
    // re-exec the module as a direct script rather than calling main().
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const monitorPath = fileURLToPath(new URL("../monitor.mjs", import.meta.url));
    try {
      execFileSync(process.execPath, [monitorPath, "--dispatch", ...rest], { stdio: "inherit" });
    } catch (err) {
      process.exit(typeof err.status === "number" ? err.status : 1);
    }
    break;
  }

  case "dossier":
  case "evidence-download": {
    const { main } = await import("../dossier-builder.mjs");
    await main(rest);
    break;
  }

  case "vote-executor": {
    const { main } = await import("../phase-c-executor.mjs");
    main(rest);
    break;
  }

  case "doctor": {
    const { runDoctor } = await import("../lib/doctor.mjs");
    await runDoctor(rest);
    break;
  }

  case "skill": {
    const { main } = await import("../lib/skill.mjs");
    await main(rest);
    break;
  }

  case "--help":
  case "-h":
  case undefined:
    process.stdout.write(USAGE + "\n");
    process.exit(0);
    break;

  default:
    process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${USAGE}\n`);
    process.exit(1);
}
