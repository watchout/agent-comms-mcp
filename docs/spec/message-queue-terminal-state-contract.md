# Message Queue Terminal-State Contract

Issue: #407

This contract defines the target state for `message_queue` terminal semantics. It is intentionally separate from any live migration. Code and operators must first collect read-only evidence, then apply any schema/data migration only after review and explicit approval.

## Status Vocabulary

Target statuses:

- `pending`: visible, unclaimed work. Claim columns must be empty.
- `received`: claimed work that has been surfaced to an agent. `claimed_by` is required.
- `in_progress`: claimed work that the agent has explicitly started. `claimed_by` is required.
- `done`: terminal no-reply completion. `done_at` and durable terminal evidence are required.
- `replied`: terminal reply completion. `replied_with` and `replied_at` are required.

Legacy statuses:

- `read`
- `skipped`
- `failed`

Legacy rows must be archived or normalized with audit evidence before the live status `CHECK` is narrowed. Do not silently rewrite them.

## Invariants

- `status='replied'` means an actual reply exists and must have `replied_with` and `replied_at`.
- No-reply terminal closure uses `done`, not `replied` without reply evidence.
- `status='pending'` must not retain `claimed_by`, `claimed_at`, or `claim_expires_at`.
- `status IN ('received', 'in_progress')` must have `claimed_by`.
- `status='done'` must have `done_at` and durable terminal evidence in the payload/audit trail.
- Live DB mutation, queue drain, mass terminalization, and schema migration are outside the implementation PR unless separately approved.

## Read-Only Preflight

Use:

```bash
agent-com queue terminal-preflight --format json
```

The preflight is read-only. It inventories:

- `message_queue` status `CHECK` constraint and allowed status literals.
- Required terminal-state columns.
- Status counts.
- `replied` rows missing reply evidence.
- `pending` rows retaining claim ownership.
- active rows missing claim owner.
- `done` rows missing `done_at`.
- legacy `read` / `skipped` / `failed` rows.

Samples include queue ids, status/claim/reply timestamps, payload byte length, and payload shape only. They do not print raw payload content.

The command exits non-zero while blockers remain. A clean preflight does not authorize live migration by itself; it is only evidence for review.

## Migration Gate

Before any live migration:

1. Capture a safe backup.
2. Run the read-only preflight and preserve JSON evidence.
3. Define a per-status disposition policy for legacy rows.
4. Prove replacement terminal reason/evidence storage exists before dropping legacy audit columns.
5. Pass L1/L2/L3 review.
6. Obtain explicit CEO/operator approval for the live DB operation.
