# Queue-Work Residue Policy

Issue: https://github.com/watchout/agent-comms-mcp/issues/758

## Purpose

#722 proved one bounded `state-daemon-queue-work-scheduler` path with
`message_queue.id=121745` for `kodama`. Before broader scheduler rollout, old
evidence rows that could be confused with scheduler work must be classified by
exact row identity so future activation cannot silently process stale work.

This policy is not cleanup authorization. It preserves known evidence and gives
later preflight/runtime code a machine-readable way to fail closed.

## Invariant

Queue-work scheduler activation and selection must fail closed unless every
pre-existing non-terminal residue in scheduler scope is one of:

- exact-fenced fresh work for the current activation;
- exact-row classified by governed residue policy;
- already terminal.

Policy entries may also preserve exact identity for terminalized rows that were
previously non-terminal canary or handoff residue. In that case the pinned
status must match the current terminal status so future drift still fails
closed.

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
| `120138` | `preserve_immutable_evidence` | Preserve terminalized GitHub work puller canary evidence. Exclude from queue-work scheduler selection. |
| `120245` | `preserve_failed_scheduler_evidence` | Preserve terminalized failed `qa` scheduler evidence. Do not retry this row. Fresh retry must use a fresh row/message id. |
| `121744` | `preserve_incomplete_scheduler_evidence` | Preserve incomplete `secretary` scheduler evidence. Exclude from scheduler selection, claim refresh, reclaim, and runner invocation. |
| `121839` | `preserve_immutable_evidence` | Preserve terminalized obsolete PR #764 L2 re-audit handoff evidence. |
| `121873` | `preserve_immutable_evidence` | Preserve obsolete PR #765 check handoff evidence. |
| `121876` | `preserve_immutable_evidence` | Preserve obsolete PR #769 L2 handoff evidence. |
| `121919` | `preserve_immutable_evidence` | Preserve superseded PR #773 L2 handoff evidence for old head `ba54527328d84124e5e67741f47b60b0727ed510`. |
| `121924` | `preserve_immutable_evidence` | Preserve superseded PR #773 L2 handoff evidence for updated head `f251afe5aa28672500828059ec26f61684ace5ca`. |
| `121926` | `preserve_failed_scheduler_evidence` | Preserve failed #774 l2auditor exact-row queue-work canary evidence. Do not retry this row without separate exact-row CTO authorization. |
| `121938` | `preserve_immutable_evidence` | Preserve PR #775 L2 handoff delivery evidence. |
| `122584` | `preserve_immutable_evidence` | Preserve superseded PR #780 L2 audit handoff evidence for pre-rework head `76f6708def5d1aca99683f25c6283da4fc1cca80`. |
| `122762` | `preserve_immutable_evidence` | Preserve superseded PR #780 L2 re-audit handoff evidence for head `9276f541af5973b9ea182ca67643a41a4b26d9db`. |

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
