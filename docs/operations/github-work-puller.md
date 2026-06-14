# GitHub Work Puller

Issue: `watchout/agent-comms-mcp#744`

Canonical model: `watchout/iyasaka-arc#18`

## Purpose

The GitHub work puller lets state-daemon discover Company Dev OS work from
GitHub without OS cron or human relay. GitHub remains the durable SSOT; AUN is
only notification, queue delivery, runtime evidence, and acceleration.

## Runtime Boundary

The worker is disabled by default.

Enablement requires:

- `STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED=1`
- `STATE_DAEMON_GITHUB_WORK_REPOS=owner/repo[,owner/repo...]`
- protected review before live activation

Optional scope:

- `STATE_DAEMON_GITHUB_WORK_LABELS=needs:impl,needs:audit,...`
- `STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST=agent-com-dev,codex-audit,...`
- `STATE_DAEMON_GITHUB_WORK_INTERVAL_MS=120000`
- `STATE_DAEMON_GITHUB_WORK_ROLE_OWNER_MAP_JSON='{"impl":"agent-com-dev"}'`
- `STATE_DAEMON_GITHUB_WORK_WRITEBACK_ENABLED=1`
- `STATE_DAEMON_GITHUB_TOKEN` or `GITHUB_TOKEN`

## Behavior

For each configured repository, the worker reads open GitHub issues/PRs and
matches configured labels such as:

- `needs:arc`
- `needs:impl`
- `needs:audit`
- `needs:qa`
- `needs:check`
- `needs:cto`
- `owner:<agent-or-role>`
- `route:fast`
- `route:protected`
- `runner:codex`
- `runner:claude-code`
- `blocked:aun`

Matched work is classified into role, owner, route, and runner policy. The
worker writes an AUN queue notification containing the GitHub URL and records
`audit_log` evidence. Duplicate dispatch is suppressed across restarts by the
GitHub fingerprint recorded in `audit_log`.

Protected routes resolve to `stop_lane`; they are surfaced but not approved,
merged, deployed, live-activated, or executed as autonomous work.

## Evidence

DB evidence is recorded in `audit_log` with event types:

- `github_work.dispatch_attempt`
- `github_work.blocked`
- `github_work.dispatch_failed`
- `github_work.writeback`
- `github_work.writeback_failed`

Queue payloads carry:

- GitHub URL
- repo / issue or PR number / node id
- role / owner / route / runner policy
- protected flag
- phase-goal presence
- dispatch fingerprint
- explicit `ssot=github`

If GitHub writeback is enabled, the worker posts dispatch evidence to the
GitHub issue/PR. Writeback failure does not hide the work item; it is recorded
as degraded evidence.

## Non-Goals

This worker does not authorize:

- #722 scheduler enablement
- Discord gateway recovery
- fleet rollout
- production launchd mutation
- auto-merge
- protected GO/NO-GO bypass
- treating AUN ACK, queue id, Discord projection, TUI text, or green CI alone
  as completion evidence
