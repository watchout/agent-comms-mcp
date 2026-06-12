# ADR-029R Spike B + C — Result (2026-06-13)

> Verdict: **GO** — daemon restart/reconnect behavior and the end-to-end DB
> queue canary both pass with full evidence, executed over the experimental
> Streamable HTTP endpoint against real Postgres with the REAL tools.
> Per ARC ACK this is spike evidence, not fleet rollout approval.

Tests: `tests/contract/test_http_mcp_restart_canary.test.ts` — 3/3 pass (CI-safe).

## Spike B — restart / reconnect

| ARC acceptance item | result |
|---|---|
| same bot_id reconnect closes/replaces prior connection deterministically | ✅ second initialize for the same bot closes the first session server-side (`http_mcp.session_replaced` log); a request with the old `mcp-session-id` is rejected 400 |
| restart with ≥2 bots connected: clients recover without stale duplicate sessions | ✅ two bots connected → SIGTERM → reboot → old session ids rejected 400 → both bots establish fresh sessions and operate; per-bot session map guarantees ≤1 live session per bot |
| restart loses no pending queue rows (frozen req 6) | ✅ row seeded pre-restart is still `pending` and claimable post-restart (queue state lives in Postgres, not in the process) |
| no duplicate Discord/native adapter ownership after reconnect | ✅ structurally: the `/mcp` path creates no Discord clients at all; adapter ownership is daemon-side per #722 DB-primary design (nothing to duplicate). Recorded as design property, re-verified at implementation PR 4 health work |
| health degraded → ok with timestamps | partial: `/health` returns ok through restart; per-session/per-bot delivery health states are implementation PR 4 scope (ARC prerequisite 2 + frozen req 5) — recorded as a tracked gap, not silently skipped |

Client-side auto-reconnect (exponential backoff) is documented Claude Code
behavior and SDK-level reconnection was exercised here as
new-initialize-after-failure; long-lived interactive client reconnect gets
re-verified during the PR 5 canary on live bots.

## Spike C — end-to-end DB queue canary (real tools, full evidence chain)

Flow executed entirely over HTTP MCP with the real tools:

```
A notify(channel, mention B)            → agent_messages row (message_id)
                                          message_queue row for B: status=pending   ← NOT delivery evidence
B next                                  → status=received, claimed_by=B,
                                          read_at set, claimed_at set              ← claim evidence captured here
B processing(queue_id)                  → status=in_progress
B send(reply_to=message_id, mention A)  → original row: status=replied,
                                          replied_at set, replied_with=<reply id>
reply message                           → A's queue: new pending row exists
                                          (correct target identity)
```

All ARC-required evidence fields asserted: message_queue id, message_id,
target agent_id, status transitions, claimed_by, read_at / claimed_at /
replied_at, replied_with. Note: reply finalization clears the claim columns
by design, so `claimed_by` is asserted at claim time, not terminal state.

Channel ACL is enforced on the path (notify without a
`channel_routing_policy.outbound_allowlist` entry fails closed with
`OUTBOUND_ACL_VIOLATION` — observed during fixture development; the canary
seeds an explicit allowlist).

## Gaps carried to implementation PR 4 (tracked, per ARC)

1. Per-bot delivery health states (process healthy / MCP connected / queue
   claim working / end-to-end delivery working) + source identity in health.
2. Phase 1 identity resolver + the 5 fail-closed negative cases (replaces
   the spike-only `bot_id` query identity).
3. Streamable HTTP as a first-class production transport (auth-subject
   binding, OAuth; bearer-only in spikes).
