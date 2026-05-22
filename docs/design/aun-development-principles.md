# AUN Development Principles

Date: 2026-05-22

## Purpose

These principles are the default decision gate for AUN design and
implementation work.

AUN may use Discord, tmux, local scripts, Codex, Claude Code, or future remote
runtimes during rollout, but the product being built is a durable control plane
for LLM agents. Near-term internal stability work must stay on the same path as
the long-term enterprise design.

## Non-Negotiable Principles

### 1. Control Plane First

Core AUN concepts are provider-neutral:

- `agent_id`
- runtime instance
- connector instance
- channel binding
- queue row
- control-plane lease
- projection identity
- audit evidence

Discord, Slack, Streamable HTTP, stdio, webhooks, and future transports are
adapters or projections. They must not become core routing identity.

### 2. Database Is The Durable Source Of Truth

The database stores intent, queue state, identity, policy, leases, and audit
evidence. Chat UI state is useful operator feedback, but it is not the source of
truth for completion, delivery, identity, or authorization.

Decision order:

1. DB rows and constraints
2. deterministic command output
3. CI / GitHub state
4. provider delivery evidence
5. human-readable chat or LLM prose

The last item can explain a decision; it cannot prove the decision by itself.

### 3. State Transitions Are Script-Controlled

Queue and lifecycle transitions must be performed by deterministic code:

- CLI commands
- hooks
- runner code
- state-daemon actions
- database transactions

LLMs may produce plans, summaries, and runtime results, but they must not be the
authority that decides how to claim work, close work, reassign work, or mutate
control-plane state. If an LLM result affects state, a script must validate and
apply it through a typed contract.

### 4. Evidence-Based Completion

Work is complete only when durable evidence exists.

Examples of acceptable evidence:

- `message_queue` row status and close metadata
- `agent_messages` event or reply row
- `outbound_queue` terminal `sent` or `failed` state
- `audit_log` or explicit PR evidence comment
- CI run id and result
- GitHub PR state from GitHub as SSOT
- control-plane lease row with holder, fencing token, heartbeat, and terminal
  state

Examples that are not sufficient alone:

- Discord message appeared in a channel
- an LLM says it is done
- a tmux pane shows output
- a local process exists
- a path or directory name implies identity

### 5. No Implicit Trust

Local path, tmux session name, Discord identity, environment variables, and
model name are runtime evidence only. They are not trusted identity or policy.

Trusted actions must flow through explicit records:

- agent identity
- runtime instance
- connector instance
- endpoint or key
- channel membership and routing policy
- control-plane lease
- audit evidence

This keeps local-only operation useful while preserving the path to
zero-trust, multi-tenant, externally hosted deployments.

### 6. Distributed Without A Post Office

AUN should not rely on one universal router process that receives and forwards
everything. Workers should run the same code, advertise capabilities through DB
state, and directly claim eligible work through leases and row-level queue
claims.

Use a central database as the coordination layer, not a central runtime process
as the bottleneck.

### 7. Additive First, Reversible When Possible

Internal stabilization must not create later enterprise rewrites.

Default schema posture:

- additive columns and tables first
- nullable opt-in references for migrations
- explicit constraints for new invariants
- paired rollback artifacts for operational migrations
- legacy compatibility until the fleet is safely moved

Provider-specific acceleration is acceptable only when it enters through
adapter tables, connector bindings, or projection metadata.

### 8. Observability Is A Product Requirement

Every production-grade action should be diagnosable without reading chat
history. New runtime or connector work should expose enough structured state for:

- who owns the work
- what is waiting
- what was claimed
- what lease is active
- what failed and why
- what evidence allows merge, close, retry, or rollback

Future public surfaces should align with OpenTelemetry-style telemetry and
CloudEvents-style event shape, but local/internal implementation may start with
DB rows and deterministic CLI reports.

## PR Decision Checklist

Every AUN PR should be answerable with concrete evidence:

- Does this keep core identity provider-neutral?
- Does this avoid making Discord, tmux, or local path the authority?
- What DB row or typed event proves the state transition?
- What script, hook, runner, or transaction owns the mutation?
- Can the same design support a future Streamable HTTP/OAuth connector?
- Does this add a channel-specific script or duplicate code path?
- Is rollback or opt-out clear for mixed old/new fleet operation?
- Are audit and diagnostic surfaces updated enough for operators?
- Are claims based on CI, DB, GitHub, or provider evidence rather than prose?

## Near-Term Application

For `aun`, `wasurezu`, `shirube`, and `kodama`, internal communication
stabilization must improve the same control plane that later supports external
agents.

For `totonoe` and the hotel channels, early Discord canaries should use
channel adapters, connector bindings, routing policy, projection identity, and
queue evidence. Do not add channel-specific scripts or Discord-only core
routing shortcuts for speed.

