# State Daemon Restart Readiness Runbook

This runbook resolves the #421 post-merge restart-readiness blockers without
authorizing a production restart. Do not restart `state_daemon`, mutate launchd,
change DB rows, edit `.mcp.json`, or edit the bot registry until CTO explicitly
approves the restart window.

## Restart Standard

### Desired Plist And Environment

These are the desired values for the next approved restart. They are not live
mutation instructions until CTO approves the restart window.

```text
Label: com.agent-comms.state-daemon
ProgramArguments.0: /Users/yuji/.bun/bin/bun
ProgramArguments.1: <APPROVED_REPO>/bin/state-daemon.ts
WorkingDirectory: <APPROVED_REPO>
StandardOutPath: <APPROVED_REPO>/logs/state-daemon.out.log
StandardErrorPath: <APPROVED_REPO>/logs/state-daemon.err.log
EnvironmentVariables.NODE_ENV: production
EnvironmentVariables.DATABASE_URL: postgresql:///agent_comms?host=/tmp
EnvironmentVariables.PATH: /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
EnvironmentVariables.STATE_DAEMON_WAKE_DUPLICATE_SUPPRESS_SEC: 30
EnvironmentVariables.STATE_DAEMON_AGENT_ALLOWLIST: auditor,codex-audit,codex-aun,codex-cto
KeepAlive: true
ThrottleInterval: 10
ProcessType: Background
```

`<APPROVED_REPO>` must be a clean checkout/worktree at the CTO-approved
post-fix `main` commit. That commit must be the #432-or-later merge commit
containing the `scripts/restart-bot.sh` adapter fix. Do not use the dirty/behind
developer checkout at `/Users/yuji/Developer/agent-comms-mcp` for restart.

### DB URL

The observed launchd plist used `postgresql://localhost/agent_comms`, while
operator verification used `postgresql:///agent_comms?host=/tmp`. Treat this as
a release gate, not as an implicit migration.

The restart standard is `postgresql:///agent_comms?host=/tmp`. Using TCP
`localhost` requires separate CTO approval with connection-test evidence that
it targets the same intended production database.

Preflight command:

```bash
plutil -extract EnvironmentVariables.DATABASE_URL raw \
  ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist

psql 'postgresql:///agent_comms?host=/tmp' -Atc 'SELECT current_database(), inet_server_addr(), now();'
psql 'postgresql://localhost/agent_comms' -Atc 'SELECT current_database(), inet_server_addr(), now();'
```

Restart approval must name one canonical `DATABASE_URL`. If both commands point
to the same PostgreSQL cluster, record that evidence in the issue. If one fails
or they point to different clusters, update the installed plist only during the
approved restart window.

### Audit Wake Scope

The PR audit path uses `auditor` for L1 and `codex-audit` for L2. The next
approved restart profile must include both recipients in
`STATE_DAEMON_AGENT_ALLOWLIST` so DB queue delivery and daemon wake behavior
match for the full PR audit chain.

```text
auditor,codex-audit,codex-aun,codex-cto
```

`auditor` is a TUI/tmux L1 recipient. `codex-audit` and `codex-aun` use the
Codex runner path. `codex-cto` remains a TUI/tmux recipient. If L1 audit moves
to a different identity later, change the PR audit runbook and this allowlist
in the same reviewed PR; do not leave queue fanout pointing at an identity that
the daemon is not allowed to wake.

Preflight command:

```bash
plutil -extract EnvironmentVariables.STATE_DAEMON_AGENT_ALLOWLIST raw \
  ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist

psql 'postgresql:///agent_comms?host=/tmp' -P pager=off -c "
SELECT id, agent_id, message_id, status, created_at, last_wake_attempt_at,
       claimed_by, claimed_at
  FROM message_queue
  WHERE agent_id IN ('auditor','codex-audit')
    AND status IN ('pending','received','in_progress')
  ORDER BY created_at DESC
  LIMIT 20;"
```

### Approved Checkout

The daemon must run from a clean checkout at the CTO-approved post-fix merge
commit. The approved commit must include the #432 `scripts/restart-bot.sh`
adapter fix; #431 commit `0b6efae21c49e85619394194a466f7120f79d964` is not
sufficient for restart because it still references the missing
`scripts/start-runbot.sh` path.

```text
CTO_APPROVED_STATE_DAEMON_COMMIT=<#432-or-later merge commit containing the restart-bot.sh adapter fix>
```

Preflight command:

```bash
CTO_APPROVED_STATE_DAEMON_COMMIT='<fill-with-CTO-approved-#432-or-later-merge-commit>'
APPROVED_REPO=/private/tmp/agent-comms-state-daemon-${CTO_APPROVED_STATE_DAEMON_COMMIT}

git fetch origin main
test "$(git rev-parse origin/main)" = "$CTO_APPROVED_STATE_DAEMON_COMMIT"
git worktree add --detach "$APPROVED_REPO" "$CTO_APPROVED_STATE_DAEMON_COMMIT"
git -C "$APPROVED_REPO" status --short
bun --cwd "$APPROVED_REPO" install --frozen-lockfile
```

The installed launchd `WorkingDirectory`, `ProgramArguments`, and log paths must
all point to the approved checkout selected by CTO. Do not reuse a dirty working
tree for the restart.

### Bot Restart Launcher

The production `state_daemon` restart adapter now calls
`scripts/restart-bot.sh`, which exists in the repo and is already used by
watchdog/operator paths. The previous `scripts/start-runbot.sh` reference was a
blocker because that file was absent.

Risk classification:

- Severity: restart-readiness blocker for bot auto-restart paths.
- Runtime impact before this PR: the daemon can still wake/observe queues, but
  a dead TUI bot restart attempt fails with a missing-file error and escalates.
- Data-safety impact: no direct queue-row mutation or terminal-close risk.
- Resolution in this PR: call the existing repo-owned
  `scripts/restart-bot.sh` launcher and pin that path in source tests.
- Residual operational risk: `scripts/restart-bot.sh` may sync `.mcp.json` from
  bot registry during bot restart, so do not force bot auto-restart in the first
  smoke unless CTO explicitly approves that side effect.

Preflight command:

```bash
test -x "$APPROVED_REPO/scripts/restart-bot.sh"
test ! -e "$APPROVED_REPO/scripts/start-runbot.sh"
rg 'scripts/(restart-bot|start-runbot)\\.sh' \
  "$APPROVED_REPO/bin" "$APPROVED_REPO/core" "$APPROVED_REPO/tests" "$APPROVED_REPO/config"
```

## Read-Only Preflight

Run these before asking CTO for restart approval:

```bash
CTO_APPROVED_STATE_DAEMON_COMMIT='<fill-with-CTO-approved-#432-or-later-merge-commit>'
APPROVED_REPO=/private/tmp/agent-comms-state-daemon-${CTO_APPROVED_STATE_DAEMON_COMMIT}
DATABASE_URL='postgresql:///agent_comms?host=/tmp'
APPROVED_AGENT_ALLOWLIST='auditor,codex-audit,codex-aun,codex-cto'

git fetch origin main
test "$(git rev-parse origin/main)" = "$CTO_APPROVED_STATE_DAEMON_COMMIT"
git -C "$APPROVED_REPO" diff --check
bun --cwd "$APPROVED_REPO" test \
  tests/contract/state-daemon/test_state_action_matrix.test.ts \
  tests/contract/state-daemon/m2-sweep.test.ts \
  tests/contract/state-daemon/test_per_bot_suppression.test.ts \
  tests/contract/state-daemon/m4-entry-smoke.test.ts
bun --cwd "$APPROVED_REPO" build --target bun bin/state-daemon.ts \
  --outfile /private/tmp/state-daemon-${CTO_APPROVED_STATE_DAEMON_COMMIT}.js

ps aux | rg 'state-daemon|bin/state-daemon|state_daemon' | rg -v rg || true
launchctl print "gui/$(id -u)/com.agent-comms.state-daemon" || true
CURRENT_AGENT_ALLOWLIST="$(plutil -extract EnvironmentVariables.STATE_DAEMON_AGENT_ALLOWLIST raw \
  ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist 2>/dev/null || true)"
printf 'installed STATE_DAEMON_AGENT_ALLOWLIST=%s\n' "$CURRENT_AGENT_ALLOWLIST"
printf 'approved  STATE_DAEMON_AGENT_ALLOWLIST=%s\n' "$APPROVED_AGENT_ALLOWLIST"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off -c "
BEGIN READ ONLY;
SELECT now() AS checked_at;
SELECT status, count(*) FROM message_queue
  WHERE status IN ('received','in_progress')
  GROUP BY status ORDER BY status;
SELECT count(*) AS stale_dispatch_since_431
  FROM message_queue
  WHERE failed_reason LIKE 'STALE_DISPATCH:%'
    AND created_at >= timestamptz '2026-05-16 22:26:32+00';
SELECT id, agent_id, message_id, status, created_at, read_at,
       claimed_by, claimed_at, claim_expires_at, failed_reason, replied_at, done_at
  FROM message_queue
  WHERE status IN ('received','in_progress')
  ORDER BY created_at;
SELECT id, agent_id, message_id, status, created_at, last_wake_attempt_at,
       claimed_by, claimed_at
  FROM message_queue
  WHERE agent_id IN ('auditor','codex-audit')
    AND status IN ('pending','received','in_progress')
  ORDER BY created_at DESC
  LIMIT 20;
COMMIT;"
```

Pass criteria:

- installed plist values match the desired values above, or every mismatch is
  recorded as pending CTO-approved restart-window mutation
- L1 `auditor` and L2 `codex-audit` are both included in the approved
  `STATE_DAEMON_AGENT_ALLOWLIST`, unless the PR audit routing policy was
  explicitly changed in the same reviewed release
- pending audit rows are accounted for; no row is stranded only because its
  `agent_id` is outside the daemon allowlist
- focused tests and build pass
- installed service status is recorded before restart
- `STALE_DISPATCH:%` count since #431 merge is zero or explicitly explained
- active `received` / `in_progress` rows are not terminal-closed by age
- `state_daemon_state_actions_total`, `state_daemon_pg_notify_errors_total`, and
  `state_daemon_wake_actions_total` are present in code/tests

## CTO-Approved Restart Commands

Run this section only after CTO explicitly approves the restart and names the
approved `DATABASE_URL` and approved checkout path.

```bash
APPROVED_REPO=/path/approved-clean-checkout
APPROVED_DATABASE_URL='postgresql:///agent_comms?host=/tmp'
APPROVED_AGENT_ALLOWLIST='auditor,codex-audit,codex-aun,codex-cto'
PLIST=~/Library/LaunchAgents/com.agent-comms.state-daemon.plist

plutil -replace ProgramArguments.1 -string "$APPROVED_REPO/bin/state-daemon.ts" "$PLIST"
plutil -replace WorkingDirectory -string "$APPROVED_REPO" "$PLIST"
plutil -replace StandardOutPath -string "$APPROVED_REPO/logs/state-daemon.out.log" "$PLIST"
plutil -replace StandardErrorPath -string "$APPROVED_REPO/logs/state-daemon.err.log" "$PLIST"
plutil -replace EnvironmentVariables.DATABASE_URL -string "$APPROVED_DATABASE_URL" "$PLIST"
plutil -replace EnvironmentVariables.STATE_DAEMON_AGENT_ALLOWLIST -string "$APPROVED_AGENT_ALLOWLIST" "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.agent-comms.state-daemon"

launchctl print "gui/$(id -u)/com.agent-comms.state-daemon"
tail -n 80 "$APPROVED_REPO/logs/state-daemon.out.log"
tail -n 80 "$APPROVED_REPO/logs/state-daemon.err.log"
```

## Smoke

After approved restart:

1. Confirm the daemon logs `started` and stays alive beyond one sweep interval.
2. Confirm #421 metrics appear in logs after a controlled wake/observe path.
3. Create or identify a CTO-approved controlled queue item.
4. Claim it with `aun receive` or `aun next`.
5. Send progress with `aun reply --no-close --queue-id <id> --message-id <uuid>`.
6. Verify the queue remains non-terminal after progress.
7. Send final with `aun reply --close --queue-id <id> --message-id <uuid>`.
8. Verify only the final close terminal-closes the queue.
9. Verify outbound delivery projection for the final reply.
10. Send a CTO-approved controlled PR-audit wake to the chosen L1 identity and
    verify its queue row is either claimed automatically or documented as a
    deliberate manual-only exception.

## Rollback

Rollback is supervisor-only unless CTO separately approves DB repair.

```bash
PLIST=~/Library/LaunchAgents/com.agent-comms.state-daemon.plist
PREVIOUS_REPO=/path/previous-known-good-checkout
PREVIOUS_DATABASE_URL='postgresql:///agent_comms?host=/tmp'

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
plutil -replace ProgramArguments.1 -string "$PREVIOUS_REPO/bin/state-daemon.ts" "$PLIST"
plutil -replace WorkingDirectory -string "$PREVIOUS_REPO" "$PLIST"
plutil -replace StandardOutPath -string "$PREVIOUS_REPO/logs/state-daemon.out.log" "$PLIST"
plutil -replace StandardErrorPath -string "$PREVIOUS_REPO/logs/state-daemon.err.log" "$PLIST"
plutil -replace EnvironmentVariables.DATABASE_URL -string "$PREVIOUS_DATABASE_URL" "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.agent-comms.state-daemon"
```

Do not manually update `message_queue` rows during rollback unless CTO provides
exact row IDs and SQL.

## Residual Risks

- `scripts/restart-bot.sh` syncs `.mcp.json` from bot registry during bot
  restart. That is expected for bot restart automation, but the first approved
  state_daemon restart smoke should avoid forcing a bot auto-restart unless CTO
  also approves that side effect.
- Existing active `in_progress` rows may remain open by design. #421 must not
  infer lifecycle closure; #426 owns lifecycle terminal semantics.
- If the installed launchd plist and operator shell use different DB URLs, the
  daemon may observe a different queue than manual verification.
