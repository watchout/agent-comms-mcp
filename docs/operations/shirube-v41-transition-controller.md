# Shirube V4.1 transition controller

Status: implemented but not activated. This change adds an inert controller and
AUN admission boundary. It does not import the modules from a live queue path,
register a controller adapter or destination, apply a database migration, deploy,
merge, or deliver an external effect.

## Contract pins

- C4 exact head: `de0cdf18907dfce5b01bdc76b68dad03a5865888`
- C4 exact tree: `ec79706df937026fe83a9de033ee51476ee0fee9`
- receipt schema SHA-256: `0f167547e1b5851478f774e962dd4bed812888710d64a1f33801c127aee0e446`
- checker SHA-256: `1decd8f8687160f3f03677def5bacf44fa2620aaa14d6f9bb9f3020c2cb1762a`
- composed 33-case fixture SHA-256: `70d28a8aa7c2faee51917f0f7c7f798c9a590c0f593ac9df16964c5a55158441`

The receipt wire is an exact-key `shirube-transition-admission-receipt/v2`
payload. Canonical strings must be Unicode scalar values in NFC. Hashing uses
canonical JSON and SHA-256. A receipt binds the goal run, plan, generation,
graph/node, parent graph/node, subject tuple, verified result, from/to state,
ready set, selected node, destination, handoff, controller identity, store
revision, idempotency key, and issue/expiry clock.

## Controller transaction

The controller recomputes the completed set, dependency-closed ready set, WIP
contract, typed waits, frontmost node, destination reachability, and classifier
from the locked graph state. The state digest binds the complete graph and
execution context, so a caller cannot substitute its own readiness booleans or
remove a critical node while retaining the current state digest. Same-actor,
same-active-function work remains local and cannot create a queue row. A graph
actor transfer, independent gate, graph amendment, protected gate, or owner
decision can produce at most one receipt with hop count one. A protected human
decision is distinct from an agent/function gate.

One database transaction then performs this order:

1. lock the exact plan/generation/node state;
2. bind a verified result to its configured actor and active function;
3. reserve the authoritative receipt revision by incrementing the locked
   adapter row (a PostgreSQL sequence is intentionally not used because sequence
   increments do not roll back) and persist the immutable receipt;
4. compare-and-swap the state digest;
5. consume the result digest once; and
6. insert the controller outbox row once.

Any exception rolls the whole transaction back. A committed replay returns the
previous receipt and creates no new state, outbox, or external effect.

## AUN admission transaction

AUN authenticates the exact controller adapter, then checks local consumption
before consulting authoritative state. A valid local record is replayed even if
the remote receipt is later acknowledged, advanced, expired, or unavailable.
Its full provenance and digest must still match.

With no local record, AUN verifies the authoritative revision, canonical bytes,
payload digest, current committed state, lifecycle, clock, exact plan/subject/
result/handoff binding, registered destination, and idempotency key. Queue row,
V4.1 queue projection, and local consumption are written in one transaction.
Admission performs no provider or outbound delivery effect.

The runtime reports model, input/output/cached token counts, and attempt/decision
timestamps on controller receipts. A caller that cannot observe a value must use
the explicit `NOT_AVAILABLE` sentinel; absence is not silently converted to zero.

## Migration and rollback

The migration is additive and contains no adapter/destination registration,
trigger, runtime import, or activation. Apply it only in a separately authorized
deployment. The down migration refuses to run if any receipt, result consumption,
outbox, queue projection, or local consumption evidence exists. Operators must
archive and reconcile those records under a separate protected procedure before
rollback can remove the inert tables.

Run the focused checks before any activation proposal:

```sh
bun test tests/shirube-v41-transition-controller.test.ts
bun test tests/migrations/shirube-v41-transition-admission.test.ts
bun build core/shirube-v41-transition-controller.ts --target bun --no-bundle --outfile /tmp/shirube-v41-controller.js
bun build core/shirube-v41-transition-persistence.ts --target bun --no-bundle --outfile /tmp/shirube-v41-persistence.js
```
