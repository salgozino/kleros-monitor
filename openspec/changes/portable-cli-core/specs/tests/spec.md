# Tests Specification

## Purpose

Minimal, high-value Vitest unit tests on the pure logic this refactor puts at risk: config classification/fail-closed behavior and state-path derivation. No network or external-CLI mocking.

## Requirements

### Requirement: Vitest as Test Runner

`vitest` MUST be added as a `devDependency`, and `vitest run` MUST be a working command that exits 0 when the suite passes.

#### Scenario: Test suite runs and passes

- GIVEN the refactor is complete
- WHEN CI or an operator runs `vitest run`
- THEN all tests pass and the process exits 0

### Requirement: Config Module Coverage

Unit tests MUST cover: each REQUIRED field (`WORKDIR`, `COURT_ID`, `KLEROS_JUROR_HOME`) throwing/exiting when missing, each SANE DEFAULT field falling back correctly when unset, and an explicit `.env` value overriding its default.

#### Scenario: Missing-required-field test

- GIVEN a test sets no `WORKDIR` env var
- WHEN the test imports `config.mjs` (or a testable factory wrapping it)
- THEN the test asserts an error is thrown

#### Scenario: Default-applied test

- GIVEN a test sets no `EVIDENCE_CHAIN` env var
- WHEN the test imports `config.mjs`
- THEN the test asserts `EVIDENCE_CHAIN === "arbitrum-one"`

### Requirement: State Path Derivation Coverage

Unit tests MUST cover `helpers/state.mjs`'s derivation of `STATE_FILE` and `LOCK_FILE` from `WORKDIR` plus the juror address, including the `KLEROS_JUROR_ADDRESS` env override path.

#### Scenario: STATE_FILE derives from WORKDIR and address

- GIVEN `WORKDIR=/tmp/x` and a known juror address
- WHEN the derivation logic runs
- THEN `STATE_FILE` equals `/tmp/x/state-<first8hexofaddress>.json`

### Requirement: No External Mocking

Tests MUST NOT mock or stub RPC calls, IPFS gateways, or `execFileSync`/external CLI invocations (`kleros-juror`, `kleros`). Only pure, synchronous logic is under test.

#### Scenario: Test suite has zero network/CLI mocks

- GIVEN the full test suite
- WHEN reviewed
- THEN no test file references `vi.mock` against `node:child_process`, RPC clients, or IPFS helpers
