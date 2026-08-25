# Runtime checkout provenance implementation handoff

IMPL-ID: `IMPL-MCP-RUNTIME-CHECKOUT-PROVENANCE-001`

SPEC-ID: `SPEC-MCP-RUNTIME-CHECKOUT-PROVENANCE-001`

CELL-ID: `CELL-MCP-RUNTIME-CHECKOUT-PROVENANCE-001`

Risk Tier: `R2`

Control source: [watchout/ai-dev-framework Issue #576](https://github.com/watchout/ai-dev-framework/issues/576)

## Implemented behavior

- Runtime checkout evidence is frozen and collected once from the explicit
  checkout override or `SERVER_ROOT`.
- The selected checkout's Git HEAD is authoritative. A validated 40-character
  env SHA is fallback-only when Git metadata is unavailable and cannot make a
  different clean checkout report the approved SHA.
- `SERVER_ROOT` uses `fileURLToPath(import.meta.url)` so percent-encoded and
  platform-specific file URL paths are decoded safely.
- Server heartbeat row path/commit and metadata path/commit/dirty fields use the
  same evidence object.
- Drift evaluation rejects contradictory row/metadata path or commit evidence
  with `runtime_checkout_evidence_mismatch` independently of ordinary drift
  policy.
- Runtime inventory, connector inventory, and AUN fleet readiness expose the
  mismatch as a blocker; fleet drift exclusions cannot hide it.
- Existing aligned clean, dirty, allowed-dirty, and legacy single-projection
  behavior remains covered.

## Changed files

- Runtime implementation: `server.ts`, `core/git-checkout-evidence.ts`,
  `core/fleet-checkout-drift.ts`, `core/runtime-inventory.ts`, and
  `core/aun-fleet-readiness.ts`.
- Regression coverage: `tests/git-checkout-evidence.test.ts`,
  `tests/fleet-checkout-drift.test.ts`, `tests/runtime-inventory.test.ts`,
  `tests/aun-fleet-readiness.test.ts`, and
  `tests/spec-enforcement/cli-commands.test.ts`.
- Contract and operator guidance: this Spec/Cell/Impl/checklist set and
  `docs/operations/aun-recovery-final-approval-packet.md`.

## Validation

- `env -u DATABASE_URL -u AGENT_COM_DB bun test ...` on the five focused test
  files: 127 pass, 0 fail.
- `env -u DATABASE_URL -u AGENT_COM_DB bun build server.ts --target=bun ...`:
  868 modules bundled successfully.
- Aliases-disabled safe parse of every `.shirube/**/*.yaml`: pass.
- `git diff --check`: pass.

A broad-suite attempt is excluded from validation evidence and recorded only as
the incident below.

## Validation incident — unauthorized inherited live DB connection

At approximately `2026-08-13T21:24Z` through `2026-08-13T21:27Z`, the broad
test command inherited a `DATABASE_URL` and connected without approval to a
remote database whose `database_name` was `agent_comms`. The run was stopped;
however, source inspection proves that mutation had already occurred:

- The migration round-trip test deleted rows matching
  `__norm021_roundtrip_%` and `__ui_identity_roundtrip_%`, then inserted the
  two test rows `__norm021_roundtrip_up__` and
  `__ui_identity_roundtrip_up__`. Each test failed at its destructive down gate
  before its test-local cleanup, so those two inserted rows are known to remain.
- File-level cleanup added `agents.current_message_id` and the message-queue
  claim columns with `ADD COLUMN IF NOT EXISTS`.
- The run recreated `idx_mq_expired_claims`, `notify_queue_event()`,
  `message_queue_notify`, `set_agent_identity_defaults()`, and
  `trg_agents_identity_defaults`, and reran the UI identity up migration,
  including `agent_ui_id_seq` creation/setval behavior and its UI indexes.
- The repository production guard blocked the destructive down migrations. It
  did not undo the preceding DML, idempotent additions, or catalog-object
  recreation.
- Other PostgreSQL integration tests also ran under the same inherited
  environment before the broad command was stopped. Consequently, the incident
  impact cannot be bounded to the named migration test or the objects listed
  above.

A read-only incident check found no general migration ledger capable of
reconstructing the preimage, so exact before/after state is unavailable. No
repair, rollback, compensating DML/DDL, restart, or deployment was executed.
No result from this broad run or the incident readback is implementation
validation evidence.

## Known risks and non-evidence

- No running runtime was restarted, so live heartbeat readback remains a later
  protected verification step.
- No live database state is completion evidence for this implementation.
- This file is an implementation handoff, not an audit verdict.

## Next required review

An independent auditor must review the exact head against the accompanying
checklist. Runtime restart, deployment, merge, and live verification remain
separately gated.
