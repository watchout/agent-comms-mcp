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
- `p2_required_for_execution: true`
- `mutation_performed: false`

QueueView does not claim that queue rows were created or processed. Any real
GitHub pull, DB queue insert, writeback, runner/canary, or scheduler behavior
belongs to a later owner-approved P2 or protected-surface cell.

## Merge Gates

The P1 merge gate is executable:

```bash
bun test tests/contract/test_github_work_p1_contract_only.test.ts
```

It contains four frozen gates:

- F1: EventLogCore schema/parser accepts the valid P1 fixture.
- F2: parser rejects P2/live/API/token/DB/queue forbidden scope.
- F3: QueueView projector preserves GitHub SSOT and P1 no-mutation evidence.
- F4: source pins prove the contract layer is not wired into daemon, scheduler,
  AUN runner, LaunchAgent, or CLI execution surfaces.

Fixture source:

- `tests/fixtures/github-work-p1-contract/F1-event-log-core-valid.json`
- `tests/fixtures/github-work-p1-contract/F2-forbidden-live-scope.json`
- `tests/fixtures/github-work-p1-contract/F3-queue-view-events.json`
- `tests/fixtures/github-work-p1-contract/F4-merge-gates.json`

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
