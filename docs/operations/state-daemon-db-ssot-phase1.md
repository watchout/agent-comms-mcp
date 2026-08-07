# State-daemon DB SSOT Phase 1

Issue #917 Phase 1 makes database desired state the ordinary communication and automatic-processing authority. This implementation does not migrate data, reload production, or authorize activation.

## Authority

- `channels.members` is the only channel send/receive authorization record. The sender and every active recipient must be members.
- Discord member-to-provider projections fail closed: an empty or unresolved `channels.members` projection does not mean “accept all.”
- `channel_routing_policy.outbound_allowlist` remains physically present for compatibility and diagnostics with status `DEPRECATED_NON_AUTHORITATIVE`. Changing it alone has no authorization effect.
- Automatic processing requires all of the following DB-derived conditions: the agent is enrolled, `profile_enabled` is true, `disabled_at` is null, a non-empty ready runtime and non-empty status are configured, the status is not disabled/offline/retired, the target agent is in the message channel's `channels.members`, and the agent is not denylisted.
- `STATE_DAEMON_AGENT_ALLOWLIST` never makes an agent eligible. It may only narrow a separately eligible target during one protected canary.

Normal generated and loaded LaunchAgent state must contain neither `STATE_DAEMON_AGENT_ALLOWLIST` nor any `STATE_DAEMON_CANARY_OVERLAY_*` key.

## Protected canary overlay

A non-empty `STATE_DAEMON_AGENT_ALLOWLIST` is rejected unless it contains exactly one target and all of these keys are present and valid:

- `STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF`: immutable GitHub comment for the activation handoff
- `STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF`: separate authenticated watchout exact-head activation decision
- `STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT`: future timestamp
- `STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256`: lowercase SHA-256 of captured prior plist bytes
- `STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND`: exact rollback command recorded before activation
- `STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION`: absolute evidence path or GitHub destination
- `STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST`: `sha256:aec4d6cc4184b10a30ca5de63fd1924f091ab5cea401d7f1cd6abfbd1fde1661`

The only Phase 1 targets, in order, are:

1. `aun`
2. `codex-audit`
3. `adf-lead`
4. `devauditor`

`codex-aun` is retired. An expired overlay, multiple targets, a wrong subject, a retired target, or any target outside the four-agent cohort is a preflight blocker. Legacy queue-work activation plans that provide only `--agent-allowlist` are therefore not executable until a typed overlay is supplied.

## Activation boundary

The implementation PR must remain a draft and causes zero production runtime, queue, provider, database, plist, or LaunchAgent effects. Activation is a later protected operation and requires both:

1. independent `codex-audit` PASS for the exact implementation head and tree with zero blockers; and
2. a separate watchout decision naming the same exact head and tree, followed by a distinct activation handoff.

Only one overlay and one reload attempt may be active. Before advancing to the next target, capture the observed commit, plist digest, loaded environment, exact queue lifecycle, reply/provider evidence where applicable, and restore steady state with the allowlist absent.

## Readiness and rollback

Use the read-only LaunchAgent preflight/readiness commands before any separately authorized mutation. They report unqualified persistent allowlists, incomplete overlay metadata, expiry, retired/outside targets, and plist/loaded-state drift as `NO_GO`.

Rollback restores the captured prior plist bytes and prior commit, performs at most one separately authorized reload, and verifies that the loaded environment contains zero allowlist and overlay keys. A rollback receipt must include the prior plist digest, restored commit, loaded-state readback, and evidence destination. No next target begins until that receipt is complete.
