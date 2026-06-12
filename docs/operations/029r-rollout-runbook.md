# ADR-029R Rollout Runbook — single-daemon HTTP MCP + identity SSOT

> Scope: PR 5 of the ADR-029R chain. Execution requires protected review
> (audit + QA/check + CTO/security per frozen requirement 7). CEO direction
> is business approval; this runbook's evidence gates are the technical
> completion criteria. Nothing here is "done" without the DB/runtime
> evidence queries below returning the expected rows.

## 0. Preconditions

- [ ] PR 4 merged; canonical checkout deployed at
      `~/.agent-comms/state-daemon/checkouts/<sha>` with
      `~/.agent-comms/state-daemon/current` symlink updated.
- [ ] Daemon launchd unit for the HTTP MCP daemon runs from `current` with:
      `AGENT_COMMS_PORT=<port>`, `AGENT_COMMS_EXPERIMENTAL_HTTP_MCP=1`
      (identity mode defaults to `binding`; `spike-bot-id` must NOT be set).
- [ ] `/health` shows the expected `source.git_sha` (mechanical drift check):
      `curl -s localhost:<port>/health | jq .source`

## 1. Per-bot migration procedure (repeat per bot)

```
1. seed identity SSOT (dry-run first, then --execute):
   bun scripts/seed-workspace-identity.ts --agent-id <bot> --workspace <repo> --project <name> --execute
2. issue credential (plaintext printed ONCE):
   bun scripts/issue-http-mcp-token.ts --agent-id <bot>
3. generate client config snippets:
   bun scripts/generate-http-mcp-client-config.ts --agent-id <bot>
4. install: token env var into the bot's launch env (plist/run script);
   codex TOML block or claude .mcp.json entry from step 3.
5. REMOVE the bot's stdio spawn entry (server.ts command/args) in the same
   change — no silent dual-path (frozen requirement 4).
6. restart the bot session.
```

### Per-bot acceptance evidence (all three required)

```sql
-- a. identity binding recorded (frozen req 2)
SELECT detail FROM audit_log
 WHERE event_type='http_mcp.identity_bound' AND agent_id='<bot>'
 ORDER BY created_at DESC LIMIT 1;

-- b. live session visible with timestamps (frozen req 5)
--    curl -s localhost:<port>/health | jq '.http_mcp.sessions[] | select(.bot_id=="<bot>")'

-- c. end-to-end delivery: send a real message to the bot, then
SELECT id, status, claimed_by, read_at, claimed_at, replied_at
  FROM message_queue WHERE agent_id='<bot>' ORDER BY created_at DESC LIMIT 1;
-- pending → received(claimed_by=<bot>) → in_progress → done/replied.
-- A pending row, an ACK, or Discord visibility is NOT delivery evidence.
```

## 2. Canary stage (gate before any expansion)

- Canary bots: **two low-risk bots, one per runtime family** — recommended:
  `secretary` (Claude runtime) and `research-lead` (Codex runtime).
  Rationale: no merge-gate or audit-chain duties; outages do not block
  governance.
- Run §1 for both. Soak: canary bots must process **at least 3 real queue
  items each** through the full lifecycle with §1 evidence, and survive
  **one daemon restart** (sessions re-established, no stale duplicates —
  verify via /health sessions and a post-restart claim).
- Record the evidence (queue ids, audit_log ids, /health snapshots) as a
  comment on issue #722 before requesting expansion review.

## 3. Expansion (only after canary review passes)

- Protected review of canary evidence: audit + QA/check + CTO/security.
- Then migrate remaining bots in batches of 3-5 per §1, checking the
  per-bot evidence each time. Bots with special roles (auditors, cto)
  migrate LAST so the review chain stays operational throughout.
- After each batch: `ps aux | grep server.ts` — the stdio spawn count must
  shrink by exactly the batch size; any survivor is a missed step-5.

## 4. Completion criteria (fleet)

- [ ] stdio `server.ts` spawn count = 0 across the host (`ps` sweep).
- [ ] Every active bot has: active binding row, active bearer key,
      `http_mcp.identity_bound` evidence, live `/health` session.
- [ ] Global config layers carry NO identity values
      (`grep AGENT_ID ~/.codex/config.toml` → only per-project/explicit).
- [ ] Drift check green: `/health source.git_sha` == deployed checkout sha.

## 5. Rollback

Per-bot (preferred — bots are independent):
```
1. restore the bot's previous stdio config from its timestamped backup
   (*.bak-unify-* / *.bak-identity-*)
2. restart the bot session
3. revoke the bot's bearer key:
   UPDATE agent_identity_keys SET status='revoked', revoked_at=now()
    WHERE agent_id='<bot>' AND key_type='bearer-sha256' AND status='active';
```

Daemon-level (multiple bots affected):
```
1. flip ~/.agent-comms/state-daemon/current symlink to the prior checkout
2. launchctl kickstart -k the daemon unit
3. clients auto-reconnect (Spike B evidence); verify /health sessions
4. queue rows are never deleted — recovery is queue_id-scoped reclaim only
```

## 6. Emergency stdio fallback discipline (frozen requirement 4)

stdio spawn may be re-enabled for a bot ONLY:
- with an explicit operator marker in its env:
  `AGENT_ID_OVERRIDE_REASON="<incident ref>" AGENT_ID_OVERRIDE_ACTOR="<who>"`
  (the resolver logs the override; unmarked AGENT_ID fails closed),
- time-boxed: the same incident record must contain the planned end, and
- logged: an audit_log row / #722-thread comment at enable AND at disable.

No silent reintroduction of per-bot `DISCORD_BOT_TOKEN` + `server.ts` spawn
as normal mode. Discord connections remain daemon-only.

## 7. Known follow-ups outside this rollout

- OAuth 2.1 / PKCE subject binding replaces bearer keys (ADR-029R §5
  Phase 2 final form; bearer binding is the accepted bridge).
- agent-memory (`wasurezu`) identity unification via the shared resolver
  (cross-repo; global `AGENT_MEMORY_AGENT_ID` default removal) — issue #733.
- Queue-work debts #730/#731/#732 before broader scheduler rollout.
