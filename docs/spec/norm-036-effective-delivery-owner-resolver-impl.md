# NORM-036 Effective Delivery Owner Resolver Impl

Date: 2026-05-25
Status: Named contract implemented for audit
Phase: MVP internal normalization
Slice: NORM-036

## Purpose

NORM-036 replaces user-facing per-channel owner setup with a deterministic
resolver that chooses the effective delivery connector from DB evidence.

The user should not have to configure a low-level `adapter_owner_agent_id` for
every channel. If a token-bearing connector can post to a provider channel and
there is no ambiguity, AUN should derive the delivery owner. If there is
ambiguity or no eligible connector, AUN should return a deterministic diagnosis
instead of silently picking a bot.

## Resolver Inputs

The resolver reads:

- logical message author and intended recipients
- core `channel_id` and provider surface
- `channels.members`
- `channel_routing_policy.outbound_allowlist`
- active `connector_instances`
- active connector credentials from NORM-030
- provider channel access from NORM-035
- explicit `channel_connector_bindings` priority/override rows
- legacy `channel_routing_policy.adapter_owner_agent_id`
- provider identities from NORM-025

## Resolver Output

The public contract is exported from `core/outbound-projection.ts` as:

- `EffectiveDeliveryOwnerResult`
- `resolveEffectiveDeliveryOwner(...)`
- `toEffectiveDeliveryOwnerResult(...)`

The resolver returns:

```ts
type EffectiveDeliveryOwnerResult =
  | {
      ok: true
      source: 'explicit_binding' | 'derived_single_connector' | 'legacy_adapter_owner'
      connectorInstanceId: string | null
      consumerAgentId: string
      providerIdentityId?: string | null
      channelBindingId?: string | null
      evidence: Record<string, unknown>
      fallbackReason?: string | null
    }
  | {
      ok: false
      code:
        | 'NO_ELIGIBLE_CONNECTOR'
        | 'AMBIGUOUS_CONNECTOR'
        | 'MISSING_CREDENTIAL'
        | 'MISSING_PROVIDER_ACCESS'
        | 'CONNECTOR_DISABLED'
        | 'RECIPIENT_NOT_MEMBER'
        | 'RECIPIENT_NOT_ALLOWED'
      evidence: Record<string, unknown>
    }
```

The exact TypeScript shape may vary, but the output must be machine-readable.

## Resolution Order

1. Validate logical sender/recipient policy:
   - sender is channel member
   - recipient is channel member unless policy explicitly permits otherwise
   - outbound allowlist permits sender and recipient
   - disabled or revoked agents fail closed
2. Use explicit active connector binding when present and healthy.
3. Derive eligible connectors:
   - active connector instance
   - active non-revoked credential
   - provider identity is active and non-revoked
   - provider channel access says `can_write=true`
4. If exactly one connector is eligible, choose it.
5. If multiple connectors are eligible, return `AMBIGUOUS_CONNECTOR`.
6. If none are eligible, use legacy `adapter_owner_agent_id` only when:
   - fallback policy permits it
   - the legacy owner has enough current connector evidence to post
   - fallback reason is persisted in outbound projection evidence
7. Otherwise return a terminal diagnosis.

## Persistence Contract

Outbound writes must persist enough evidence to explain delivery:

- `consumer_agent_id`
- `delivery_connector_instance_id` when available
- `channel_binding_id` when available
- `projection_identity_id`
- `intended_projection_identity_id`
- `projection_source`
- `projection_fallback_reason`
- resolver source and failure code, either in existing columns or metadata

Legacy fields may remain for compatibility, but diagnostics must not require a
human to infer why `agent-com-dev` posted a message intended for `auditor`.

## Acceptance Criteria

1. Resolver chooses direct connector delivery when exactly one eligible
   token-bearing connector can write to the provider channel.
2. Resolver returns ambiguity when multiple eligible connectors exist.
3. Resolver returns deterministic failure when no eligible connector exists.
4. Legacy adapter-owner fallback is visible and not mistaken for direct
   delivery.
5. Disabled, revoked, non-member, or non-allowlisted recipients fail closed.
6. Resolver does not call provider APIs in the hot path; it uses DB access
   evidence from NORM-035.
7. CLI/doctor diagnostics can explain the selected owner or failure code.
8. Existing mixed-fleet behavior remains compatible while new evidence columns
   are nullable.

## Implementation Notes

- Legacy `adapter_owner_agent_id` / primary fallback is denied by default in
  the named contract and returns `FALLBACK_POLICY_DENIED` unless a diagnostic
  caller explicitly sets fallback allowance.
- Runtime projection remains mixed-fleet compatible, but diagnostics expose the
  named effective-owner result so fallback is not silent.
- Multiple eligible `channel_connector_bindings` may choose a single winner
  only when `priority` has a unique lowest value; otherwise the result is
  `AMBIGUOUS_CONNECTOR`.

## Non-Goals

- No UI implementation.
- No enterprise HA lease enforcement.
- No provider channel discovery. That belongs to NORM-035.
- No credential fingerprinting. That belongs to NORM-030.
- No data reconciliation execution. That belongs to NORM-050.
