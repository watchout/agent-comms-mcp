# Operations Runbook

> agent-comms-mcp の運用手順書。

MCP 登録名と tool namespace の正本は [AUN MCP Registration And Namespace Runbook](./aun-mcp-registration.md) を参照。新規セッションは `aun` / `mcp__aun__*`、移行中のみ `agent-comms` / `mcp__agent_comms__*` / `mcp__agent-comms__*` を legacy alias として扱う。
> Phase 5 (PR #309) で `config/bot-routing.json` 編集手順を追加。NORM-080 以降、production runtime は `channel_routing_policy` DB snapshot を読む。JSON は seed/bootstrap/test fallback 専用。

---

## 1. Channel routing policy (DB SSOT)

Production routing policy is stored in `channel_routing_policy`. Use the channel policy/reconcile CLI paths for production changes; `config/bot-routing.json` is retained only for seed/bootstrap/test compatibility when file fallback is explicitly enabled.

### Legacy seed file shape

`config/bot-routing.json` uses the same logical fields as the DB policy:

```jsonc
{
  "version": 1,
  "channels": {
    "<channel_id>": {
      "primary": "<agent_id>",            // mention 不在時の inbound default 宛先
      "adapterOwner": "<agent_id>",       // chat projection を claim/send する adapter owner
      "outboundAllowlist": ["<agent_id>"] // sender + recipients の ACL
    }
  }
}
```

- **`primary`**: `routeInbound` で `mention` が無く、`channel.primary` がある場合に primary を 1 名 enqueue。両方無い channel は skip + warning log。
- **`adapterOwner`**: #410 以降、`outbound_queue.agent_id` は canonical author として保持し、Discord 等の chat projection は `consumer_agent_id` が示す adapter owner process が claim する。`adapterOwner` 不在時は互換 fallback として `primary` を使う。
- **`outboundAllowlist`**: `send` / `notify` で sender or recipients が含まれていなければ `OUTBOUND_ACL_VIOLATION` reject。**allowlist 不在 channel (entry 自体無し) は legacy compat、全 sender 許可**。

### Production editing

1. Use `agent-com channel policy ...` / `agent-com channel reconcile ...` to plan and execute DB policy changes.
2. `agent_id` は `agents` table 登録済の literal value (`cto` / `lead-ama` 等)
3. `channel_id` は Discord channel id (snowflake) または internal id

### Reload behavior

DB policy is refreshed from `channel_routing_policy` by the routing/projection call sites. Legacy JSON fallback is read only when `AGENT_COM_BOT_ROUTING_PATH` is set or `AGENT_COM_ENABLE_BOT_ROUTING_FILE_FALLBACK=true`.

### Post-merge fleet restart (Phase 5 PR merge 後)

```bash
# 全 bot プロセスを停止 (tmux session)
tmux kill-session -t agent-comms || true

# 再起動 (start-fleet.sh が config を再読込)
bash scripts/start-fleet.sh
```

または個別 restart:

```bash
mcp__agent-comms__restart_bot agent_id=<id>
```

### 検証

```bash
# bot status を確認 (online + heartbeat OK)
mcp__agent-comms__bot_status

# routing が想定通りか smoke test
# (channel に test message を送る → primary に enqueue されるか確認)
```

### Failure modes (cycle 1 ARC §3.4-§3.7 + Phase 5)

| 状況 | 挙動 |
|---|---|
| `channel_routing_policy` に channel policy が無い | production は file fallback せず fail-closed (primary なし、empty allowlist) |
| explicit legacy file fallback の `config/bot-routing.json` 不在 | legacy compat (primary なし、allowlist なし) |
| explicit legacy file fallback の parse/schema error | last-known valid config を維持、初回は empty legacy compat |
| `primary` の agent_id が agents table に不在 | inbound 時 enqueue 失敗 + alert log |
| `adapterOwner` の bot process / Discord token が無い | outbound 診断で `consumer_agent_not_registered` または `consumer_agent_not_available` |
| `cc[]` allowlist 外 agent | `OUTBOUND_ACL_VIOLATION` reject (cc[] strip は v2 で廃止) |
| `mention` + `mentions` 両方指定 | mention 優先 + warning log |

---

## 2. Phase 1 delivery smoke diagnostics (#410)

Bot-to-bot receive と chat projection のどちらも、script-driven JSON 診断で確認する。

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun scripts/diagnose-phase1-delivery.ts --queue-id 71984

DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun scripts/diagnose-phase1-delivery.ts --outbound-message-id b807397b-243f-44ef-9a17-1d88ce793b3c
```

同じ処理は CLI からも実行できる。

```bash
bun cli/index.ts diagnose-delivery --message-id <agent_messages_or_message_queue_id>
```

診断 JSON の要点:

- `inbound.next_returnable=false`: `next` が返さない理由を `reason` に出す。terminal row は `terminal_status_not_returned_by_next`。
- `inbound.terminal_writer_class`: `replied` / `skipped` / `failed` / `stale` / `cleanup` / `auto-skip` の推定。
- `outbound.author_id`: canonical author (`codex-aun` 等)。
- `outbound.consumer_agent_id`: projection owner (`agent-com-dev` 等)。
- `outbound.reason`: pending なのに projection されない機械可読理由。

## 3. Queue Normalization Plan

Use this before mutating production queue state. It wraps `diagnose-queue` into
an ordered, read-only plan with candidate counts, scoped dry-run commands, and
the execute command only where the existing guarded repair path can safely do
the write.

Global view:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts queue normalize --format text --stale-minutes 15
```

Agent-scoped view:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts queue normalize --agent-id codex-aun --format json
```

Rules:

- `queue normalize` is read-only. It rejects `--execute`.
- Apply only the reported repair command after reviewing its dry-run output.
- Every mutating repair command must remain queue-id scoped unless the operator
  intentionally wants to drain every pending row for that agent.
- Historical `read` / `skipped` / `failed` rows are audit history. Do not delete
  or rewrite them until a terminal-state archive policy is approved.
- Stale `outbound_queue` rows must be classified by display value and projection
  evidence before re-projecting or marking obsolete.

## 4. Legacy Pre-#411 Outbound Cleanup (#412)

Use this only for `outbound_queue` rows created before the #411 adapter-owner projection fix, where `consumer_agent_id IS NULL` leaves Discord projection unclaimed or misdiagnosed.

Dry-run first:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun scripts/legacy-outbound-cleanup.ts --limit 200
```

The script prints proposed actions:

- `mark_obsolete`: known ACK/status rows that should not be posted late.
- `backfill_consumer`: only rows explicitly named with `--backfill-message-id`.
- `manual_review`: fail-closed default; inspect before deciding.

Apply is guarded and requires both `--apply` and the existing destructive-operation guard:

```bash
AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1 \
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun scripts/legacy-outbound-cleanup.ts --apply --obsolete-message-id <uuid>
```

To backfill a display-worthy row:

```bash
AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1 \
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun scripts/legacy-outbound-cleanup.ts --apply --backfill-message-id <uuid>
```

Stop and escalate if dry-run shows unexpected `backfill_consumer` rows, rows outside channel `1487368919613444156`, or content that could create stale duplicate Discord posts.

## 5. Codex CTO Identity Normalization (#417)

The detailed mutation plan, rollback, and E2E smoke checklist live in:

```bash
docs/operations/codex-cto-identity-normalization.md
```

Do not mutate production identity rows, `/Users/yuji/Developer/tech-lead/.mcp.json`, `scripts/bot-registry.txt`, or restart `discord-cto` until the #417 plan is reviewed and approved for an execution window.

## 6. Full AUN Recovery GO/NO-GO (#602)

Terminal reboot recovery must follow the docs-only GO/NO-GO sequence in
[`aun-full-recovery-runbook.md`](./aun-full-recovery-runbook.md).

The short version:

- run CP-70 doctor/preflight before CP-80 activation planning
- use CP-80 recovery readiness and activation-plan as dry-run gates
- treat #603 LaunchAgent persistent-path evidence and #604 Discord projection
  diagnostics as required inputs
- do not wake queues through TUI prompt injection, `next`, `inbox`, or FIFO
  drain
- do not restart state_daemon, bootstrap/kickstart launchd, or activate
  Discord before explicit approval

## 7. Bounded Recovery Canary Approval (#602)

Use [`aun-bounded-canary-approval-pack.md`](./aun-bounded-canary-approval-pack.md)
to prepare the final approval packet before any recovery canary or live smoke.
The packet is read-only preparation: it requires CP-70, CP-80 readiness,
CP-80 activation-plan, Discord projection diagnostic, state-daemon readiness,
and state-daemon install-plan dry-run evidence before a separate explicit
live-smoke approval. Prefer the bounded runner:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun scripts/recovery-readonly-gate-pack.ts --output-dir evidence
```

The runner writes `evidence/recovery-scope.json` plus every report required for
the GO/NO-GO classifier in `evidence/summary.json`. Every CP-80 command in the
packet consumes the same scope file so scope drift fails closed. If the #672
install-plan CLI is not present, the runner records that dependency as NO-GO;
do not treat the approval packet as complete by omission.

## 8. その他運用 (既存項目)

(既存の運用手順は本 runbook に追記される — Phase 5 で初版作成、後続 PR で他項目統合予定)
