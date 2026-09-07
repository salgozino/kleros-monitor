# kleros-monitor

A portable CLI for Kleros jurors on Arbitrum One. Monitors for new draws,
builds evidence dossiers deterministically, and executes committed votes
without any LLM involvement in the critical voting path.

> **Arbitrum One only.** All contract addresses and chain names are hardcoded
> for Arbitrum One (chainId 42161). Do not point this tool at any other network
> without reviewing every default in `config.mjs`.

---

## Quickstart

### 1. Install dependencies

```bash
yarn install
```

### 2. Set up your `.env` file

```bash
cp .env.example .env
```

Edit `.env` and fill in the three REQUIRED fields:

| Field | Description |
|-------|-------------|
| `WORKDIR` | Absolute path to your working directory (state, dossiers, logs) |
| `COURT_ID` | Kleros Court ID to monitor (e.g. `34`) |
| `KLEROS_JUROR_HOME` | Path to directory holding your `key` file |

All other fields have sane defaults for Arbitrum One mainnet.

### 3. Run the doctor

Verify your environment before the first monitor run:

```bash
node bin/kleros-monitor.mjs doctor
```

The doctor checks:
1. Config loads without error
2. Key file exists at `$KLEROS_JUROR_HOME/key`
3. Key file has mode `0600`
4. `kleros-juror` is in PATH
5. `kleros-juror` version ≥ 0.1.0 (WARN if below, not FAIL)
6. `kleros` (agentkit) is in PATH
7. Arbitrum One RPC responds to `eth_blockNumber`

All checks pass → you are ready to monitor.

### 4. First monitor run

```bash
node bin/kleros-monitor.mjs monitor
```

Silent output means no new draws were found. Detailed alert output means you
have been drawn in at least one dispute.

---

## Subcommands

```
kleros-monitor monitor [--status] [--gate]
kleros-monitor watch   [--status] [--gate]     # alias for monitor
kleros-monitor dossier <disputeID> [round]
kleros-monitor evidence-download <disputeID> [round]  # alias for dossier
kleros-monitor vote-executor
kleros-monitor skill generate [--harness <name>]
kleros-monitor doctor [--json]
kleros-monitor --help
```

---

## Skill generation

The `skill generate` command renders the harness-specific verdict-skill prompt
and writes it to `$WORKDIR/veredict-skill.md`. Run this once per deployment to
produce a portable, operator-specific skill file — no hand-editing required.

```bash
node bin/kleros-monitor.mjs skill generate
# or via the yarn script shorthand (if configured):
yarn kleros-monitor skill generate
```

Override the harness for a single run with `--harness`:

```bash
node bin/kleros-monitor.mjs skill generate --harness hermes
```

Or set the `HARNESS` environment variable in your `.env`:

```
HARNESS=hermes   # optional; defaults to hermes
```

### Harnesses directory layout

```
harnesses/
  hermes/
    index.mjs           — Hermes adapter (implemented; registered in lib/harness.mjs)
    veredict-skill.md   — Hermes prompt template ({{WORKDIR}} / {{HARNESS_SESSION_ID}})
  claw/
    README.md           — Claw invocation contract (design-only documentation)
    veredict-skill.md   — Claw prompt template [DESIGN ONLY — no runtime adapter]
```

| Harness | Status      | `skill generate` support |
|---------|-------------|--------------------------|
| `hermes` | Implemented | ✅ Default                |
| `claw`   | Design only | ❌ Exits with error       |

> **Claw is design-only.** Running `skill generate --harness claw` (or setting
> `HARNESS=claw`) will exit with code 1 and an error message. See
> `harnesses/claw/README.md` for the intended contract and the implementation
> checklist for a future adapter.

---

## External Tool Coupling

This tool integrates with two external CLI tools that must be installed
separately. Without them, monitor and dossier commands will fail.

### `kleros-juror-cli` (required)

- Binary: `kleros-juror`
- Install: `npm install -g kleros-juror-cli` or via volta
- Minimum version: **0.1.0** — this is the first release that supports the
  `--home` flag. Earlier versions will cause `phase-c-executor` to fail.
- Used by: `phase-c-executor.mjs` for `status`, `commit`, and `reveal`
  subcommands. Every invocation passes `--home $KLEROS_JUROR_HOME`.
- **viem version pin**: `kleros-juror-cli@0.1.0` bundles **viem 2.55.19**.
  This project pins viem to the same version (`"viem": "2.55.19"` in
  `package.json`) to guarantee ABI encoding/decoding compatibility.
  Do not upgrade viem in this project independently of `kleros-juror-cli`.

### `@kleros/agentkit` (required)

- Binary: `kleros`
- Install: follow the installation guide at https://github.com/kleros/agentkit
- Used by: `dossier-builder.mjs` (`kleros evidence list`) and `monitor.mjs`
  (`kleros dispute get`) for best-effort enrichment of dispute data.
- Arbitrum One only: all `--chain` flags are hardcoded to `arbitrum-one`.

---

## Testing

```bash
yarn test
```

Runs all Vitest tests (config, state, harness, skill, integration). No network
access required.

---

## Architecture

```
bin/
  kleros-monitor.mjs        — CLI entry point; routes subcommands to main() exports
lib/
  doctor.mjs                — 7-check environment validator
  harness.mjs               — Harness registry; getHarness(name) returns adapter or throws
  skill.mjs                 — skill generate subcommand implementation
harnesses/
  hermes/
    index.mjs               — Hermes adapter: renderSkill(config) → portable prompt string
    veredict-skill.md       — Hermes prompt template ({{WORKDIR}} / {{HARNESS_SESSION_ID}})
  claw/
    README.md               — Claw invocation contract (design-only; no runtime adapter)
    veredict-skill.md       — Claw prompt template [DESIGN ONLY]
monitor.mjs                 — Draw scanner; exports main(argv)
dossier-builder.mjs         — Evidence downloader; exports main(argv)
phase-c-executor.mjs        — Vote executor; exports main(argv)
config.mjs                  — Fail-closed config loader from .env
constants.mjs               — Protocol constants (topics, period names, block timing)
address.mjs                 — Derives juror address from key file
helpers/
  state.mjs                 — State file + lock management
  rpc.mjs                   — JSON-RPC helpers with retry
  ipfs.mjs                  — IPFS fetch with gateway fallback
  utils.mjs                 — Shared utilities
test/
  config.test.mjs           — Config module tests
  harness.test.mjs          — Harness registry + adapter + token-parity tests
  skill.test.mjs            — Skill command unit tests
  skill-integration.test.mjs — Integration tests for skill generate end-to-end
  state.test.mjs            — State derivation tests
```

---

## License

MIT — see [LICENSE](LICENSE).
