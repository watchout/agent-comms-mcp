# AUN K0 contract, corpus, and benchmark plan

This document is the implementation record for
`CELL-MCP-AUN-K0-CONTRACT-CORPUS-BENCHMARK-001`. It encodes the
owner-ratified AUN vocabulary and measurable acceptance without changing
production runtime behavior.

Authoritative inputs:

- `SPEC-AUN-SHIRUBE-001-oss-grade-runtime-architecture.md`, SHA-256
  `ba23fe5a7e1ba8dbf10344e4753288ffbc8228533f3be778598707dfea408fc7`.
- `SPEC-AUN-SHIRUBE-001-acceptance.yaml`, SHA-256
  `aa2e91055953439022ab65fc429ef86d9d280acc6a9fde6a46394694d44a85a5`.
- [AUN-first F0-F5 graph §4](https://github.com/watchout/agent-comms-mcp/issues/794#issuecomment-4950705886).

## Truth boundaries

- PostgreSQL `event_log` is the only declared production task-history
  authority. SQLite is a unit/conformance adapter and fails closed for
  multi-worker production claims.
- `LISTEN/NOTIFY` is a wake hint. A database scan/backstop owns correctness.
- A runtime timeout is attempt evidence, never semantic completion.
- Only the current fencing-token holder may write `turn.completed`.
- `reply.handoff_accepted` proves durable placement; only a validated provider
  receipt can prove `reply.delivered`.
- External effectively-once behavior is conditional on a verified end-to-end
  idempotency capability. Same nonce with a different payload is a collision.
- Synthetic provider receipts are forbidden.

The exact event and delivery vocabularies are machine-readable in:

- `schemas/aun-k0-event-vocabulary-v1.schema.json`
- `schemas/aun-k0-delivery-vocabulary-v1.schema.json`
- `tests/fixtures/aun-k0/event-vocabulary-v1.json`
- `tests/fixtures/aun-k0/delivery-vocabulary-v1.json`

These are K0 contracts. Future K1-K4 Cells own runtime implementation.

## Database capability truth

`schemas/aun-k0-db-capabilities-v1.schema.json` and its fixtures distinguish:

| Database | Profile | Production authority | Multi-worker claim |
| --- | --- | --- | --- |
| PostgreSQL | production | yes | declared capability |
| SQLite | unit/conformance | no | unsupported, fail closed |

No schema, migration, production database access, or concurrency implementation
is introduced by this Cell.

## Owner acceptance coverage

`tests/fixtures/aun-k0/acceptance-v1.json` contains all 15 AUN acceptance IDs
exactly once:

- `AUN-PERF-001` through `AUN-PERF-006`
- `AUN-RES-001` through `AUN-RES-008`
- `AUN-EFF-001`

Every predicate maps to at least one correctness specimen. Unknown and
duplicate IDs fail the contract test. This mapping is coverage evidence only;
it is not performance or resilience PASS evidence.

## Correctness corpus

The 12 owner-required specimens live under
`tests/fixtures/aun-k0/specimens/`. Every specimen contains:

- source provenance;
- structured input;
- expected predicate;
- proof tier;
- owning future Cell; and
- `behavior_status: not_executed`.

The K0 tests verify completeness and referential integrity. They do not
fabricate the future runtime measurements.

## Benchmark profiles and evidence grading

The plan-only harness supports:

- `A0_correctness`
- `A1_reference`
- `A2_soak`

Every JSON output contains source/tree/config/policy digests, database version,
CPU, RAM, payload profile, and worker count. `generated_at`, `run_id`, and
observed hardware are excluded from `plan_digest`, so identical canonical plan
inputs produce the same digest.

Plan mode always emits:

```json
{
  "contract_valid": true,
  "behavior_proven": false,
  "acceptance": [{ "status": "not_measured", "measured": null }]
}
```

Thus a valid schema/corpus/profile can never be confused with an executed SLO.
K1-K5 Cells own measured results, independent gates, and any later activation.

## Non-goals

This Cell does not implement or activate runtime, runner, daemon, connector,
queue, database, schema, migration, provider, credential, secret, F2-F5
behavior, #862 rebase, workflow, required check, deploy, or merge behavior.
