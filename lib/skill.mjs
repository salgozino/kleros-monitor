// lib/skill.mjs — `skill generate` subcommand implementation.
//
// Routes the `generate` action: resolves the harness, renders the skill
// prompt template for ONE assigned draw (--dispute / --round), then either
// writes $WORKDIR/veredict-skill.md and prints the path, or prints the
// rendered prompt itself (--stdout) for manual one-shot agent runs.
//
// Exit codes:
//   0 — success
//   1 — bad action (no args / unknown action), missing --dispute/--round,
//       unknown harness, or render failure

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHarness } from "./harness.mjs";
import { loadConfig } from "../config.mjs";

const USAGE = `
Usage: kleros-monitor skill <action> [options]

Actions:
  generate --dispute <id> --round <n> [--harness <name>] [--stdout]
                                Render the verdict-skill prompt for one draw.
                                Writes \$WORKDIR/veredict-skill.md unless
                                --stdout is given.

Options:
  --dispute <id>                Dispute ID assigned to the agent (required).
  --round <n>                   Round of the dispute (required).
  --harness <name>              Override the harness (default: HARNESS config, "hermes").
  --stdout                      Print the rendered prompt instead of writing the file.
                                Example: hermes -z "$(kleros-monitor skill generate --dispute 5 --round 0 --stdout)"
`.trim();

/** Minimal flag parser: `--key value` pairs plus boolean `--stdout`. */
function parseFlags(flags) {
  const out = { stdout: false };
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === "--stdout") { out.stdout = true; continue; }
    if ((f === "--harness" || f === "--dispute" || f === "--round") && flags[i + 1] != null) {
      out[f.slice(2)] = flags[i + 1];
      i++;
    }
  }
  return out;
}

/**
 * Main entry point for the `skill` subcommand.
 * @param {string[]} argv - arguments after "skill" (e.g. ["generate", "--dispute", "5", "--round", "0"])
 */
export async function main(argv = []) {
  const [action, ...flags] = argv;

  if (!action || action === "--help" || action === "-h") {
    process.stderr.write(USAGE + "\n");
    process.exit(1);
  }

  if (action !== "generate") {
    process.stderr.write(`Unknown action: ${action}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const opts = parseFlags(flags);

  if (opts.dispute == null || opts.dispute === "" || opts.round == null || opts.round === "") {
    process.stderr.write(`skill generate: --dispute <id> and --round <n> are required.\n\n${USAGE}\n`);
    process.exit(1);
  }
  if (!/^\d+$/.test(String(opts.dispute)) || !/^\d+$/.test(String(opts.round))) {
    process.stderr.write(`skill generate: --dispute and --round must be non-negative integers.\n`);
    process.exit(1);
  }

  // Load config to get WORKDIR and the default HARNESS value.
  // loadConfig reads from process.env (already populated by dotenv in config.mjs).
  const config = loadConfig(process.env);
  const harnessName = opts.harness || config.HARNESS;

  // --- resolve adapter ---
  let adapter;
  try {
    adapter = getHarness(harnessName);
  } catch (err) {
    process.stderr.write(`skill generate: ${err.message}\n`);
    process.exit(1);
  }

  // --- render ---
  let rendered;
  try {
    rendered = adapter.renderSkill(config, { dispute: opts.dispute, round: Number(opts.round) });
  } catch (err) {
    process.stderr.write(`skill generate: render failed — ${err.message}\n`);
    process.exit(1);
  }

  if (opts.stdout) {
    process.stdout.write(rendered);
    return;
  }

  // --- write ---
  const outPath = join(config.WORKDIR, "veredict-skill.md");

  if (existsSync(outPath)) {
    process.stderr.write(
      `warn: ${outPath} already exists — overwriting.\n`
    );
  }

  writeFileSync(outPath, rendered, "utf8");
  process.stdout.write(outPath + "\n");
}
