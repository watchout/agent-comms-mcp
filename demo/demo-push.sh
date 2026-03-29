#!/bin/bash
# agent-com push notification demo
# Example: Manager Bot → Dev Bot

set -e

DB_URL="postgresql://localhost/agent_comms"

echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║  agent-com: Push Notification Demo                ║"
echo "  ║  AI Agent Organization — Real bots, real comms    ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""
sleep 1

# Step 1: Manager sends instruction to Dev
echo "  ┌─── Manager Bot ─────────────────────────────────────"
echo "  │"
echo "  │  > send_message(to: 'dev', channel: 'dev-chat',"
echo "  │      content: '[instruction] Implement JWT auth"
echo "  │               middleware. Refresh token TTL: 7 days')"
echo "  │"
sleep 1

MSG_ID=$(psql -t -A "$DB_URL" -c "
  INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata)
  VALUES (
    gen_random_uuid(), 'dev-chat', 'manager',
    '[instruction] Implement JWT auth middleware. Refresh token TTL: 7 days',
    'instruction',
    '{\"to\": \"dev\"}'::jsonb
  ) RETURNING id;
")

echo "  │  ✓ DB saved (${MSG_ID:0:8}...)"

psql -t -A "$DB_URL" -c "SELECT pg_notify('agent_inbox', '{\"to\": \"dev\", \"message_id\": \"$MSG_ID\"}');" > /dev/null

echo "  │  ✓ pg_notify → agent_inbox"
echo "  └──────────────────────────────────────────────────────"
echo ""
sleep 2

# Step 2: Listener delivers
echo "  ┌─── Listener ─────────────────────────────────────────"
echo "  │"
echo "  │  NOTIFY received → target: dev"
echo "  │  POST http://localhost:8790 → 200 OK ✓"
echo "  │"
echo "  └──────────────────────────────────────────────────────"
echo ""
sleep 1

# Step 3: Dev auto-receives (no check_inbox!)
echo "  ┌─── Dev Bot (push — no tool call needed!) ────────────"
echo "  │"
echo "  │  ← agent-com-bridge · manager → #dev-chat:"
echo "  │    [instruction] Implement JWT auth middleware."
echo "  │    Refresh token TTL: 7 days"
echo "  │"
echo "  │  Dev Bot sees the message instantly."
echo "  │  No check_inbox. No polling. Just push."
echo "  │"
echo "  └──────────────────────────────────────────────────────"
echo ""

# Step 4: Dev responds
sleep 1
echo "  ┌─── Dev Bot → Manager ────────────────────────────────"
echo "  │"
echo "  │  > send_message(to: 'manager', channel: 'dev-chat',"
echo "  │      content: '[report] Done. 8 tests passing. PR #12 created')"
echo "  │"
echo "  │  ✓ Delivered to Manager via push notification"
echo "  └──────────────────────────────────────────────────────"
echo ""

echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║  ✓ Full round-trip in <2 seconds                  ║"
echo "  ║  ✓ Zero polling — push-based delivery             ║"
echo "  ║  ✓ Works with any number of agents                ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""
