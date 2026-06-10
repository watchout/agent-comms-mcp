# AUN Recovery Final Approval Packet (#602)

This packet is the final approval material before any recovery canary or live
smoke. It is preparation only. It does not authorize or perform runtime work.

## Hard Guardrails

The approval packet collection step must not perform any of the following:

- state_daemon restart
- `launchctl bootstrap`, `launchctl kickstart`, or equivalent host activation
- Discord activation or live Discord write
- live smoke execution
- `next`, `inbox`, or FIFO drain
- DB mutation or schema migration
- live runtime call
- automatic retry loop

## Required Repository State

Record these values in the approval request:

```text
current_main_sha: dbfe0b4d6c6c36cb310ba7e73427caa54de6f862
required_merged_prs:
  - #650 Disable state-daemon TUI wake prompts
  - #651 CP-70 control-plane doctor/preflight
  - #653 CP-80 recovery readiness
  - #654 CP-80 activation-plan dry-run
  - #658 Discord projection diagnostic
  - #667 state-daemon LaunchAgent readiness diagnostic
  - #669 runtime supervisor adapter contract
  - #670 bounded canary/live smoke approval pack
  - #671 local supervisor adapter dry-run evidence
  - #672 state-daemon install-plan dry-run
  - #674 recovery read-only gate pack
required_audit_wait_prs:
  - #668 full AUN recovery runbook
```

If `origin/main` has moved since the packet was prepared, refresh every
read-only report before requesting live-smoke approval.

## Kodama Token Rotation Safety Check

This check is DB-first and non-secret. It must not print, copy, store, or compare
raw Discord tokens. Only token source references, credential IDs, statuses, and
revocation evidence are allowed in the output.

Expected state:

- `agents.provider_token_source_ref` for `kodama` is
  `agent-com-api-keys:Kodama_token`.
- The live `connector_credentials` row for `kodama` resolves only to
  `agent-com-api-keys:Kodama_token`.
- No active/registered live credential for `kodama` uses the legacy
  `mcp-json:*DISCORD_BOT_TOKEN*` reference.
- The old `mcp-json:*DISCORD_BOT_TOKEN*` credential is explicitly revoked or
  disabled in DB evidence.

Capture evidence with a read-only query:

```bash
mkdir -p evidence
psql "$DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  --tuples-only \
  --no-align \
  --command "
WITH credential_rows AS (
  SELECT
    cc.credential_id::text,
    cc.agent_id,
    cc.provider,
    cc.connector_instance_id::text,
    cc.secret_ref,
    cc.status,
    cc.trust_status,
    cc.source,
    cc.evidence_revision,
    cc.last_verified_at,
    cc.created_at,
    cc.updated_at,
    cc.disabled_at,
    cc.revoked_at,
    CASE
      WHEN cc.secret_ref = 'agent-com-api-keys:Kodama_token' THEN 'new_ref'
      WHEN cc.secret_ref LIKE 'mcp-json:%DISCORD_BOT_TOKEN%' THEN 'legacy_mcp_json'
      ELSE 'other_ref'
    END AS ref_class,
    CASE
      WHEN cc.status IN ('registered', 'active')
       AND cc.disabled_at IS NULL
       AND cc.revoked_at IS NULL
       AND cc.trust_status NOT IN ('disabled', 'revoked')
      THEN true
      ELSE false
    END AS live_eligible
  FROM connector_credentials cc
  WHERE cc.agent_id = 'kodama'
    AND cc.provider = 'discord'
),
agent_row AS (
  SELECT agent_id, provider_token_source_ref
  FROM agents
  WHERE agent_id = 'kodama'
)
SELECT jsonb_pretty(jsonb_build_object(
  'ok',
    (SELECT provider_token_source_ref = 'agent-com-api-keys:Kodama_token' FROM agent_row)
    AND (SELECT count(*) FROM credential_rows WHERE ref_class = 'new_ref' AND live_eligible) = 1
    AND (SELECT count(*) FROM credential_rows WHERE ref_class <> 'new_ref' AND live_eligible) = 0
    AND (SELECT count(*) FROM credential_rows WHERE ref_class = 'legacy_mcp_json'
          AND (status IN ('revoked', 'disabled') OR trust_status IN ('revoked', 'disabled')
               OR revoked_at IS NOT NULL OR disabled_at IS NOT NULL)) >= 1,
  'go_no_go',
    CASE WHEN
      (SELECT provider_token_source_ref = 'agent-com-api-keys:Kodama_token' FROM agent_row)
      AND (SELECT count(*) FROM credential_rows WHERE ref_class = 'new_ref' AND live_eligible) = 1
      AND (SELECT count(*) FROM credential_rows WHERE ref_class <> 'new_ref' AND live_eligible) = 0
      AND (SELECT count(*) FROM credential_rows WHERE ref_class = 'legacy_mcp_json'
            AND (status IN ('revoked', 'disabled') OR trust_status IN ('revoked', 'disabled')
                 OR revoked_at IS NOT NULL OR disabled_at IS NOT NULL)) >= 1
    THEN 'GO' ELSE 'NO_GO' END,
  'agent_id', 'kodama',
  'expected_secret_ref', 'agent-com-api-keys:Kodama_token',
  'agent_provider_token_source_ref', (SELECT provider_token_source_ref FROM agent_row),
  'new_live_credential_count', (SELECT count(*) FROM credential_rows WHERE ref_class = 'new_ref' AND live_eligible),
  'legacy_live_credential_count', (SELECT count(*) FROM credential_rows WHERE ref_class = 'legacy_mcp_json' AND live_eligible),
  'legacy_revoked_or_disabled_count', (SELECT count(*) FROM credential_rows WHERE ref_class = 'legacy_mcp_json'
    AND (status IN ('revoked', 'disabled') OR trust_status IN ('revoked', 'disabled')
         OR revoked_at IS NOT NULL OR disabled_at IS NOT NULL)),
  'other_live_credential_count', (SELECT count(*) FROM credential_rows WHERE ref_class = 'other_ref' AND live_eligible),
  'credential_rows',
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'credential_id', credential_id,
      'connector_instance_id', connector_instance_id,
      'secret_ref', secret_ref,
      'ref_class', ref_class,
      'status', status,
      'trust_status', trust_status,
      'source', source,
      'evidence_revision', evidence_revision,
      'last_verified_at', last_verified_at,
      'disabled_at', disabled_at,
      'revoked_at', revoked_at,
      'live_eligible', live_eligible
    ) ORDER BY ref_class, secret_ref, credential_id) FROM credential_rows), '[]'::jsonb),
  'mutation_performed', false,
  'raw_token_included', false
));
" > evidence/kodama-token-rotation.json
```

GO requires `ok=true`, `go_no_go=GO`, `raw_token_included=false`,
`new_live_credential_count=1`, `legacy_live_credential_count=0`,
`legacy_revoked_or_disabled_count>=1`, and `other_live_credential_count=0`.

NO-GO blockers:

- `KODAMA_AGENT_TOKEN_REF_NOT_NEW`: agent profile does not point to
  `agent-com-api-keys:Kodama_token`.
- `KODAMA_NEW_CREDENTIAL_NOT_EXACTLY_ONE`: zero or multiple live new-ref
  credentials exist.
- `KODAMA_LEGACY_MCP_JSON_STILL_LIVE`: legacy mcp-json credential remains
  active/registered and not revoked/disabled.
- `KODAMA_LEGACY_REVOCATION_EVIDENCE_MISSING`: no explicit revoked/disabled
  legacy evidence exists.
- `KODAMA_OTHER_LIVE_CREDENTIAL_PRESENT`: an unexpected live credential ref can
  resolve for `kodama`.
- `KODAMA_RAW_TOKEN_EXPOSED`: any command output includes raw token material.

## Required Read-Only Evidence Artifacts

The approval packet must include these files:

```text
evidence/recovery-scope.json
evidence/cp70-preflight.json
evidence/recovery-readiness.json
evidence/activation-plan.json
evidence/discord-projection.json
evidence/state-daemon-readiness.json
evidence/runtime-inventory.json
evidence/fleet-readiness.json
evidence/queue-processing-readiness.json
evidence/install-plan.json
evidence/summary.json
evidence/kodama-token-rotation.json
```

Use the merged #674 read-only gate pack:

```bash
APPROVED_COMMIT="$(git rev-parse HEAD)"
APPROVED_CHECKOUT_ROOT="$HOME/.agent-comms/state-daemon/checkouts"

DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun scripts/recovery-readonly-gate-pack.ts \
    --output-dir evidence \
    --agent-id codex-cto \
    --to-agent ceo \
    --channel-id 1487368919613444156 \
    --install-plan-commit "$APPROVED_COMMIT" \
    --approved-commit "$APPROVED_COMMIT" \
    --approved-checkout-root "$APPROVED_CHECKOUT_ROOT"
```

The required scope is canary-first:

```json
{
  "agents": ["codex-cto"],
  "channels": ["1487368919613444156"],
  "max_canary_count": 1,
  "fallback_allowed": false
}
```

## Exact GO Conditions

The final approval packet is GO only when all conditions are true:

- `evidence/summary.json.ok=true`
- `evidence/summary.json.go_no_go=GO`
- every required report has `go_no_go=GO` or `ok=true`
- every required report has `mutation_performed=false`
- every state-daemon report has `restart_performed=false`
- CP-70 preflight has zero blockers for the exact scope
- CP-80 recovery readiness is GO for the same `recovery-scope.json`
- CP-80 activation-plan dry-run is GO for the same readiness report
- Discord projection diagnostic is direct delivery with
  `consumer_agent_id=codex-cto`, `consumer_source=sender_token_evidence`, and
  `fallback_allowed=false`
- Discord projection diagnostic reports
  `contract.runtime_delivery_status_contract=drift` with active delivery credential evidence
- state-daemon readiness is GO or explicitly report-only for unloaded/not-running
  with no restart performed
- runtime inventory has zero stale, unapproved checkout, commit mismatch,
  missing checkout evidence, or dirty checkout blockers
- fleet readiness has zero checkout drift blockers for production active agents;
  any bounded drift exclusion is present as auditable `approved_fleet_exclusion`
  evidence and does not count the agent as ready
- queue-processing readiness is GO and has no `QUEUE_WAKE_STUCK` blockers
- install-plan dry-run is GO, persistent-path safe, and non-mutating
- kodama token rotation evidence is GO and contains no raw token
- #668 audit status is PASS or explicitly accepted as a documented dependency
  before live-smoke approval

## Exact NO-GO Blockers

Any of these makes the approval packet NO-GO:

- any report missing
- any report scoped to different agent/channel/runtime values
- any blocker in `evidence/summary.json.blockers`
- any `mutation_performed=true`
- any `restart_performed=true`
- CP-70 blocker such as loop prompt backlog, stale active queue row, duplicate
  active baton/turn, or legacy prompt artifact
- state-daemon path under `/private/tmp` or other volatile checkout
- missing state-daemon ProgramArguments or WorkingDirectory target
- any production runtime heartbeat missing the approved commit/checkout path
- any production runtime on an unapproved checkout root, mismatched commit, or
  dirty working tree
- any MCP-only or tmux-only runtime identity counted as fleet ready while an
  approved commit or checkout-root gate is active
- state-daemon listener identity mismatch
- Discord projection fallback to AUN/router when direct delivery is expected
- Discord credential/write capability unknown
- send failure counted as success
- kodama old mcp-json credential not revoked/disabled
- kodama active/registered credential resolving to anything other than
  `agent-com-api-keys:Kodama_token`
- raw token material printed or stored

## Rollback Trigger List

If approval is later granted for one-message live smoke, stop on the first
trigger:

- FIFO drain detected
- loop prompt detected
- wrong `AGENT_ID` or listener identity
- Discord fallback to AUN/router when direct delivery is expected
- projection evidence missing
- queue row stuck
- duplicate active work
- prompt-driven `next` or `inbox` request appears
- state_daemon wrong path or wrong checkout/build artifact
- Discord credential/write evidence missing
- live Discord send failure
- raw token exposure

Rollback means pausing the exact activation scope and preserving evidence. It
does not mean deleting rows, bulk-terminalizing active work, restarting
state_daemon as repair, retrying automatically, or asking an LLM to process more
queue rows.

## Live Smoke Request Template

Use this text only after the final approval packet is GO and a human explicitly
approves one live smoke.

```text
LIVE SMOKE APPROVAL REQUEST - #602 recovery canary

Requested scope:
- channel_id: 1487368919613444156
- agent_id: codex-cto
- runtime: codex
- max_canary_count: 1
- fallback_allowed: false
- message_count: 1

Required pre-approval evidence:
- current_main_sha: <sha>
- #668 audit status: <PASS/accepted dependency>
- #674 merged in current_main_sha: yes
- recovery-scope: evidence/recovery-scope.json
- CP-70 preflight: evidence/cp70-preflight.json -> GO
- CP-80 readiness: evidence/recovery-readiness.json -> GO
- CP-80 activation-plan dry-run: evidence/activation-plan.json -> GO
- Discord projection diagnostic: evidence/discord-projection.json -> direct, no fallback
- state-daemon readiness: evidence/state-daemon-readiness.json -> GO/report-only as approved, restart_performed=false
- install-plan dry-run: evidence/install-plan.json -> GO, mutation_performed=false, restart_performed=false
- gate summary: evidence/summary.json -> GO
- kodama token rotation: evidence/kodama-token-rotation.json -> GO, raw_token_included=false

Requested live action after approval:
- exactly one channel
- exactly one agent
- exactly one message
- no automatic retry
- stop on first blocker

Explicitly prohibited during live smoke:
- no FIFO drain
- no prompt-driven next/inbox
- no fleet-wide activation
- no unapproved state_daemon restart
- no unapproved launchctl bootstrap/kickstart
- no unapproved Discord write beyond the one approved message
- no DB/schema migration
- no live runtime call beyond what is separately approved for the exact canary
  scope

Success criteria:
- DB queue/result/outbound/projection/audit evidence is captured
- consumer_agent_id=codex-cto
- consumer_source=sender_token_evidence
- fallback_allowed=false
- fallback_reason=null
- no duplicate active work
- no loop prompt
- no raw token exposure

Discord visibility alone is not success.
```
