// lib/skill.mjs — `skill generate` subcommand implementation.
//
// Routes the `generate` action: resolves the harness, renders the skill
// prompt template, warns if the output file already exists, then writes
// $WORKDIR/veredict-skill.md and prints the path to stdout.
//
// Exit codes:
//   0 — success
//   1 — bad action (no args / unknown action), unknown harness, or render failure

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHarness } from "./harness.mjs";
import { loadConfig } from "../config.mjs";

const USAGE = `
Usage: kleros-monitor skill <action> [options]

Actions:
  generate [--harness <name>]   Render and write the verdict-skill prompt to
                                \$WORKDIR/veredict-skill.md.
                                Defaults to the HARNESS config value ("hermes").

Options:
  --harness <name>              Override the harness to use for this run.
`.trim();

/**
 * Main entry point for the `skill` subcommand.
 * @param {string[]} argv - arguments after "skill" (e.g. ["generate", "--harness", "hermes"])
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

  // --- resolve harness name ---
  // Parse --harness <name> from flags, or fall back to config.HARNESS.
  let harnessName = null;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--harness" && flags[i + 1]) {
      harnessName = flags[i + 1];
      break;
    }
  }

  // Load config to get WORKDIR and the default HARNESS value.
  // loadConfig reads from process.env (already populated by dotenv in config.mjs).
  const config = loadConfig(process.env);

  if (!harnessName) {
    harnessName = config.HARNESS;
  }

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
    rendered = adapter.renderSkill(config);
  } catch (err) {
    process.stderr.write(`skill generate: render failed — ${err.message}\n`);
    process.exit(1);
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
