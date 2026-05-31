# AUN Agent Communication Control Plane Charter

Date: 2026-05-31
Status: Normative charter for send/receive redesign

## Purpose

AUN is an agent communication control plane, not a chat bridge, job queue, or
tmux automation layer. The send/receive redesign must preserve the product
meaning of communication:

```text
message -> delivery -> conversation -> baton -> agent turn
        -> reply | handoff | close | no-reply | retry | quarantine
```

The control plane must answer, from durable evidence:

- what message was sent
- who received it
- who currently owns response responsibility
- what turn is running or completed
- whether the conversation was replied, handed off, closed, or escalated
- which audit evidence allows that state

## Core Terms

| Term | Meaning |
|---|---|
| message | A logical utterance from a human, agent, system, or connector. |
| delivery | A durable attempt to present a message to an intended agent. |
| conversation | An AUN-owned logical work thread that groups related messages, deliveries, and baton transitions. Provider channel, thread, and UI state are evidence, not the primary identity. |
| baton | The active response responsibility for a conversation or request. |
| agent turn | One bounded execution by the agent that owns the baton. |
| handoff | A typed transfer of the baton to another responsible agent. |
| close | A terminal decision that no further response responsibility remains. |
| projection | Provider-specific display or transport output, such as Discord or GitHub. |
| audit event | Durable evidence for a state transition, policy decision, or projection result. |

Existing tables may continue to implement these terms during migration. For
example, `agent_messages` can represent messages, `message_queue` can represent
delivery state, and `audit_log` can represent audit events. The charter defines
the target semantics; it does not require a schema rewrite in the first PR.

## Product Invariants

The final send/receive system must enforce these invariants:

1. One open conversation has exactly one active baton.
2. One active baton has exactly one responsible agent.
3. A delivery row is not itself response responsibility unless it is linked to
   the active baton.
4. `cc` and `fyi` recipients are observers, not baton owners.
5. LLMs may produce reply text, audit findings, or handoff recommendations, but
   they must not decide queue claim, baton ownership, close status, retry, or
   recovery state.
6. Every baton transition is performed by deterministic code and recorded as an
   audit event.
7. Provider messages are projections and evidence, not authority for identity,
   ownership, or completion.
8. A failed runtime leaves reclaimable state; it must not silently lose or
   duplicate the baton.
9. A loop prompt, progress ACK, or repeated wake message cannot create a new
   active baton.
10. Reply, handoff, no-reply close, and escalation are typed outcomes, not
    inferred from free-form chat text alone.

## Send Contract

Send and notify surfaces must distinguish active ownership from visibility.

Required direction:

```text
mention: exactly one active owner
cc: observer list, no queue row, no baton
fyi: observer list, no queue row, no baton
```

Legacy multi-recipient fanout must not create multiple active response
responsibilities for one logical request. If a use case truly needs many agents
to work independently, the sender must create separate typed requests or an
explicit fanout workflow where each child request has its own baton and parent
audit link.

Send must record enough evidence to answer:

- source message or initiating operator
- active owner
- observers
- channel or thread context
- policy decision
- created delivery row or outbox projection
- resulting baton id, once the baton model exists

## Receive Contract

Receive must be script-controlled and one-row scoped.

Allowed flow:

```text
pending delivery
  -> receive runner claims one row
  -> process runner starts one agent turn
  -> completion runner records reply, handoff, close, no-reply, retry, or escalation
```

Audit, recovery, and bridge workflows that already know the intended work item
must use an exact `queue_id` claim. A runner must fail closed if that row is not
pending for the expected agent. It must not drain unrelated FIFO rows to reach a
target row.

Forbidden flow:

```text
pending delivery
  -> natural-language prompt tells an LLM to call next
  -> LLM chooses how many rows to claim
  -> prompt text or ACKs become more queue work
```

The runtime receives only the claimed message, baton context, and bounded
supporting evidence. It must not receive an unrelated pending queue preview.
This requirement is runtime-neutral: Codex, Claude Code, OpenClaw, and future
adapters use the same queue, baton, turn, and completion state machine.

## Baton Transition Model

The target state machine is:

```text
open
  -> claimed
  -> in_turn
  -> replied
  -> closed

open
  -> claimed
  -> in_turn
  -> handoff_requested
  -> handed_off
  -> claimed by next owner

open
  -> claimed
  -> in_turn
  -> no_reply_close

open
  -> claimed
  -> stalled
  -> retry | reclaim | escalate | quarantine
```

The current `message_queue` states can bridge to this model while migration is
in progress:

| Current queue state | Charter meaning |
|---|---|
| `pending` | Delivery exists but the baton/turn has not been claimed by a runner. |
| `received` | Delivery was claimed for one owner and is ready to start a turn. |
| `in_progress` | A bounded agent turn is active. |
| `done` | Internal turn finished, but final reply/handoff/close evidence must still be resolved. |
| `replied` | Terminal reply evidence exists. |

## Runner Responsibilities

Runners are the execution boundary between durable communication state and LLM
runtime output.

Receive runner:

- claims at most one row per invocation unless a batch mode explicitly sets a
  bounded limit
- supports an exact `queue_id` claim for audit, recovery, and bridge workflows
- writes claim owner, claim time, expiry, and trace metadata
- refuses identity mismatch
- refuses drain-to-target behavior; unrelated pending rows remain untouched

Process runner:

- moves a claimed row into a single active turn
- provides only the scoped input for that turn
- captures runtime start, completion, and failure evidence

Completion runner:

- validates that the claim or lease is still current
- records one typed outcome
- emits outbox work for provider projections
- closes, hands off, retries, or quarantines through deterministic code

## Audit And Development Gates

The send/receive redesign must move through small audited PRs. The default
route is:

```text
L1: devauditor
L2: l2auditor
L3 / merge: codex-cto
```

For core communication semantics, the required flow is:

```text
spec PR -> L1 -> L2 -> L3
implementation PR -> L1 -> L2 -> L3 -> merge
```

Spec and implementation may be combined only for low-blast-radius changes such
as diagnostic output, doctor checks, repair helpers, tests, or small CLI
surfaces. The following areas require spec before implementation:

- baton and delivery invariants
- send/notify ownership contract
- receive claim and lease semantics
- reply, handoff, no-reply, close, retry, and quarantine transitions
- state-daemon scheduler behavior
- identity, ACL, and security boundaries

Audit-request enqueue is not audit completion. Each level advances only after
durable evidence appears in GitHub review, PR comment, or an AUN audit message.

## Migration Slices

The charter should be implemented through these audited slices:

1. Restart preflight and loop-prompt blocker.
2. Single-active-owner send/notify contract with `cc` and `fyi` observers.
3. Baton schema or compatibility layer that exposes one active baton per open
   conversation.
4. Script-controlled receive runner, including exact `queue_id` claim,
   canonical message presentation, and runtime-neutral adapter contract.
5. Script-controlled process and completion runner with durable agent turn
   ledger.
6. Typed reply, handoff, no-reply, close, retry, and quarantine outcomes.
7. Outbox projection consistency for Discord, GitHub, and future connectors.
8. Doctor/preflight/repair coverage for stuck baton, expired lease, duplicate
   owner, loop prompt, split request, drain-to-target loop, and unclosed turn.
9. State-daemon scheduler activation after preflight is clean.

## Non-Goals

This charter does not require immediate implementation of:

- hosted multi-tenant deployment
- full enterprise UI
- replacing every existing `message_queue` column in one migration
- removing all compatibility CLI commands
- public OAuth/OIDC enforcement before local normalization is stable

## Acceptance Criteria

The redesign is on track when:

- a pending message can be processed without an LLM calling `next`
- an audit or bridge request can be processed by exact `queue_id` without
  draining unrelated FIFO work
- sending to observers cannot create extra active batons
- an operator can inspect the current baton owner for an open conversation
- an agent turn can be reclaimed or retried after runtime failure
- Codex, Claude Code, and future adapters use the same queue/baton/turn state
  machine, differing only at launch, IO, timeout, and result parsing
- every reply, handoff, close, and no-reply outcome has audit evidence
- state-daemon can be restarted as a scheduler without natural-language wake
  prompt injection
- PR audit work follows L1, L2, L3 evidence gates before merge
