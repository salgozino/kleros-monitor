// test/skill.test.mjs — Unit tests for lib/skill.mjs (skill generate command).
//
// Tests the happy path (writes file) and error paths (unknown harness, bad action).
// Uses a temporary WORKDIR to avoid polluting the real working directory.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run lib/skill.mjs main() with the given argv, capturing stdout/stderr and
 * the process.exit code (without actually exiting the test process).
 */
async function runSkill(argv, envOverrides = {}) {
  // Capture process.exit calls.
  let exitCode = null;
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((code) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    });

  // Capture stdout and stderr.
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

  // Inject env overrides.
  const savedEnv = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  let error = null;
  try {
    const { main } = await import("../lib/skill.mjs");
    await main(argv);
  } catch (err) {
    // Swallow the fake exit error; preserve real errors.
    if (!err.message.startsWith("process.exit(")) {
      error = err;
    }
  } finally {
    // Restore env.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  if (error) throw error;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("skill generate — happy path", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kleros-skill-test-"));
    process.env.HERMES_SESSION_ID = "test-session-skill";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HERMES_SESSION_ID;
    vi.resetModules();
  });

  it("writes veredict-skill.md to WORKDIR and prints path to stdout", async () => {
    process.env.WORKDIR = tmpDir;
    process.env.COURT_ID = "34";
    process.env.KLEROS_JUROR_HOME = "/tmp/juror-home";

    const { exitCode, stdout } = await runSkill(["generate"]);

    const outPath = join(tmpDir, "veredict-skill.md");
    expect(existsSync(outPath)).toBe(true);
    expect(stdout.trim()).toBe(outPath);
    expect(exitCode).toBeNull(); // no exit called → success
  });

  it("writes rendered content with no {{...}} placeholders", async () => {
    process.env.WORKDIR = tmpDir;
    process.env.COURT_ID = "34";
    process.env.KLEROS_JUROR_HOME = "/tmp/juror-home";

    await runSkill(["generate"]);

    const content = readFileSync(join(tmpDir, "veredict-skill.md"), "utf8");
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
    expect(content).toContain(tmpDir); // WORKDIR substituted
  });
});

describe("skill generate — error paths", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kleros-skill-err-"));
    process.env.WORKDIR = tmpDir;
    process.env.COURT_ID = "34";
    process.env.KLEROS_JUROR_HOME = "/tmp/juror-home";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("exits 1 and writes to stderr when harness is unknown", async () => {
    const { exitCode, stderr } = await runSkill([
      "generate",
      "--harness",
      "bogus-unknown",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/bogus-unknown/);
    // File must NOT be created on error.
    expect(existsSync(join(tmpDir, "veredict-skill.md"))).toBe(false);
  });

  it("exits 1 and writes usage to stderr when no action provided", async () => {
    vi.resetModules();
    const { exitCode, stderr } = await runSkill([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  it("exits 1 for an unknown action", async () => {
    vi.resetModules();
    const { exitCode, stderr } = await runSkill(["unknown-action"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown action");
  });
});
