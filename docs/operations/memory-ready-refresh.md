# Memory-ready fleet refresher

The production refresher is repository-owned at
`scripts/operator/memory-ready-refresh.ts`. It covers every enabled
`idle`/`busy` seat, reports denylisted seats explicitly, and continues after a
per-seat failure. It never invokes a provider or sends a Discord message.

## Dry-run

Use an explicit PostgreSQL URL. The command refuses an absent URL instead of
falling back to SQLite.

```sh
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
STATE_DAEMON_AGENT_DENYLIST='<current exact value>' \
bun scripts/operator/memory-ready-refresh.ts --dry-run
```

The report must satisfy `summary.terminal_results == summary.inventory`.
`summary.ready == summary.eligible` is the readiness target. A failed seat is a
typed repair signal and does not prevent later seats from being evaluated.

## Render and install the LaunchAgent

First read `STATE_DAEMON_AGENT_DENYLIST` from the installed state-daemon plist.
Pass that exact value to the renderer; SD-C2a does not authorize denylist
changes. Render from a merged, governed checkout and inspect the digest before
installing.

```sh
bun scripts/operator/memory-ready-refresh-launchagent.ts render \
  --repo-root /Users/yuji/Developer/agent-comms-mcp \
  --database-url 'postgresql:///agent_comms?host=/tmp' \
  --denylist '<current exact state-daemon value>'

bun scripts/operator/memory-ready-refresh-launchagent.ts install \
  --repo-root /Users/yuji/Developer/agent-comms-mcp \
  --database-url 'postgresql:///agent_comms?host=/tmp' \
  --denylist '<current exact state-daemon value>' \
  --execute

plutil -lint ~/Library/LaunchAgents/com.agent-comms.operator.memory-ready-refresh.plist
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.agent-comms.operator.memory-ready-refresh.plist 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.agent-comms.operator.memory-ready-refresh.plist
launchctl kickstart -k "gui/$(id -u)/com.agent-comms.operator.memory-ready-refresh"
```

Publish the template path/digest, installed plist digest, exact unchanged
denylist readback, batch report, and launchctl status. `install --execute`
preserves an existing plist at the returned `rollback_path` and reports its
digest. Rollback is to copy that saved plist back and repeat
`bootout`/`bootstrap`; keep it until effect verification is complete.
