# GitHub-backed AUN Phase Handoff

Issue: https://github.com/watchout/agent-comms-mcp/issues/766

## Contract

GitHub is the durable SSOT for Company Dev OS phase evidence and merge gates.
AUN is the communication, queue, wake, runtime-health, timeout, retry,
reassignment, and reconciliation layer.

Phase completion evidence must be posted as a machine-readable GitHub comment.
AUN queue rows, ACKs, Discord projection, TUI visibility, and green CI are not
phase completion evidence by themselves.

## Phase Result Comment Markers

Supported markers:

- `<!-- conveyor:audit-result/v1 -->`
- `<!-- conveyor:qa-result/v1 -->`
- `<!-- conveyor:check-result/v1 -->`
- `<!-- conveyor:cto-result/v1 -->`

Required fields:

- `repo`
- `pr` or `issue`
- `role`
- `phase`
- `verdict`
- `exact_head` for PR-gated work
- `source_handoff_url`
- `required_fixes`
- `next_role`
- `non_scope`

Example:

```text
<!-- conveyor:audit-result/v1 -->
repo: watchout/agent-comms-mcp
pr: 765
role: audit
audit_level: L1
phase: audit
verdict: PASS
exact_head: 73e40a6f9478fb779029cf529cbcc12e787ca75a
source_handoff_url: https://github.com/watchout/agent-comms-mcp/issues/698#issuecomment-4716171020
required_fixes: none
next_role: audit
non_scope: no live Discord send / no DB mutation / no #722 activation
```

Downstream roles must not treat a check or CTO comment that merely summarizes
upstream L2/QA as independent upstream evidence. The upstream role must post its
own marker comment.

## Read-only Reconciliation

Use the dry-run report:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun scripts/reconcile-with-github.ts \
  --repo watchout/agent-comms-mcp \
  --pr 765
```

The report detects:

- `superseded_by_github_evidence`: an active AUN handoff row is older than later
  exact-head GitHub evidence.
- `github_label_phase_drift`: PR labels lag behind exact-head phase evidence and
  should be updated through `scripts/pr-conveyor.ts`.
- `phase_handoff_stalled`: an AUN handoff is active beyond TTL and no GitHub
  phase result exists.
- `missing_independent_phase_evidence`: downstream evidence exists but upstream
  role evidence is missing.

This command is read-only. It does not mutate PR labels, queue rows, GitHub
comments, LaunchAgents, state-daemon runtime, #722 scheduler state, Discord
state, or fleet state.
