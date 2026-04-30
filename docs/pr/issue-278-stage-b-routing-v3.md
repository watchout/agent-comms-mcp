# Issue #278 — routing v3 Stage B (per-row claim + auto-pull + watchdog)

> **Route label: `route:ceo-approval`** — DB schema migration + architectural shift. CEO 明示承認が merge 条件です。

Closes the §A-G scope of [Issue #278](https://github.com/watchout/agent-comms-mcp/issues/278). Replaces the legacy single-slot in-flight pointer (`agents.current_message_id`) with a per-row claim model on `message_queue`, lands the CEO-bypass routing tweak, ships the auto-pull SessionStart hook + Stop-hook v8 with retry-limit-reached escalation, and hands operational supervision to launchd via the watchdog daemon. Closes related Issues #272 / #273 / #274 / #268 / #178 structurally; honours CEO directive *「query をするところまで script で強制」*.

## Component map

| Component | Spec | Commits | Tests |
|---|---|---|---|
| **A. Per-row claim model** | §1 / §A | `6dbd48f` `52f3ee0` `34c34c2` `09f381f` `8082d0a` `c440727` `7279cb1` `ccedc40` (segments 1 → 3d + hotfix) | `test_claim_ttl_implicit_abandon` (case 2), behavioral-spec-alignment B1/B2/B4, message-queue-phase2 T1/T4/T5, send-push-path T4, cli-fail-skip-reclaim T2/T3/T4, cli-sqlite-backend F2/F3/F4, **`test_routing_v3_stage_b_e2e` (case 1, case 5, case 5b)** |
| **B. CEO bypass routing** | §B | `3b604ed` | `inbound-mentions-filter` (case 4 + 4 behavioral cases) |
| **C. Stop hook v8 + G-3 escalation** | §C / §G-3 | `612f345` | `test_claim_close_enforcement` (case 6a/6b/6c, case 17, dedupe) |
| **E. Watchdog auto-restart + G-1 launchd** | §E / §G-1 | `d3a66b5` | `test_watchdog` (case 7/7b/7c + system-exclusion + rate-limit + window-slide) |
| **F. Auto-pull (SessionStart + role differential + auto-skip share)** | §F-1..F-4 | `fd6ae34` `f5f009e` `2306885` `4f34862` | `test_session_start_drain` (case 10 / 12 / 13 / 14 + env override + role differentials), `test_drain_with_auto_skip` (helper unit, 6 cases) |
| **G-2. Paired up/down migration framework** | §G-2 | `52f3ee0` (framework) + new paired files for Stage B | **`test_migration_up_down_up_idempotent` (case 16, both pairs reversible + idempotent)** |

Total: **17 commits**, **+~2,500 / -~250** LOC across `core/` `server.ts` `cli/index.ts` `hooks/` `bin/` `infra/launchd/` `db/migrations/` and 11 test files.

## Test summary

```
DATABASE_URL=postgresql://yuji@localhost:5432/agent_comms bun test tests/
→ 717 pass / 19 skip / 0 fail (+41 new cases since main)
```

The `19 skip` rows are environment-gated (`describe.skip` when `DATABASE_URL` is unset) and are exercised whenever the DB is reachable — so the 717 is the canonical figure for CI / merge gate evaluation.

### Smoke evidence (dogfooded, not just unit-level)

- **F-1 SessionStart drain** — 4 seeded pending rows; 1 plain chat + 3 noise (lead-ama-warning, system_info type, self-echo) → `drained=4 skipped=3 unmatched=1`, only the chat row remained pending for the LLM turn.
- **§C Stop hook v8** — 4 Stop iterations on a seeded open claim → exit 2 / 2 / 2 / 0; bypass log line written, audit_log row inserted, CEO notify subprocess invoked exactly once (dedupe sentinel).
- **§E Watchdog** — `AUN_WATCHDOG_DRY_RUN=1` smoke detected `ceo` (last_seen NULL / status='online') and `arc` (last_seen 2 days old / status='idle'), logged `outcome=dry_run` for both, no tmux side effects, no audit rows persisted past cleanup.
- **§G-2 paired migrations** — `up → down → up → up` on both Stage B pairs; column / index state matches the post-up shape after every cycle, re-up is a no-op (idempotent).

## Migration & rollout

1. Merge with CEO ceo-approval. **`route:ceo-approval`** route label set on this PR.
2. Coordinated fleet restart so every bot loads the new code (`server.ts` + `cli/index.ts` are no-op-on-old-DB; new code does not read `current_message_id`).
3. Run the paired drop manually:
   ```
   bun db/migrate.ts --up=db/migrations/2026-04-30-stage-b-drop-current-message-id.up.sql
   ```
   Rollback path: `--down=` on the same path. The bootstrap migrate.ts intentionally only ADDs the column (hotfix `ccedc40`, lead-ama incident memo `feedback_no_auto_drop_in_bootstrap_migrate.md`).
4. Install the launchd plists on the operator workstation:
   ```
   cp infra/launchd/com.aun.{watchdog,heartbeat}.plist ~/Library/LaunchAgents/
   launchctl load -w ~/Library/LaunchAgents/com.aun.watchdog.plist
   launchctl load -w ~/Library/LaunchAgents/com.aun.heartbeat.plist
   ```
   Update `WorkingDirectory` / `DATABASE_URL` blocks in the plists before loading.
5. Wire the new hooks into each bot's `.claude/settings.json`:
   - `SessionStart` → `hooks/aun-session-start-drain.sh`
   - `Stop`         → `hooks/aun-claim-close-enforcement.sh`

## 24h pilot (post-merge)

Per Issue #278 §検証 plan, run on CTO bot for 24 h and confirm:

- `pending` ≤ 10 常態。
- `oldest_pending_at` 1 h 以内。
- `IMPLICIT_ABANDON` 件数 ≤ 5 / day。
- `bot_status crashed` 偽陽性 0 件。
- `bot.auto_restart` audit_log で復旧成功 ≥ 1 件 (本 issue の発端 #178 / #274 を吸収する想定).

## Closes / structurally resolves

- Closes #272 (2-path bloat) — `uq_mq_agent_message` UNIQUE INDEX に統合。
- Closes #273 (drain SLA) — Component F + Stop hook v8 で構造解消。
- Closes #274 (stale code) — Watchdog で構造解消。
- Closes #268 (TUI 応答強制) — Stop hook v8 で統合。
- Closes #178 (initializing stuck) — Watchdog で構造解消。

## Test plan (reviewer checklist)

- [ ] `DATABASE_URL=...` `bun test tests/` → 717 pass / 19 skip / 0 fail
- [ ] `bun test tests/contract/test_routing_v3_stage_b_e2e.test.ts` (case 1 / 5)
- [ ] `bun test tests/contract/test_migration_up_down_up_idempotent.test.ts` (case 16 both pairs)
- [ ] `bun test tests/contract/test_claim_close_enforcement.test.ts` (case 6 / 17)
- [ ] `bun test tests/contract/test_watchdog.test.ts` (case 7)
- [ ] `bun test tests/contract/test_session_start_drain.test.ts` (case 10 / 12 / 13 / 14)
- [ ] Manual: `AUN_WATCHDOG_DRY_RUN=1 bun bin/aun-watchdog.ts` reports the expected stale-bot list with no side effects.
- [ ] Manual: SessionStart hook on a freshly seeded queue produces the documented `drained=N skipped=M unmatched=K` line.
