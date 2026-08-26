# Memory-ready fleet refresher

The production refresher is repository-owned at
`scripts/operator/memory-ready-refresh.ts`. It covers every enabled
`idle`/`busy` seat,  and continues after a
per-seat failure. It never invokes a provider or sends a Discord message.

## Dry-run

Use an explicit PostgreSQL URL. The command refuses an absent URL instead of
falling back to SQLite.

```sh
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
bun scripts/operator/memory-ready-refresh.ts --dry-run
```

The report must satisfy `summary.terminal_results == summary.inventory`.
`summary.ready == summary.eligible` is the readiness target. A failed seat is a
typed repair signal and does not prevent later seats from being evaluated.

## Runtime identity monitor

Use the read-only monitor to count registration-profile drift, mismatched live
instances de-prioritized behind an exact live instance, and evidence still
bound to a superseded runtime instance. It opens an explicit read-only
transaction and requires a PostgreSQL URL.

```sh
bun scripts/operator/memory-ready-identity-monitor.ts \
  --database-url 'postgresql:///agent_comms?host=/tmp'
```

`REGISTRATION_PROFILE_MISMATCH` means a live instance exists but its recorded
session or checkout is inconsistent with the registered seat profile. A sole
live mismatched instance remains current instead of becoming a silent permanent
block; the runtime heartbeat must correct its registration from
`agents.home_directory` / `agents.metadata.tmux_session` and record
`registration_metadata_provenance`. `PROFILE_MISMATCH_DEPRIORITIZED` means an
exact live instance exists and the mismatched competitor ranked below it. The
monitor never quarantines, stops, reaps, or deletes either row.
`SUPERSEDED_EVIDENCE_BINDING` means the common resolver selected a live exact
profile runtime while the latest evidence still names another instance.
Ordinary runtime heartbeats repair the latter through the single-seat
refresher, and state-daemon startup runs the same idempotent reconciliation once
to cover rotations that predate deployment.

## Render and install the LaunchAgent

The retired STATE_DAEMON_AGENT_DENYLIST is no longer read or rendered; seat
inventory exclusion is DB-only (profile_enabled, disabled_at, agent_type).
changes. Render from a merged, governed checkout and inspect the digest before
installing.

```sh
bun scripts/operator/memory-ready-refresh-launchagent.ts render \
  --repo-root /Users/yuji/Developer/agent-comms-mcp \
  --database-url 'postgresql:///agent_comms?host=/tmp' \

bun scripts/operator/memory-ready-refresh-launchagent.ts install \
  --repo-root /Users/yuji/Developer/agent-comms-mcp \
  --database-url 'postgresql:///agent_comms?host=/tmp' \
  --execute

plutil -lint ~/Library/LaunchAgents/com.agent-comms.operator.memory-ready-refresh.plist
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.agent-comms.operator.memory-ready-refresh.plist 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.agent-comms.operator.memory-ready-refresh.plist
launchctl kickstart -k "gui/$(id -u)/com.agent-comms.operator.memory-ready-refresh"
```

Publish the template path/digest, installed plist digest, exact unchanged
batch report and launchctl status. `install --execute`
preserves an existing plist at the returned `rollback_path` and reports its
digest. Rollback is to copy that saved plist back and repeat
`bootout`/`bootstrap`; keep it until effect verification is complete.
