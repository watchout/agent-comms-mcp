# Message Queue Terminal State Contract

Issue #407 hardens `message_queue` terminal semantics for public release.

## Contract

- `pending` means the row is available to claim. Claim columns must be empty:
  `claimed_by IS NULL`, `claimed_at IS NULL`, and `claim_expires_at IS NULL`.
- `received` / `in_progress` are active work states. Claim ownership lives on
  those rows only.
- `replied` means an actual reply message was written. New transitions to
  `replied` must set both `replied_with` and `replied_at`.
- `skipped` means a no-reply terminal close that was not a machine failure.
  New transitions must set `failed_reason` and `done_at`.
- `failed` means a no-reply terminal close caused by machine or dispatch
  failure. New transitions must set `failed_reason` and `done_at`.

## Current Writers

- `agent-com send` / `aun reply` are the reply writers and preserve the PR #406
  durable close path.
- Auto-skip and bulk cleanup write `skipped`, not `replied`.
- `state_daemon` stale dispatch writes `failed`, not `replied`.
- Any transition back to `pending` clears claim columns atomically.

## Legacy Diagnostics

Run:

```bash
bun scripts/diagnose-message-queue-invariants.ts
```

The script reports legacy rows such as `replied` without reply evidence and
`pending` rows that still carry claim ownership. It does not normalize rows;
operators should archive or repair them with an explicit migration/runbook.
