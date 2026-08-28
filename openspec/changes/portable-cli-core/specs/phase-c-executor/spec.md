# Delta for Phase-C Executor

## MODIFIED Requirements

### Requirement: Deterministic Vote Execution via kleros-juror CLI

`phase-c-executor.mjs` MUST read `WORKDIR` and `KLEROS_JUROR_HOME` from `config.mjs` (not a hardcoded constant), and MUST pass `--home <KLEROS_JUROR_HOME>` on every `execFileSync("kleros-juror", ...)` invocation — `status`, `commit` (both simulate and `--broadcast` calls), and `reveal` (both simulate and `--broadcast` calls) — so the CLI's key-home always agrees with the operator's configured home, even when it differs from `kleros-juror-cli`'s own default. Vote choice MUST continue to be read from `decision.json`; vote IDs MUST continue to be sourced exclusively from monitor state (`st.seen`), never from `decision.json`, which carries no votes field. Broadcasting an on-chain action MUST remain gated behind `PHASE_C_BROADCAST=1`; without it, every `kleros-juror` call MUST run in simulate mode only.

(Previously: every `execFileSync("kleros-juror", ...)` call omitted `--home`, so the CLI silently used its own default key home — diverging from the operator's `KLEROS_JUROR_HOME` whenever it was set to a non-default path.)

#### Scenario: --home reaches every kleros-juror call

- GIVEN `KLEROS_JUROR_HOME=/opt/juror-keys` in config
- WHEN `phase-c-executor.mjs` calls `status`, `commit`, or `reveal`
- THEN the `execFileSync` args include `--home /opt/juror-keys` on every one of those calls

#### Scenario: Vote IDs still come only from monitor state

- GIVEN `decision.json` for a draw contains `{ dispute, round, choice }` only
- WHEN `phase-c-executor.mjs` builds the `--votes` argument for `commit`/`reveal`
- THEN the vote IDs come from `st.seen[key]` (on-chain-derived), never from `decision.json`

#### Scenario: Simulate-only without the broadcast env var

- GIVEN `PHASE_C_BROADCAST` is unset
- WHEN a commit or reveal is due
- THEN `kleros-juror` is called without `--broadcast`, and no on-chain transaction is sent

#### Scenario: Out-of-range choice halts before any CLI call

- GIVEN `decision.json`'s `choice` is outside `[0, answers.length]` from the dossier's `template.json`
- WHEN `phase-c-executor.mjs` evaluates the draw
- THEN it logs a HALT and makes zero `kleros-juror` calls for that draw — unchanged by this refactor
