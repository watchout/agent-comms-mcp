# agent-com チャンネル・スレッド制御仕様（実装レベル）

> CEO承認待ち: 2026-04-08
> 原則: LLM判断ゼロ。全制御をコード（スクリプト）で強制
> Discordのデフォルト動作を再現: 発言した場所に返る

---

## 1. 設計原則

```
1. botが宛先を選択する手段を物理的に持たない
2. 受信した場所に返信する（Discordのデフォルト動作）
3. 自発的発言（cron等）はCLIでchannel/thread必須指定
4. 全制御はコード側で強制。CLAUDE.mdルールに依存しない
```

---

## 2. sendツール仕様

### 2.1 パラメータ定義

```typescript
// toパラメータは存在しない。botが宛先を指定できない
send({
  mentions: string[],      // 必須。空配列は拒否（NOT_MENTIONED）
  content: string,         // 必須。50,000文字上限
  reply_to?: string,       // 任意。元メッセージID
})
```

### 2.2 宛先決定ロジック（コアRouter内部）

```typescript
async function resolveSendDestination(
  sender: Agent,
  params: SendParams
): Promise<Destination | ErrorResult> {

  // ケース1: reply_toあり → 元メッセージの場所に送信
  if (params.reply_to) {
    const original = await db.query(
      "SELECT channel_id, thread_id, author_id, mentions FROM agent_messages WHERE id = $1",
      [params.reply_to]
    );
    
    if (!original) {
      return error("MESSAGE_NOT_FOUND", `reply_to '${params.reply_to}' が見つかりません`);
    }
    
    // reply_toメンション検証: 元メッセージで自分がメンションされているか
    const isMentioned = original.mentions.includes(sender.agent_id);
    const isAuthor = original.author_id === sender.agent_id;
    const isHuman = sender.agent_type === "human";
    
    if (!isMentioned && !isAuthor && !isHuman) {
      return error("NOT_MENTIONED_IN_ORIGINAL",
        "元メッセージであなたはメンションされていません。応答権限がありません");
    }
    
    return {
      channel_id: original.channel_id,
      thread_id: original.thread_id || null,
    };
  }

  // ケース2: reply_toなし → 直前受信メッセージの場所に送信
  if (sender.last_received_channel) {
    // 警告: reply_toなしは推奨されない（同時受信で混乱の可能性）
    await auditLog("send.no_reply_to", {
      agent_id: sender.agent_id,
      fallback_channel: sender.last_received_channel,
      fallback_thread: sender.last_received_thread,
    });
    
    return {
      channel_id: sender.last_received_channel,
      thread_id: sender.last_received_thread || null,
    };
  }

  // ケース3: 受信コンテキストなし → エラー
  return error("NO_CONTEXT",
    "送信先を決定できません。受信メッセージがありません。" +
    "定期タスクの場合は agent-com notify --channel <id> を使用してください");
}
```

### 2.3 送信実行（バリデーション付き）

```typescript
async function handleSend(sender: Agent, params: SendParams) {
  // Step 1: 宛先決定（LLM判断なし）
  const dest = await resolveSendDestination(sender, params);
  if (dest.error) return dest; // エラーフィードバックをpush

  // Step 2: membersチェック
  const channel = await db.query(
    "SELECT members FROM channels WHERE id = $1",
    [dest.channel_id]
  );
  if (!channel) {
    return error("CHANNEL_NOT_FOUND", `チャンネル '${dest.channel_id}' は存在しません`);
  }
  if (!channel.members.includes(sender.agent_id)) {
    return error("NOT_A_MEMBER", `あなたはチャンネル '${dest.channel_id}' のメンバーではありません`);
  }

  // Step 3: mentions全員が投稿先チャンネルのmembersか検証
  for (const mention of params.mentions) {
    if (!channel.members.includes(mention)) {
      return error("MENTION_NOT_MEMBER",
        `メンション先 '${mention}' はチャンネル '${dest.channel_id}' のメンバーではありません`);
    }
  }

  // Step 4: 自己送信防止
  if (params.mentions.length === 1 && params.mentions[0] === sender.agent_id) {
    return error("SELF_SEND", "自分自身には送信できません");
  }

  // Step 5: サイズ制限
  if (params.content.length > 50000) {
    return error("MESSAGE_TOO_LONG",
      `メッセージが長すぎます（${params.content.length}文字 / 上限50,000文字）`);
  }

  // Step 6: ループ検出
  const loopCheck = await checkLoopDetection(sender.agent_id, dest.channel_id);
  if (loopCheck.detected) {
    return error("LOOP_DETECTED",
      `ループを検出（${loopCheck.pair}間で${loopCheck.count}回の往復）。再送しないでください`);
  }

  // Step 7: レート制限
  const rateCheck = await checkRateLimit(sender.agent_id);
  if (rateCheck.exceeded) {
    return error("RATE_LIMITED",
      `送信制限超過（${rateCheck.current}/${rateCheck.max}/分）。${rateCheck.retry_after}秒後に再試行`);
  }

  // Step 8: DB INSERT
  const messageId = await db.query(
    `INSERT INTO agent_messages 
     (id, channel_id, thread_id, author_id, content, mentions, reply_to, sequence, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, nextval('msg_sequence'), now())
     RETURNING id, sequence`,
    [uuid(), dest.channel_id, dest.thread_id, sender.agent_id,
     params.content, params.mentions, params.reply_to]
  );

  // Step 9: pg_notify
  await db.query(
    "SELECT pg_notify('agent_events', $1)",
    [JSON.stringify({
      type: "message.created",
      message_id: messageId,
      channel_id: dest.channel_id,
      thread_id: dest.thread_id,
      from: sender.agent_id,
      mentions: params.mentions,
    })]
  );

  // Step 10: Discord投稿（daemon経由、bot固有Token）
  const externalChannelId = await resolveToDiscord(dest.channel_id, dest.thread_id);
  await sendToDiscord(sender.agent_id, externalChannelId, params.content);

  // Step 11: audit_log
  await auditLog("message.created", {
    message_id: messageId,
    channel_id: dest.channel_id,
    thread_id: dest.thread_id,
    from: sender.agent_id,
    mentions: params.mentions,
    reply_to: params.reply_to,
  });

  return { success: true, message_id: messageId };
}
```

---

## 3. 受信制御（routeInbound）

### 3.1 routeInbound()は純粋関数（副作用なし）

```typescript
interface RouteResult {
  pushTargets: string[];                    // pushすべきagent_id
  dropTargets: Record<string, string>;      // dropするagent_idとその理由
  dbInsert: boolean;                        // DB保存するか
}

function routeInbound(msg: UnifiedMessage, channel: Channel, agents: Agent[]): RouteResult {
  const pushTargets: string[] = [];
  const dropTargets: Record<string, string> = {};

  for (const memberId of channel.members) {
    const agent = agents.find(a => a.agent_id === memberId);
    if (!agent) continue;

    // 自己送信防止（自分のメッセージは受け取らない）
    if (memberId === msg.author_id) continue;

    // 0. DM → 無条件push
    if (channel.type === "dm") {
      pushTargets.push(memberId);
      continue;
    }

    // 1. 緊急メッセージ or 送信者がhuman → 全員push
    if (isEmergency(msg) || getAgent(msg.author_id)?.agent_type === "human") {
      pushTargets.push(memberId);
      continue;
    }

    // 2. observer_mode → pushしない
    if (agent.observer_mode) {
      dropTargets[memberId] = "OBSERVER_MODE";
      continue;
    }

    // 3. グループメンション（@all, @dev, @org）
    if (hasGroupMention(msg.mentions, agent)) {
      pushTargets.push(memberId);
      continue;
    }

    // 4. 個別メンション or reply_to元送信者
    const isMentioned = msg.mentions.includes(memberId);
    const isReplyTarget = msg.reply_to_author === memberId;

    if (!isMentioned && !isReplyTarget) {
      dropTargets[memberId] = "NOT_MENTIONED";
      continue;
    }

    // 全チェック通過 → push
    pushTargets.push(memberId);
  }

  return { pushTargets, dropTargets, dbInsert: true };
}
```

### 3.2 緊急メッセージの判定（決定論的）

```typescript
function isEmergency(msg: UnifiedMessage): boolean {
  if (msg.message_type === "emergency") return true;
  if (msg.content.startsWith("!stop")) return true;
  return false;
}
```

### 3.3 グループメンションの判定

```typescript
function hasGroupMention(mentions: string[], agent: Agent): boolean {
  if (mentions.includes("all")) return true;
  if (mentions.includes("dev") && agent.agent_type === "dev") return true;
  if (mentions.includes("org") && agent.agent_type === "org") return true;
  return false;
}
```

### 3.4 呼び出し元（daemon onMessage）

```typescript
// daemon側: フィルタ完了前にpushしない
client.on("messageCreate", async (msg) => {
  if (msg.author.id === client.user.id) return;

  // Step 1: 変換（pushは一切しない）
  const unified = await discordToUnified(msg);

  // Step 2: チャンネル/スレッド解決
  const channel = await resolveChannel(unified.channel_id);
  if (!channel) {
    await saveMessageRaw(unified); // 未知チャンネルでもDB保存
    return;
  }

  // Step 3: 未知スレッドの自動登録
  if (unified.thread_id && !await threadExists(unified.thread_id)) {
    await autoRegisterThread(unified.thread_id, channel.id, msg);
  }

  // Step 4: フィルタ（pushは一切しない、判定結果だけ返す）
  const agents = await getChannelAgents(channel.members);
  const result = routeInbound(unified, channel, agents);

  // Step 5: DB INSERT（全メッセージ、フィルタ結果に関わらず）
  await saveMessage(unified);

  // Step 6: push対象botのlast_received_contextを更新
  for (const agentId of result.pushTargets) {
    await db.query(
      `UPDATE agents SET 
         last_received_channel = $1, 
         last_received_thread = $2 
       WHERE agent_id = $3`,
      [unified.channel_id, unified.thread_id, agentId]
    );
  }

  // Step 7: push対象botにだけHTTP POST（ここで初めてpush）
  for (const agentId of result.pushTargets) {
    const port = await getChannelPort(agentId);
    const payload = buildPushPayload(unified, agentId);
    await pushToChannelServer(port, payload);
  }

  // Step 8: audit_log記録
  await auditLog("message.routed", {
    message_id: unified.message_id,
    pushTargets: result.pushTargets,
    dropTargets: result.dropTargets,
  });
});
```

---

## 4. agent-com notify CLI（cron/自発的発言用）

### 4.1 コマンド定義

```typescript
program
  .command("notify")
  .description("チャンネル/スレッドにメッセージを送信（cron/スクリプト用）")
  .requiredOption("--agent-id <id>", "送信者のagent_id")
  .requiredOption("--channel <id>", "送信先チャンネルID")
  .option("--thread <id>", "送信先スレッドID")
  .requiredOption("--mentions <agents...>", "メンション対象（カンマ区切り）")
  .requiredOption("--content <text>", "メッセージ内容")
  .action(async (opts) => {
    // バリデーション（sendツールと同じ）
    
    // 1. agent_id存在チェック
    const agent = await db.query(
      "SELECT * FROM agents WHERE agent_id = $1", [opts.agentId]
    );
    if (!agent) {
      console.error(`エラー: agent_id '${opts.agentId}' は登録されていません`);
      console.error("agent-com agents で一覧を確認してください");
      process.exit(1);
    }

    // 2. チャンネル存在 + membersチェック
    const channel = await db.query(
      "SELECT * FROM channels WHERE id = $1", [opts.channel]
    );
    if (!channel) {
      console.error(`エラー: チャンネル '${opts.channel}' は存在しません`);
      process.exit(1);
    }
    if (!channel.members.includes(opts.agentId)) {
      console.error(`エラー: '${opts.agentId}' はチャンネル '${opts.channel}' のメンバーではありません`);
      process.exit(1);
    }

    // 3. スレッド存在チェック（指定時のみ）
    if (opts.thread) {
      const thread = await db.query(
        "SELECT * FROM threads WHERE id = $1 AND channel_id = $2",
        [opts.thread, opts.channel]
      );
      if (!thread) {
        console.error(`エラー: スレッド '${opts.thread}' は存在しないか、チャンネル '${opts.channel}' に属していません`);
        process.exit(1);
      }
    }

    // 4. mentions全員がmembersか
    const mentions = opts.mentions.split(",");
    for (const m of mentions) {
      if (!channel.members.includes(m)) {
        console.error(`エラー: '${m}' はチャンネル '${opts.channel}' のメンバーではありません`);
        process.exit(1);
      }
    }

    // 5. DB INSERT
    const messageId = await db.query(
      `INSERT INTO agent_messages 
       (id, channel_id, thread_id, author_id, content, mentions, sequence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, nextval('msg_sequence'), now())
       RETURNING id`,
      [uuid(), opts.channel, opts.thread || null, opts.agentId, opts.content, mentions]
    );

    // 6. pg_notify
    await db.query(
      "SELECT pg_notify('agent_events', $1)",
      [JSON.stringify({
        type: "message.created",
        message_id: messageId,
        channel_id: opts.channel,
        from: opts.agentId,
        mentions: mentions,
      })]
    );

    // 7. Discord投稿
    const externalId = await resolveToDiscord(opts.channel, opts.thread);
    await sendToDiscord(opts.agentId, externalId, opts.content);

    // 8. push対象にHTTP POST
    for (const m of mentions) {
      const port = await getChannelPort(m);
      if (port) {
        await pushToChannelServer(port, {
          message_id: messageId,
          channel_id: opts.channel,
          thread_id: opts.thread,
          author_id: opts.agentId,
          mentions: mentions,
          content: opts.content,
          message_type: "message",
          timestamp: new Date().toISOString(),
        });
      }
    }

    console.log(`✅ 送信完了: ${messageId}`);
  });
```

### 4.2 cron使用例

```bash
# 毎朝9時にCTOに日次レポート
0 9 * * * agent-com notify \
  --agent-id "daily-reporter" \
  --channel "hotel-kanri" \
  --thread "daily-reports" \
  --mentions "cto" \
  --content "日次レポート: テスト全件パス、未解決Issue 3件"

# 毎時、全Dev Botにヘルスチェック通知
0 * * * * agent-com notify \
  --agent-id "health-monitor" \
  --channel "dev-ops" \
  --mentions "all" \
  --content "ヘルスチェック: 全サービス正常"
```

---

## 5. last_received_context管理

### 5.1 DBスキーマ

```sql
ALTER TABLE agents ADD COLUMN last_received_channel TEXT;
ALTER TABLE agents ADD COLUMN last_received_thread TEXT;

-- daemon再起動でも消失しない（DB永続化）
```

### 5.2 更新タイミング

```
push対象として選ばれた時のみ更新:
  routeInbound() → pushTargets に含まれる
  → UPDATE agents SET last_received_channel/thread

pushされなかった場合は更新しない:
  → NOT_MENTIONED でdropされたbotのcontextは変わらない
  → 最後にpushされた場所が保持される
```

### 5.3 起動直後の対策

```
botが起動直後、last_received_channel = NULL の場合:
  → sendツール → NO_CONTEXT エラー
  → 対策: daemon起動通知をpushする

daemon起動時:
  全アクティブbotに対してシステム通知をpush:
    {
      channel_id: agentのデフォルトチャンネル（agentsテーブルに追加）,
      author_id: "system",
      content: "セッション開始。メッセージを待機中です",
      message_type: "system_info",
      mentions: [agentId]
    }
  → last_received_channelが設定される
  → 以降のsendが正常動作
```

```sql
-- agents テーブルに追加
ALTER TABLE agents ADD COLUMN default_channel TEXT REFERENCES channels(id);
-- bot登録時に設定: agent-com agent register --default-channel hotel-kanri
```

---

## 6. エラーフィードバック仕様

### 6.1 全エラーコード（sendツール用）

```
CHANNEL_NOT_FOUND       チャンネルが存在しない
THREAD_NOT_FOUND        スレッドが存在しない
NOT_A_MEMBER            送信者がメンバーでない
MENTION_NOT_MEMBER      メンション先がチャンネルメンバーでない
NOT_MENTIONED           メンション配列が空
NOT_MENTIONED_IN_ORIGINAL  reply_to元メッセージでメンションされていない
MESSAGE_NOT_FOUND       reply_toのメッセージIDが存在しない
RATE_LIMITED            レート制限超過
LOOP_DETECTED           ループ検出
MESSAGE_TOO_LONG        サイズ制限超過
AUTH_FAILED             認証失敗
SELF_SEND               自己送信
NO_CONTEXT              受信コンテキストなし（cron用CLIを使え）
THREAD_ARCHIVED         スレッドがアーカイブ済み
```

### 6.2 フィードバック配信

```
全エラーで送信者にフィードバックをpush注入:
  → message_type = "system_error"
  → 通常メッセージと区別可能
  → system_errorにはバリデーションを適用しない（ループ防止）
  → DBにはINSERTしない（audit_logのみ記録）
```

---

## 7. 削除する機能（不要になったもの）

```
❌ agents.active_thread カラム → 削除
❌ focus ツール → 削除
❌ unfocus ツール → 削除
❌ routeInbound内のactive_threadフィルタ → 削除
❌ [指示]受信時のactive_thread自動設定 → 削除
❌ [報告]送信時のactive_threadリセット → 削除
❌ sendツールの to パラメータ → 削除
❌ CLAUDE.mdの「共有チャンネル静観ルール」→ 不要（コードで強制）
```

---

## 8. 追加する機能

```
✅ agents.last_received_channel カラム
✅ agents.last_received_thread カラム
✅ agents.default_channel カラム
✅ sendツールの宛先自動決定ロジック
✅ reply_toメンション検証
✅ reply_to元メッセージのthread_id自動解決
✅ mentions全員のmembersチェック
✅ agent-com notify CLI（cron/スクリプト用）
✅ daemon起動通知（last_received_context初期化）
✅ routeInbound()の純粋関数化（pushTargetsを返すだけ）
✅ NO_CONTEXT エラーコード
✅ MENTION_NOT_MEMBER エラーコード
✅ THREAD_ARCHIVED エラーコード
✅ MESSAGE_NOT_FOUND エラーコード
✅ NOT_MENTIONED_IN_ORIGINAL エラーコード
```

---

## 9. セキュリティ対策

### 9.1 CLI bashバイパス防止

```
botがbash経由で agent-com notify を実行する場合:
  → CLIにも同じバリデーションが適用される（§4.1参照）
  → --agent-id 必須（誰として送信するか明示）
  → membersチェック、mentionsチェック全て実行
  → sendツールと同じ安全性
```

### 9.2 .envファイル保護

```bash
# .envのパーミッションをowner onlyに設定
chmod 600 .env

# Claude Codeのsettings.jsonにdenyListを追加
# → botが .env ファイルを読めないようにする
{
  "permissions": {
    "deny": [
      { "tool": "Read", "path": "**/.env" },
      { "tool": "Bash", "pattern": "cat.*\\.env|less.*\\.env|more.*\\.env" }
    ]
  }
}
```

### 9.3 channel-server HMAC認証

```
daemon → channel-server 間:
  → HMAC-SHA256署名必須
  → botが curl localhost:{port}/push しても
    HMAC_SECRET を知らなければ 401
  → .env を読めないようにdenyListで保護
```

---

## 10. 実装チェックリスト

### DB変更
- [ ] agents に last_received_channel カラム追加
- [ ] agents に last_received_thread カラム追加
- [ ] agents に default_channel カラム追加
- [ ] agents から active_thread カラム削除
- [ ] agent_messages の sequence を PostgreSQL SERIAL に変更

### sendツール
- [ ] to パラメータ削除
- [ ] resolveSendDestination() 実装（§2.2）
- [ ] reply_to メンション検証（NOT_MENTIONED_IN_ORIGINAL）
- [ ] reply_to thread_id 自動解決
- [ ] mentions 全員の members チェック（MENTION_NOT_MEMBER）
- [ ] NO_CONTEXT エラー追加
- [ ] THREAD_ARCHIVED エラー追加
- [ ] MESSAGE_NOT_FOUND エラー追加
- [ ] 全エラーでフィードバックpush

### routeInbound()
- [ ] 純粋関数化（RouteResult を返すだけ、pushしない）
- [ ] active_thread フィルタ削除
- [ ] push対象の last_received_channel/thread 更新
- [ ] 呼び出し元（daemon onMessage）でpushTargetsに従ってpush

### agent-com notify CLI
- [ ] --agent-id 必須
- [ ] --channel 必須
- [ ] --thread 任意
- [ ] --mentions 必須
- [ ] --content 必須
- [ ] 全バリデーション（members、mentions、存在チェック）
- [ ] DB INSERT + pg_notify + Discord投稿 + push

### daemon
- [ ] 起動時にアクティブbot全員にシステム通知push
- [ ] onMessage内でrouteInbound()結果確定後にpush（§3.4）
- [ ] push前にlast_received_context更新

### 削除
- [ ] focus ツール削除
- [ ] unfocus ツール削除
- [ ] active_thread 関連コード全削除
- [ ] sendツールの to パラメータ削除

### セキュリティ
- [ ] .env パーミッション 600
- [ ] settings.json denyList に .env パターン追加
- [ ] CLI にsendツールと同じバリデーション

---

## 11. テストケース

### 正常系
- [ ] スレッド内受信 → sendで同じスレッドに送信される
- [ ] チャンネル受信 → sendで同じチャンネルに送信される
- [ ] reply_to指定 → 元メッセージの場所に送信される
- [ ] 伝言（A→B→C）→ 全員同じスレッドに送信される
- [ ] DM受信 → DMに返信される
- [ ] cron CLI → 指定チャンネル/スレッドに送信される
- [ ] 緊急メッセージ → 全員にpushされる
- [ ] human送信 → 全員にpushされる
- [ ] グループメンション → 該当グループ全員にpush
- [ ] observer_mode → pushされない

### 異常系
- [ ] mentions空配列 → NOT_MENTIONED エラー
- [ ] 非メンバーチャンネルに送信 → NOT_A_MEMBER エラー
- [ ] mentionsにチャンネル非メンバー → MENTION_NOT_MEMBER エラー
- [ ] reply_to元でメンションされていない → NOT_MENTIONED_IN_ORIGINAL エラー
- [ ] 存在しないreply_to → MESSAGE_NOT_FOUND エラー
- [ ] 起動直後にsend → NO_CONTEXT エラー
- [ ] アーカイブ済みスレッドに送信 → THREAD_ARCHIVED エラー
- [ ] 自分宛send → SELF_SEND エラー
- [ ] 50,000文字超 → MESSAGE_TOO_LONG エラー
- [ ] ループ検出 → LOOP_DETECTED エラー
- [ ] レート制限 → RATE_LIMITED エラー

### 同時実行
- [ ] 2チャンネルから同時受信 → last_received_contextが後勝ち（reply_to推奨の警告がaudit_logに記録）
- [ ] 2 botが同時send → sequence番号が重複しない（PostgreSQL保証）

### セキュリティ
- [ ] bash経由CLI実行 → 同じバリデーションが通る
- [ ] curlでchannel-server直叩き → HMAC検証で401
- [ ] .envファイル読み取り → denyListでブロック

---

## 改訂履歴

| 日付・時刻 | 内容 |
|-----------|------|
| 2026-04-08 | 初版: チャンネル・スレッド制御仕様（active_thread廃止、sendのto廃止、宛先自動決定、notify CLI、全テストケース） |
