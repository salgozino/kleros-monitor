// lib/harness.mjs — Static harness registry.
//
// Maps harness names to their adapter modules. Each adapter exports:
//   { name: string, renderSkill(config) -> string }
//
// "claw" is design-only: no harnesses/claw/index.mjs exists at runtime,
// so it is intentionally absent from this registry. Requesting it (or any
// unknown name) throws a descriptive error listing valid names.

import * as hermesAdapter from "../harnesses/hermes/index.mjs";

/** @type {Record<string, { name: string, renderSkill: (config: object) => string }>} */
const REGISTRY = {
  hermes: hermesAdapter,
};

const KNOWN_NAMES = Object.keys(REGISTRY);

/**
 * Return the adapter for the given harness name.
 * Throws with a descriptive message listing known names if the name is unknown.
 *
 * @param {string} name
 * @returns {{ name: string, renderSkill: (config: object) => string }}
 */
export function getHarness(name) {
  const adapter = REGISTRY[name];
  if (!adapter) {
    throw new Error(
      `Unknown harness: "${name}". Known harnesses: ${KNOWN_NAMES.join(", ")}.`
    );
  }
  return adapter;
}
