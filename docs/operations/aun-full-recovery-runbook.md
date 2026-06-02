# Full AUN Recovery Runbook And GO/NO-GO Checklist

> Issue: #602 `Automate full AUN recovery after terminal reboot, including queue wake-up`
> Status: docs-only recovery planning slice.

This runbook defines the operator sequence for restoring AUN after a terminal
reboot. It is a planning and GO/NO-GO checklist only. It does not authorize
state_daemon restart, launchd bootstrap/kickstart, Discord activation, queue
drain, DB mutation, or runtime live calls.

## Safety Boundary

Do not perform any of these actions while following this runbook:

- restart `state_daemon`
- run `launchctl bootstrap`, `launchctl kickstart`, or equivalent supervisor
  activation
- activate Discord, send a live Discord message, or perform a live Discord
  smoke
- call `next`, `inbox`, or drain FIFO rows to reach a target queue item
- inject a prompt into a TUI asking an LLM to call `next`, `processing`,
  `done`, or cleanup tools
- mutate `message_queue`, `agent_messages`, `outbound_queue`, routing,
  connector, credential, LaunchAgent, or schema state
- run live Codex, Claude, or other runtime invocations

Every command in the pre-approval path must be read-only or dry-run. Any
future repair, restart, launchctl action, queue canary, or Discord live smoke
requires a separate explicit approval that names the exact scope.

## Terminal Reboot Preconditions

After a terminal reboot, start by establishing evidence, not by waking agents.

1. Record the exact operator session time, host, repo checkout, and expected
   production DB URL.
2. Confirm whether state_daemon is intentionally disabled, quarantined, or
   merely not running.
3. Confirm no stale LaunchAgent points to a disposable `/tmp` or `/private/tmp`
   checkout.
4. Confirm the queue state is inspected from DB diagnostics, not by `next` or
   `inbox`.
5. Confirm Discord projection is diagnosed from DB/connector evidence, not by a
   live Discord write.
6. Define an exact activation scope before running readiness:

```json
{
  "label": "cp80-recovery-canary",
  "agents": ["codex-cto"],
  "channel_ids": ["1487368919613444156"],
  "runtime_kinds": ["codex"],
  "runner_phases": ["receive", "process", "completion"],
  "expected_projection": {
    "from_agent": "codex-cto",
    "to_agent": "ceo",
    "channel_id": "1487368919613444156",
    "consumer_agent_id": "codex-cto",
    "consumer_source": "sender_token_evidence"
  }
}
```

The scope must be canary-first. Fleet-wide activation is not a valid first
recovery step.

## Recovery Sequence

The ordering is fixed:

1. CP-70 doctor/preflight
2. CP-80 recovery readiness
3. CP-80 activation plan dry-run
4. explicit human approval for any runtime, daemon, launchd, or Discord action
5. bounded canary execution in a later approved slice

### 1. CP-70 Doctor And Queue Evidence

Run the control-plane doctor for the exact intended scope. The doctor must be
read-only and must return stable blocker codes with exact IDs.

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  agent-com queue doctor --agent-id codex-cto --format json
```

Use the output to identify:

- loop prompt backlog
- stale `received` / `in_progress` rows
- duplicate active turn or baton evidence, when available
- projection stalls
- exact queue IDs that require separate repair planning

NO-GO if any blocker exists. Do not repair by prompting an LLM, calling `next`,
or draining FIFO rows.

### 2. #603 LaunchAgent Readiness Position

#603 owns state-daemon persistent path and LaunchAgent readiness evidence.
Before CP-80 readiness can become GO, the LaunchAgent diagnostic must show:

- expected plist path is inspectable
- `ProgramArguments[1]` exists
- `WorkingDirectory` exists
- executable paths are present and executable where required
- no `ProgramArguments`, working directory, process cwd, or build artifact path
  points to `/tmp`, `/private/tmp`, or another disposable checkout
- launchd loaded/running state is reported if inspectable
- `AGENT_ID`, runtime kind, and listener identity match the expected
  state_daemon identity

Current read-only helper:

```bash
bun scripts/state-daemon-launchagent.ts preflight \
  --plist ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist
```

When the dedicated #603 CLI is present, use it as the front door:

```bash
agent-com state-daemon readiness --format json
```

Unloaded or not running state is evidence. It is not permission to restart.
Restart remains blocked until CP-80 readiness, activation-plan dry-run, and a
separate explicit approval are all present.

### 3. #604 Discord Projection Diagnostic Position

#604 owns DB-first Discord direct-delivery / AUN fallback evidence. Run it
before treating CP-80 readiness as GO for any Discord-facing recovery scope.

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  agent-com diagnose-projection \
    --channel 1487368919613444156 \
    --from codex-cto \
    --to ceo \
    --format json
```

Required direct delivery evidence for the default gate:

- `consumer_agent_id=codex-cto`
- `consumer_source=sender_token_evidence`
- usable sender credential
- provider write capability known and positive
- delivery connector instance and channel binding identified
- no router/AUN fallback

Diagnostic GO is not live delivery confirmation. It only proves that the DB and
connector evidence predict direct delivery. A live Discord smoke is a separate
approval step after the activation plan is accepted.

`fallback_allowed` must not be used to pass the default direct-delivery gate.
If sender credential evidence is usable but the decision falls back to
AUN/router, treat it as a blocker.

### 4. CP-80 Recovery Readiness

Run recovery readiness with the exact scope file. The readiness report is the
first whole-system GO/NO-GO gate.

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  agent-com recovery readiness \
    --scope-file ./recovery-scope.json \
    --format json > ./recovery-readiness.json
```

The report must include or reference:

- CP-70 preflight result for the exact scope
- LaunchAgent and persistent path evidence from #603
- queue backlog and stale active row evidence
- Discord projection diagnostic evidence from #604
- exact blocker IDs and stable blocker codes
- recommended next commands
- `mutation_performed:false`

NO-GO if any blocker is present, if evidence is stale, or if the report scope
does not exactly match the intended activation scope.

### 5. CP-80 Activation Plan Dry-Run

Only after readiness is GO, generate the activation plan. This is still
read-only.

```bash
agent-com recovery activation-plan \
  --scope-file ./recovery-scope.json \
  --readiness-report ./recovery-readiness.json \
  --format json > ./recovery-activation-plan.json
```

The plan must be canary-first and include these phases:

1. CP-70 preflight evidence check
2. state_daemon LaunchAgent readiness check
3. queue receive/process canary plan
4. completion outcome evidence plan
5. Discord projection evidence plan
6. audit evidence plan
7. rollback trigger list

The plan is not approval to run the canary. It is the packet used to request
approval for a later bounded execution.

## GO/NO-GO Checklist

| Gate | GO evidence | NO-GO evidence |
|---|---|---|
| Scope | exact agents, channel IDs, runtime kinds, phases, and expected projection are listed | fleet-wide first activation, missing channel ID, missing agent ID, or scope mismatch |
| CP-70 doctor | zero blocker findings for exact scope; exact IDs for warnings | loop prompt backlog, drain-to-target risk, stale active work, duplicate active turn/baton, quarantine, projection stall blocker |
| Queue readiness | backlog summarized; stale rows listed by exact ID; no mutation requested | active rows proposed for bulk terminalization, malformed evidence treated as success, or cleanup requires FIFO drain |
| #603 LaunchAgent readiness | persistent checkout paths exist; no volatile path; identity matches state_daemon | `/tmp` or `/private/tmp` target, missing executable, missing working dir, wrong `AGENT_ID`, wrong checkout, crash-loop evidence |
| state_daemon runtime state | loaded/running state is reported as evidence | unloaded/not running is silently corrected, bootstrap/kickstart suggested as current action, or restart performed |
| #604 Discord projection | direct delivery predicted with `consumer_agent_id=codex-cto` and `consumer_source=sender_token_evidence` | usable sender credential falls back to AUN/router, credential unknown, binding missing, write capability unknown |
| CP-80 readiness | `ok=true`, `go_no_go=GO`, exact scope, mutation false | `NO_GO`, missing CP-70/#603/#604 evidence, stale report, blocker present |
| CP-80 activation plan | readiness GO consumed; ordered canary-first phase plan emitted; mutation false | missing readiness report, readiness NO-GO, scope mismatch, fleet-wide activation |
| Approval | explicit approval names daemon, Discord, queue IDs, channel IDs, and rollback | implicit approval inferred from docs, LLM prose, or operator intent |

## Queue Wake-Up Policy

Queue wake-up after reboot must be DB-first and exact-scope.

- TUI prompt injection is prohibited.
- `next`, `inbox`, and FIFO drain are prohibited as recovery mechanisms.
- Wake-up may only be planned through bounded runner paths with exact
  `queue_id`, exact agent identity, and canary-first scope.
- Cleanup must start as dry-run classification with exact IDs.
- Stale no-reply cleanup must not touch active rows.
- Active rows are never bulk terminalized. They are reported as
  `active_stale_needs_reclaim` and require the reclaim flow.
- Malformed queue payloads fail closed into actionable/manual-review
  classifications unless independent joined evidence is sufficient.
- A row with ambiguous reply/outbound evidence must not be counted as
  successfully closed or safe to skip.

Allowed dry-run classifications for future cleanup planning:

- `stale_no_reply_report`
- `already_merged_pr_report`
- `legacy_prompt_artifact`
- `active_stale_needs_reclaim`
- `actionable_current_work`

Mutation, when separately approved in a future slice, must be exact ID only,
transactional, `RETURNING`-backed, and accompanied by an audit file.

## Discord Recovery Policy

Discord is a projection surface, not the queue source of truth.

- Diagnostic GO is not live delivery confirmation.
- Live smoke requires a later approval that names channel, sender, target, and
  rollback.
- `fallback_allowed=true` is not part of the default direct-delivery gate.
- Sender credential usable plus AUN/router fallback is a blocker.
- Missing credential, missing channel binding, or unknown provider write
  capability must fail closed.
- Send failure is projection failure evidence, not success.
- Live Discord write evidence must be captured only after approval.

## State-Daemon Recovery Policy

state_daemon recovery is gated by persistent path and LaunchAgent evidence.

- The LaunchAgent must point to a persistent approved checkout or artifact.
- `/private/tmp`, `/tmp`, dirty developer checkouts, and disposable worktrees
  are blockers for ProgramArguments, WorkingDirectory, and runtime cwd.
- Restart is allowed only after CP-80 readiness GO, activation-plan dry-run GO,
  and explicit approval.
- `launchctl bootstrap` and `launchctl kickstart` are approval-gated even in
  this runbook.
- Crash-loop evidence blocks activation until the path/config issue is fixed
  in a separate approved change.
- A disabled or quarantined daemon remains disabled until the approval packet
  says otherwise.

## Rollback And Stop Criteria

Stop immediately and keep evidence if any of these appear:

- FIFO drain or `next` / `inbox` usage is required to make progress
- TUI loop prompt or prompt-driven lifecycle text appears in queued content,
  LaunchAgent config, logs, or artifacts
- duplicate active work is detected
- active rows are proposed for bulk close
- Discord projection falls back unexpectedly
- provider send failure is counted as success
- state_daemon path points to the wrong checkout or wrong `AGENT_ID`
- Discord credential/write evidence is missing or ambiguous
- readiness or activation-plan scope does not match the intended canary
- any command attempts restart, bootstrap, kickstart, live Discord write, DB
  mutation, schema migration, or runtime live call before approval

Rollback after a later approved canary must pause or disable the exact
activation scope and preserve audit evidence. It must not delete rows,
bulk-close active work, or repair by restart/prompt injection.

## Acceptance And Close Criteria For #602

#602 can be considered ready for closure only when the following evidence
exists:

- recovery readiness report is GO for the exact scope
- activation plan dry-run is GO for the same scope
- LaunchAgent readiness is GO with persistent path evidence
- Discord projection diagnostic is GO for the expected direct delivery path
- bounded canary plan exists with exact queue, agent, channel, connector, and
  rollback evidence requirements
- live smoke evidence is captured only after explicit approval
- no state_daemon restart, launchd activation, Discord write, queue mutation,
  FIFO drain, or runtime live call was performed before approval

## Related Documents

- [Control-Plane Doctor And Preflight Contract](../spec/aun-control-plane-doctor-preflight-contract.md)
- [Scheduler Activation And Discord Canary Contract](../spec/aun-scheduler-activation-canary-contract.md)
- [State Daemon Restart Readiness Runbook](./state-daemon-restart-readiness-runbook.md)
- [State Daemon Restart Checklist](./state-daemon-restart-checklist.md)
- [Surface Projection Matrix](../design/surface-projection-matrix.md)
