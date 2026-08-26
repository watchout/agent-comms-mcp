# AUN Fleet Readiness

Date: 2026-05-23

This runbook defines the operational meaning of "all bots can communicate
through AUN". It is intentionally stricter than "a Discord message appeared":
delivery is ready only when the DB queue, daemon wake path, bot reply, Discord
projection, and lifecycle close are all accounted for.

## Readiness Gates

An agent is AUN communication-ready when all of these are true:

1. `agents.agent_id` is the canonical identity.
2. `channels.members` contains at least one channel for the agent.
3. `agents.metadata->>'tmux_session'` or a runtime record identifies the local
   runtime.
- (retired) STATE_DAEMON_AGENT_DENYLIST: 存在してはならない。残存は readiness が STATE_DAEMON_AGENT_DENYLIST_RETIRED blocker として検出する
5. `agents.status` is active (`idle`, `busy`, or `online`) rather than
   `disabled`, `offline`, or `retired`.
6. A smoke from `codex-aun` reaches the target, the target replies with the
   expected ACK, and the target request queue reaches a terminal state.
7. The ACK is visible either as a `codex-aun` queue row or as an
   `agent_messages` row linked by `replied_with`.

## Current Fleet Classes

### Ready Now

These agents are ready after the 2026-05-23 AUN send/receive smoke and PR #520
live state_daemon reload. `codex-aun` is the sender/operator identity; the other
rows were direct smoke targets.

| Agent | Primary channel | Result |
|---|---|---|
| `adf-lead` | `ai-dev-framework` | ACK seen, request terminal |
| `agent-com-dev` | `agent-com` | ACK seen, request terminal |
| `agent-mem-dev` | `agent-mem` | ACK seen, request terminal |
| `auditor` | `agent-com` | ACK seen, request terminal |
| `codex-audit` | `agent-com` | ACK seen, request terminal |
| `codex-aun` | `agent-com` | active queue drained after smoke |
| `codex-cto` | `agent-com` | ACK seen, request terminal |
| `haishin-dev` | `haishin-puls-hub` | ACK seen, request terminal |
| `hotel-dev` | `hotel-kanri` | ACK seen, request terminal |
| `lead-sus` | `hotel-kanri` | ACK seen, request terminal |
| `lead-tuk` | `agent-mem` | ACK seen through `replied_with`, request terminal |
| `nyusatsu-dev` | `nyusatsu` | ACK seen, request terminal |
| `org-build-dev` | `org-build` | ACK seen, request terminal |
| `upwork-dev` | `upwork-automation` | ACK seen, request terminal |
| `vice` | `ceo-vice` | ACK seen, request terminal |
| `wbs-dev` | `wbs` | ACK seen, request terminal |
| `webb-dev` | `iyasaka-hplp` | ACK seen, request terminal |
| `xmarketing-dev` | `x-marketing-engine` | ACK seen, request terminal |

### Activation Candidates

These agents are not ready because they are offline or lack complete runtime
metadata. Do not count them as failed AUN delivery until they are explicitly
activated.

| Agent | Current evidence | Required action |
|---|---|---|
| `arc` | in many channels, has `discord-arc`, DB status `offline` | operator-approved context-preserving activation, then smoke |
| `lead-ama` | channel member, DB status `offline`, no registry entry, no tmux metadata | decide revive vs retire; if revived, add registry/runtime metadata first |
| `research-lead` | registry entry and approvals channel, DB status `offline` | operator-approved restart/activation, then smoke |
| `secretary` | registry entry and secretary channels, DB status `offline` | operator-approved restart/activation, then smoke |

### Excluded By Policy

These identities must not be auto-woken by state_daemon. They are human,
legacy, disabled, test-only, unknown, or duplicate identities.

```text
adf-dev,arc-test,auditor-test,ceo,codex-test,cto,cto-test,cto-test2,
dev-001,hotfix-test,iyasaka-arc,test,test-probe,unknown
```

If any excluded identity becomes real production scope, remove it from the
denylist in a reviewed PR, update channel membership/runtime metadata, reload
state_daemon, and smoke it explicitly.

## Post-Smoke Cleanup Rule

A successful reply is not enough. The receiver must also close its own request
queue row. During the 2026-05-23 smoke, several TUI bots replied but left their
request rows `in_progress`; those rows were closed only after ACK evidence was
verified. That cleanup is acceptable for a canary, but production operation
requires every bot to call `done` after a final reply.

Next implementation target:

```text
reply success -> request queue final close -> sender-visible ACK evidence
```

This should be enforced in the bot instructions or runtime wrapper before the
fleet is treated as fully autonomous.

## Verification Queries

Scripted report:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts fleet readiness \
  --format text \

  --smoke-run-id 20260523T160628 \
  --require-smoke
```

This report is read-only and classifies every agent as `ready`,
`activation_candidate`, or `excluded` from DB evidence. Use it before and after
any activation or smoke run so readiness decisions stay script-controlled.

For recovery or production restart approval, include the approved deployed
commit and checkout root. This makes the runtime-instance evidence fail closed
when a bot is on an unapproved path, an older or mismatched commit, a dirty
checkout, or only legacy tmux metadata:

```bash
APPROVED_COMMIT="$(git rev-parse HEAD)"
APPROVED_CHECKOUT_ROOT="$HOME/.agent-comms/state-daemon/checkouts"

DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts runtime inventory \
    --format json \
    --expected-commit "$APPROVED_COMMIT" \
    --approved-checkout-root "$APPROVED_CHECKOUT_ROOT" \
    > evidence/runtime-inventory.json

DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts fleet readiness \
    --format json \
    --approved-commit "$APPROVED_COMMIT" \
    --approved-checkout-root "$APPROVED_CHECKOUT_ROOT" \
    --drift-exclusion-file evidence/fleet-drift-exclusions.json \
    > evidence/fleet-readiness.json
```

`fleet-drift-exclusions.json` is optional. When used, each exclusion must be
bounded and auditable:

```json
{
  "exclusions": [
    {
      "target_agent": "agent-com-dev",
      "actor": "ceo",
      "reason": "approved maintenance window",
      "scope": "fleet_checkout_drift",
      "expires_at": "2026-06-08T12:00:00.000Z"
    }
  ]
}
```

Missing actor, reason, target, recognized scope, or future expiry is ignored.
An approved exclusion classifies the agent as `excluded`; it does not make the
agent ready.

Active queue check:

```sql
SELECT status, count(*)
  FROM message_queue
  WHERE status IN ('pending','received','in_progress')
  GROUP BY status
  ORDER BY status;
```

Current fleet view:

```sql
WITH channel_members AS (
  SELECT id AS channel_id, name AS channel_name, unnest(members) AS agent_id
    FROM channels
)
SELECT a.agent_id,
       a.status,
       a.runtime,
       a.metadata->>'tmux_session' AS tmux_session,
       count(cm.channel_id) AS channel_count,
       string_agg(cm.channel_name, ', ' ORDER BY cm.channel_name) AS channels
  FROM agents a
  LEFT JOIN channel_members cm USING (agent_id)
 GROUP BY a.agent_id
 ORDER BY a.agent_id;
```

Smoke evidence check:

```sql
WITH json_rows AS (
  SELECT id, agent_id, status, claimed_by, done_at, replied_at, replied_with,
         created_at, payload::jsonb AS p
    FROM message_queue
   WHERE payload LIKE '{%'
),
req AS (
  SELECT id, agent_id, status, claimed_by, done_at, replied_at, replied_with,
         p->>'content' AS content
    FROM json_rows
   WHERE p->>'content'
      LIKE 'AUN send/receive smoke 20260523T160628 for %. Please reply exactly: ACK-%-20260523T160628.%'
),
ack_queue AS (
  SELECT p->>'author_id' AS author_id, p->>'content' AS content,
         status, id, created_at
    FROM json_rows
   WHERE agent_id='codex-aun'
     AND p->>'content' LIKE '%ACK-%-20260523T160628%'
),
ack_msg AS (
  SELECT author_id, content, id, created_at
    FROM agent_messages
   WHERE content LIKE '%ACK-%-20260523T160628%'
)
SELECT req.agent_id,
       req.id AS request_queue_id,
       req.status AS request_status,
       CASE WHEN req.status IN ('done','replied','skipped')
            THEN 'terminal' ELSE 'active' END AS request_terminal,
       (SELECT ack_queue.status
          FROM ack_queue
         WHERE ack_queue.author_id=req.agent_id
           AND ack_queue.content LIKE '%' || 'ACK-' || req.agent_id || '-20260523T160628' || '%'
         ORDER BY ack_queue.created_at DESC
         LIMIT 1) AS codex_aun_ack_queue_status,
       EXISTS (
         SELECT 1
           FROM ack_msg
          WHERE ack_msg.author_id=req.agent_id
            AND ack_msg.content LIKE '%' || 'ACK-' || req.agent_id || '-20260523T160628' || '%'
       ) AS ack_agent_message_seen
  FROM req
 ORDER BY req.agent_id;
```
