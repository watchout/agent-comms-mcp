# Queue-Work Residue Policy

Issue: https://github.com/watchout/agent-comms-mcp/issues/758

## Purpose

#722 proved one bounded `state-daemon-queue-work-scheduler` path with
`message_queue.id=121745` for `kodama`. Before broader scheduler rollout, old
non-terminal evidence rows must be classified by exact row identity so future
activation cannot silently process stale work.

This policy is not cleanup authorization. It preserves known evidence and gives
later preflight/runtime code a machine-readable way to fail closed.

## Invariant

Queue-work scheduler activation and selection must fail closed unless every
pre-existing non-terminal residue in scheduler scope is one of:

- exact-fenced fresh work for the current activation;
- exact-row classified by governed residue policy;
- already terminal.

Broad time windows are not sufficient. `created_after` can define an activation
epoch, but preserved residue is authorized only by exact `queue_id` plus
identity evidence.

## Policy File

The repository policy file is:

```text
config/queue-work-residue-policy.json
```

The schema version is `queue_work_residue_policy_v1`. Each entry must include:

- `queue_id`
- `agent_id`
- `message_id` where present, or `null`
- `classification`
- `scheduler_action=exclude`
- `authorized_action=preserve_only`
- `evidence_ref`

Entries may also pin identity fields such as expected status,
`payload.source`, `receive_claim.source`, runner invocation source, and runner
error code. If any pinned identity field drifts, policy checks must fail
closed with a mismatch instead of assuming the row is safe.

## Current Classifications

| queue_id | Classification | Action |
|---:|---|---|
| `120138` | `preserve_immutable_evidence` | Preserve GitHub work puller canary evidence. Exclude from queue-work scheduler selection. |
| `120245` | `preserve_failed_scheduler_evidence` | Preserve failed `qa` scheduler evidence. Do not retry this row. Fresh retry must use a fresh row/message id. |
| `121744` | `preserve_incomplete_scheduler_evidence` | Preserve incomplete `secretary` scheduler evidence. Exclude from scheduler selection, claim refresh, reclaim, and runner invocation. |
| `123851` | `preserve_immutable_evidence` | Preserve CP80 superseded AUN notification evidence. Exclude from queue-work scheduler selection. |
| `123940` | `preserve_immutable_evidence` | Preserve CP80 superseded AUN instruction evidence. Exclude from queue-work scheduler selection. |
| `123945` | `preserve_immutable_evidence` | Preserve CP80 superseded AUN instruction evidence. Exclude from queue-work scheduler selection. |

`121745` is terminal `replied` and is not a residue policy entry.

## Read-Only Classifier

Validate the policy file only:

```bash
bun scripts/queue-work-residue-policy.ts --no-db
```

Validate the policy against live DB rows without mutation:

```bash
bun scripts/queue-work-residue-policy.ts --format json
```

The classifier is read-only. It must not mutate DB rows, terminalize residue,
start runtimes, call Discord, touch LaunchAgent, or enable scheduler flags.

## Activation Boundary

This PR1 policy layer does not change scheduler selection or LaunchAgent
preflight. Follow-up PRs must wire this model into:

- LaunchAgent queue-work activation preflight;
- scheduler notify/sweep/fetch paths;
- claim refresh/reclaim paths.

Until those PRs land and are reviewed, this policy is documentation and
read-only classification evidence only.

## Non-Goals

- No DB cleanup.
- No residue terminalization.
- No persistent scheduler activation.
- No broad #722 enablement.
- No Discord gateway recovery.
- No GitHub work puller activation.
- No fleet rollout.
