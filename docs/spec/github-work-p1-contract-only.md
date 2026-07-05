# GitHub Work P1 Contract Only

Control sources:

- `watchout/agent-comms-mcp#744`
- `watchout/agent-comms-mcp#766`

This P1 slice defines the contract-only layer for GitHub-first work discovery.
It does not authorize P2 pull-once execution, live GitHub/API calls, canaries,
daemon or scheduler changes, AUN runner execution, token use, DB/queue mutation,
repo settings changes, workflow changes, or deploy changes.

## EventLogCore

`schemas/github-work-event-log-core-v1.schema.json` defines
`github_work_event_log_core_v1`.

The parser in `core/state-daemon/github-work-event-log-core.ts` accepts only
P1 contract events with:

- `lane: P1_contract_only`
- `evidence.ssot: github`
- `evidence.aun_is_acceleration_only: true`
- `mutation_performed: false`
- `live_github_api_performed: false`
- `live_canary_performed: false`
- `daemon_or_scheduler_touched: false`
- `token_used: false`
- `db_queue_mutation_performed: false`
- `repo_settings_changed: false`
- `workflow_changed: false`
- `deploy_changed: false`
- `route.autonomous_execution_allowed: false`
- `queue.queue_id: null`
- `queue.status: null`
- `claim.winner_confirmation_required_before_execution: true`
- `claim.runtime_execution_performed: false`
- `claim.result_publication_performed: false`
- `poll_profile.no_poll_overlap: true`
- `poll_profile.max_in_flight_claims_per_seat: 1`
- `poll_profile.max_new_claims_per_poll: 1`
- `protected_surface.classification_source: independent_classifier_v1`

Completion evidence cannot be reduced to AUN or infrastructure signals. Each
valid event must explicitly reject:

- `aun_ack`
- `queue_id`
- `discord_projection`
- `tui_visibility`
- `green_ci_alone`

## QueueView

`projectQueueView()` projects one or more EventLogCore events into
`github_work_queue_view_v1`.

The QueueView is an operator-facing read model. It preserves:

- GitHub as SSOT
- AUN as acceleration only
- the latest contract status
- role, owner, route, runner policy, protected flag, and blocker codes
- independent protected-surface classification result
- claimable/blocked state derived from blockers and the classifier, not from a
  self-declared `protected_surface=false` input
- `p2_required_for_execution: true`
- `mutation_performed: false`

QueueView does not claim that queue rows were created or processed. Any real
GitHub pull, DB queue insert, writeback, runner/canary, or scheduler behavior
belongs to a later owner-approved P2 or protected-surface cell.

## F1 Claim Confirmation

P1 represents the two-phase claim-confirmation contract without executing work.

`claim.requested` is candidate-only. It must not set
`winner_execution_precondition_met`, execute runtime work, or publish results.
Execution/result publication requires:

- settle window, default `3000` ms
- re-read after settle
- stable event set
- deterministic winner election by earliest GitHub server `created_at`, then
  lexicographic `claim_id`
- loser emits `claim_lost`

The frozen fixture `github-double-claim-one-confirmed.yaml` proves a synthetic
two-seat race with exactly one confirmed winner and no loser execution/result.

## F2 Poll Profiles

P1 defines poll cadence, fairness, and backpressure as contract data only.

Profiles:

- `serial_seat_default`: `120000` ms poll interval, `0..30000` ms jitter,
  one in-flight claim per seat, one new claim per poll.
- `audit_pool_profile`: `60000` ms poll interval, `0..20000` ms jitter,
  `source_ref: watchout/iyasaka-arc#32`, pool width from active registered
  `evidence_audit_gate` seats in the #32 registry, same two-phase claim race
  behavior as F1.
- `protected_surface_gate_profile`: `120000` ms poll interval,
  `0..30000` ms jitter, owner-decision routing only.

Backpressure is encoded as no overlapping poll per seat, exponential backoff
with jitter for rate limits, and ETag/If-None-Match repo hammer guard when
available. Missed signals must recover on the next poll/discover cycle.

## F3 Protected-Surface Classifier

The classifier is independent contract logic. It does not trust
`route.protected`, labels, or a payload's self-declared
`protected_surface=false` as authority.

Classifier inputs:

- GitHub title/body/labels
- changed paths
- declared operations
- route labels
- linked owner-decision URL, if present

Detected protected surfaces include runtime/runner activation, state-daemon or
queue scheduler enablement, launchd/plist activation, token or secret source
changes, DB/queue lifecycle mutation, repo settings/workflow changes, deploy or
production changes, pricing/billing, and contract `.v2`.

Mismatch policy:

- declared false but classified true: blocked with
  `PROTECTED_SURFACE_OWNER_REQUIRED`, claim not allowed.
- declared true but classified false: blocked with `CONTRACT_INVALID`, claim
  not allowed.

QueueView claimability is derived from the independent classifier and blocker
codes, not from self-declared protected-surface data.

## Merge Gates

The P1 merge gate is executable:

```bash
bun test tests/contract/test_github_work_p1_contract_only.test.ts
```

It contains four frozen gates:

- F1: two-phase claim confirmation elects exactly one winner from a synthetic
  two-seat race and blocks loser execution/result.
- F2: parser rejects P2/live/API/token/DB/queue forbidden scope and accepts the
  #32 audit-pool cadence/fairness/backpressure profile.
- F3: QueueView and the independent protected-surface classifier fail closed
  when self-declared `protected_surface=false` conflicts with classified
  protected work.
- F4: required golden failure fixtures are present and executable, and source
  pins prove the contract layer is not wired into daemon, scheduler, AUN runner,
  LaunchAgent, or CLI execution surfaces.

Fixture source:

- `tests/fixtures/github-work-p1-contract/F1-event-log-core-valid.json`
- `tests/fixtures/github-work-p1-contract/F2-audit-pool-profile.json`
- `tests/fixtures/github-work-p1-contract/F2-forbidden-live-scope.json`
- `tests/fixtures/github-work-p1-contract/F3-queue-view-events.json`
- `tests/fixtures/github-work-p1-contract/F4-merge-gates.json`
- `tests/fixtures/github-work-p1-contract/github-double-claim-one-confirmed.yaml`
- `tests/fixtures/github-work-p1-contract/missed-signal-next-poll-recovers.yaml`
- `tests/fixtures/github-work-p1-contract/function-address-binding-unresolved-blocked.yaml`
- `tests/fixtures/github-work-p1-contract/protected-surface-misdeclared-blocked.yaml`
- `tests/fixtures/github-work-p1-contract/protected-option-a-owner-required.yaml`

## Non-Scope

This P1 cell must not include:

- `P2_github_pull_once`
- live GitHub/API/canary execution
- daemon or scheduler mutation
- AUN runner execution
- token, DB, queue, repo settings, workflow, or deploy changes
- persistent puller enablement
- completion evidence based only on AUN ACK, queue id, Discord projection, TUI
  visibility, or green CI
