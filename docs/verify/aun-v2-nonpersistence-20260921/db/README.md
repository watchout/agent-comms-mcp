# AUN v2 DB non-persistence candidate — scoped maker evidence

Actor: `codex-cto/e3_independent_review`, function `implementation_executor`. This is the DB slice of the adopted D1–D4 implementation, not an independent acceptance or permission to apply a shared schema.

- Handoff: [5755459642](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755459642), raw SHA256 `a8fe020709c5ffca697476455dc436f0cba0797649952e2d996fca912c0fef86`.
- Owner adoption: [5755364993](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755364993), raw SHA256 `8414bb149e2a8b9aee4fb62b87f11d6109d5bc9bf9beb67019e282e21bcc1791`.
- Baseline `174c04e7db86b5fbc89c4bce08dbe48583c5ffac`; branch `codex/aun-v2-nonpersist-db-20260921`.
- Actual start `2026-09-21T13:43:29.894646+09:00`; deadline `2026-09-21T14:58:29.894646+09:00`. Final source is bound by the six hashes below and the published result commit.

## Observed result

Final run 7: **10 PASS / 0 FAIL / 0 SKIP, 105 assertions**, exit 0, 1.639 seconds, `2026-09-21T14:07:47.786240+09:00` to `2026-09-21T14:07:49.425813+09:00`. PostgreSQL 17.9 on an owned private Unix socket and real Bun SQLite; no live DB. The private cluster was stopped, resumed once for a changed entrypoint check, then stopped again; the final postmaster PID file is absent. PG16 and shared application were not tested.

```sh
bun test tests/contract/test_runtime_observation_nonpersistence_db.test.ts --timeout 30000
```

`fixture.json`, `test-environment.json`, and `run-7.json` record exact environment, socket, role/database/version identity, argv and file hashes. Test child environments are explicit minimal maps and never inherit ambient DB/provider credentials. HOME is not replaced. The helper requires the dedicated `/private/tmp/aun-np-db-*` root and its Unix socket; it rejects other endpoints.

| Saved run | PASS / FAIL | Input change / finding |
|---|---|---|
| 1 | 0 / 9 | Fixture URL omitted a WHATWG hostname; no product migration ran. Original errors retained. |
| 2 | 7 / 2 | Explicit Unix socket retained with localhost URL syntax; SQLite positive paths did not match json_tree quoted underscore keys. |
| 3 | 9 / 0 | Exact JSON paths corrected without permissive quote normalization. |
| 4 | 5 / 5 | Added typed scalar, lossless bypass, config and direct-history checks; PostgreSQL CASE expression syntax failed. Its rollback test had accepted an arbitrary failure and was subsequently strengthened. |
| 5 | 10 / 0 | CASE expression corrected; rollback now requires the injected division-by-zero error rather than a syntax failure. |
| 6 | 10 / 0 | UUID shape parity and explicit zero-port compatibility; positive actual port remains forbidden. |
| 7 | 10 / 0 | Move direct SQLite entrypoint below guard initialization; fresh SQLite case invokes migrate-sqlite.ts directly. |

Each run has unmodified stdout/stderr and execution JSON. Earlier failures were neither erased nor treated as acceptance. Runs 4–7 also bind every changed source/test file by SHA256. Runs 1–3 retain their original tracked-diff digest and raw failures; that digest alone did not cover the then-untracked new files, so it is not a complete source reproduction record. The final run has complete six-file coverage.

## Implementation and tested preservation

- Fresh and upgraded runtime anchors allow NULL physical provider/status/start fields; readiness session/port/argv constraints are nullable. New physical column values are rejected. Old values remain unchanged on allowed logical updates.
- SQLite rebuild is one transaction with foreign keys disabled before BEGIN, exact named-column and implicit-rowid copying, indexes/triggers and AUTOINCREMENT sequence preserved, then complete FK check before commit. Failure rolls back and restores the prior FK setting. It does not delete referenced runtime rows under FK enforcement.
- The fixture starts from the exact fixed legacy migration source (only import locations are rebound to the dedicated fixture). It seeds real legacy rows, including message/task text, queue owner/expiry, lease fence, readiness/native metadata, audit/error history, outbound/activity/connector links and PG configuration history. Migration and reapply preserve snapshot hashes.
- All six runtime FK references are checked: message_queue assigned+claimed, lease holder, connector, worker_activity, outbound_queue. Normal logical queue completion, lease release/fencing and display-name updates still work. This is not an old-claim replay test of the core execution path.
- Runtime/readiness/endpoint-lease JSON have positive schemas. Hashes and UUIDs have value checks; unknown nested/renamed fields, wrong-source scalar values, raw machine errors and cleanup targets with encoded PID/port are rejected. Each backend exercises 15 negative attempts with unchanged snapshots.
- Readiness bypass keeps owner prose, bootstrap run identity, nested target and all singular/plural queue constraints, including string/number arrays. It does not silently drop a restriction.
- Non-endpoint logical lease metadata remains supported. Endpoint is exactly `lease_scope_type=runtime_instance && lease_purpose=worker`; logical holder/fence/expiry and authority heartbeat are untouched.
- SQLite creates the existing EventLog base table before guard installation, so a later normal ensure does not create an unguarded reply.failed sink. Machine audit events and reply.failed use their typed shapes.
- Existing desired-state trigger cannot refresh physical diagnostics or nested physical projections: rejected transactions change neither desired revision/digest nor outbox. A permitted stable policy update advances once. New configuration observed/restart inserts are denied while the host-scope contract is unresolved; existing physical-derived digest/history columns cannot be refreshed.
- The new down migration refuses incompatible physical-writing rollback. No old migration was edited. This does not prove an actual compatible-build rollback.

## Scope limits for the integrator and checker

General agent/workspace/connector metadata and non-endpoint lease metadata retain free logical fields and recursively reject known observation keys. This DB slice does **not** prove that every arbitrary renamed/encoded scalar in those free fields is absent. The core producer inventory and positive serializers must close that boundary; do not label the 10 database checks as full NP01/all-sink acceptance. Owner-authored task/message text is not substring-filtered.

Core ensure DDL, bootstrap, native receipt readers, serializer value provenance, DB-error propagation and impacted tests need the integrated candidate. Current migration guards correctly reject historical writer fixtures that seed physical rows after migration; historical regression fixtures should pin the old migration, not weaken guards or delete assertions. Optional versioned configuration tables installed after cutover require guard reapplication before writers; this slice keeps the configuration writer unavailable rather than inventing a new logical host ID.

NP mapping and exact remaining work are in `result.json`: NP10 has scoped PG17/SQLite evidence; NP01/02/09/11 cover only the named database assertions; NP12 is NOT_RUN. No shared runtime/DB/auth/queue, merge, PR, CI rerun or extra agent operation was performed.

## Reproduce only in a new owned synthetic fixture

Use installed PG17 and Bun, create a new private `/private/tmp/aun-np-db-*` directory and socket, then run `initdb -D <root>/pgdata -U fixture --auth-local=trust --auth-host=reject --no-locale` and `pg_ctl -D <root>/pgdata -l <root>/postgres.log -o "-k <root>/socket -c listen_addresses=''" -w start`. Supply only explicit PATH/LANG and `AUN_NP_FIXTURE_ROOT`, `AGENT_COM_TEST_DATABASE_URL=postgresql://fixture@localhost/postgres?host=<root>/socket`, `DATABASE_URL` with the same socket URL, `AGENT_COM_DB=postgres`, and `AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1` to the test child. The flag covers only this synthetic fixture. Stop that cluster with `pg_ctl -D <root>/pgdata -m smart -w stop`; do not use an ambient/default database.

## Final source and log hashes

| File | SHA256 |
|---|---|
| `db/migrate.ts` | `0659c029ae23f6d740bf899b325521728d9c3d67901e13f277511837146ee9de` |
| `db/migrate-sqlite.ts` | `797c5f2d4b2bb322ed0ac27d2d19e4da89463b615db07d6d49891cb1fab6fb04` |
| `db/migrations/2026-09-21-runtime-observation-nonpersistence.up.sql` | `9e3d347e9e7a4a1aa858bd2f6f40a963bc65d6e9e56a059247f1291e436f5c0f` |
| `db/migrations/2026-09-21-runtime-observation-nonpersistence.down.sql` | `507331e2c275b4ba85305741d03773450c637a751a02217922f7d10fc3a97139` |
| `tests/contract/test_runtime_observation_nonpersistence_db.test.ts` | `537c0fccbd01c1cb180fc18f6edb0792ea44e6b2a352539642cff37e14736805` |
| `tests/helpers/runtime-observation-nonpersistence-db-fixture.ts` | `06d28f9f5ad32ac9b8b98cdc55ad95c76cb2b667b623521068c4a83e296aac29` |
| `run-7.stdout.log` | `648636de320206596241e3124dae6624963793b4c8eeef6fdf50deecfd29cde3` |
| `run-7.stderr.log` | `45da0ac9e99c41315ed57111046e7db50afde78509ae3cb08aecf91739200df7` |
| `result.json` | `e08f1badb02e22d6492984e34ea0980feced7976d2104c657941be8671ea379d` |

next_action: existing `execution_guide_review` integrates this fixed DB commit and aligns source/test interfaces; `aun_kusabi_current` independently checks the fixed candidate. Delivery is the single #940 return plus direct actor/root message. Inputs are the exact handoff/adoption refs, source hashes and raw logs above. Scope remains the adopted bounded implementation; no live application authority is implied. Completion evidence is the integrated exact commit plus affected tests and independent findings. `blocking: false`.
