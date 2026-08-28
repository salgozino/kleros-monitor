# Config Module Specification

## Purpose

`.env`-driven configuration replacing hardcoded values in `constants.mjs`, fail-closed on missing REQUIRED fields, exporting the same constant names existing scripts already import so the refactor is a drop-in replacement.

## Requirements

### Requirement: Dotenv Load Order

`config.mjs` MUST call `dotenv/config` (or equivalent) at the top of the module, before any exported constant is evaluated, so `.env` values are available to every consumer that imports `config.mjs`.

#### Scenario: .env values available on first import

- GIVEN a `.env` file with `WORKDIR=/home/op/kleros-monitor`
- WHEN any script does `import { WORKDIR } from "./config.mjs"`
- THEN `WORKDIR` equals the `.env` value, not `undefined`

### Requirement: Required Fields Fail Closed

`WORKDIR`, `COURT_ID`, and `KLEROS_JUROR_HOME` MUST have no code-level default. If any is missing or empty at module load, `config.mjs` MUST throw (or `process.exit(1)`) with a message naming the missing field, before exporting anything.

#### Scenario: Missing WORKDIR halts startup

- GIVEN `.env` has no `WORKDIR` entry
- WHEN any script imports `config.mjs`
- THEN the import throws (or exits non-zero) naming `WORKDIR` as missing
- AND no subcommand logic runs

#### Scenario: Empty COURT_ID halts startup

- GIVEN `.env` has `COURT_ID=` (empty string)
- WHEN `config.mjs` loads
- THEN it fails closed the same way as a missing key

### Requirement: Sane Defaults Applied When Unset

`RPC_URLS`, `IPFS_GATEWAYS`, `CORE`, `PNK`, `SORT`, `DISPUTERESOLVER`, `DRT`, and `EVIDENCE_CHAIN` MUST fall back to their documented Arbitrum One defaults when absent from `.env`, without throwing.

#### Scenario: Unset RPC_URLS uses public Arbitrum One RPCs

- GIVEN `.env` has no `RPC_URLS` entry
- WHEN `config.mjs` loads
- THEN `RPC_URLS` equals the built-in Arbitrum One public RPC list

#### Scenario: Explicit override wins over default

- GIVEN `.env` sets `EVIDENCE_CHAIN=custom-chain`
- WHEN `config.mjs` loads
- THEN `EVIDENCE_CHAIN` equals `"custom-chain"`, not the built-in default

### Requirement: Export Name Compatibility

`config.mjs` MUST export the same constant names existing scripts import from `constants.mjs` today (`CORE`, `PNK`, `SORT`, `DISPUTERESOLVER`, `DRT`, `WORKDIR`, `RPC_URLS`, `IPFS_GATEWAYS`, `EVIDENCE_CHAIN`), plus the new REQUIRED fields `COURT_ID` and `KLEROS_JUROR_HOME`, so `monitor.mjs`, `dossier-builder.mjs`, `phase-c-executor.mjs`, and `helpers/state.mjs` only need an import-path change, not a call-site rewrite.

#### Scenario: Drop-in import swap

- GIVEN a script currently does `import { CORE, WORKDIR } from "./constants.mjs"`
- WHEN the import path changes to `./config.mjs`
- THEN no other line in that script needs to change

| Field | Class | Default when unset |
|---|---|---|
| `WORKDIR` | REQUIRED | none — fail closed |
| `COURT_ID` | REQUIRED | none — fail closed |
| `KLEROS_JUROR_HOME` | REQUIRED | none — fail closed |
| `RPC_URLS` | SANE DEFAULT | Arbitrum One public RPCs |
| `IPFS_GATEWAYS` | SANE DEFAULT | Kleros CDN + ipfs.io + Pinata |
| `CORE`, `PNK`, `SORT`, `DISPUTERESOLVER`, `DRT` | SANE DEFAULT | verified Arbitrum One addresses |
| `EVIDENCE_CHAIN` | SANE DEFAULT | `arbitrum-one` |
