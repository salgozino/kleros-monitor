# Tasks: Portable CLI Core

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 450–500 (additions + deletions) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 (see work units below) |
| Delivery strategy | auto-chain |
| Chain strategy | pending (orchestrator asks) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Foundation: `package.json`, `config.mjs`, `constants.mjs` strip, `address.mjs` refactor, `helpers/state.mjs` swap — the import-path seam is ready, no script runs yet | PR 1 | `vitest run test/config.test.mjs test/state.test.mjs` | `node -e "import('./config.mjs').then(c=>console.log(c.EVIDENCE_CHAIN))"` with valid `.env` | Revert `constants.mjs`, `address.mjs`, `state.mjs`; delete `config.mjs` and `package.json` changes — scripts return to original standalone mode |
| 2 | Wiring: `monitor.mjs`, `dossier-builder.mjs`, `phase-c-executor.mjs` import-path swap + `main` exports; `bin/kleros-monitor.mjs` router + `doctor`; `.env.example`, `README.md`, `LICENSE` | PR 2 (base: PR 1 branch if stacked, feature branch if chain) | `node bin/kleros-monitor.mjs --help` ; `node bin/kleros-monitor.mjs doctor` | `node bin/kleros-monitor.mjs monitor --gate` (requires valid `.env` + RPC) | Delete `bin/`; revert the 3 scripts' import lines — each script stays runnable standalone via `node script.mjs` |

---

## Phase 1: Foundation — Package Manifest and Config Seam

- [x] 1.1 **`package.json` (Create)** — Add `type:module`, `bin: { "kleros-monitor": "bin/kleros-monitor.mjs" }`, `engines: { node: ">=22" }`, `dependencies: { viem: "<pinned-version>", dotenv: "..." }`, `devDependencies: { vitest: "..." }`, `scripts: { test: "vitest run" }`. **Confirm at apply:** pin viem to the version bundled by `kleros-juror-cli` on the target machine before committing.
  - Acceptance: `node -e "import('./package.json',{assert:{type:'json'}}).then(p=>console.log(p.bin))"` prints the bin entry; `npm install` succeeds with no missing peer warnings.
  - Maps to: proposal §In-Scope (real viem dep), constants-module spec §No VIEM_PATH.

- [x] 1.2 **`config.mjs` (Create)** — `import "dotenv/config"` at top; export `loadConfig(env)` factory: throw on missing/empty `WORKDIR`, `COURT_ID`, `KLEROS_JUROR_HOME`; apply SANE DEFAULTS for `RPC_URLS`, `IPFS_GATEWAYS`, `CORE`, `PNK`, `SORT`, `DISPUTERESOLVER`, `DRT`, `EVIDENCE_CHAIN`; module-level exports call `loadConfig(process.env)`.
  - Acceptance: `loadConfig({})` throws naming `WORKDIR`; `loadConfig({ WORKDIR:"/x", COURT_ID:"34", KLEROS_JUROR_HOME:"/h" })` returns `EVIDENCE_CHAIN === "arbitrum-one"`.
  - Maps to: config-module spec §Required Fields Fail Closed, §Sane Defaults, §Export Name Compatibility.

- [x] 1.3 **`constants.mjs` (Modify)** — Remove `VIEM_PATH`, `JUROR`, `KEY_PATH`, `WORKDIR`, `COURT_ID`, all contract addresses, `RPC_URLS`, `IPFS_GATEWAYS`, `EVIDENCE_CHAIN`. Replace `require(VIEM_PATH)` with `import { keccak256, stringToHex } from "viem"`. Keep `TOPIC_DRAW`, `PERIOD_NAMES`, `INIT_LOOKBACK_BLOCKS`, `BLOCKS_PER_DAY`, ABI-related exports.
  - Acceptance: `grep -r "VIEM_PATH" constants.mjs address.mjs monitor.mjs` returns no matches; `import { TOPIC_DRAW } from "./constants.mjs"` still resolves.
  - Maps to: constants-module spec §Constants Module Contract, all four scenarios.

- [x] 1.4 **`address.mjs` (Modify)** — Replace `require(VIEM_PATH)` with `import { privateKeyToAccount } from "viem/accounts"`; replace `VIEM_PATH` import from `constants.mjs` with nothing; extract and export `deriveJuror(home = KLEROS_JUROR_HOME)` that reads the key file and returns `account.address`; keep standalone print under `import.meta.url === process.argv[1]` guard; do NOT read any config at module scope (deriveJuror receives home as argument).
  - Acceptance: `import { deriveJuror } from "./address.mjs"` resolves; called with a valid key-home dir it returns a checksummed `0x…` address; standalone `node address.mjs` still prints the address.
  - Maps to: design §JUROR source, §Derivation home; constants-module spec §No VIEM_PATH.

- [x] 1.5 **`helpers/state.mjs` (Modify)** — Change `import { WORKDIR, JUROR } from "../constants.mjs"` to `import { WORKDIR } from "../config.mjs"`; replace hardcoded `JUROR` fallback with `process.env.KLEROS_JUROR_ADDRESS ?? deriveJuror()` (import `deriveJuror` from `../address.mjs`).
  - Acceptance: with `WORKDIR=/tmp/x` and `KLEROS_JUROR_ADDRESS=0x606D2DD4Ca178349b327Ed7ACacf68058bd748Bc`, `STATE_FILE` equals `/tmp/x/state-606d2dd4.json`.
  - Maps to: tests spec §State Path Derivation Coverage; design §state path derivation.

---

## Phase 2: Script Wiring — Import Swap and `main` Exports

- [x] 2.1 **`monitor.mjs` (Modify)** — Drop both `require(VIEM_PATH)` lines (L31, L49); add `import { … } from "viem"`; change `import { … } from "./constants.mjs"` to `import { WORKDIR, COURT_ID, RPC_URLS } from "./config.mjs"`; import `deriveJuror` from `./address.mjs`; resolve juror as `process.env.KLEROS_JUROR_ADDRESS ?? deriveJuror()`; wrap current top-level logic in `export async function main(argv = process.argv.slice(2)) { … }`; guard side-effects behind `if (import.meta.url === new URL(process.argv[1], "file://").href) main()`.
  - Acceptance: `node monitor.mjs --gate` still works standalone; `import { main } from "./monitor.mjs"` resolves without executing.
  - Maps to: cli-binary spec §Flag Passthrough; design §Scripts as modules.

- [x] 2.2 **`dossier-builder.mjs` (Modify)** — Change constants import to `import { CORE, DISPUTERESOLVER, DRT, RPC_URLS, IPFS_GATEWAYS, WORKDIR, EVIDENCE_CHAIN } from "./config.mjs"`; export `async function main(argv)`; add `import.meta` guard for standalone execution.
  - Acceptance: `node dossier-builder.mjs --help` (or equivalent flag) runs standalone; `import { main } from "./dossier-builder.mjs"` resolves without side effects.
  - Maps to: cli-binary spec §Subcommand Routing; design §File Changes.

- [x] 2.3 **`phase-c-executor.mjs` (Modify)** — Change `import { CORE, JUROR, WORKDIR } from "./constants.mjs"` to `import { WORKDIR, KLEROS_JUROR_HOME } from "./config.mjs"`; derive CORE from config; build `const HOME_ARGS = ["--home", KLEROS_JUROR_HOME]`; append `...HOME_ARGS` to every `execFileSync("kleros-juror", …)` call in `klerosStatus`, `klerosCommit` (both simulate and broadcast), and `klerosReveal` (both simulate and broadcast) — 5 call sites total. Export `function main(argv)`; add `import.meta` guard. **Confirm at apply:** verify `--home` flag exists in the installed `kleros-juror --version`; note minimum version in README.
  - Acceptance: grepping `execFileSync("kleros-juror"` in the file shows `HOME_ARGS` spread on every match (5 occurrences); `node phase-c-executor.mjs` runs standalone.
  - Maps to: phase-c-executor spec §Deterministic Vote Execution, §--home reaches every call.

- [x] 2.4 **`bin/kleros-monitor.mjs` (Create)** — `#!/usr/bin/env node`; ESM imports of `main` from each script and a `runDoctor` function; `switch(process.argv[2])` routing: `monitor`|`watch` → `monitor.main`, `dossier`|`evidence-download` → `dossier.main`, `vote-executor` → `executor.main`, `doctor` → `runDoctor`; no-args / `--help` / `-h` → print usage to stdout, exit 0; unknown subcommand → print usage to stderr, exit 1; invoke with `process.argv.slice(2)` forwarded to each `main`.
  - Acceptance: `node bin/kleros-monitor.mjs --help` exits 0 and lists all subcommands; `node bin/kleros-monitor.mjs bogus` exits non-zero; `node bin/kleros-monitor.mjs watch --gate` and `node bin/kleros-monitor.mjs monitor --gate` both resolve to the same `monitor.main` code path.
  - Maps to: cli-binary spec §Single Entry Point, §Subcommand Routing, §Help Output, §Flag Passthrough.

- [x] 2.5 **`doctor` implementation (part of `bin/kleros-monitor.mjs` or `lib/doctor.mjs`)** — Sequential checks: (1) config loads without throw, (2) key file exists at `path.join(KLEROS_JUROR_HOME, "key")`, (3) key file mode is `0o600`, (4) `which kleros-juror` resolves, (5) check `kleros-juror --version` against minimum threshold → WARN if below (not FAIL), (6) `which kleros` resolves, (7) Arbitrum One RPC responds (HEAD or `eth_blockNumber`). Prereq-failed checks report SKIPPED. Each FAIL includes `cta` string. Default output: human-readable table; `--json` flag: stdout as JSON array. Exit non-zero if any check is FAIL.
  - Acceptance: with missing key file, check 2 is FAIL and check 3 is SKIPPED; `--json` output is `JSON.parse`-able; with old `kleros-juror`, check 4 is WARN (exit 0). Five checks PASS + one FAIL → exit non-zero.
  - Maps to: doctor-command spec (all requirements and scenarios).

---

## Phase 3: Config Assets

- [x] 3.1 **`.env.example` (Create)** — One entry per config field; inline comment on each line: REQUIRED (no default) vs SANE DEFAULT (shows the default value). All 10 fields from `config.mjs` covered.
  - Acceptance: `grep -c "REQUIRED" .env.example` ≥ 3; `grep -c "SANE DEFAULT\|DEFAULT" .env.example` ≥ 7.
  - Maps to: proposal §Success Criteria (.env.example covers every field).

- [x] 3.2 **`README.md` (Create)** — Quickstart (install, `.env` setup, first `doctor` run, first `monitor` run); coupling section naming `kleros-juror-cli` and `@kleros/agentkit` as required external tools and stating Arbitrum One-only constraint; viem version pin note.
  - Acceptance: README contains the words "kleros-juror-cli", "agentkit", "Arbitrum One", and a viem version pin line.
  - Maps to: proposal §In-Scope (README), §Risks (Arbitrum One-only confusion).

- [x] 3.3 **`LICENSE` (Create)** — Add a standard license file (MIT or as per project preference).
  - Acceptance: file exists and is non-empty.
  - Maps to: proposal §In-Scope (LICENSE).

---

## Phase 4: Tests

- [x] 4.1 **RED: `test/config.test.mjs` — write failing tests first** — Assert: (a) `loadConfig({})` throws with message naming `WORKDIR`; (b) `loadConfig({ WORKDIR:"", COURT_ID:"34", KLEROS_JUROR_HOME:"/h" })` throws naming `WORKDIR`; (c) `loadConfig({ WORKDIR:"/x", COURT_ID:"34", KLEROS_JUROR_HOME:"/h" })` returns `EVIDENCE_CHAIN === "arbitrum-one"`; (d) same call with `EVIDENCE_CHAIN:"custom-chain"` returns `"custom-chain"`. Tests must fail before `config.mjs` is complete.
  - Acceptance: `vitest run test/config.test.mjs` exits non-zero (RED confirmed).
  - Maps to: tests spec §Config Module Coverage; config-module spec §Required Fields, §Sane Defaults.

- [x] 4.2 **GREEN: `test/config.test.mjs` passes** — Verify that `config.mjs` (from task 1.2) makes all assertions in 4.1 pass. No mocks against `child_process`, RPC, or IPFS allowed.
  - Acceptance: `vitest run test/config.test.mjs` exits 0.
  - Maps to: tests spec §No External Mocking; tests spec §Vitest as Test Runner.

- [x] 4.3 **RED: `test/state.test.mjs` — write failing tests first** — Assert: with `WORKDIR=/tmp/x` and `KLEROS_JUROR_ADDRESS=0x606D2DD4Ca178349b327Ed7ACacf68058bd748Bc`, the derived `STATE_FILE` equals `/tmp/x/state-606d2dd4.json` and `LOCK_FILE` equals `/tmp/kleros-draw-monitor-606d2dd4.lock`. Tests must fail before `helpers/state.mjs` refactor (1.5) is complete.
  - Acceptance: `vitest run test/state.test.mjs` exits non-zero (RED confirmed).
  - Maps to: tests spec §State Path Derivation Coverage.

- [x] 4.4 **GREEN: `test/state.test.mjs` passes** — Verify task 1.5 makes all assertions pass. No fs/network mocks.
  - Acceptance: `vitest run test/state.test.mjs` exits 0; `vitest run` (full suite) exits 0.
  - Maps to: tests spec §No External Mocking, §Vitest as Test Runner.

- [x] 4.5 **Regression: standalone script check** — Run `node --check monitor.mjs dossier-builder.mjs phase-c-executor.mjs address.mjs config.mjs bin/kleros-monitor.mjs` with no errors. Verify `node bin/kleros-monitor.mjs --help` exits 0 and all four subcommands appear in usage.
  - Acceptance: all `node --check` invocations exit 0; `--help` output contains `monitor`, `dossier`, `vote-executor`, `doctor`.
  - Maps to: cli-binary spec §Help Output; proposal §Success Criteria.

- [x] 4.6 **Threat matrix: --home arg-array spot check** — Inspect `phase-c-executor.mjs` source: grep for `execFileSync("kleros-juror"` and confirm each occurrence spreads `HOME_ARGS` (no shell-string composition, no omission). Exactly 5 occurrences required.
  - Acceptance: `grep -c 'execFileSync("kleros-juror"' phase-c-executor.mjs` returns 5; each match includes `HOME_ARGS`.
  - Maps to: design §Threat Matrix (PR commands / argument composition); phase-c-executor spec §--home reaches every call.

---

## Open Apply-Time Confirmations

- [x] A.1 **viem version pin** — Before writing `package.json`, run `node -e "require('/usr/local/lib/node_modules/kleros-juror-cli/node_modules/viem/package.json').version |> console.log"` (or equivalent) to read the bundled viem version and pin it exactly in `dependencies`. Document it in README.
  - Maps to: proposal §Risks (viem version mismatch); design §Open Questions.

- [x] A.2 **`kleros-juror --version` threshold** — Before writing the `doctor` WARN gate (task 2.5), run `kleros-juror --version` on the target machine and identify the version that introduced `--home`. Hard-code that version as the minimum in `doctor`. Document it in README coupling section.
  - Maps to: doctor-command spec §kleros-juror Version Gate; design §Open Questions.
