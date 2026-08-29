# Claw Harness — Design Contract

> **Status: DESIGN ONLY.** No runtime adapter exists for this harness.
> `harnesses/claw/index.mjs` MUST NOT be created until a Claw integration is
> formally scoped and implemented. See `harnesses/claw/veredict-skill.md` for
> the intended skill contract.

---

## What is Claw?

[Claw (myclaw.ai)](https://myclaw.ai) is an alternative AI harness for running
LLM agents. Unlike Hermes, which uses ephemeral session attachments, Claw
typically delivers prompts via its own API (tool call payloads or context
injection). The kleros-monitor harness abstraction allows a future Claw adapter
to plug in without touching the verdict pipeline source code.

---

## How this harness differs from Hermes

| Dimension            | Hermes                                    | Claw (design only)                          |
|----------------------|-------------------------------------------|---------------------------------------------|
| Prompt delivery      | Session attachment (`$HERMES_SESSION_ID`) | Tool call payload or context injection      |
| Session lifecycle    | Ephemeral (one session per draw tick)     | Potentially persistent across ticks         |
| Placeholder style    | `{{WORKDIR}}`, `{{HARNESS_SESSION_ID}}`   | `<WORKDIR>`, `<SESSION_ID>`, `<JUROR_ADDR>` |
| Adapter file         | `harnesses/hermes/index.mjs` (exists)     | `harnesses/claw/index.mjs` (NOT created)    |
| Registry status      | Registered in `lib/harness.mjs`           | NOT registered — throws on `getHarness("claw")` |
| `skill generate` support | Yes (`--harness hermes` or default)  | No — exits with code 1 and an error message |

---

## Placeholder convention

Claw templates use angle-bracket placeholders (`<PLACEHOLDER>`) to distinguish
them clearly from the Hermes convention (`{{PLACEHOLDER}}`). This prevents
accidental cross-harness token leakage and makes it obvious at a glance which
harness a template targets.

A future `harnesses/claw/index.mjs` adapter would:

1. Export `{ name: "claw", renderSkill(config) }` following the harness interface.
2. Read `harnesses/claw/veredict-skill.md`.
3. Substitute `<WORKDIR>`, `<SESSION_ID>`, `<JUROR_ADDR>` (and any other
   Claw-specific tokens) using the Claw API session context.
4. Register itself in `lib/harness.mjs` under the `"claw"` key.

---

## What would call this adapter

Once implemented, the adapter would be invoked via:

```bash
node bin/kleros-monitor.mjs skill generate --harness claw
# or: HARNESS=claw node bin/kleros-monitor.mjs skill generate
```

The rendered `veredict-skill.md` would then be delivered to the Claw runtime
via its ingestion API, rather than attached as a Hermes session document.

---

## Why design-only for now

Claw support is a "nice to have" — the operator's current production setup uses
Hermes exclusively. The design-only placeholder:

- Keeps the harness abstraction interface honest (the registry rejects `"claw"` at
  runtime, which is the correct behavior when no adapter exists).
- Documents the intended contract so a future implementer knows exactly what to build.
- Prevents the `skill generate` command from silently doing the wrong thing if
  someone accidentally sets `HARNESS=claw` in their `.env`.

---

## Implementation checklist (future)

When Claw support is scoped, a minimal implementation requires:

- [ ] `harnesses/claw/index.mjs` — export `{ name, renderSkill }` following the adapter interface
- [ ] Register `"claw"` in `lib/harness.mjs` static registry
- [ ] Update `harnesses/claw/veredict-skill.md` placeholder substitution to match the final Claw API
- [ ] Add integration tests in `test/skill-integration.test.mjs` for the `--harness claw` path
- [ ] Update `README.md` to mark Claw as implemented
