# State Daemon Restart Checklist

Formal `state_daemon` restart is blocked until #421 is complete and CTO
explicitly approves the restart. This checklist is a preflight record only.
Use `docs/operations/state-daemon-restart-readiness-runbook.md` for the
blocker-resolution commands, approved restart commands, smoke, and rollback.

## Preconditions

- #421 implementation PRs are merged and audited with L1/L2 evidence.
- #420 close semantics are deployed: ACK/progress uses `--no-close`, final
  completion uses explicit `--close` with `queue_id` / `message_id`.
- #426 request lifecycle boundaries are preserved: AUN owns communication
  completeness; Shirube owns broader work/project management.
- No pending production DB, launchd, bot-registry, or runtime identity mutation
  is bundled into the restart step.

## Preflight Checks

- Confirm `origin/main` includes the latest #421 merge commit.
- Confirm the installed launchd `DATABASE_URL` matches the CTO-approved
  production DB URL.
- Confirm launchd points at a clean approved checkout, not a dirty developer
  working tree.
- Confirm `STATE_DAEMON_AGENT_ALLOWLIST` is absent/empty. Production rollout is
  DB-driven; allowlist is only an emergency narrowing override.
- Confirm `STATE_DAEMON_AGENT_DENYLIST` excludes disabled/test/human identities
  only, and does not include current PR audit recipients: `auditor` for L1 and
  `codex-audit` for L2.
- Confirm the daemon restart launcher path resolves to
  `scripts/restart-bot.sh`.
- Run focused tests:
  - Use an isolated PostgreSQL database, not the live `agent_comms` database.
    A running production `state_daemon` scans DB-primary queue rows and can
    wake or mutate `sd-test-*` fixture rows in the shared DB, producing false
    failures and non-representative evidence.
  - `DATABASE_URL='postgresql:///<isolated_test_db>?host=/tmp' bun test tests/contract/state-daemon/test_state_action_matrix.test.ts tests/contract/state-daemon/m2-sweep.test.ts tests/contract/state-daemon/test_per_bot_suppression.test.ts`
  - `bun build --target bun bin/state-daemon.ts --outfile /tmp/state-daemon-build.js`
- Check recent queue failures:
  - no new `STALE_DISPATCH:%` failures in the target observation window
  - no active `received` / `in_progress` row is being terminal-closed by age
  - no `auditor` / `codex-audit` queue row is stranded only because its
    recipient is denied or marked inactive
- Confirm state/action metrics are available:
  - `state_daemon_state_actions_total{action,status,terminal}`
  - `state_daemon_pg_notify_errors_total`
  - existing `state_daemon_wake_actions_total`

## Restart Procedure

Do not run this section without explicit CTO approval.

1. Record current running daemon process, working directory, and commit.
2. Stop the old daemon through the approved supervisor path.
3. Start the daemon from the approved checkout at the approved `main` commit.
4. Confirm the daemon logs `started` and remains alive past one sweep interval.
5. Run an AUN smoke:
   - create a DB-primary queue item
   - receive with the target `AGENT_ID`
   - ACK/progress with `--no-close`
   - final close with `--close --queue-id --message-id`
6. Confirm the smoke queue is terminal only after final close.
7. Confirm no unrelated production config or bot registry files changed.

## Rollback

- Stop the new daemon through the approved supervisor path.
- Restart the previous known-good daemon commit.
- Do not mutate queue rows manually unless CTO separately approves a DB repair
  operation with exact row IDs and SQL.

## Non-Goals

- This checklist does not authorize production restart.
- This checklist does not define request lifecycle semantics beyond #420 close
  intent. #426 owns lifecycle transitions such as `ack`, `needs_info`,
  `result`, `close`, and `cancel`.
