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
EnvironmentVariables.STATE_DAEMON_CODEX_RUNNER_ENABLED: 1
EnvironmentVariables.STATE_DAEMON_CODEX_RUNNER_DATABASE_URL: postgresql:///agent_comms?host=/tmp
EnvironmentVariables.STATE_DAEMON_AGENT_ALLOWLIST: <unset>
KeepAlive: true
ThrottleInterval: 10
ProcessType: Background
```

`<APPROVED_REPO>` must be a clean checkout/worktree at the CTO-approved
post-fix `main` commit and must live under the durable restore root
`~/.agent-comms/state-daemon/checkouts/<commit>` unless CTO explicitly approves
another persistent package/artifact path. Do not use the dirty/behind developer
checkout at `/Users/yuji/Developer/agent-comms-mcp`, and do not point launchd at
an unowned `/tmp` or `/private/tmp` worktree. That commit must include the
`scripts/restart-bot.sh` adapter fix, the Codex restart prompt-skip fix, and the
DB-driven denylist state_daemon profile.

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

### Fleet Wake Scope

The normal production scope is DB-driven: an enabled agent with channel
membership and runtime/tmux metadata is in daemon scope by default. The launchd
profile must leave `STATE_DAEMON_AGENT_ALLOWLIST` unset; that key is only an
emergency narrowing override. `STATE_DAEMON_AGENT_DENYLIST` excludes
disabled/test/human identities that must not be woken even if a queue row is
inserted.

The PR audit path still uses `auditor` for L1 and `codex-audit` for L2. Those
recipients must be enabled DB agents and must not appear in the denylist.
Runtime and tmux routing are DB-owned (`agents.runtime` plus
`agents.metadata->>'tmux_session'`) and must be verified in preflight rather
than hard-coded into launchd scope.

Preflight command:

```bash
CURRENT_AGENT_ALLOWLIST="$(plutil -extract EnvironmentVariables.STATE_DAEMON_AGENT_ALLOWLIST raw ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist 2>/dev/null || true)"
CURRENT_AGENT_DENYLIST="$(plutil -extract EnvironmentVariables.STATE_DAEMON_AGENT_DENYLIST raw ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist 2>/dev/null || true)"
printf 'installed STATE_DAEMON_AGENT_ALLOWLIST=%s\n' "$CURRENT_AGENT_ALLOWLIST"
printf 'installed STATE_DAEMON_AGENT_DENYLIST=%s\n' "$CURRENT_AGENT_DENYLIST"

psql 'postgresql:///agent_comms?host=/tmp' -P pager=off -c "
SELECT agent_id, status, runtime, (metadata->>'tmux_session') AS tmux_session,
       last_seen_at
  FROM agents
  WHERE agent_id IN ('auditor','codex-audit','codex-aun','codex-cto')
  ORDER BY agent_id;
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
commit. The approved commit must include the repo-owned
`scripts/restart-bot.sh` adapter, the Codex restart prompt-skip fix, and the
DB-driven denylist state_daemon profile. #431 commit
`0b6efae21c49e85619394194a466f7120f79d964` is not sufficient for restart
because it still references the missing `scripts/start-runbot.sh` path.

The durable restore helper owns checkout creation, dependency/build
verification, plist staging, and preflight. It refuses to load/kickstart when
`ProgramArguments[1]` or `WorkingDirectory` is missing, and it rejects unowned
`/tmp` / `/private/tmp` launchd targets before launchd can crash-loop with
`Module not found`.

```text
CTO_APPROVED_STATE_DAEMON_COMMIT=<approved main merge commit containing the restart-bot adapter, Codex prompt-skip, and denylist profile>
```

Preflight command:

```bash
CTO_APPROVED_STATE_DAEMON_COMMIT='<fill-with-CTO-approved-main-merge-commit>'
APPROVED_RESTORE_ROOT="$HOME/.agent-comms/state-daemon/checkouts"
APPROVED_REPO="${APPROVED_RESTORE_ROOT}/${CTO_APPROVED_STATE_DAEMON_COMMIT}"

git fetch origin main
test "$(git rev-parse origin/main)" = "$CTO_APPROVED_STATE_DAEMON_COMMIT"

bun scripts/state-daemon-launchagent.ts restore \
  --commit "$CTO_APPROVED_STATE_DAEMON_COMMIT" \
  --restore-root "$APPROVED_RESTORE_ROOT" \
  --dry-run
```

The installed launchd `WorkingDirectory`, `ProgramArguments`, and log paths must
all point to the approved durable checkout selected by CTO. Do not reuse a dirty
working tree for the restart.

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
CTO_APPROVED_STATE_DAEMON_COMMIT='<fill-with-CTO-approved-main-merge-commit>'
APPROVED_RESTORE_ROOT="$HOME/.agent-comms/state-daemon/checkouts"
APPROVED_REPO="${APPROVED_RESTORE_ROOT}/${CTO_APPROVED_STATE_DAEMON_COMMIT}"
DATABASE_URL='postgresql:///agent_comms?host=/tmp'
APPROVED_AGENT_DENYLIST='adf-dev,arc-test,auditor-test,ceo,codex-test,cto,cto-test,cto-test2,dev-001,hotfix-test,iyasaka-arc,test,test-probe,unknown'

git fetch origin main
test "$(git rev-parse origin/main)" = "$CTO_APPROVED_STATE_DAEMON_COMMIT"
test -d "$APPROVED_REPO"
git -C "$APPROVED_REPO" diff --check

# Run state_daemon contract tests against an isolated PostgreSQL database.
# Do not point these tests at the live `agent_comms` DB: the currently
# running production daemon can observe and mutate `sd-test-*` fixture rows,
# which turns operator preflight into a race against the live supervisor.
STATE_DAEMON_TEST_SHA="$(printf '%s' "$CTO_APPROVED_STATE_DAEMON_COMMIT" | cut -c1-12)"
STATE_DAEMON_TEST_DB="agent_comms_sd_${STATE_DAEMON_TEST_SHA}_$(date +%Y%m%d%H%M%S)"
createdb "$STATE_DAEMON_TEST_DB"
trap 'dropdb --if-exists "$STATE_DAEMON_TEST_DB"' EXIT
(
  cd "$APPROVED_REPO"
  DATABASE_URL="postgresql:///${STATE_DAEMON_TEST_DB}?host=/tmp" \
    bun run db/migrate.ts
  DATABASE_URL="postgresql:///${STATE_DAEMON_TEST_DB}?host=/tmp" \
    bun test \
      tests/contract/state-daemon/test_state_action_matrix.test.ts \
      tests/contract/state-daemon/m2-sweep.test.ts \
      tests/contract/state-daemon/test_per_bot_suppression.test.ts \
      tests/contract/state-daemon/m4-entry-smoke.test.ts \
      tests/contract/state-daemon/test_launchagent_restore.test.ts
  STATE_DAEMON_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-comms-state-daemon-build.XXXXXX")"
  trap 'rm -rf "$STATE_DAEMON_BUILD_DIR"' EXIT
  bun build --target bun bin/state-daemon.ts \
    --outfile "$STATE_DAEMON_BUILD_DIR/state-daemon-build.js"
)

bun scripts/state-daemon-launchagent.ts preflight \
  --plist ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist

ps aux | rg 'state-daemon|bin/state-daemon|state_daemon' | rg -v rg || true
launchctl print "gui/$(id -u)/com.agent-comms.state-daemon" || true
CURRENT_AGENT_ALLOWLIST="$(plutil -extract EnvironmentVariables.STATE_DAEMON_AGENT_ALLOWLIST raw \
  ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist 2>/dev/null || true)"
CURRENT_AGENT_DENYLIST="$(plutil -extract EnvironmentVariables.STATE_DAEMON_AGENT_DENYLIST raw \
  ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist 2>/dev/null || true)"
printf 'installed STATE_DAEMON_AGENT_ALLOWLIST=%s\n' "$CURRENT_AGENT_ALLOWLIST"
printf 'installed STATE_DAEMON_AGENT_DENYLIST=%s\n' "$CURRENT_AGENT_DENYLIST"
printf 'approved  STATE_DAEMON_AGENT_ALLOWLIST=<unset>\n'
printf 'approved  STATE_DAEMON_AGENT_DENYLIST=%s\n' "$APPROVED_AGENT_DENYLIST"

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
SELECT agent_id, status, runtime, (metadata->>'tmux_session') AS tmux_session,
       last_seen_at
  FROM agents
  WHERE agent_id IN ('auditor','codex-audit','codex-aun','codex-cto')
  ORDER BY agent_id;
COMMIT;"
```

Pass criteria:

- installed plist values match the desired values above, or every mismatch is
  recorded as pending CTO-approved restart-window mutation
- `STATE_DAEMON_AGENT_ALLOWLIST` is absent/empty in the production profile
- L1 `auditor` and L2 `codex-audit` are enabled DB agents and absent from
  `STATE_DAEMON_AGENT_DENYLIST`, unless the PR audit routing policy was
  explicitly changed in the same reviewed release
- pending audit rows are accounted for; no row is stranded only because its
  `agent_id` is denied or marked inactive
- focused tests and build pass
- installed service status is recorded before restart
- installed plist preflight passes, including existing `ProgramArguments[1]`,
  existing `WorkingDirectory`, and no unowned `/tmp` / `/private/tmp` target
- `STALE_DISPATCH:%` count since #431 merge is zero or explicitly explained
- active `received` / `in_progress` rows are not terminal-closed by age
- `state_daemon_state_actions_total`, `state_daemon_pg_notify_errors_total`, and
  `state_daemon_wake_actions_total` are present in code/tests

## CTO-Approved Restart Commands

Run this section only after CTO explicitly approves the restart and names the
approved `DATABASE_URL`, restore root, and checkout path.

```bash
CTO_APPROVED_STATE_DAEMON_COMMIT='<approved-main-merge-commit>'
APPROVED_RESTORE_ROOT="$HOME/.agent-comms/state-daemon/checkouts"
APPROVED_DATABASE_URL='postgresql:///agent_comms?host=/tmp'

bun scripts/state-daemon-launchagent.ts restore \
  --commit "$CTO_APPROVED_STATE_DAEMON_COMMIT" \
  --restore-root "$APPROVED_RESTORE_ROOT" \
  --database-url "$APPROVED_DATABASE_URL" \
  --execute

launchctl print "gui/$(id -u)/com.agent-comms.state-daemon"
tail -n 80 "$APPROVED_RESTORE_ROOT/$CTO_APPROVED_STATE_DAEMON_COMMIT/logs/state-daemon.out.log"
tail -n 80 "$APPROVED_RESTORE_ROOT/$CTO_APPROVED_STATE_DAEMON_COMMIT/logs/state-daemon.err.log"
```

The helper stages the plist to a temporary file in the LaunchAgents directory and
renames it only after checkout creation, dependency install, build verification,
and plist preflight pass. If any step fails, launchd is not loaded or
kickstarted.

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
PREVIOUS_STATE_DAEMON_COMMIT='<previous-known-good-main-commit>'
APPROVED_RESTORE_ROOT="$HOME/.agent-comms/state-daemon/checkouts"
PREVIOUS_DATABASE_URL='postgresql:///agent_comms?host=/tmp'

bun scripts/state-daemon-launchagent.ts restore \
  --commit "$PREVIOUS_STATE_DAEMON_COMMIT" \
  --restore-root "$APPROVED_RESTORE_ROOT" \
  --database-url "$PREVIOUS_DATABASE_URL" \
  --execute
```

Do not manually update `message_queue` rows during rollback unless CTO provides
exact row IDs and SQL.

## Restore Checkout Prune

Prune is dry-run by default and protects any checkout referenced by the active
`com.agent-comms.state-daemon` LaunchAgent. Do not use generic `git worktree
prune` or `rm -rf ~/.agent-comms/state-daemon/checkouts/*` for this restore
root.

```bash
bun scripts/state-daemon-launchagent.ts prune \
  --restore-root "$HOME/.agent-comms/state-daemon/checkouts" \
  --keep 3 \
  --dry-run

bun scripts/state-daemon-launchagent.ts prune \
  --restore-root "$HOME/.agent-comms/state-daemon/checkouts" \
  --keep 3 \
  --execute
```

## Residual Risks

- `scripts/restart-bot.sh` syncs `.mcp.json` from bot registry during bot
  restart. That is expected for bot restart automation, but the first approved
  state_daemon restart smoke should avoid forcing a bot auto-restart unless CTO
  also approves that side effect.
- Existing active `in_progress` rows may remain open by design. #421 must not
  infer lifecycle closure; #426 owns lifecycle terminal semantics.
- If the installed launchd plist and operator shell use different DB URLs, the
  daemon may observe a different queue than manual verification.
