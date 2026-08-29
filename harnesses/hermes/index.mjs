// harnesses/hermes/index.mjs — Hermes adapter for skill generation.
//
// Implements the harness adapter interface:
//   { name: string, renderSkill(config) -> string }
//
// renderSkill is a PURE function: reads the template and substitutes
// {{WORKDIR}} and {{HARNESS_SESSION_ID}} via plain String.replaceAll.
// No file writes, no subprocess calls, no side effects.
//
// Template location: harnesses/hermes/veredict-skill.md (sibling file).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, "veredict-skill.md");

/** Adapter name — matches the registry key in lib/harness.mjs. */
export const name = "hermes";

/**
 * Render the Hermes verdict-skill prompt for the given configuration.
 * Substitutes all template placeholders and returns the rendered Markdown string.
 * Guarantees no `{{...}}` tokens remain in the output.
 *
 * @param {{ WORKDIR: string }} config - operator configuration (WORKDIR required)
 * @returns {string} rendered Markdown prompt
 */
export function renderSkill(config) {
  const template = readFileSync(TEMPLATE_PATH, "utf8");

  return template
    .replaceAll("{{WORKDIR}}", config.WORKDIR)
    .replaceAll(
      "{{HARNESS_SESSION_ID}}",
      process.env.HERMES_SESSION_ID ?? ""
    );
}
