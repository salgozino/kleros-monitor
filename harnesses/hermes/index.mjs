// harnesses/hermes/index.mjs — Hermes adapter for skill generation.
//
// Implements the harness adapter interface:
//   { name: string, renderSkill(config, ctx) -> string }
//
// renderSkill is a PURE function: reads the template and substitutes
// {{WORKDIR}}, {{DISPUTE}} and {{ROUND}} via plain String.replaceAll.
// No file writes, no subprocess calls, no side effects.
//
// Template location: harnesses/hermes/veredict-skill.md (sibling file).
// Note: HERMES_SESSION_ID is captured at runtime by the agent itself
// (echo $HERMES_SESSION_ID) — no build-time substitution needed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, "veredict-skill.md");

/** Adapter name — matches the registry key in lib/harness.mjs. */
export const name = "hermes";

/**
 * Render the Hermes verdict-skill prompt for ONE assigned draw.
 * Substitutes all template placeholders and returns the rendered Markdown string.
 * Guarantees no `{{...}}` tokens remain in the output.
 *
 * @param {{ WORKDIR: string }} config - operator configuration (WORKDIR required)
 * @param {{ dispute: string|number, round: string|number }} ctx - assigned draw (required)
 * @returns {string} rendered Markdown prompt
 */
export function renderSkill(config, ctx) {
  if (!config || !config.WORKDIR) throw new Error("renderSkill: config.WORKDIR is required");
  if (!ctx || ctx.dispute == null || ctx.dispute === "" || ctx.round == null || ctx.round === "") {
    throw new Error("renderSkill: ctx.dispute and ctx.round are required");
  }
  const template = readFileSync(TEMPLATE_PATH, "utf8");

  return template
    .replaceAll("{{WORKDIR}}", config.WORKDIR)
    .replaceAll("{{DISPUTE}}", String(ctx.dispute))
    .replaceAll("{{ROUND}}", String(ctx.round));
}
