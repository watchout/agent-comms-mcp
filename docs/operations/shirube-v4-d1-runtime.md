# Shirube V4 D1 Runtime Activation

The D1 runtime is fail-closed and disabled by default. Admission binds one
exact repository, agent, control source, queue row, authorization digest, and
activation-evidence set before live queue claim. D1 claim/invocation receipts
are then created only after the queue runner reaches durable `DONE` and before
mediated finalization performs the selected effect.

## Required gates

Do not enable D1 until the deployed commit has all of the following evidence:

1. independent exact-head audit PASS;
2. QA PASS, technical-check PASS, and CTO GO for the same commit;
3. successful database migration;
4. GitHub mediated-posting probe PASS;
5. an owner-approved exact canary tuple.

## Migration

Run the normal migration command before enabling the runtime:

```sh
bun run migrate
```

The migration adds `shirube_d1_claims`, `shirube_d1_invocations`, and
`shirube_d1_effect_deliveries`. Each actual effect receipt is durably keyed by
one deterministic invocation key.

## Default-off policy

Both activation controls must be set explicitly. Omitting either one keeps D1
inactive.

```sh
export SHIRUBE_D1_ENABLED=1
export SHIRUBE_D1_KILL_SWITCH=0
export SHIRUBE_D1_TARGET_ALLOWLIST='[{"repository":"watchout/agent-comms-mcp","agent_id":"dev-001","control_source":"https://github.com/watchout/agent-comms-mcp/issues/887"}]'
export SHIRUBE_D1_AUTHORIZATION_DIGEST=<audited-64-hex-digest>
export SHIRUBE_D1_ADAPTER_HEAD_SHA=<deployed-40-hex-sha>
export SHIRUBE_D1_AUDIT_REF=<exact-head-audit-comment-url>
export SHIRUBE_D1_QA_REF=<qa-comment-url>
export SHIRUBE_D1_CHECK_REF=<technical-check-comment-url>
export SHIRUBE_D1_CTO_GO_REF=<cto-go-comment-url>
```

Every enrolled queue payload must contain a `shirube_v4_d1` object with schema
`shirube-v4/d1-runtime-binding/v1`, the exact allowlisted target, an audited
authorization envelope, exact activation evidence matching the environment,
and a closed-world `allowed_effects` list. The
authorization digest is SHA-256 of the canonical JSON object whose keys are
`allowed_paths`, `control_source`, `exact_base_sha`, and `handoff_id`; paths are
deduplicated and sorted before hashing.

Missing authorization, a digest mismatch, a target mismatch, an unlisted
effect, or an active kill switch fails before the corresponding mutation or
effect.

`internal_reply` uses the canonical queue reply path with a deterministic
message ID derived from the D1 invocation key. `github_writeback` uses the
mediated GitHub sender and exact body/key readback. `external_send` accepts
only a validated K3 `DeliveryUnitV1` plus its loaded connector registration;
it appends `reply.enqueued` and leaves the provider effect to the existing K3
dispatcher.

An effect lease is never reassigned after expiry: the original performer may
still be alive outside the database transaction. Recovery performs only a
read-only invocation-key readback. A matching durable receipt completes the
reservation; no receipt returns `D1_EFFECT_OUTCOME_UNKNOWN` and performs no
second effect. Final queue close then rechecks the completed invocation and
effect receipt in the close CAS and does not call a sender while holding the
queue-row lock.

## Protected GitHub canary

Use one newly created queue row and fence the execution with its exact queue
ID, message ID, creation time, deployed head SHA, and agent ID. The row must be
a GitHub-backed `phase_handoff`, set `reply_contract.required=false`, and allow
only `github_writeback`.

Configure the deterministic canary runtime and mediated posting wrapper:

```sh
export AUN_QUEUE_WORK_COMMAND=bun
export AUN_QUEUE_WORK_ARGS_JSON='["scripts/shirube-d1-github-canary-runtime.ts"]'
export AUN_QUEUE_WORK_GITHUB_WRITEBACK_MODE=mediated
export AUN_QUEUE_WORK_MEDIATED_POSTING_COMMAND=bun
export AUN_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON='["scripts/queue-work-github-writeback.ts","--allow-repo","watchout/agent-comms-mcp"]'
export SHIRUBE_D1_CANARY_REPOSITORY=watchout/agent-comms-mcp
export SHIRUBE_D1_CANARY_ISSUE=887
export SHIRUBE_D1_CANARY_HEAD_SHA=<deployed-40-hex-sha>
export SHIRUBE_D1_CANARY_AGENT_ID=dev-001
export SHIRUBE_D1_CANARY_QUEUE_ID=<exact-queue-id>
export SHIRUBE_D1_CANARY_MESSAGE_ID=<exact-message-id>

bun bin/aun.ts runtime-v2 \
  --agent-id dev-001 \
  --queue-id "$SHIRUBE_D1_CANARY_QUEUE_ID" \
  --message-id "$SHIRUBE_D1_CANARY_MESSAGE_ID" \
  --created-after <timestamp-before-row-creation> \
  --runtime command-json \
  --finalize \
  --json
```

A passing response must contain all of these values:

- `outcome.code: E2E_DONE`
- `outcome.plan.live_activation: true`
- `outcome.shirube_v4_d1.effect_delivery_performed: true`
- exactly one `durable_receipts` entry for `github_writeback`
- `duplicate_effects: 0`
- the same GitHub comment URL in the durable receipt and finalizer result

Retry the exact execution once with the same queue, message, creation-time, and
activation fences. Runtime-v2 resumes only the stored `DONE` result, performs
read-only receipt recovery when needed, and must return the same receipt
without rerunning the model or posting a second comment.

## Rollback

Set `SHIRUBE_D1_KILL_SWITCH=1` and restart the worker. Confirm a new exact
D1 row is rejected before claim and that prior receipt rows remain readable.
Then set `SHIRUBE_D1_ENABLED=0`, clear `SHIRUBE_D1_TARGET_ALLOWLIST`, and
restart again. Retain the authorization and effect receipt tables.
Do not run the down migration during ordinary rollback. Dropping the D1 tables
requires separate approval and proof that no retained receipt is needed.
