# AUN Discord Projection Diagnostic Contract

Status: proposed
Issue: #604
Scope: read-only diagnostic evidence for Discord direct delivery versus AUN/router fallback.

## Purpose

AUN recovery must be able to prove whether a Discord outbound message will use
the expected sender credential directly or fall back to an AUN/router consumer.
This contract makes that decision machine-readable before any live Discord
write is attempted.

## Invariants

1. `agent-com diagnose-projection` is read-only. It must not write Discord,
   mutate DB rows, restart state_daemon, call launchctl, or drain queue work.
2. The default gate expects sender-direct delivery:
   `consumer_agent_id == sender_agent_id` and
   `consumer_source == "sender_token_evidence"`.
3. Router/AUN fallback is a `NO_GO` blocker unless the operator explicitly
   runs the diagnostic with fallback allowed for that scope.
4. If sender direct evidence is usable but the selected route falls back to
   AUN/router, the diagnostic must emit a blocker.
5. The report must expose credential/write evidence:
   `consumer_agent_id`, `projection_identity_id`,
   `delivery_connector_instance_id`, `channel_binding_id`,
   `credential_status`, `provider_write_capability`, `fallback_allowed`,
   `fallback_reason`, and `decision_source`.
6. Runtime login credential statuses and delivery-eligible credential statuses
   must be reported together. If they drift, the report must expose
   `runtime_delivery_status_contract: "drift"` so recovery gates can fail
   closed or stop for review.
7. `GO` means DB/resolver evidence is clean. It is not proof of live Discord
   delivery. Live smoke requires a separate explicit approval.

## Required JSON Fields

The diagnostic report is the SSOT for pre-smoke projection readiness and must
include:

- `go_no_go`
- `mutation_performed`
- `policy.no_discord_live_write`
- `decision.consumer_agent_id`
- `decision.consumer_source`
- `decision.delivery_connector_instance_id`
- `decision.channel_binding_id`
- `decision.credential_status`
- `decision.provider_write_capability`
- `decision.fallback_allowed`
- `decision.fallback_reason`
- `contract.runtime_login_credential_statuses`
- `contract.delivery_credential_statuses`
- `contract.runtime_delivery_status_contract`
- `blockers[].code`

## Non-Goals

- This contract does not send a live Discord message.
- This contract does not rotate or reveal credentials.
- This contract does not enable state_daemon, scheduler activation, or queue
  wake processing.
- This contract does not authorize AUN/router fallback for the default recovery
  path.
