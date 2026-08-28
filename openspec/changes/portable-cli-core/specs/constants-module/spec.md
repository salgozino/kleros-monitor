# Delta for Constants Module

## MODIFIED Requirements

### Requirement: Constants Module Contract

`constants.mjs` MUST export ONLY protocol-generic derivations that are identical for every operator: `TOPIC_DRAW` (computed via a real `viem` import, not a hardcoded path require), `PERIOD_NAMES`, `INIT_LOOKBACK_BLOCKS`, `BLOCKS_PER_DAY`, and the ABI-related exports. It MUST NOT export operator-specific values (`WORKDIR`, contract addresses, `RPC_URLS`, `IPFS_GATEWAYS`, `EVIDENCE_CHAIN`) — those move to `config.mjs`. It MUST NOT export or reference `VIEM_PATH`.

(Previously: `constants.mjs` hardcoded `WORKDIR`, `KEY_PATH`, all five contract addresses, `RPC_URLS`, `IPFS_GATEWAYS`, `EVIDENCE_CHAIN`, and `COURT_ID`, and derived `TOPIC_DRAW` via `require(VIEM_PATH)` pointing into `kleros-juror-cli`'s internal `node_modules` — broken on any machine without that exact internal path.)

#### Scenario: TOPIC_DRAW computed without the parasitic path

- GIVEN a clean install with real `viem` declared as a dependency
- WHEN `constants.mjs` is imported
- THEN `TOPIC_DRAW` is computed via `import { keccak256, stringToHex } from "viem"`, not `require(VIEM_PATH)`

#### Scenario: Protocol-generic values still importable

- GIVEN any consumer of `constants.mjs`
- WHEN it imports `PERIOD_NAMES` or `TOPIC_DRAW`
- THEN the import succeeds exactly as it does today — unchanged by this refactor

#### Scenario: Operator-specific values are no longer exported

- GIVEN the refactor is complete
- WHEN any code attempts `import { WORKDIR } from "./constants.mjs"`
- THEN that import fails (the name is not exported) — `WORKDIR` MUST come from `config.mjs` instead

#### Scenario: No VIEM_PATH anywhere

- GIVEN the refactor is complete
- WHEN the codebase is searched for `VIEM_PATH`
- THEN zero references remain in `constants.mjs`, `address.mjs`, or `monitor.mjs`
