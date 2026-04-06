# MCP SSE Transport 移行仕様書（ADR-029 Phase 3）

> MCPサーバーのstdio方式からSSE（Server-Sent Events）方式への移行。
> Bot起動時のプロセス増殖問題を構造的に解決する。

---

## 1. 背景と目的

### 課題

stdio方式ではBot数 x 2のMCPプロセスが毎回生成され、孤児化によるOOM killが発生（実測47プロセス/1.4GB）。Phase 1（cleanup hook）・Phase 2（PIDファイル+watchdog排他制御）は事後対策であり、根本解決にならない。

### 目的

SSE transport化により「プロセスを生成しない」構造に変更し、問題を根本的に解決する。

---

## 2. アーキテクチャ

### デーモン構成（分離方式）

| デーモン | デフォルトポート | 役割 |
|---------|----------------|------|
| agent-comms | localhost:8800 | Discord/Telegram連携、メッセージング |
| agent-memory | localhost:8801 | 知識DB、コンテキスト管理 |

- 各デーモンはlaunchd plistで独立管理
- プロセスライフサイクルはOSが管理（KeepAlive: true）
- ThrottleInterval: 10（再起動ループ防止）

### ポート選択ロジック

OSS環境でのポート競合を防ぐため、以下の3段階でポートを決定する。

```
1. 環境変数が指定されている場合 --> そのポートを使用
   - AGENT_COMMS_PORT (デフォルト: 8800)
   - AGENT_MEMORY_PORT (デフォルト: 8801)

2. 環境変数が未指定の場合 --> デフォルトポートを試行

3. デフォルトポートが使用中の場合 --> OS自動割り当て
   - server.listen(0) でOSが空きポートを割り当て
   - 実際のポートをログ出力
   - .mcp.json の url を自動更新
```

#### 設計判断

| 方式 | 判定 | 理由 |
|------|------|------|
| デフォルトポート固定 (8800/8801) | 採用 | ドキュメント・トラブルシュートが固定値前提で書ける。FastMCP(8000)や一般的な8080とも非競合 |
| 環境変数オーバーライド | 採用 | Docker/CI等でポート固定が必要なケースに対応。12-factor app準拠 |
| ポート範囲設定 | 不採用 | 自動選択があれば冗長。設定項目が増えるだけ |
| UNIXソケット | 不採用 | SSE(HTTP)はTCPが前提。Nginxリバースプロキシ等の設定が複雑化。レイテンシ差はMCPユースケースで無視できる |

### スコープ

本SSOTの実装範囲は **agent-comms（:8800）のSSE化** に限定する。agent-memory（:8801）のSSE化は同一アーキテクチャを踏襲するが、別SSOTで定義し、agent-commsの移行完了・安定稼働を確認後に着手する。

### 配置と参照

- **実装仕様（正本）**: `agent-comms-mcp/docs/SSE_TRANSPORT_SPEC.md` に配置
- **参照リンク**: 本ファイル（`iyasaka/docs/ssot/SSE_TRANSPORT_SPEC.md`）は正本への参照として維持
- agent-comms-mcp既存の `SSOT.md` からは本仕様を別ファイルとして参照する（統合しない。スコープが異なるため）

### SSEエンドポイント

```
GET /sse?bot_id={botId}
```

- MCP SDK標準のSSE transportパス `/sse` に準拠
- bot_idクエリパラメータでセッションを識別
- bot_idは現行stdio方式の環境変数 `AGENT_ID` と同一値を使用（例: `arc`, `cto`, `dev`）

### .mcp.json 形式

**変更前（stdio）:**
```json
{
  "mcpServers": {
    "agent-comms": {
      "command": "bun",
      "args": ["run", "server.ts"],
      "env": { "AGENT_ID": "arc", "DATABASE_URL": "...", ... }
    }
  }
}
```

**変更後（SSE）:**
```json
{
  "mcpServers": {
    "agent-comms": {
      "type": "sse",
      "url": "http://localhost:8800/sse"
    }
  }
}
```

- command/args/envは全てデーモン側（launchd plist）で管理
- プロジェクトごとの.mcp.jsonを維持（各プロジェクトが使うMCPサーバーが異なるため）

### bot_id と AGENT_ID の対応

SSE移行時、現行stdioの `env.AGENT_ID` をSSEの `bot_id` クエリパラメータにそのまま使用する。

| Bot | AGENT_ID (stdio) | bot_id (SSE) |
|-----|-------------------|--------------|
| IYASAKA ARC | arc | arc |
| IYASAKA CTO | cto | cto |
| agent-comms Dev | dev | dev |
| （その他Bot） | （同一値を維持） | （同一値を維持） |

---

## 3. 認証・セキュリティ

### 認証方式

OSS化を前提にBearer token認証をPhase 3から組み込む。

```
クライアント(Bot) --> HTTPS --> Nginx(TLS終端) --> localhost:8800
                       |
                Bearer token検証
```

- 各Botに固有トークンを発行（環境変数で管理）
- デーモン側でトークン検証middleware
- **localhost利用時はトークン検証スキップオプション付き**（開発体験を損なわない）

### データ暗号化レベル

| データ種別 | 暗号化レベル | 理由 |
|-----------|------------|------|
| ユーザー <-> エージェント会話 | カラムレベル暗号化 | 個人情報・経営判断の混入リスク |
| エージェント <-> エージェント会話 | 保存時暗号化 + アクセス制御 | 技術情報中心だが漏洩リスクは管理すべき |
| エージェントのメモリ/知識DB | カラムレベル暗号化 | 会話から抽出した情報が蓄積されるため |

### 補足

- 保持期間ポリシー（例: 90日で自動削除）とアクセス権限の最小化を併用
- 監査ログ（誰がいつアクセスしたか）を記録

---

## 4. 障害耐性

### 監視レイヤー

```
watchdog.sh    --> Bot(Claude Code)の生死監視（既存・維持）
launchd plist  --> MCPデーモンの生死監視（新規追加）
Bot reconnect  --> SSE接続断の再接続（Bot側に実装）
```

- watchdog.shは廃止しない（Bot監視として継続）
- ポートチェック部分をSSEヘルスチェック（GET /health）に進化

### Bot側reconnect戦略

- Exponential backoff: 1s -> 2s -> 4s -> 8s -> max 30s
- 最大試行回数: 無制限（接続復旧まで継続）

### デーモンヘルスチェック

`GET /health` エンドポイントをデーモンに追加し、watchdog.shのポートチェック（Check 3b）をこれに置き換える。

#### 背景: stdio方式の構造的盲点

現行stdio方式では「プラグインは起動中だがClaude Codeが切断」状態を検知できない。

- Check 3a: tmux出力の文字列残存で偽healthy判定
- Check 3b: プラグインが生きていればポートはopen（Claude Code死活と無関係）
- Check 4: Claude Codeが正常終了した場合のみ検知

SSE方式ではClaude Code切断時にSSE接続が即座にドロップ（TCP FIN/RST）するため、この問題が構造的に解消される。

#### レスポンス仕様

```json
GET /health

{
  "status": "ok",
  "uptime": 3600,
  "connected_bots": {
    "arc": { "connected_at": "2026-04-04T10:00:00Z", "last_activity": "2026-04-04T10:05:00Z" },
    "cto": { "connected_at": "2026-04-04T10:01:00Z", "last_activity": "2026-04-04T10:04:30Z" }
  },
  "expected_bots": ["arc", "cto", "dev"]
}
```

| フィールド | 型 | 説明 |
|-----------|---|------|
| status | string | "ok" / "degraded" / "error" |
| uptime | number | デーモン起動からの経過秒数 |
| connected_bots | object | SSE接続中のBot一覧（bot_idをキー） |
| connected_bots[].connected_at | string | SSE接続確立時刻（ISO 8601） |
| connected_bots[].last_activity | string | 最後にMCPリクエストを受けた時刻（ISO 8601） |
| expected_bots | string[] | 設定ファイルで定義された全Bot一覧 |

#### statusの判定ロジック

```
"ok"       -- expected_botsの全Botがconnected_bots内に存在
"degraded" -- expected_botsの一部がconnected_bots内に不在
"error"    -- デーモン内部エラー
```

#### watchdog連携

watchdog.shは `/health` を呼び出し、以下の条件で再起動をトリガーする:

1. `status` が `"degraded"` かつ、未接続Botの `last_activity` が10分以上前（または接続履歴なし）
2. `/health` 自体にアクセスできない場合（デーモンダウン → launchdが復旧するが、念のため）

これにより、現行watchdog Check 3a/3b/5相当の機能が単一のHTTPコールに集約される。

---

## 5. 移行戦略

### 方式: 1Botずつ段階的移行

```
Step 1: デーモン起動（launchd plist install）
  --> SSEエンドポイントが立ち上がる。既存stdio Botに影響なし

Step 2: テスト用Bot 1台の.mcp.jsonをSSEに切替
  --> 24-48時間様子見
  --> テストBot: IYASAKA ARC（最もリスクが低い）

Step 3: 残りのBotを順次切替

Step 4: 全Bot SSE化確認後、Phase 1 cleanup hook廃止
  --> 全Bot SSE化 + 1週間安定稼働確認後に廃止
```

### Phase 2c個別ポートの廃止

SSE化完了後、Phase 2cで割り当てたBot個別ポート（8789-8795）は不要になる。

```
Phase 3 全Bot移行完了
  --> 1週間安定稼働確認
  --> Bot個別ポート（8789-8795）を廃止
  --> watchdog.shのポートチェック対象をSSEヘルスチェックに完全移行
```

### Rollback手順

`.mcp.json`をstdio設定に戻すだけ。デーモンは動いたままでも影響なし。

---

## 6. 導入フロー（OSS向け）

### 目標: 3ステップで完了

```bash
# Step 1: インストール
npx @iyasaka/agent-comms init

# Step 2: 対話式セットアップ
? Discord Bot Token: ********
? ポート番号 (default: 8800):
? 認証トークン (auto-generate): [自動生成]
--> .env, launchd plist, Nginx設定を自動生成

# Step 3: 起動
npx @iyasaka/agent-comms start
--> デーモン起動 + ヘルスチェック + .mcp.json自動更新
```

### 設計原則

- デフォルト値で動く（設定項目を最小限に）
- 対話式CLIで迷わない（選択肢を提示）
- 設定ファイルは1つ（agent-comms.config.jsonに集約）
- エラー時に何をすべきか明示（診断コマンド付き）

---

## 7. 懸念事項と対策

| 懸念 | 対策 |
|------|------|
| SSE接続の安定性（macOSスリープ復帰、ネットワーク瞬断） | Exponential backoff reconnectで自動復旧 |
| MCP SDK SSEサポートの成熟度 | 1Botずつ移行で問題を早期発見、rollback容易 |
| デーモンのシングルポイント障害 | launchd KeepAliveで即再起動 + Bot側reconnect |
| デバッグの複雑化 | デーモンに構造化ログ実装、bot_idでフィルタ可能 |
| OSS化時の設定難易度 | 対話式CLI + docker-compose/セットアップスクリプトで一発構築 |

---

## 8. マルチクライアント対応（ADR-038）

### 背景

MCP SDKの`Server`クラスは`connect(transport)`で1つのtransportにのみbindされる制約がある。Phase 3 Step 1では1接続限定のガードを設けていたが、複数Botが同一SSEデーモンに接続する運用要件が発生。

### 方式: Per-Bot Server Factory パターン

Bot接続ごとに新規MCP Serverインスタンスを生成する。

```
[SSE Daemon (1 process, 1 port)]
  ├── 共有: db pool, sseTransports, connectedBots
  ├── GET /sse?bot_id=cto → createBotServer("cto")
  ├── GET /sse?bot_id=dev-a → createBotServer("dev-a")
  └── GET /sse?bot_id=dev-b → createBotServer("dev-b")
```

### 主要変更点

1. **`createBotServer(botId)` Factory関数**: Bot接続時にMCP Serverインスタンスを生成し、ツール登録・transport接続を行う
2. **`registerTools(server, ctx: BotContext)` 抽出**: ツール登録ロジックを共通関数化。BotContextにbot_id固有の設定を格納
3. **ガード条件変更**: 「全体1接続」→「同一bot_id重複のみブロック（graceful reconnect）」
4. **Discord AdapterのBot別インスタンス化**: allowFromがBot固有のため、Bot別にAdapterを生成

### リソース共有方針

| リソース | 共有/分離 | 理由 |
|----------|----------|------|
| db pool | 共有 | PostgreSQL接続プール。全Botで同一DBを使用 |
| sseTransports | 共有 | sessionId → transport のMap。全Botのtransportを管理 |
| connectedBots | 共有 | botId → {server, transport} のMap。ライフサイクル管理 |
| AGENT_ID / config | 分離 | Bot固有の識別子・設定 |
| MCP Server | 分離 | SDK制約により1 Server = 1 transport |
| Discord Adapter | 分離 | allowFrom（アクセス制御）がBot固有 |

### connectedBots型変更

```typescript
// 変更前
Map<string, { transport: SSEServerTransport, connected_at: string, last_activity: string }>

// 変更後
Map<string, { server: Server, transport: SSEServerTransport, connected_at: string, last_activity: string }>
```

### 接続ライフサイクル

```
1. GET /sse?bot_id=X
2. 同一bot_idの既存接続チェック
   → 既存あり: 旧transport.close() + 旧server cleanup → 新規生成
   → 既存なし: 新規生成
3. createBotServer(botId) → { server, transport }
4. connectedBots.set(botId, { server, transport, ... })
5. SSE切断時: connectedBots.delete(botId), sseTransports.delete(sessionId)
```

### 不採用案

| 方式 | 理由 |
|------|------|
| Multi-daemon（Bot別プロセス） | プロセス増殖問題が再発。SSE化の目的に反する |
| Proxy + stdio | レイテンシ増加・複雑性高。MCP SDKのstdio制約を回避できるがアーキテクチャが複雑 |

---

## 9. フェーズ計画

| フェーズ | 内容 | 状態 |
|---------|------|------|
| Phase 1 | startup hook cleanup（孤児プロセス事後掃除） | 実装済み |
| Phase 2 | PIDファイル + watchdog排他制御 | 実装中 |
| Phase 3 | SSE transport化（本仕様書の範囲） | 設計承認済み |
| Phase 3b | SSEマルチクライアント対応（ADR-038） | 設計承認済み |
| Phase 4 | リモート接続対応（TLS + 本格認証 + マルチテナント） | 未着手 |

---

## 10. 承認履歴

| 日付 | 承認者 | 内容 |
|------|--------|------|
| 2026-04-02 | CEO | デーモン分離構成、SSEエンドポイント設計 |
| 2026-04-04 | CEO | 全設計項目承認（認証、障害耐性、移行戦略、導入フロー、セキュリティレベル） |
| 2026-04-04 | CEO | リモート接続対応をPhase 4に分離 |
| 2026-04-06 | CTO | ADR-038: Per-Bot Server Factoryパターンによるマルチクライアント対応設計 |
