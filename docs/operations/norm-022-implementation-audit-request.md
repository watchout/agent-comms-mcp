# NORM-022 Implementation Audit Request

Date: 2026-05-27
Requester: AUN
Reviewer: l2auditor
Status: implementation re-audit PASS

## Scope

This request covers the implementation slice on:

```text
repo: /Users/yuji/Developer/agent-comms-mcp
branch: impl/norm-022-slice1-endpoint-read-model
base head: eb0ac7a0263828b567c36bc50a3b0f8e149c595d
```

Pre-implementation approval was recorded as audit
`ff87bb6f-4ce2-4f4e-9ef9-2697aa81f3c7`. That approval allowed
implementation start only. It did not grant merge approval.

## Implemented

- `bot_status` DB read model now reports endpoint lease readiness from
  active connectors, runtime linkage, and live `runtime_instance` leases.
- MCP `bot_status` output includes endpoint lease state and lease/runtime-linked
  connector counts.
- `agent profile doctor --strict` fails closed for active connectors missing a
  runtime instance or live runtime endpoint lease.
- Non-tmux supervisor modes no longer fail solely because tmux evidence is
  absent; tmux diagnostics are only used for `supervisor_type=tmux`.
- `restart_bot`, `watchdog_check`, and `cleanup_ports` use a shared destructive
  lifecycle gate that requires full endpoint coverage and fails closed for
  unsupported non-tmux restart/cleanup adapters.
- The NORM-022 frozen fixture list plus the implementation-audit regressions
  are executable in
  `tests/norm-022-runtime-endpoint-lease.test.ts`.
- Audit BLOCK 1 addressed: endpoint coverage now requires every active
  connector to have runtime linkage and live endpoint lease coverage.
- Audit BLOCK 2 addressed: non-tmux cleanup/restart no longer uses absent tmux
  session evidence as authority; it fails closed with
  `unsupported_supervisor_for_restart_cleanup` until an adapter exists.

## Audit Result

Implementation re-audit PASS was returned by `l2auditor` on 2026-05-27.

```text
PASS message ids:
de5cb5cd-6c93-47e3-8dcf-b10c169e8aa5
862bcb22-0366-4c5e-a531-f43784d0cda7
```

Residual note from audit: implementation is still in uncommitted working-tree
state, including new untracked files. Merge preparation must stage and commit
intentionally. POST_MERGE evidence is still required separately.

Merge preparation on 2026-05-29 moved the audited implementation onto clean PR
branch `codex/norm-022-slice1-pr` from `origin/main` after the DB profile SSOT
hotfix merged. The original dirty local branch remains untouched as audit
source evidence; this branch contains the intentionally staged NORM-022 slice.

## Files Changed

```text
cli/index.ts
core/bot-lifecycle.ts
core/bot-health.ts
core/bot-status-db.ts
server.ts
tests/bot-health.test.ts
tests/cli-sqlite-backend.test.ts
tests/contract/test_routing_v3_stage_a.test.ts
tests/norm-022-runtime-endpoint-lease.test.ts
tests/spec-enforcement/norm-022-server-gates.test.ts
docs/operations/norm-022-implementation-audit-request.md
docs/plans/norm-022-runtime-endpoint-lease-impl-plan.md
docs/spec/norm-022-runtime-endpoint-lease-supervisor-adapter-impl.md
docs/SPEC-INDEX.md
docs/design/aun-normalization-roadmap.md
docs/design/aun-normalization-wbs.md
docs/operations/agent-role-routing-map.md
```

## Frozen Fixtures And Regressions

All nine canonical fixtures are covered:

```text
healthy_endpoint_lease
missing_lease_refusal
stale_ttl_expiry
duplicate_active_lease_fenced
supervisor_down_fail_closed
restart_gated_by_lease_heartbeat_fencing
disabled_or_revoked_fail_closed
multi_channel_single_runtime
tmux_diagnostics_only_for_tmux_supervisor
```

The implementation-audit BLOCK regressions are also covered:

```text
partial_active_connector_coverage_fails_closed
non_tmux_destructive_lifecycle_fails_closed_without_tmux_evidence
```

## Verification

```text
bun test tests/norm-022-runtime-endpoint-lease.test.ts tests/bot-health.test.ts tests/spec-enforcement/norm-022-server-gates.test.ts tests/spec-enforcement/cli-commands.test.ts tests/cli-sqlite-backend.test.ts
=> 115 pass

DATABASE_URL=$(jq -r '.database_url' config.json) bun test tests/contract/test_routing_v3_stage_a.test.ts
=> 19 pass

git diff --check
=> pass
```

## Audit Questions

1. Does the implementation preserve the approved authority order:
   DB connector/runtime/endpoint lease evidence before supervisor/tmux/port
   observations?
2. Are `restart_bot`, `watchdog_check`, and `cleanup_ports` now sufficiently
   gated so missing or non-ok endpoint lease evidence cannot trigger destructive
   action?
3. Does strict doctor fail closed with actionable blocker codes for active
   connectors missing runtime or live endpoint lease evidence?
4. Does the partial active-connector coverage regression prove that 2 active
   connectors with only 1 linked/leased connector fail closed?
5. Does the non-tmux destructive lifecycle regression prove that tmux absence
   is not used as restart/cleanup authority outside `supervisor_type=tmux`?
6. Are all nine frozen fixtures executable and aligned with the plan/spec names?
7. Is this slice safe to proceed to merge preparation once implementation audit
   findings are resolved, with POST_MERGE evidence still required after merge?

## Remaining Gate

Merge preparation may proceed intentionally after this PASS, but the lane is not
complete until POST_MERGE evidence is collected.
