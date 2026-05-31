# Send/Notify Single-Owner Migration

Date: 2026-05-31

Scope: PR #617, Slice 2 implementation of
`docs/spec/aun-send-notify-owner-observer-contract.md`.

## Summary

`send` and `notify` now create at most one active-owner delivery row per call.
`mention` is the canonical active-owner input. `mentions[]` is retained only as
a one-item compatibility alias.

Multi-active fanout is intentionally rejected with
`MULTI_ACTIVE_RECIPIENT_UNSUPPORTED`.

## Consumer Impact

Affected callers are any MCP, CLI, wrapper, script, or operator workflow that
uses one `send` or `notify` call to address more than one active owner:

```json
{ "mentions": ["agent-a", "agent-b"] }
```

or:

```sh
agent-com notify --mentions agent-a,agent-b ...
```

Those calls no longer create multiple queue rows. They fail closed.

Unaffected callers:

- MCP `send` / `notify` with `mention: "agent-a"`
- MCP `send` / `notify` with `mentions: ["agent-a"]`
- CLI `agent-com send` / `agent-com notify` with one `--mention` or one
  `--mentions` value
- `scripts/run-bot.sh`, which sends replies to one `$from` value
- `hooks/claim-close-enforcement.ts`, which uses one `--mentions ceo`
- inbound Discord routing tests and smoke paths that exercise message mentions,
  not MCP/CLI send ownership

Affected in-repo compatibility surfaces:

- `bin/aun reply` and `bin/aun notify` still accept `--mentions` for wrapper
  compatibility, but the wrapped core CLI now treats that value as one active
  owner only.
- Historical docs that show `--mentions a,b` are legacy examples and must be
  interpreted as requiring split requests or owner plus observers.

## Migration Pattern

For visibility-only recipients, use one active owner and observers:

```json
{
  "mention": "agent-a",
  "cc": ["agent-b"],
  "fyi": ["agent-c"]
}
```

For independent work by multiple agents, split the work explicitly:

```text
notify mention=agent-a content=<request A>
notify mention=agent-b content=<request B>
```

Do not use one multi-recipient `mentions[]` call as a fanout shortcut. The
future parent/child request model will add typed fanout with a parent audit
link; that model is outside PR #617.

## Live Fleet Evidence

Read-only DB check on 2026-05-31:

```sql
SELECT count(*) FILTER (
         WHERE jsonb_typeof(metadata->'mentions') = 'array'
           AND jsonb_array_length(metadata->'mentions') > 1
       ) AS multi_mentions_metadata,
       count(*) AS total_recent
  FROM agent_messages
 WHERE created_at > now() - interval '14 days';
```

Result: `83` recent messages with multi-mention metadata out of `6784` recent
messages.

Common recent multi-mention sets included:

- `["auditor", "codex-audit"]`
- `["auditor", "codex-audit", "codex-cto"]`
- `["agent-com-dev", "codex-aun"]`
- `["devauditor", "l2auditor", "codex-cto"]`
- `["codex-cto", "ceo"]`

This confirms the breaking change is real, not a false positive. Those
workflows must be split into one-owner requests or recast as owner plus
observers before they rely on PR #617 behavior.

## Exported Type Compatibility

The previous exported type is preserved:

```ts
export type InboundResolveError = 'INVALID_MENTION' | 'UNKNOWN_AGENT'
```

PR #617 adds `InboundResolveControlPlaneError` for the new
`MULTI_ACTIVE_RECIPIENT_UNSUPPORTED` value used by `InboundResolveErr`. Existing
importers of `InboundResolveError` keep the old meaning.

## No-Owner Calls

No-owner `send` / `notify` is not an intended success path.

`resolvePhase5()` may return `null` when none of the Phase 5 fields are present
so older call sites can preserve legacy control flow, but MCP and CLI
send/notify handlers still reject before enqueue when the resolved active-owner
list is empty.
