# Proposal: Portable CLI Core

Any operator can install, configure, and run kleros-monitor as an npm package — no hardcoded paths, no parasitic imports, and a `doctor` command that catches environment problems before they surface as silent failures.

## Intent

kleros-monitor works today but only for the original operator: paths, court ID, wallet location, and contract addresses are hardcoded in `constants.mjs`. The `viem` import is parasitic (hardcoded absolute path into `kleros-juror-cli`'s internal `node_modules` — **verified broken on the current dev machine**). There is no install story, no config guide, and no way to validate an environment before first use.

This change packages the deterministic core (monitor, dossier-builder, vote-executor) as a config-driven npm CLI, publishable under the operator's personal npm account.

## Scope

### In Scope

- **Real `viem` dependency** in `package.json` + `engines: { node: ">=22" }` (fixes the broken parasitic require)
- **Config module** — `.env`-driven, replacing all hardcoded constants; includes `.env.example`
- **Single CLI binary** with three subcommands mapping 1-to-1 to the existing scripts:
  - `monitor` / `watch` — wraps `monitor.mjs` (incl. `--status` / `--gate`)
  - `dossier` / `evidence-download` — wraps `dossier-builder.mjs`
  - `vote-executor` — wraps `phase-c-executor.mjs` (incl. `--broadcast` safety gate)
- **`doctor` / `init` command** — validates environment before first use (key file exists + permissions, external CLIs on PATH, required config present); error UX designed for non-technical operators
- **README** — quickstart, `.env` setup, and an explicit section on the intentional hard coupling to `kleros-juror-cli` and `@kleros/agentkit`
- **LICENSE**
- **Tests (Vitest)** — minimal, high-value unit tests on the pure logic the refactor introduces risk to: the config module (fail-closed on missing REQUIRED fields, correct REQUIRED-vs-SANE-DEFAULT classification, defaults applied) and `helpers/state.mjs` path derivation. No network / external-CLI mocking theater. Vitest chosen for native ESM, Node 22, and clean `vi.mock`; added as a devDependency.

### Out of Scope

- Harness abstraction / multi-agent-runtime support → **Change 2**
- Skill-generation CLI command / templating `veredict-skill.md` → **Change 2**
- Output channel/language as a consumed config axis → **Change 2** (a config field name may be reserved, but nothing consumes it here)
- `stake-court34.mjs` — removed: it imported operator constants this change strips from constants.mjs, and was already slated for removal in a separate change
- Multi-chain vote execution — blocked by `kleros-juror-cli` being Arbitrum One-only by design; document the constraint instead
- Programmatic/importable JS API — CLI-only by explicit user choice
- A full test suite — no test runner exists today; smoke checks (`node --check`) at most

## Capabilities

### New Capabilities

- `cli-binary`: Single entry-point CLI (`kleros-monitor`) with `monitor`, `dossier`, `vote-executor`, and `doctor` subcommands
- `config-module`: `.env`-driven configuration replacing `constants.mjs` hardcoded values, with `.env.example`
- `doctor-command`: Environment validation command — key file, permissions, external deps on PATH, required config; non-technical-user-safe error messages

### Modified Capabilities

- `constants-module`: `constants.mjs` contract changes — all operator-specific values move to config; only protocol-generic derivations (ABIs, TOPIC_DRAW, PERIOD_NAMES, numeric hints) remain
- `phase-c-executor`: Must explicitly pass `--home <dir>` on every `kleros-juror` invocation so key-home agrees between our config and the external CLI (fixes silent divergence when `KLEROS_JUROR_HOME` is non-default)

## Approach

**No bundler. ESM throughout. `package.json` `exports` field with a single `bin` entry.**

1. Add real `viem` to `package.json`; remove the `VIEM_PATH` require pattern from `constants.mjs`, `address.mjs`, `monitor.mjs`.
2. Write `config.mjs` — reads `.env` via `dotenv`, exports the same constant names as today; fail-closed on missing REQUIRED fields.
3. Write `bin/kleros-monitor.mjs` — thin router (no framework needed at this scale) dispatching to the three existing script entry points, plus `doctor`.
4. Implement `doctor` — sequential checks: config present → key file exists → `chmod 600` → `kleros-juror` on PATH → `kleros` (`agentkit`) on PATH → Arbitrum One RPC reachable. JSON + human-readable output; `cta` block naming the fix command on each failure (mirroring `kleros-juror-cli`'s own error UX).
5. Pipe `--home <dir>` into every `execFileSync("kleros-juror", ...)` call in `phase-c-executor.mjs`, sourced from config.
6. Update `helpers/state.mjs` to read `WORKDIR` from config (not a hardcoded string); all other helpers are already portable.
7. Write `.env.example`, README (quickstart + coupling section), LICENSE.
8. Add `vitest` as devDependency; write unit tests for the config module and `helpers/state.mjs` path derivation under `test/` (or `*.test.mjs`). Pure-logic only — no RPC/IPFS/external-CLI mocking.

**Config field classification:**

| Field | Class | Default |
|-------|-------|---------|
| `WORKDIR` | REQUIRED — no default | none |
| `COURT_ID` | REQUIRED — no default | none |
| `KLEROS_JUROR_HOME` | REQUIRED — no default, no shipped wallet | none |
| `RPC_URLS` | SANE DEFAULT | Arbitrum One public RPCs |
| `IPFS_GATEWAYS` | SANE DEFAULT | Kleros CDN + ipfs.io + Pinata |
| `CORE`, `PNK`, `SORT`, `DISPUTERESOLVER`, `DRT` | SANE DEFAULT | Verified Arbitrum One addresses |
| `EVIDENCE_CHAIN` | SANE DEFAULT | `arbitrum-one` |

> **Key convention design decision (Finding 2):** `kleros-juror-cli` upstream has NO env-var override for key home — its only override is `--home <flag>`. Our config uses `KLEROS_JUROR_HOME` (env var) for *our own* key-path derivation, and we then pass `--home` explicitly on every CLI invocation. This keeps our config ergonomic while respecting the upstream tool's contract.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `constants.mjs` | Modified | Operator-specific values removed; TOPIC_DRAW/PERIOD_NAMES/numerics stay; VIEM_PATH removed entirely |
| `address.mjs` | Modified | Replace `require(VIEM_PATH)` with real `viem` import |
| `monitor.mjs` | Modified | Replace `require(VIEM_PATH)`; read WORKDIR/COURT_ID/RPC_URLS from config module |
| `dossier-builder.mjs` | Modified | Read WORKDIR/IPFS_GATEWAYS/EVIDENCE_CHAIN/contract addrs from config module |
| `phase-c-executor.mjs` | Modified | Read WORKDIR/KLEROS_JUROR_HOME from config; add `--home` to every `kleros-juror` invocation |
| `helpers/state.mjs` | Modified | WORKDIR sourced from config, not hardcoded string |
| `helpers/rpc.mjs`, `helpers/ipfs.mjs`, `helpers/utils.mjs`, `abis/*.mjs` | No change | Already protocol-generic and portable |
| `package.json` | New / replaced | Real `viem` dep, `engines`, `bin`, `type: module` |
| `config.mjs` | New | `.env`-driven config module, fail-closed on REQUIRED fields |
| `bin/kleros-monitor.mjs` | New | CLI entry point with subcommand router |
| `.env.example` | New | Template for all config fields with inline comments |
| `README.md` | New | Quickstart, `.env` setup, coupling documentation |
| `LICENSE` | New | License file |
| `veredict-skill.md` | No change | Hermes-specific; Change 2 scope |
| `stake-court34.mjs` | Removed | Depended on constants.mjs exports removed here; already slated for removal separately |
| `scripts/` | No change | Hermes-specific tooling; Change 2 scope |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `viem` version mismatch between our `package.json` and what `kleros-juror-cli` bundles internally (different public API or tree-shaking artifacts) | Med | Pin the exact `viem` version confirmed working today; document in README |
| `--home` flag not present in installed version of `kleros-juror-cli` (operator has an older build) | Med | `doctor` checks `kleros-juror --version` and warns if version is below the known-good threshold |
| dotenv loading order — `.env` must be loaded before any config import; ESM top-level await semantics may surprise operators who try to use `config.mjs` directly | Low | `config.mjs` calls `dotenv/config` at module load; document the import order requirement |
| No automated test coverage for config parsing or `doctor` paths | Low | RESOLVED — Vitest added as devDependency; minimal unit tests cover config-module fail-closed/classification and state-path derivation (pure logic, no network mocking). `doctor`/phase integration left for later (mocking-heavy, low value-per-cost). |
| `kleros-juror-cli` is Arbitrum One-only — operators expecting multi-chain vote execution will be confused | Low | README coupling section + `doctor` output explicitly state the constraint |

## Rollback Plan

1. The existing scripts (`monitor.mjs`, `dossier-builder.mjs`, `phase-c-executor.mjs`) continue to exist as standalone files — they are not deleted, only refactored to import from `config.mjs` instead of `constants.mjs`.
2. Rolling back means reverting `constants.mjs` to hardcoded values and removing the `config.mjs` import statements — a single `git revert` of the constants/config commits restores original behaviour for the original operator.
3. The npm publish is a separate manual step; no publish happens during this change's implementation.

## Dependencies

- `viem` — real npm dependency (version to confirm against current `kleros-juror-cli` internal version)
- `dotenv` — `.env` file loading (standard; minimal footprint)
- `vitest` — devDependency, test runner (native ESM, Node 22, clean mocking for config/doctor unit tests)
- External runtime: `kleros-juror` CLI on PATH (commit/reveal signing, Arbitrum One only)
- External runtime: `kleros` (`@kleros/agentkit`) on PATH (evidence listing/enrichment)

## Success Criteria

- [ ] `npm install -g .` on a clean machine (no `kleros-juror-cli` in `/usr/local/lib`) succeeds and `kleros-monitor --help` shows all subcommands
- [ ] `kleros-monitor doctor` catches a missing key file, a wrong-permission key file, and a missing external CLI — each with a clear `cta` message
- [ ] `kleros-monitor monitor --gate` produces the same stdout hash as the original `monitor.mjs --gate` against the same block range (regression check)
- [ ] A non-default `KLEROS_JUROR_HOME` in `.env` is correctly passed as `--home` to every `kleros-juror` invocation (verified via `--dry-run` or log inspection)
- [ ] `.env.example` covers every config field with an inline comment explaining REQUIRED vs SANE DEFAULT
- [ ] README coupling section is clear enough that a new operator understands the `kleros-juror-cli` and `agentkit` dependency without reading their source code
- [ ] `vitest run` passes: config module throws on missing REQUIRED fields, applies SANE DEFAULTs, and derives state paths correctly from WORKDIR + JUROR
