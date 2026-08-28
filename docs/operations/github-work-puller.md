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
- `STATE_DAEMON_GITHUB_TOKEN_FILE=/path/to/token`

One-shot diagnostics may still use `STATE_DAEMON_GITHUB_TOKEN` or
`GITHUB_TOKEN`, but reviewed persistent LaunchAgent activation must use
`STATE_DAEMON_GITHUB_TOKEN_FILE`. LaunchAgent preflight rejects raw GitHub token
values in plist environment variables.

## P2 Pull-Once Planner

`agent-com github-work pull-once` is a bounded P2 planning surface for the
GitHub-comment EventLog claim path. The CLI surface is dry-run only and reads
fixture/mock data; it does not call the live GitHub API, read a token, write
the DB, claim/process/complete queue rows, activate a daemon, touch a scheduler,
or start an AUN runner.

Example dry-run:

```bash
bun cli/index.ts github-work pull-once \
  --repo watchout/agent-comms-mcp \
  --label canary:github-work-pull-once \
  --owner-allowlist aun \
  --target-number 744 \
  --target-kind issue \
  --fixture tests/fixtures/github-work-p2-pull-once/dry-run-canary.json \
  --format json
```

The output is a `github_work_pull_once_v1` plan with:

- one selected canary work item, or explicit blocker codes
- would-post `claim.requested` EventLog comment data
- duplicate suppression from existing `claim.won` or `result.posted` comments
- protected-surface blocking from the independent classifier
- evidence flags for no live API, no DB/queue mutation, no token use, no
  daemon/scheduler touch, no AUN runner touch, and no repo settings/workflow
  mutation

`--execute` is intentionally rejected by this CLI path. A later live path
requires a fresh owner decision URL with exact canary scope before execution.

## Persistent Activation Profile

Persistent activation is intentionally narrower than the general worker
configuration. The restore helper only permits a bounded canary profile:

- exactly one repository
- exactly one `canary:*` label
- exactly one owner allowlist entry
- token supplied by `STATE_DAEMON_GITHUB_TOKEN_FILE`
- dry-run by default

Example dry-run:

```bash
bun scripts/state-daemon-launchagent.ts restore \
  --commit <exact-main-merge-sha> \
  --github-work-puller-enabled \
  --github-work-repos watchout/agent-comms-mcp \
  --github-work-labels canary:github-work-puller \
  --github-work-owner-allowlist agent-com-dev \
  --github-work-interval-ms 120000 \
  --github-work-writeback-enabled \
  --github-token-file ~/.config/agent-comms/github-work-token
```

The dry-run output may include the token file path, but must not include the
token value. `--execute` performs checkout verification, build, generated plist
preflight, staged plist preflight, atomic plist replace, and launchd bootstrap.
Do not use `--execute` without a fresh protected CTO authorization for the exact
commit, repo, label, owner, token file path, rollback, and post-start evidence.

## Behavior

For each configured repository, the worker reads open GitHub issues/PRs and
matches configured labels such as:

- `needs:arc`
- `needs:impl`
- `needs:implementation`
- `needs:rework`
- `needs:audit`
- `needs:l1-audit`
- `needs:l2-audit`
- `needs:qa`
- `needs:check`
- `needs:cto`
- `needs:l3-review`
- `needs:ceo-approval`
- `owner:<agent-or-role>`
- `route:fast`
- `route:protected`
- `runner:codex`
- `runner:claude-code`
- `blocked:aun`

Matched work is classified into role, owner, route, and runner policy. The
worker writes an AUN queue notification containing the GitHub URL and records
`audit_log` evidence. Duplicate dispatch is suppressed across restarts by the
GitHub fingerprint recorded in `audit_log`. The fingerprint uses an activity
cursor that excludes the worker's own optional GitHub writeback comments, so
writeback evidence cannot become the next dispatch trigger. External issue/PR
changes, label/body/title changes, human comments, and PR reviews still advance
the cursor.

Blocked items are also fingerprint-deduplicated before optional writeback. This
prevents an unresolved item from accumulating one puller comment per poll.

Protected routes resolve to `stop_lane`; they are surfaced but not approved,
merged, deployed, live-activated, or executed as autonomous work.

PR conveyor labels are normalized before owner resolution. The canonical
standard route is `audit -> QA -> check -> CTO when high-risk`; `needs:l3-review`
is retained only as a compatibility label for older PR conveyor runs.

- `needs:l1-audit` / `needs:l2-audit` -> role `audit`, owner `codex-audit`
- `needs:qa` -> role `qa`, owner `qa`
- `needs:check` -> role `check`, owner `check`
- `needs:cto` / `needs:l3-review` -> role `cto`, owner `codex-cto`
- `needs:ceo-approval` -> role `ceo`, owner `ceo`
- `needs:rework` -> role `implementation`, owner `agent-com-dev`

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

## #747 Canary Residue

The bounded one-shot canary for #746 intentionally left one evidence row:

- GitHub issue: `watchout/agent-comms-mcp#747`
- queue row: `message_queue.id=120138`
- status at acceptance: `pending`

Treat this row as evidence residue unless a separate governed cleanup or normal
processing path is approved. Do not bulk-close or drain it as part of persistent
puller activation.

## Rollback

If persistent activation is later approved and the puller misroutes, duplicates,
writes back unexpectedly, or touches protected lanes incorrectly:

1. Restore the LaunchAgent without the GitHub work puller env or unset
   `STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED`.
2. Preserve queue, audit, GitHub comments, and daemon logs.
3. Do not bulk-close queue rows.
4. Do not combine rollback with #722 scheduler activation, Discord recovery, or
   fleet repair.

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
