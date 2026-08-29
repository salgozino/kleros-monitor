#!/usr/bin/env node
// bin/kleros-monitor.mjs — Single entry point for the kleros-monitor CLI.
//
// Subcommands:
//   monitor | watch        — scan for new draws (kleros-draw-monitor)
//   dossier | evidence-download — build evidence dossier for a dispute
//   vote-executor          — run the deterministic vote executor
//   doctor                 — run environment health checks
//
// All flags after the subcommand are forwarded to the respective main().
//
// Usage:
//   kleros-monitor [monitor|watch] [flags]
//   kleros-monitor dossier <disputeID> [round] [flags]
//   kleros-monitor evidence-download <disputeID> [round] [flags]
//   kleros-monitor vote-executor [flags]
//   kleros-monitor doctor [--json]
//   kleros-monitor --help | -h

const USAGE = `
Usage: kleros-monitor <subcommand> [flags]

Subcommands:
  monitor, watch           Scan for new draws (Kleros Draw Monitor).
                           Flags: --status, --gate
  dossier, evidence-download
                           Build evidence dossier for a dispute.
                           Args: <disputeID> [round]
  vote-executor            Run the deterministic vote executor.
                           Env: PHASE_C_BROADCAST=1 to broadcast on-chain.
  doctor                   Run environment health checks.
                           Flags: --json

Options:
  --help, -h               Show this help and exit.
`.trim();

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case "monitor":
  case "watch": {
    const { main } = await import("../monitor.mjs");
    await main(rest);
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
