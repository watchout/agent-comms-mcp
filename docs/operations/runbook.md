# Operations Runbook

> agent-comms-mcp の運用手順書。
> Phase 5 (PR #309) で `config/bot-routing.json` 編集手順を追加。

---

## 1. `config/bot-routing.json` 編集 (Phase 5 routing)

### 何が入っているか

```jsonc
{
  "version": 1,
  "channels": {
    "<channel_id>": {
      "primary": "<agent_id>",            // mention 不在時の inbound default 宛先
      "outboundAllowlist": ["<agent_id>"] // sender + recipients の ACL
    }
  }
}
```

- **`primary`**: `routeInbound` で `mention` が無く、`channel.primary` がある場合に primary を 1 名 enqueue。両方無い channel は skip + warning log。
- **`outboundAllowlist`**: `send` / `notify` で sender or recipients が含まれていなければ `OUTBOUND_ACL_VIOLATION` reject。**allowlist 不在 channel (entry 自体無し) は legacy compat、全 sender 許可**。

### 編集手順

1. `config/bot-routing.json` を直接編集 (jsonc コメント可)
2. `agent_id` は `agents` table 登録済の literal value (`cto` / `lead-ama` 等)
3. `channel_id` は Discord channel id (snowflake) または internal id

### Reload は **restart-only** (§3.7 file watch reload anti-pattern)

JSON 変更は **プロセス再起動でのみ反映** する。理由:
- file watch reload は stale window / partial reload race を生む (§3.7 過去 incident)
- restart-only なら "現在の policy = process 起動時の file の snapshot" が常に成立

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
| `config/bot-routing.json` 不在 | 全 channel が legacy compat (primary なし、allowlist なし) |
| parse error (invalid JSON) | 同上 (fail-closed semantics — 起動継続、警告 log) |
| schema invalid (channels が object でない等) | 同上 |
| `primary` の agent_id が agents table に不在 | inbound 時 enqueue 失敗 + alert log |
| `cc[]` allowlist 外 agent | `OUTBOUND_ACL_VIOLATION` reject (cc[] strip は v2 で廃止) |
| `mention` + `mentions` 両方指定 | mention 優先 + warning log |

---

## 2. その他運用 (既存項目)

(既存の運用手順は本 runbook に追記される — Phase 5 で初版作成、後続 PR で他項目統合予定)
