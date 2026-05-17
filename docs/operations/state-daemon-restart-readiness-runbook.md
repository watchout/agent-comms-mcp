# State Daemon Restart Readiness Runbook

This runbook resolves the #421 post-merge restart-readiness blockers without
authorizing a production restart. Do not restart `state_daemon`, mutate launchd,
change DB rows, edit `.mcp.json`, or edit the bot registry until CTO explicitly
approves the restart window.

## Blockers Resolved

### DB URL

The observed launchd plist used `postgresql://localhost/agent_comms`, while
operator verification used `postgresql:///agent_comms?host=/tmp`. Treat this as
a release gate, not as an implicit migration.

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

### Approved Checkout

The daemon must run from a clean checkout at the approved merge commit. For the
#431 / #421 verification window, that commit is:

```text
0b6efae21c49e85619394194a466f7120f79d964
```

Preflight command:

```bash
APPROVED_COMMIT=0b6efae21c49e85619394194a466f7120f79d964
APPROVED_REPO=/private/tmp/agent-comms-state-daemon-${APPROVED_COMMIT}

git fetch origin main
test "$(git rev-parse origin/main)" = "$APPROVED_COMMIT"
git worktree add --detach "$APPROVED_REPO" "$APPROVED_COMMIT"
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
APPROVED_COMMIT=0b6efae21c49e85619394194a466f7120f79d964
APPROVED_REPO=/private/tmp/agent-comms-state-daemon-${APPROVED_COMMIT}
DATABASE_URL='postgresql:///agent_comms?host=/tmp'

git -C "$APPROVED_REPO" diff --check
bun --cwd "$APPROVED_REPO" test \
  tests/contract/state-daemon/test_state_action_matrix.test.ts \
  tests/contract/state-daemon/m2-sweep.test.ts \
  tests/contract/state-daemon/test_per_bot_suppression.test.ts \
  tests/contract/state-daemon/m4-entry-smoke.test.ts
bun --cwd "$APPROVED_REPO" build --target bun bin/state-daemon.ts \
  --outfile /private/tmp/state-daemon-${APPROVED_COMMIT}.js

ps aux | rg 'state-daemon|bin/state-daemon|state_daemon' | rg -v rg || true
launchctl print "gui/$(id -u)/com.agent-comms.state-daemon" || true

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
COMMIT;"
```

Pass criteria:

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
PLIST=~/Library/LaunchAgents/com.agent-comms.state-daemon.plist

plutil -replace ProgramArguments.1 -string "$APPROVED_REPO/bin/state-daemon.ts" "$PLIST"
plutil -replace WorkingDirectory -string "$APPROVED_REPO" "$PLIST"
plutil -replace StandardOutPath -string "$APPROVED_REPO/logs/state-daemon.out.log" "$PLIST"
plutil -replace StandardErrorPath -string "$APPROVED_REPO/logs/state-daemon.err.log" "$PLIST"
plutil -replace EnvironmentVariables.DATABASE_URL -string "$APPROVED_DATABASE_URL" "$PLIST"

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
