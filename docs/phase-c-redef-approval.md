# Phase C 完了条件の再定義 — CEO 承認文書

> 日付: 2026-04-17
> 起草: CTO
> 承認者: CEO

## 何を変えるか (1 段落)

Phase C の完了条件を「既存アーキテクチャの改善」から「OSS product shape を組織��理にする」へ再定義する。OSS / SQLite / npm 一発は初期 spec (message-queue-spec §1 原則 7, §14, chat-ui-sync-spec §8) に要件として書かれていたが、設計の重心は IYASAKA 本番 (PostgreSQL + tmux + multi-bot + Claude Code) にあった。結果、PostgreSQL 固有機能 (pg_notify, FOR UPDATE SKIP LOCKED) が spec 本文に混入し、receiver が multi-bot 前提、Claude Code 固有制約が「確定技術制約」に昇格した。本再定義は方針転換ではなく、書かれていた product goal を設計の組織原理に昇格させるもの。

## 旧 Phase C 条件 (architecture 視点)

1. plugin:discord 非表示 ✅
2. daemon heartbeat ❌
3. next_message 一本化 ✅
4. access.json 依存ゼロ ❌

## 新 Phase C 条件 (product 視点)

| # | 条件 | 検証方法 |
|---|------|----------|
| 1 | `npx agent-comms-mcp` で全機能起動 (未 init なら init 自動実行) | CI: fresh env で npx → bot online 確認 |
| 2 | SQLite default / PostgreSQL optional | CI: SQLite mode で全テスト pass |
| 3 | 1 daemon プロセスが inbound + outbound + heartbeat 完結 | テスト: daemon 起動 → Discord msg 送受信 → MCP 不要 |
| 4 | routing は 100% deterministic — DB config のみ、LLM 判断ゼロ | テスト: LLM 未接続で全ルーティング動作 |
| 5 | access.json / plugin:discord 等の外部ファイル依存ゼロ | grep: import/require に access.json / plugin 参照なし |

## 確定した設計判断 (3 点)

### 1. Dispatcher (§19.2) の扱い

- **廃止** (CEO 判断: LLM 自動判定はルーティングの事故原因になる)
- §19.2 は spec から削除
- `AGENT_COM_DISPATCH_ENABLED` env var も廃止
- routing は 100% deterministic (DB config のみ)

### 2. プロセス境界: 案 A (1 プロセス集約)

```
npx agent-comms-mcp
  └─ 1 プロセス:
     ├─ Discord Gateway (N bot token 分の接続)
     ├─ inbound receiver (routeInbound → DB)
     ├─ outbound consumer (DB → Discord)
     ├─ heartbeat monitor
     └─ MCP tools (stdio / SSE で外部 LLM tool が接続)
```

- receiver は daemon に吸収、独立プロセスとしては廃止
- multi-bot: 1 プロセス内で N Discord client (discord.js 複数 Client 対応)
- per-bot daemon (案 B) は不採用 (multi-process 管理が npm 一発と矛盾)

### 4. Reply Chain Context (CEO 口頭承認 2026-04-17)

- Push Enrichment (チャンネル履歴付与) を廃止し、reply_to chain による会話文脈付与に置換
- next_message が返すメッセージに reply_to を再帰的に辿った祖先メッセージを付加
- チャンネル内の無関係メッセージは含めない (複数話題混在問題の解決)
- 設定: AGENT_COM_REPLY_CHAIN_DEPTH (default: 10)

### 3. Init / Start: 単一コマンド兼用

```bash
npx agent-comms-mcp          # 未 init → init + start / init 済 → start
npx agent-comms-mcp init     # 明示 init のみ (token 入力 + SQLite 作成)
npx agent-comms-mcp start    # 明示 start のみ
```

- init 時: SQLite ファイル + `.env` テンプレート自動生成
- DB migration: start 時に auto-run
- Discord token: init で対話入力 or `.env` 事前設定

## 廃止する設計要素

| 廃止対象 | 理由 |
|----------|------|
| embedded/standalone dual mode | 1 mode (daemon 集約) に統一 |
| `AGENT_COM_DAEMON_MODE` env var | mode がないため不要 |
| receiver 独立プロセス | daemon に吸収 |
| `pg_notify` 必須依存 | polling 統一 (PostgreSQL 時は pg_notify を「加速」として opt-in 利用可) |
| access.json | DB routing で完結 |
| plugin:discord | adapter 統合済み |
| filtering 層 (system prompt 判定) | routing 層のみで完結 |
| §6.6 「確定技術制約」の Claude Code 固有項�� | LLM-agnostic に書き直し |

## IYASAKA 本番への影響

- 18 bot は PostgreSQL + tmux で継続運用可能 (breaking change なし)
- 新アーキテクチャへの migration は段階的 (daemon 集約 → tmux 削減)
- pg_notify は PostgreSQL 接続時に自動有効化 (polling + pg_notify 併用で高速化)

## 旧 Task の扱い

| Task | 扱い |
|------|------|
| Task A2.5 (PR #197, HOLD 中) | close → 新条件で再起票 |
| Task A3 (chat-ui-sync-spec) | 新条件で scope 再評価 |
| Task B (daemon 分離 Issue) | 新条件で body 書き直し |

## 承認後の実行計画

1. PR #197 close
2. message-queue-spec v2.0.0 改訂 (OSS primary + 上記全反映)
3. attachment-spec / source-awareness / chat-ui-sync-spec を v2.0.0 に追随
4. 実装 Task 再分解 → agent-com-dev に指示
