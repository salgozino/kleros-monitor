# Doctor Command Specification

## Purpose

`kleros-monitor doctor` validates an operator's environment before first use, catching missing or misconfigured prerequisites with actionable fix messages instead of letting them surface later as silent on-chain-call failures.

## Requirements

### Requirement: Sequential Environment Checks

`doctor` MUST run checks in this fixed order: (1) config present/valid — REQUIRED fields resolve without throwing, (2) key file exists at the derived path (`KLEROS_JUROR_HOME`, or the upstream default `~/.kleros-juror`, + `/key`), (3) key file permissions are `600`, (4) `kleros-juror` resolves on `PATH`, (5) `kleros` (`@kleros/agentkit`) resolves on `PATH`, (6) the Arbitrum One RPC endpoint responds. A check whose prerequisite failed (e.g., the permissions check when the key file is missing) MUST be reported as SKIPPED, not run against a nonexistent input.

#### Scenario: All checks pass

- GIVEN a fully configured environment
- WHEN the operator runs `kleros-monitor doctor`
- THEN all six checks report PASS and the process exits 0

#### Scenario: Missing key file skips the permission check

- GIVEN `KLEROS_JUROR_HOME` points to a directory with no `key` file
- WHEN `doctor` runs
- THEN the key-file-exists check reports FAIL and the chmod-600 check reports SKIPPED (not FAIL)

### Requirement: Actionable CTA on Every Failure

Each failed check MUST include a `cta` field naming the exact command or action to fix it, mirroring `kleros-juror-cli`'s own error UX (a concrete command, not a vague description).

#### Scenario: Wrong permissions gets a concrete fix command

- GIVEN the key file exists with mode `644`
- WHEN `doctor` runs
- THEN the permissions check FAILs with `cta: "chmod 600 <path>"`

#### Scenario: Missing external CLI gets an install pointer

- GIVEN `kleros-juror` is not on `PATH`
- WHEN `doctor` runs
- THEN the check FAILs with a `cta` naming how to install/link `kleros-juror-cli`

### Requirement: Dual Output Format

`doctor` MUST support both a JSON report (machine-readable, for scripting) and a human-readable report (default, for terminal use); the format MUST be selectable via a flag.

#### Scenario: JSON output is parseable

- GIVEN the operator runs `kleros-monitor doctor --json`
- WHEN the command completes
- THEN stdout is valid JSON with one entry per check, each carrying `name`, `status`, and an optional `cta`

### Requirement: kleros-juror Version Gate for --home

`doctor` MUST check the installed `kleros-juror --version` and WARN (not FAIL) if it is below the known-good version that supports the `--home` flag, since `vote-executor` depends on that flag existing on every invocation.

#### Scenario: Old kleros-juror-cli triggers a warning

- GIVEN the installed `kleros-juror` reports a version below the known-good threshold
- WHEN `doctor` runs
- THEN it reports WARN (not FAIL), explains `--home` support requires an upgrade, and includes the upgrade `cta`

### Requirement: Non-Zero Exit on Any Failure

`doctor` MUST exit with a non-zero code if any check reports FAIL, and exit 0 if all checks are PASS or WARN, so it can gate scripts and CI.

#### Scenario: One failing check fails the whole run

- GIVEN five checks PASS and one FAILs
- WHEN `doctor` finishes
- THEN `process.exitCode` is non-zero
