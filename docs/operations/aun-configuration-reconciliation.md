# AUN configuration reconciliation

Mutable agent configuration is owned by PostgreSQL. Provider MCP entries,
LaunchAgent plists, launchd state, and runtime registrations are generated
projections or observations; they must never update the desired row.

## Authority boundary

The following inputs remain outside the database because the database cannot
bootstrap or authorize them itself:

- the database locator and credential references;
- the exact release commit/tree and durable Shirube control references;
- protected owner decisions; and
- secret references. Raw secret values are forbidden from desired documents,
  candidates, logs, and evidence digests.

Everything else in the mutable operational profile is represented by the
governed `agents` columns and their `desired_revision`/`desired_digest`.
Provider CLI readback is scoped to `canonical_home`; agents sharing one host do
not share a provider-home projection. A profile does not receive a desired
revision until `ordinary_projection` contains both `provider_repo_root` and
`provider_config_root` plus `daemon_checkout`, so legacy inventory cannot
synthesize unsafe paths or inherit another agent's provider config scope.
Supported direct SQL and profile CLI updates traverse the same trigger. A
logical change appends exactly one durable outbox row in the same transaction.
This includes `profile_enabled=false` for an already complete profile; disabling
an enrolled profile cannot erase its revision or bypass the outbox.

## Reconciliation

`state-daemon` owns a host-scoped `configuration-reconciler:<host_id>` lease:

- lease TTL: 45 seconds;
- heartbeat target: 15 seconds;
- bounded sweep: 30 seconds, maximum 100 rows;
- PostgreSQL notification: acceleration only; and
- missed-notification recovery deadline: at most 60 seconds.

The reconciler verifies its fence before rendering, immediately before apply,
and before committing observed state. Every candidate binds one desired
revision/digest, release commit/tree, sorted control refs, provider projection,
LaunchAgent projection, runtime projection, rollback envelope, and candidate
digest. A revision, digest, lease, or fencing-token change discards the
candidate before effects.

Native reads use provider CLI, `launchctl`, the active primary runtime/workspace
binding, and clean Git checkout commit/tree readback for both the provider and
daemon roots. TUI input, tmux prompt injection, UI scraping, and generated-file
back-propagation are not supported.

## Restart boundary

If convergence would require a process restart, the reconciler performs zero
restart and creates one `AWAITING_OWNER_DECISION` request with
`restart_budget=1`. A separate exact owner decision and CTO runtime-recovery
execution context are required. Rejection, expiry, or candidate drift cannot
retry a restart.

## READY

`READY` requires equality across the current desired revision/digest, immutable
candidate, normalized provider/LaunchAgent/runtime native readback, current
lease fence, and observed-state receipt. File existence, process liveness,
desired state alone, or an old bootstrap journal is insufficient.

Database outage retains the last-known-good native state and reports
`DEGRADED_DB_UNAVAILABLE`; it cannot regenerate, delete, restart, or claim
`READY`.

## Migration and rollback fixture

The schema pair is:

```text
db/migrations/2026-07-26-aun-configuration-reconciliation.up.sql
db/migrations/2026-07-26-aun-configuration-reconciliation.down.sql
```

`aun bootstrap` applies the PostgreSQL up migration twice to prove idempotency.
The down migration is a test/rollback artifact only and refuses to erase
any nonempty desired-outbox, observed, or restart evidence. Applying it to any
shared, staging, or production database requires a separate protected decision;
this implementation does not apply it.

## Bootstrap relationship

B0-B8 is the first reconciliation. B3 writes the exact desired release/control
metadata, B4/B6 create provider and daemon projections, and B8 records a fenced
native readback and closes the matching outbox row. The generated LaunchAgent
then enables the continuous reconciler for subsequent DB revisions.
