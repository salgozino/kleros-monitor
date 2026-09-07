// test/skill-integration.test.mjs — Integration tests for lib/skill.mjs main().
//
// These tests call main() directly (process-in-process), capturing stdout/stderr
// via Node's process stream interception rather than spawning a child process.
// A real temp WORKDIR is created via os.tmpdir + mkdtemp for each test that
// needs one, then cleaned up with fs.rmSync.
//
// Covered scenarios:
//   5.4 Happy path: main(["generate","hermes"]) writes veredict-skill.md with
//       substituted tokens; content has no {{...}} and no /root/ literals.
//   5.5 Error path: unknown harness → exit 1, stderr names harness, no file.
//   5.6 Re-run path: overwrites existing file; warn on stderr; fresh content.
//   5.7 Usage path: no action / bad action → usage in stderr, exit 1.
//       Token-parity: renderSkill output has no unresolved {{...}}.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We import main() directly for in-process testing.
import { main } from "../lib/skill.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a temporary directory, set it as WORKDIR in process.env,
 * and return its path along with a cleanup function.
 */
function makeTempWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), "kleros-skill-test-"));
  const original = process.env.WORKDIR;
  process.env.WORKDIR = dir;
  return {
    dir,
    cleanup() {
      if (original === undefined) {
        delete process.env.WORKDIR;
      } else {
        process.env.WORKDIR = original;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Capture stdout and stderr writes during the execution of fn().
 * Returns { stdout, stderr } accumulated strings.
 * Restores original write functions afterwards.
 */
function captureStreams(fn) {
  let stdout = "";
  let stderr = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    return fn().then
      ? fn().then((result) => {
          process.stdout.write = origOut;
          process.stderr.write = origErr;
          return { result, stdout, stderr };
        }).catch((err) => {
          process.stdout.write = origOut;
          process.stderr.write = origErr;
          throw err;
        })
      : (() => {
          process.stdout.write = origOut;
          process.stderr.write = origErr;
          return { result: fn(), stdout, stderr };
        })();
  } catch (err) {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    throw err;
  }
}

/**
 * Run main(argv) and capture its exit behavior.
 * process.exit is mocked to throw a special sentinel so the test can catch it.
 * Returns { exitCode, stdout, stderr }.
 */
async function runMain(argv) {
  let exitCode = null;

  // Mock process.exit to capture the code without actually exiting.
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCode = code ?? 0;
    // Throw so async code in main() stops executing after the exit call.
    throw Object.assign(new Error(`process.exit(${code})`), { isExitSentinel: true });
  };

  let stdout = "";
  let stderr = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };

  try {
    await main(argv);
    // If main() resolves without calling process.exit, treat as exit 0.
    exitCode = 0;
  } catch (err) {
    if (!err.isExitSentinel) {
      // Unexpected throw — restore and re-throw.
      process.exit = originalExit;
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      throw err;
    }
  } finally {
    process.exit = originalExit;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  return { exitCode, stdout, stderr };
}

// ── Task 5.4: Happy path ──────────────────────────────────────────────────────

describe("skill generate — happy path (hermes)", () => {
  let workdir;

  beforeEach(() => {
    workdir = makeTempWorkdir();
    // Provide a test HERMES_SESSION_ID so the template substitutes cleanly.
    process.env.HERMES_SESSION_ID = "integration-test-session";
  });

  afterEach(() => {
    workdir.cleanup();
    delete process.env.HERMES_SESSION_ID;
  });

  it("writes veredict-skill.md to WORKDIR", async () => {
    const { exitCode } = await runMain(["generate", "--harness", "hermes"]);
    expect(exitCode).toBe(0);
    const outPath = join(workdir.dir, "veredict-skill.md");
    expect(existsSync(outPath)).toBe(true);
  });

  it("prints the output path to stdout", async () => {
    const { exitCode, stdout } = await runMain(["generate", "--harness", "hermes"]);
    expect(exitCode).toBe(0);
    const outPath = join(workdir.dir, "veredict-skill.md");
    expect(stdout.trim()).toBe(outPath);
  });

  it("rendered content has no unresolved {{...}} tokens", async () => {
    await runMain(["generate", "--harness", "hermes"]);
    const outPath = join(workdir.dir, "veredict-skill.md");
    const content = readFileSync(outPath, "utf8");
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("rendered content does not contain /root/ (portable path)", async () => {
    await runMain(["generate", "--harness", "hermes"]);
    const outPath = join(workdir.dir, "veredict-skill.md");
    const content = readFileSync(outPath, "utf8");
    expect(content).not.toContain("/root/");
  });

  it("rendered content contains WORKDIR value", async () => {
    await runMain(["generate", "--harness", "hermes"]);
    const outPath = join(workdir.dir, "veredict-skill.md");
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain(workdir.dir);
  });
});

// ── Task 5.5: Error path — unknown harness ────────────────────────────────────

describe("skill generate — unknown harness", () => {
  let workdir;

  beforeEach(() => {
    workdir = makeTempWorkdir();
  });

  afterEach(() => {
    workdir.cleanup();
  });

  it("exits with code 1 for an unknown harness", async () => {
    const { exitCode } = await runMain(["generate", "--harness", "claw"]);
    expect(exitCode).toBe(1);
  });

  it("writes error to stderr naming the harness", async () => {
    const { stderr } = await runMain(["generate", "--harness", "claw"]);
    expect(stderr).toMatch(/claw/i);
  });

  it("does NOT write veredict-skill.md when harness is unknown", async () => {
    await runMain(["generate", "--harness", "claw"]);
    const outPath = join(workdir.dir, "veredict-skill.md");
    expect(existsSync(outPath)).toBe(false);
  });

  it("exits with code 1 for a completely bogus harness name", async () => {
    const { exitCode, stderr } = await runMain(["generate", "--harness", "bogus-xyz"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/bogus-xyz/i);
  });
});

// ── Task 5.6: Re-run warns and overwrites ─────────────────────────────────────

describe("skill generate — re-run overwrites existing file", () => {
  let workdir;

  beforeEach(() => {
    workdir = makeTempWorkdir();
    process.env.HERMES_SESSION_ID = "rerun-session";
  });

  afterEach(() => {
    workdir.cleanup();
    delete process.env.HERMES_SESSION_ID;
  });

  it("warns on stderr when output file already exists", async () => {
    const outPath = join(workdir.dir, "veredict-skill.md");
    // Write a sentinel file first.
    writeFileSync(outPath, "old content", "utf8");

    const { stderr } = await runMain(["generate", "--harness", "hermes"]);
    expect(stderr).toMatch(/already exists|overwriting/i);
  });

  it("overwrites the existing file with freshly rendered content", async () => {
    const outPath = join(workdir.dir, "veredict-skill.md");
    writeFileSync(outPath, "SENTINEL_OLD_CONTENT", "utf8");

    const { exitCode } = await runMain(["generate", "--harness", "hermes"]);
    expect(exitCode).toBe(0);

    const content = readFileSync(outPath, "utf8");
    expect(content).not.toContain("SENTINEL_OLD_CONTENT");
    // Should be freshly rendered — no unresolved tokens.
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
  });
});

// ── Task 5.7: Usage path (no action / bad action) ─────────────────────────────

describe("skill — usage errors", () => {
  let workdir;

  beforeEach(() => {
    workdir = makeTempWorkdir();
  });

  afterEach(() => {
    workdir.cleanup();
  });

  it("exits with code 1 when called with no arguments", async () => {
    const { exitCode } = await runMain([]);
    expect(exitCode).toBe(1);
  });

  it("writes usage to stderr when called with no arguments", async () => {
    const { stderr } = await runMain([]);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).toMatch(/usage|skill/i);
  });

  it("exits with code 1 for an unknown action", async () => {
    const { exitCode } = await runMain(["bogus-action"]);
    expect(exitCode).toBe(1);
  });

  it("writes usage to stderr for an unknown action", async () => {
    const { stderr } = await runMain(["bogus-action"]);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("exits with code 1 for --help flag (treated as no-action)", async () => {
    const { exitCode } = await runMain(["--help"]);
    expect(exitCode).toBe(1);
  });
});

// ── Token-parity: renderSkill output has no unresolved {{...}} ────────────────

describe("skill generate — token parity (integration)", () => {
  let workdir;

  beforeEach(() => {
    workdir = makeTempWorkdir();
    process.env.HERMES_SESSION_ID = "parity-integration-session";
  });

  afterEach(() => {
    workdir.cleanup();
    delete process.env.HERMES_SESSION_ID;
  });

  it("output file has no unresolved {{...}} tokens (parity with hermes template)", async () => {
    const { exitCode } = await runMain(["generate", "--harness", "hermes"]);
    expect(exitCode).toBe(0);
    const outPath = join(workdir.dir, "veredict-skill.md");
    const content = readFileSync(outPath, "utf8");
    const remaining = content.match(/\{\{[^}]+\}\}/g);
    expect(remaining, `Unresolved tokens found: ${remaining}`).toBeNull();
  });
});
