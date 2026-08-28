# CLI Binary Specification

## Purpose

Single npm-installable binary `kleros-monitor` exposing the existing `monitor.mjs`, `dossier-builder.mjs`, and `phase-c-executor.mjs` scripts as subcommands, plus `doctor`, with no CLI framework dependency, replacing direct `node <script>.mjs` invocations.

## Requirements

### Requirement: Single Entry Point Binary

The system MUST expose exactly one `bin` entry, `kleros-monitor`, mapped to `bin/kleros-monitor.mjs` in `package.json`, published as `type: "module"` (ESM). The router MUST NOT depend on a CLI framework (e.g., commander, yargs) — plain `process.argv` parsing only.

#### Scenario: Global install exposes the command

- GIVEN `npm install -g .` completes on a machine with no pre-existing `kleros-juror-cli` internals
- WHEN the operator runs `kleros-monitor --help`
- THEN the shell resolves `kleros-monitor` to `bin/kleros-monitor.mjs` and prints subcommand usage

### Requirement: Subcommand Routing

The system MUST route `argv[2]` to exactly one of: `monitor`|`watch` → `monitor.mjs` logic, `dossier`|`evidence-download` → `dossier-builder.mjs` logic, `vote-executor` → `phase-c-executor.mjs` logic, `doctor` → the doctor checks. Aliases MUST resolve to the same code path as their canonical name.

#### Scenario: Canonical and alias subcommands are equivalent

- GIVEN the operator runs `kleros-monitor watch --gate`
- WHEN the router dispatches
- THEN it invokes the same logic as `kleros-monitor monitor --gate`

#### Scenario: Unknown subcommand fails clearly

- GIVEN the operator runs `kleros-monitor bogus`
- WHEN the router cannot match `bogus` to any known subcommand
- THEN it prints usage to stderr and exits with a non-zero code

### Requirement: Help Output

The system MUST print full subcommand usage when invoked with no arguments or `--help`/`-h`.

#### Scenario: No-args invocation shows usage

- GIVEN the operator runs `kleros-monitor` with no arguments
- WHEN the router receives an empty subcommand
- THEN it prints the same usage text as `--help` and exits with code 0

### Requirement: Flag Passthrough

The system MUST forward all flags after the subcommand token unchanged to the wrapped script's existing argv-parsing logic (e.g., `--status`, `--gate`, `--broadcast`).

#### Scenario: Existing flags keep working

- GIVEN the operator runs `kleros-monitor vote-executor --broadcast`
- WHEN the router dispatches to the vote-executor logic
- THEN `--broadcast` reaches the same code path that reads it today
