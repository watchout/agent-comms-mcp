# Registry Retirement Runbook

SD-C8 corrects the active execution-seat registry without deleting identities,
queue rows, runtime history, or evidence. Authority is the exact control cell
[`CH-ARC-940-SD-C8-REGISTRY-HYGIENE-20260822-001`](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5380342151),
whose raw body SHA-256 is
`fc6e120540c34cac9ea760265d9d34cfd36ccc32ae1acac6b5d93d56bd15032b`.

The cohort is compiled into `core/registry-retirement.ts`. The operator cannot
add an agent ID at runtime. A missing row, already-retired row, busy row, or
active queue claim aborts the whole transaction.

## Dry-run and retirement

Always pass the database URL explicitly. Ambient `DATABASE_URL` is ignored.

```bash
unset DATABASE_URL
bun scripts/operator/registry-retirement.ts \
  --action retire \
  --database-url 'postgresql:///agent_comms?host=/tmp'

bun scripts/operator/registry-retirement.ts \
  --action retire \
  --database-url 'postgresql:///agent_comms?host=/tmp' \
  --execute \
  --confirm-cell CH-ARC-940-SD-C8-REGISTRY-HYGIENE-20260822-001 \
  --confirm-control-source-sha256 fc6e120540c34cac9ea760265d9d34cfd36ccc32ae1acac6b5d93d56bd15032b
```

Publish the report, active-seat count, strict memory-ready coverage, and
state-daemon liveness-alert delta. Do not edit the denylist or close retained
queue rows as part of this operation.

Measure unchanged strict `ready/N` through the same centralized active-seat
selector used by the refresher and gate:

```bash
unset DATABASE_URL
bun scripts/operator/memory-ready-coverage.ts \
  --database-url 'postgresql:///agent_comms?host=/tmp'
```

## Reinstatement

Reinstatement is allowed only from the exact preimage stored by the SD-C8
transition. It restores the prior `status`, `profile_enabled`, `disabled_at`,
and complete metadata object, then appends a reinstatement audit event.

```bash
unset DATABASE_URL
bun scripts/operator/registry-retirement.ts \
  --action reinstate \
  --database-url 'postgresql:///agent_comms?host=/tmp'

bun scripts/operator/registry-retirement.ts \
  --action reinstate \
  --database-url 'postgresql:///agent_comms?host=/tmp' \
  --execute \
  --confirm-cell CH-ARC-940-SD-C8-REGISTRY-HYGIENE-20260822-001 \
  --confirm-control-source-sha256 fc6e120540c34cac9ea760265d9d34cfd36ccc32ae1acac6b5d93d56bd15032b
```

If a record lacks the exact SD-C8 transition metadata, stop. Do not reconstruct
the preimage by hand and do not update an individual row outside the helper.

## Kodama canary delivery suspension

The 2026-08-25
[seat-disposition ruling](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5402944050)
temporarily removes only `kodama` from ordinary delivery while its N40 canary
is in flight. This is not retirement: the helper changes only the agent status
to `offline`, preserves the complete preimage, records an audit event, and
does not stop or mutate the canary process, runtime rows, evidence, or queue.

```bash
unset DATABASE_URL
bun scripts/operator/registry-retirement.ts \
  --action suspend-kodama \
  --database-url 'postgresql:///agent_comms?host=/tmp'

bun scripts/operator/registry-retirement.ts \
  --action suspend-kodama \
  --database-url 'postgresql:///agent_comms?host=/tmp' \
  --execute \
  --confirm-ruling RL-ARC-940-SEAT-DISPOSITION-20260825-001 \
  --confirm-control-source-sha256 5db1a7bf179b241eae4027a10091839aa8964f0fc7ce895ec44923b4da76d93b
```

Reinstatement is allowed only after the canary publishes an immutable receipt.
Pass that receipt URL and its raw body digest; the helper restores the exact
stored preimage and records both receipt fields in the audit event.

```bash
unset DATABASE_URL
bun scripts/operator/registry-retirement.ts \
  --action reinstate-kodama \
  --database-url 'postgresql:///agent_comms?host=/tmp' \
  --execute \
  --confirm-ruling RL-ARC-940-SEAT-DISPOSITION-20260825-001 \
  --confirm-control-source-sha256 5db1a7bf179b241eae4027a10091839aa8964f0fc7ce895ec44923b4da76d93b \
  --canary-receipt-url https://github.com/OWNER/REPO/issues/NUMBER#issuecomment-ID \
  --canary-receipt-sha256 64_LOWERCASE_HEX
```
