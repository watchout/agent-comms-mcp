# AUN Routing Directory

Status: proposed
Date: 2026-05-14
Scope: design only

## Problem

Current routing knowledge is spread across DB rows, config files, Discord channel context, and human memory.

Examples:

- which channel should a review request use?
- who receives L1 review?
- who receives L2 audit?
- which agent is the CTO?
- which runtime identity should Codex use?
- which channel members are allowed to receive outbound messages?

This works while a small group remembers the mapping, but it is not good enough for UI management or for new runtime adapters.

## Goal

Create a single DB-backed Routing Directory that can later be managed by UI and read by CLI/MCP/runtime adapters.

The directory must answer:

```text
For this channel, which named route should I send to?
```

Examples:

```text
channel=agent-com, route=l1-review      -> lead-ama
channel=agent-com, route=l2-audit       -> auditor
channel=agent-com, route=architecture   -> arc
channel=agent-com, route=cto            -> cto
channel=agent-com, route=implementation -> agent-com-dev
channel=agent-com, route=codex-runtime  -> codex-aun
```

## Non-goals

- Do not add a DB migration in this PR.
- Do not replace the existing `channels.members` model yet.
- Do not change send/notify behavior yet.
- Do not build UI in this PR.
- Do not make Discord the source of truth.

## Source Of Truth

The DB should be the source of truth.

```text
DB:
  routing directory source of truth

CLI:
  operator access and scripting

MCP:
  runtime adapter lookup

UI:
  management surface

Discord/Telegram:
  display and notification destinations
```

## Proposed Concepts

### Channel

Existing `channels` table remains the logical channel registry.

Important fields:

```text
channels.id
channels.name
channels.members
```

### Agent

Existing `agents` table remains the agent registry.

Important fields:

```text
agents.agent_id
agents.display_name
agents.runtime
agents.status
```

### Route

A route is a named target inside a channel.

Proposed future table:

```sql
CREATE TABLE channel_routes (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  route_name TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  purpose TEXT,
  layer TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel_id, route_name)
);
```

Possible `layer` values:

```text
l1
l2
architecture
cto
implementation
runtime
ops
```

This table intentionally points to `target_agent_id`, not Discord IDs. Chat/UI adapters can resolve platform IDs later.

## Initial Directory Seed

Current known channel:

```text
name: agent-com
id: 1487368919613444156
```

Initial route entries:

| route_name | target_agent_id | layer | purpose |
|---|---|---|---|
| `l1-review` | `lead-ama` | `l1` | implementation review |
| `l2-audit` | `auditor` | `l2` | audit / risk review |
| `architecture` | `arc` | `architecture` | architecture decision |
| `cto` | `cto` | `cto` | technical decision / infra |
| `implementation` | `agent-com-dev` | `implementation` | implementation dispatch |
| `codex-runtime` | `codex-aun` | `runtime` | Codex runtime identity |

## CLI Contract

Future CLI commands:

```bash
agent-com routes list --channel agent-com
agent-com routes get --channel agent-com --route l1-review
agent-com routes add --channel agent-com --route l1-review --agent lead-ama
agent-com routes disable --channel agent-com --route l1-review
```

Future send/notify convenience:

```bash
agent-com notify \
  --channel agent-com \
  --route l1-review \
  --content "L1 review request: PR #368 ..."
```

This should resolve to:

```text
--mentions lead-ama
```

The resolved agent_id should still be logged in output.

## MCP Contract

Future MCP tools:

```text
aun.routes
aun.route_lookup
```

`aun.route_lookup` should accept:

```json
{
  "channel": "agent-com",
  "route": "l1-review"
}
```

and return:

```json
{
  "channel_id": "1487368919613444156",
  "route": "l1-review",
  "target_agent_id": "lead-ama",
  "enabled": true
}
```

Runtime adapters should use route lookup instead of hardcoding review targets.

## UI Contract

Future UI should expose a Channel Routing page:

```text
Channel
  Members
  Routes
  Review targets
  Runtime identities
  Platform adapter mappings
```

Required UI actions:

- list routes by channel
- add/update route target
- enable/disable route
- show whether target agent is a channel member
- show whether target agent is in outbound allowlist when that policy is active
- show linked platform adapter mapping for display delivery

## Safety Rules

1. A route target must be an `agents.agent_id`.
2. Route lookup must fail closed when the route is disabled or missing.
3. Route lookup must not bypass channel membership checks.
4. Route lookup must not bypass outbound allowlist checks.
5. A route name must never imply broadcast.
6. UI should display both route name and resolved target before saving.

## Rollout Plan

### PR 1: Design

This document only.

### PR 2: DB Migration And Seed

Add `channel_routes` and seed the current `agent-com` routes.

### PR 3: CLI Read Path

Add:

```text
agent-com routes list
agent-com routes get
```

No send/notify behavior change yet.

### PR 4: CLI Send/Notify Route Flag

Add:

```text
--route <route_name>
```

as a convenience that resolves to an explicit mention.

### PR 5: MCP Read Path

Add:

```text
aun.routes
aun.route_lookup
```

### PR 6: UI Management

Build the management screen.

## Decision

Adopt Routing Directory as the single future source of truth for channel-level named targets.

Do not continue relying on ad hoc lists in chat messages once the DB-backed directory exists.

