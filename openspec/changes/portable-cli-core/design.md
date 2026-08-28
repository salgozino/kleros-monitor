# Design: Portable CLI Core

## Technical Approach

`config.mjs` becomes the single source of truth for all operator-specific values; `constants.mjs` keeps only protocol-generic derivations. Existing scripts change by **import-path swap**, not call-site rewrite — every value they read keeps its name and shape. A framework-free `bin/kleros-monitor.mjs` router imports each script's `main` and dispatches on `argv[2]`, forwarding remaining flags untouched. `doctor` runs six ordered checks with `cta` fix hints. Chain scope stays Arbitrum One (42161) only. Satisfies all six specs (cli-binary, config-module, constants-module, phase-c-executor, doctor-command, tests).

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Router | Plain `process.argv` switch importing each script's exported `main(argv)` | commander/yargs; re-exec `node script.mjs` | Spec forbids framework; in-process import keeps one dotenv load + one process; flags pass through by slicing `argv`. |
| Config seam | Scripts import from `./config.mjs`, exporting identical names | Rewrite call sites to read `process.env` | Spec requires drop-in swap; minimizes diff and regression risk. |
| JUROR source | DERIVE at runtime via `privateKeyToAccount(key).address`; remove hardcoded `JUROR` + `KEY_PATH` | Keep `JUROR` constant | Locked decision: hardcoded copy can diverge from the actual key. Single derivation path. |
| Derivation home | Extract `deriveJuror()` into `address.mjs`; state.mjs calls it as fallback after `KLEROS_JUROR_ADDRESS` env | Duplicate fs read in state.mjs | Keeps the pure env-override path testable without fs/network. |
| viem | Real `viem` dep, pinned to the version `kleros-juror-cli` bundles today | Keep `require(VIEM_PATH)` | Parasitic path verified broken (F1). |
| Scripts as modules | Guard side effects behind `import.meta.url === argv[1]` so router can import `main` without auto-running | Split each script into lib+bin files | Smaller diff; preserves standalone `node script.mjs` for rollback. |

## Data Flow

    (a) Config load / fail-closed
    import config.mjs ─→ dotenv/config ─→ read REQUIRED (WORKDIR, COURT_ID,
      KLEROS_JUROR_HOME) ── missing/empty ─→ throw naming field (no exports)
                        └─ present ─→ apply SANE DEFAULTS for unset ─→ export

    (b) --home forwarding (phase-c-executor)
    config.KLEROS_JUROR_HOME ─→ HOME_ARGS=["--home",home]
      klerosStatus/Commit/Reveal ─→ every execFileSync("kleros-juror",[...args,...HOME_ARGS])

    (c) doctor sequential checks
    config → keyfile exists → chmod 600 → kleros-juror PATH (+version gate WARN)
      → kleros PATH → RPC reachable ; prereq-failed → SKIPPED ; FAIL → cta ; exit≠0 on any FAIL

    (d) state path derivation
    WORKDIR + (KLEROS_JUROR_ADDRESS ?? deriveJuror(key)) ─→ addr.slice(2,10)
      ─→ STATE_FILE=${WORKDIR}/state-<8hex>.json ; LOCK_FILE=/tmp/...-<8hex>.lock

## File Changes

| File | Action | Description |
|---|---|---|
| `config.mjs` | Create | dotenv/config at top; fail-closed REQUIRED; SANE DEFAULTS; exports names from constants + `COURT_ID`, `KLEROS_JUROR_HOME`. |
| `bin/kleros-monitor.mjs` | Create | ESM router: `monitor`/`watch`, `dossier`/`evidence-download`, `vote-executor`, `doctor`; `--help`/no-args usage; unknown → stderr + exit≠0. |
| `constants.mjs` | Modify | Remove operator values, `VIEM_PATH`, `JUROR`, `KEY_PATH`; `TOPIC_DRAW` via `import { keccak256, stringToHex } from "viem"`. Keep PERIOD_NAMES/lookback/blocks/ABIs. |
| `address.mjs` | Modify | Real `viem` import; export `deriveJuror(home?)`; keep standalone print under `import.meta` guard. |
| `monitor.mjs` | Modify | Drop both `require(VIEM_PATH)` (lines 31,49) → `viem` import; import config values; juror from `KLEROS_JUROR_ADDRESS ?? deriveJuror()`; export `main`. |
| `dossier-builder.mjs` | Modify | Import CORE/DISPUTERESOLVER/DRT/RPC_URLS/IPFS_GATEWAYS/WORKDIR/EVIDENCE_CHAIN from config; export `main`. |
| `phase-c-executor.mjs` | Modify | WORKDIR/KLEROS_JUROR_HOME from config; add `--home` to all 5 `kleros-juror` calls; export `main`. |
| `helpers/state.mjs` | Modify | WORKDIR from config; JUROR fallback via `deriveJuror()`. |
| `package.json` | Create | `type:module`, `bin`, `engines.node>=22`, deps `viem`+`dotenv`, devDep `vitest`, `scripts.test`. |
| `.env.example` | Create | Every field, inline REQUIRED-vs-DEFAULT comments. |
| `README.md`, `LICENSE` | Create | Quickstart, coupling section (kleros-juror-cli/agentkit, Arbitrum-One-only); license. |
| `test/config.test.mjs`, `test/state.test.mjs` | Create | Pure-logic unit tests. |

Unchanged (out of scope): `helpers/rpc.mjs`, `ipfs.mjs`, `utils.mjs`, `abis/*.mjs`, `veredict-skill.md`, `stake-court34.mjs`, `scripts/`.

## Interfaces / Contracts

```js
// config.mjs
export const WORKDIR, COURT_ID, KLEROS_JUROR_HOME;       // REQUIRED, fail-closed
export const RPC_URLS, IPFS_GATEWAYS, CORE, PNK, SORT,
             DISPUTERESOLVER, DRT, EVIDENCE_CHAIN;         // SANE DEFAULT
// address.mjs
export function deriveJuror(home = KLEROS_JUROR_HOME): `0x${string}`;
// each script
export async function main(argv = process.argv.slice(3)): Promise<number|void>;
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | REQUIRED throws; DEFAULT applied; override wins | Set `process.env`, dynamic `import()` of a config factory; assert throw / value. No mocks. |
| Unit | STATE_FILE/LOCK_FILE from WORKDIR + `KLEROS_JUROR_ADDRESS` | Set env override (pure path), assert `state-<8hex>.json`. No fs/network. |

`config.mjs` must expose a testable factory (e.g. `loadConfig(env)`) so tests inject env without a live `.env`; the module-level exports call it once.

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A: no doc-path classification/execution |  —  | — |
| Git repository selection | N/A: no git automation |  —  | — |
| Commit state | N/A: no VCS writes |  —  | — |
| Push state | N/A: no push automation |  —  | — |
| PR commands (argument composition) | Applicable: `--home` composed into every `kleros-juror` call | `--home <KLEROS_JUROR_HOME>` appended to all 5 call sites; args are code-composed arrays (no shell string), so no injection surface | Verify commit/reveal simulate+broadcast and status arg arrays include `--home` + configured home (covered at apply/verify via arg-capture, not unit — no CLI mocking) |

Subprocess note: all `execFileSync` calls use array args (no `shell:true`), so operator config values are passed as discrete argv tokens — no shell metacharacter interpolation. `--home` value originates from operator config, not untrusted input.

## Migration / Rollout

No data migration. Scripts remain runnable standalone (`node monitor.mjs`) via the `import.meta` guard, so rollback is `git revert` of the config/constants commits. npm publish is a separate manual step, out of this change.

## Open Questions

- [ ] Exact `viem` version to pin — confirm against `kleros-juror-cli`'s bundled version at apply time.
- [ ] Known-good `kleros-juror --version` threshold for the `--home` gate — needs the upstream version that introduced `--home`.
- [ ] Change 2 boundary confirmed clean: no Hermes/channel/language assumptions enter config or router here; `veredict-skill.md`, `scripts/`, `stake-court34.mjs` untouched.
