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
kleros-monitor monitor [--status] [--gate | --dispatch]
kleros-monitor watch   [--status] [--gate | --dispatch]   # alias for monitor
kleros-monitor dispatch                                  # alias for monitor --dispatch
kleros-monitor dossier <disputeID> [round]
kleros-monitor evidence-download <disputeID> [round]  # alias for dossier
kleros-monitor vote-executor
kleros-monitor skill generate --dispute <id> --round <n> [--harness <name>] [--stdout]
kleros-monitor doctor [--json]
kleros-monitor --help
```

---

## Agent dispatch (one agent per dispute)

`monitor.mjs --dispatch` turns the monitor into a dispatcher: after the normal
draw scan it spawns **one isolated agent process per (dispute, round)** that
still has pending work, and never more than one per draw while a run is alive.
Each agent receives a prompt bound to its own draw, so two simultaneous
disputes never share a context window.

### Pending work

The predicate lives in `helpers/dossier-status.mjs` and is shared with the
`--gate` view:

- **Phase A** pending — dispute un-ruled and dossier not built
  (`manifest.json` missing or `chunkCount === 0`).
- **Phase B** pending — period is commit (1) and `decision.json`
  does not exist.
- Ruled disputes never have pending work.

### Claim registry (per draw, under `$WORKDIR/dossiers/<D>-r<R>/`)

| File | Purpose |
|------|---------|
| `agent.claim.json` | Live claim: `{ pid, startedAt, dispute, round, phaseHint, logFile }` |
| `agent-runs.jsonl` | Append-only history: `{ ts, pid, event }` with `event` in `spawned`, `spawn-failed`, `finished`, `kill-sent`, `kill-escalated`, `killed-timeout`, `orphan-released` |
| `agent-run-<startedAt>.log` | stdout/stderr of one agent run |
| `agent-usage.json` | Written by the agent CLI via `--usage-file` (token/cost audit) |

### Tick algorithm (every minute)

For each known draw:

1. Claim exists and pid alive: it counts toward `MAX_PARALLEL_AGENTS` and is
   never respawned. If the run is older than `AGENT_TIMEOUT_S`, send SIGTERM
   to the process group, mark the claim `terminating`, log `kill-sent`. If it
   is still alive `AGENT_KILL_GRACE_S` (default 60) later, send SIGKILL to the
   group, log `kill-escalated`. Otherwise skip silently.
2. Claim exists and pid dead: release, log `finished` (or `killed-timeout` for
   a terminating claim), print a completion line with the tail of the run log.
   Continue to step 3 in the same tick.
3. No claim and work pending: skip if the last spawn attempt is younger
   than `AGENT_SPAWN_COOLDOWN_S`; print "queued" if `MAX_PARALLEL_AGENTS`
   live agents already exist; otherwise write the claim (placeholder pid),
   spawn, update the claim with the real pid, log `spawned`, print a line.
   A failed spawn releases the claim, logs `spawn-failed`, retries after cooldown.

The claim is written **before** the spawn: an orphan claim (released on the
next tick) is preferable to a double spawn.

The spawn is `AGENT_BIN AGENT_ARGS... "<prompt>" --usage-file <dir>/agent-usage.json`
(defaults: `hermes -z ...`), detached, with `KLEROS_AGENT_DISPUTE`,
`KLEROS_AGENT_ROUND` and `KLEROS_AGENT_USAGE_FILE` in its environment.

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `AGENT_BIN` | `hermes` | Agent CLI binary |
| `AGENT_ARGS` | `-z` | Arguments placed before the prompt (comma/space separated) |
| `MAX_PARALLEL_AGENTS` | `2` | Live agents allowed across all draws |
| `AGENT_SPAWN_COOLDOWN_S` | `300` | Minimum seconds between spawns for the same draw |
| `AGENT_TIMEOUT_S` | `300` | Kill a still-running agent after this many seconds |

### Hermes cron setup

The cron job no longer carries an agent prompt. It is a `no_agent` job that
runs the dispatcher every minute; its stdout (only non-empty when something
happened) is what the operator sees on Telegram:

```bash
hermes cron create "every 1m" --no-agent --script "node /path/to/kleros-monitor/monitor.mjs --dispatch"
```

> Confirm the exact flags with `hermes cron create --help` on the host: the
> command shape above was not verified against a live Hermes install.

Manual one-shot run for a single draw:

```bash
hermes -z "$(node bin/kleros-monitor.mjs skill generate --dispute 5 --round 0 --stdout)"
```

---

## Skill generation

The `skill generate` command renders the harness-specific verdict-skill prompt
for ONE assigned draw and writes it to `$WORKDIR/veredict-skill.md`. This file
is **not tracked by git** because it contains operator-specific data (working
directory paths). The dispatcher renders the same prompt in memory for every
agent it spawns; the command exists for manual runs and inspection.

```bash
node bin/kleros-monitor.mjs skill generate --dispute 5 --round 0
# print instead of writing the file:
node bin/kleros-monitor.mjs skill generate --dispute 5 --round 0 --stdout
```

Override the harness for a single run with `--harness`:

```bash
node bin/kleros-monitor.mjs skill generate --dispute 5 --round 0 --harness hermes
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
    veredict-skill.md   — Hermes prompt template ({{WORKDIR}} / {{DISPUTE}} / {{ROUND}})
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

Runs all Vitest tests (config, state, harness, skill, dispatcher, integration).
No network access required.

---

## Architecture

```
bin/
  kleros-monitor.mjs        — CLI entry point; routes subcommands to main() exports
lib/
  dispatcher.mjs            — One agent per (dispute, round): claim registry + reconcile tick
  doctor.mjs                — 7-check environment validator
  harness.mjs               — Harness registry; getHarness(name) returns adapter or throws
  skill.mjs                 — skill generate subcommand implementation
harnesses/
  hermes/
    index.mjs               — Hermes adapter: renderSkill(config, { dispute, round }) → prompt string
    veredict-skill.md       — Hermes prompt template ({{WORKDIR}} / {{DISPUTE}} / {{ROUND}})
  claw/
    README.md               — Claw invocation contract (design-only; no runtime adapter)
    veredict-skill.md       — Claw prompt template [DESIGN ONLY]
monitor.mjs                 — Draw scanner + agent dispatcher (--dispatch); exports main(argv)
dossier-builder.mjs         — Evidence downloader; exports main(argv)
phase-c-executor.mjs        — Vote executor; exports main(argv)
config.mjs                  — Fail-closed config loader from .env
constants.mjs               — Protocol constants (topics, period names, block timing)
address.mjs                 — Derives juror address from key file
helpers/
  dossier-status.mjs        — Shared "agent work pending?" predicate (gate + dispatcher)
  state.mjs                 — State file + lock management
  rpc.mjs                   — JSON-RPC helpers with retry
  ipfs.mjs                  — IPFS fetch with gateway fallback
  utils.mjs                 — Shared utilities
test/
  config.test.mjs           — Config module tests
  dispatcher.test.mjs       — Dispatcher tick / claim registry tests (stubbed spawn)
  harness.test.mjs          — Harness registry + adapter + token-parity tests
  skill.test.mjs            — Skill command unit tests
  skill-integration.test.mjs — Integration tests for skill generate end-to-end
  state.test.mjs            — State derivation tests
```

---

## License

MIT — see [LICENSE](LICENSE).
