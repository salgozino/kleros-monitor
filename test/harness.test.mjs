// test/harness.test.mjs — Unit tests for lib/harness.mjs and harnesses/hermes/index.mjs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { getHarness } from "../lib/harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Fixture config used across render tests.
const FIXTURE_CONFIG = {
  WORKDIR: "/test/workdir",
  COURT_ID: "34",
  KLEROS_JUROR_HOME: "/test/juror-home",
};

// ── Task 4.1: getHarness("hermes") returns adapter with correct shape ────────

describe("getHarness — hermes adapter", () => {
  it('returns an object with name "hermes"', () => {
    const adapter = getHarness("hermes");
    expect(adapter.name).toBe("hermes");
  });

  it("returns an adapter with a renderSkill function", () => {
    const adapter = getHarness("hermes");
    expect(typeof adapter.renderSkill).toBe("function");
  });
});

// ── Task 4.2: getHarness with unknown / design-only names throws ─────────────

describe("getHarness — unknown harness", () => {
  it('throws for "bogus" mentioning the name and known names', () => {
    expect(() => getHarness("bogus")).toThrow(/bogus/);
    expect(() => getHarness("bogus")).toThrow(/hermes/);
  });

  it('throws for "claw" (design-only, no runtime file)', () => {
    expect(() => getHarness("claw")).toThrow(/claw/);
    expect(() => getHarness("claw")).toThrow(/hermes/);
  });

  it("throws for an empty string", () => {
    expect(() => getHarness("")).toThrow();
  });
});

// ── Task 4.3: renderSkill substitutes tokens correctly ───────────────────────

describe("renderSkill — token substitution", () => {
  it("contains the WORKDIR value from config", () => {
    const adapter = getHarness("hermes");
    const output = adapter.renderSkill(FIXTURE_CONFIG);
    expect(output).toContain(FIXTURE_CONFIG.WORKDIR);
  });

  it("does not contain the raw {{WORKDIR}} placeholder", () => {
    const adapter = getHarness("hermes");
    const output = adapter.renderSkill(FIXTURE_CONFIG);
    expect(output).not.toContain("{{WORKDIR}}");
  });

  it("does not contain any unresolved {{...}} placeholders", () => {
    const adapter = getHarness("hermes");
    const output = adapter.renderSkill(FIXTURE_CONFIG);
    expect(output).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("does not contain any hardcoded /root/ paths", () => {
    const adapter = getHarness("hermes");
    const output = adapter.renderSkill(FIXTURE_CONFIG);
    expect(output).not.toContain("/root/");
  });

  it("contains literal $HERMES_SESSION_ID for runtime capture", () => {
    const adapter = getHarness("hermes");
    const output = adapter.renderSkill(FIXTURE_CONFIG);
    expect(output).toContain("$HERMES_SESSION_ID");
  });
});

// ── Task 4.4: Token-parity scan — every {{...}} in template is substituted ──

describe("renderSkill — token parity", () => {
  it("every {{...}} in the template has a substitution in the rendered output", () => {
    const templatePath = join(ROOT, "harnesses", "hermes", "veredict-skill.md");
    const template = readFileSync(templatePath, "utf8");

    // Extract all unique placeholder tokens from the template.
    const tokens = [...template.matchAll(/\{\{([^}]+)\}\}/g)].map(
      (m) => m[0]
    );
    const uniqueTokens = [...new Set(tokens)];

    // Each token must NOT appear in the rendered output.
    const adapter = getHarness("hermes");
    const output = adapter.renderSkill(FIXTURE_CONFIG);

    for (const token of uniqueTokens) {
      expect(output, `Unresolved token: ${token}`).not.toContain(token);
    }

    // Sanity: the template must have had at least WORKDIR.
    expect(uniqueTokens).toContain("{{WORKDIR}}");
  });
});
