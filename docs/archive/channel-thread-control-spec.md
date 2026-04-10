<!-- ARCHIVED: message-queue-spec v1.0.0 に統合 (2026-04-10) -->

# agent-com チャンネル・スレッド制御仕様（実装レベル）

> CEO承認: 2026-04-08（§5.1 human bypass削除承認済み）
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

## 2. メッセージパターン別制御仕様

### 2.1 パターン一覧

```
全メッセージは以下の5パターンに分類される。
各パターンでコード制御の方法が異なる。
LLMの判断は一切介在しない。

パターン                   宛先決定          push対象           LLM判断
─────────────────────────────────────────────────────────────────────
A. メンションなし投稿       自動（受信場所）   なし（DB保存のみ）  ゼロ
B. メンション付き投稿       自動（受信場所）   メンション対象のみ  ゼロ
C. リプライ（第三者なし）   自動（元msg場所）  mentions対象のみ    ゼロ
D. リプライ + 第三者メンション 自動（元msg場所） mentions対象のみ   ゼロ
E. 自発的発言（cron等）     CLI指定（必須）   メンション対象のみ  ゼロ
```

### 2.2 パターンA: メンションなし投稿

```
Discord/Telegramの標準動作:
  チャンネルに投稿 → 全メンバーに「表示」される → ただし「通知」は飛ばない

agent-comの動作:
  「表示」= DB保存（全員がhistoryで見える）
  「通知」= push注入（botのセッションに届く）
  → メンションなし = DB保存のみ。pushしない

理由:
  botにpush = 必ず反応する = コンテキスト消費 + 不要な行動
  人間なら「スクロールして見る」ができるが、botにはその概念がない
  push = 存在を知る = 反応する → 不要なpushは害

処理:
  1. DB INSERT（メッセージは永続化される）
  2. pushしない（どのbotにも通知されない）
  3. 送信者がhumanの場合 → システム警告を返す:
     「⚠️ メンションがないためbotには通知されていません。
      特定のbotに通知: @cto 等を付けてください。
      全員に通知: @all を使ってください」
  4. 送信者がbotの場合 → 発生しない
     （sendツールのmentions必須パラメータで構造的に防止）
```

```typescript
// インバウンド処理（daemon onMessage内）
// routeInbound()のStep 4でdrop
if (!isMentioned && !isReplyTarget) {
  dropTargets[memberId] = "NOT_MENTIONED";
  continue;
}

// human送信者への警告（routeInbound完了後）
if (result.pushTargets.length === 0 && senderAgent.agent_type === "human") {
  await pushSystemWarning(msg.author_id, 
    "⚠️ メンションがないためbotには通知されていません。\n" +
    "特定のbotに通知: @cto 等を付けてください。\n" +
    "全員に通知: @all を使ってください"
  );
}
```

### 2.3 パターンB: メンション付き投稿

```
Discord/Telegramの標準動作:
  @user付きで投稿 → その人に通知が飛ぶ → 他の人にも表示はされる

agent-comの動作:
  @agent_id付き → メンションされたbotにだけpush
  他のメンバー → DB保存のみ（historyで取得可能）

処理:
  1. DB INSERT（全メンバー共通、1行）
  2. メンションされたbotにだけpush
  3. 他のメンバーにはpushしない
  4. グループメンション対応:
     @all → チャンネル全メンバーにpush
     @dev → agent_type="dev" の全メンバーにpush
     @org → agent_type="org" の全メンバーにpush
```

```typescript
// インバウンド処理（routeInbound内）

// グループメンション
if (hasGroupMention(msg.mentions, agent)) {
  pushTargets.push(memberId);
  continue;
}

// 個別メンション
if (msg.mentions.includes(memberId)) {
  pushTargets.push(memberId);
  continue;
}

// メンションされていない → DB保存のみ
dropTargets[memberId] = "NOT_MENTIONED";
```

### 2.4 パターンC: リプライ（第三者なし）

```
Discord/Telegramの標準動作:
  メッセージに返信 → 元送信者に通知 → 元メッセージの引用が表示される

agent-comの動作:
  reply_to指定 → 「どこに送るか」を決める（元メッセージの場所）
  mentions指定 → 「誰に送るか」を決める（常に必須）
  引用テキスト → push注入時に自動付与（500文字まで）
  → システムが勝手にpush対象を追加しない

処理:
  1. mentions配列の対象にのみpush（元送信者の自動追加なし）
  2. 元メッセージの場所（channel_id/thread_id）を宛先に自動設定
  3. 引用テキストをpush注入時に先頭に付与
  4. mentions空配列は常に拒否（reply_toの有無に関わらず）

例:
  Hotel Dev「JWT実装完了しました」(msg-001, スレッドA)
  CTO → send(reply_to: "msg-001", mentions: ["hotel-dev"], content: "了解")
  → mentions必須: ["hotel-dev"]
  → push対象 = ["hotel-dev"]（明示された対象のみ）
  → 宛先 = スレッドA（自動）

  Hotel Devに届くもの:
    > [引用 from:hotel-dev at:2026-04-08T10:30:00]
    > JWT実装完了しました
    
    了解
```

```typescript
// mentions は常に必須。例外なし。
if (params.mentions.length === 0) {
  return error("NOT_MENTIONED", 
    "mentions配列にagent_idを1つ以上指定してください");
}
// reply_to は「どこに送るか」を決めるだけ
// 「誰に送るか」は常にmentionsで明示
```

### 2.5 パターンD: リプライ + 第三者メンション

```
Discord/Telegramの標準動作:
  返信しつつ@別の人 → 元送信者に通知 + 第三者にも通知
  ただしDiscordでは第三者に元メッセージの引用が届かない（文脈が切れる）

agent-comの動作（Discordより優れている）:
  reply_to + mentions → mentionsに指定された対象のみpush
  全員に引用テキストが付く → 第三者にも文脈が明確に届く
  → 元送信者の自動追加はしない
  → 元送信者にも通知したければmentionsに含める

処理:
  1. mentions配列の対象にのみpush（元送信者の自動追加なし）
  2. 全push対象に引用テキスト付きでpush注入
  3. 宛先 = 元メッセージの場所（自動）

例1: 第三者だけに聞く（元送信者には通知しない）
  Hotel Dev「JWT実装完了しました」(msg-001, スレッドA)
  CTO → send(reply_to: "msg-001", mentions: ["arc"], content: "レビューして")
  → push対象 = ["arc"]（明示された対象のみ）
  → Hotel Devにはpushされない（DB保存のみ）
  → 会話が分岐しない ✅

  ARCに届くもの:
    > [引用 from:hotel-dev at:2026-04-08T10:30:00]
    > JWT実装完了しました
    
    レビューして
    → 何のレビューか文脈が明確 ✅

例2: 元送信者にも第三者にも通知する（明示的に指定）
  CTO → send(reply_to: "msg-001", mentions: ["arc", "hotel-dev"], content: "レビューして。結果待ってて")
  → push対象 = ["arc", "hotel-dev"]（両方明示）
  → 意図が明確 ✅
```

```
設計判断の理由:

  元送信者を自動追加すると:
    Hotel Dev → 「修正必要ですか？」（会話1）
    ARC → 「セキュリティに問題あり」（会話2）
    → 2つの会話が同時発生 → コンテキスト消費2倍
    → 会話が混在して管理不能

  mentionsで明示すると:
    「誰に送るか」はLLMが判断
    「システムが勝手に追加しない」
    → 意図した相手にだけ届く
    → 会話が制御可能
```

### 2.6 パターンE: 自発的発言（cron/定期タスク）

```
Discord/Telegramの標準動作:
  botが自発的にチャンネルに投稿 → そのチャンネルに表示される

agent-comの動作:
  sendツールでは送信できない（受信コンテキストがないためNO_CONTEXTエラー）
  agent-com notify CLI で channel/thread を必須指定して送信
  → botのLLMが宛先を選ぶ手段が物理的にない

処理:
  1. CLIで --channel, --mentions 必須（--thread は任意）
  2. 全バリデーション実行（members, mentions全員のmembersチェック等）
  3. DB INSERT + Discord投稿 + push対象にHTTP POST

例:
  毎朝9時にCTOに日次レポート:
    agent-com notify \
      --agent-id "daily-reporter" \
      --channel "hotel-kanri" \
      --thread "daily-reports" \
      --mentions "cto" \
      --content "日次レポート: テスト全件パス"
```

### 2.7 パターン比較まとめ

```
パターン       mentions    reply_to   宛先決定           push対象
──────────────────────────────────────────────────────────────────
A. メンションなし  なし       —         —                なし（DB保存のみ + human警告）
B. メンション付き  あり       必須      元msg場所（自動）  mentions対象
C. リプライのみ   あり（必須） 必須      元msg場所（自動）  mentions対象（自動追加なし）
D. リプライ+第三者 あり（必須） 必須      元msg場所（自動）  mentions対象（自動追加なし）
E. cron/CLI      あり       —         CLI指定（必須）    mentions対象

全パターン共通:
  ✅ botが宛先を選択する手段がない
  ✅ mentionsは常に必須。例外なし
  ✅ reply_toは常に必須（パターンB/C/D）。例外なし
  ✅ 宛先は完全に決定論的（last_received_contextフォールバック廃止）
  ✅ 「誰に送るか」はmentionsで明示。「どこに送るか」はreply_toで決定
  ✅ システムが勝手にpush対象を追加しない
  ✅ LLM判断ゼロ（宛先・配信制御）
  ✅ DB保存は全パターンで実行（監査ログ）
```

### 2.8 引用テキスト付与仕様

```typescript
// push注入時に引用を先頭に付与（reply_toがある場合のみ）
function formatPushContent(msg: UnifiedMessage, original?: Message): string {
  let content = "";
  
  if (original) {
    // 引用テキスト（500文字でtruncate）
    const quote = original.content.length > 500 
      ? original.content.substring(0, 497) + "..." 
      : original.content;
    content += `> [引用 from:${original.author_id} at:${original.created_at}]\n`;
    content += `> ${quote.split("\n").join("\n> ")}\n\n`;
  }
  
  content += msg.content;
  
  // 添付ファイルがあれば末尾に追加
  if (msg.attachments && msg.attachments.length > 0) {
    content += "\n\n📎 添付ファイル:\n";
    for (const att of msg.attachments) {
      content += `- ${att.filename} (${formatBytes(att.size_bytes)}): ${att.path}\n`;
    }
  }
  
  return content;
}
```

```
引用付与の効果:
  Discord標準: 第三者には元メッセージの引用が届かない → 文脈断絶
  agent-com:   全push対象に引用テキストが届く → 文脈が完全に保持される

  これはDiscordより優れた動作。
  複数の話題が流れていても、引用付きなら「何についての返信か」が明確。
```

---

## 3. メンション制御仕様

> このセクションはメンション固有のルールを定義する。
> チャンネル/スレッド制御は§2（パターン別）と§4（sendツール）に記載。
> 重複を避けるため、ここではメンションの「形式・解決・配信判定」のみ扱う。

### 3.1 agent_idをLLMが知るスクリプト制御

```
問題:
  botが "cto", "arc" というagent_idを知らなければメンションできない
  CLAUDE.mdに書く → ベストエフォート → 忘れる → 間違える

解決: 2つの仕組みで確実に知らせる

  仕組み1: sendツールのdescriptionに動的注入
    → MCP server起動時にagentsテーブルから一覧取得
    → sendツールのdescriptionに埋め込み
    → LLMがツールスキーマを読んだ時点で必ず知る
    → CLAUDE.md依存ではなくツールスキーマで強制

  仕組み2: agentsツールで最新一覧を取得
    → Session Boot時に agents() を呼ぶ
    → agent-memoryのSessionStart hookで自動実行
    → 起動後にbotが追加された場合もこちらで取得
```

```typescript
// sendツール定義時にagent_id一覧を動的注入
const agentList = await db.query(
  "SELECT agent_id, display_name FROM agents WHERE status != 'offline'"
);
const agentListStr = agentList
  .map(a => `${a.agent_id} (${a.display_name})`)
  .join(", ");

server.tool("send", {
  description:
    `メッセージを送信します。\n` +
    `mentions には以下のagent_idを指定してください:\n` +
    `${agentListStr}\n` +
    `グループ: all（全員）, dev（開発者全員）, org（組織層全員）\n` +
    `最新一覧は agents() ツールで確認できます`,
  params: {
    mentions: { type: "array", items: { type: "string" } },
    content: { type: "string" },
    reply_to: { type: "string", optional: true },
  }
});
```

### 3.2 メンション形式の変換（コア層全自動）

```
原則:
  botは agent_id 形式のみ使用（"cto", "arc", "hotel-dev"）
  プラットフォーム固有形式を知る必要がない
  変換はコア層（adapter）が全自動で実行

送信時（outbound: bot → Discord）:
  bot: send(mentions: ["cto"], content: "@cto レビューして")
    → adapter:
      1. "cto" → agent_adapters で mention_format 取得
         → "<@1485599598259994635>"
      2. content内の "@cto" を "<@1485599598259994635>" に変換
      3. Discord APIに送信
    → botは agent_id だけ知っていればいい

受信時（inbound: Discord → bot）:
  Discord: "<@1485599598259994635>" を含むメッセージ
    → adapter:
      1. 正規表現 /<@!?(\d+)>/g で全Discord IDを抽出
      2. agent_adapters で external_id → agent_id に変換
         → "1485599598259994635" → "cto"
      3. UnifiedMessage.mentions = ["cto"]
    → botには agent_id 形式でしか届かない

テキストメンションの検出（@all等）:
  content内の "@all", "@dev", "@org" も検出してmentionsに追加
```

```typescript
// 受信時のメンション抽出（daemon内）
async function extractMentions(msg: DiscordMessage): Promise<string[]> {
  const mentions: string[] = [];
  
  // Discord <@userId> パターンを全て抽出
  const discordMentions = msg.content.matchAll(/<@!?(\d+)>/g);
  for (const match of discordMentions) {
    const discordUserId = match[1];
    const agent = await db.query(
      "SELECT agent_id FROM agents WHERE discord_user_id = $1",
      [discordUserId]
    );
    if (agent) {
      mentions.push(agent.agent_id);
    }
    // 解決できないIDはスキップ（未登録bot/ユーザー）
  }
  
  // グループメンション検出
  if (msg.content.includes("@all")) mentions.push("all");
  if (msg.content.includes("@dev")) mentions.push("dev");
  if (msg.content.includes("@org")) mentions.push("org");
  
  return mentions;
}
```

### 3.3 古い形式の拒否（fuzzy解決を廃止）

```
原則:
  正しいagent_id形式（完全一致）のみ許可
  古い形式・誤った形式は自動修正しない
  エラーで拒否 + 正しいagent_id一覧を返す + 修正送信を促す

理由:
  fuzzy解決（自動修正）→ LLMが間違った形式を使い続ける
  エラー通知 → LLMが正しい形式を学習する
  初回だけ1往復余計にかかるが、2回目以降は発生しない

拒否される形式の例:
  "&arc"           → INVALID_MENTION_FORMAT（旧内部タグ）
  "@IYASAKA ARC"   → INVALID_MENTION_FORMAT（表示名）
  "@IYASAKA CTO"   → INVALID_MENTION_FORMAT（表示名）
  "<@148836...>"   → INVALID_MENTION_FORMAT（Discord形式を直接使用）

許可される形式:
  "arc"            → OK（agent_id完全一致）
  "cto"            → OK
  "hotel-dev"      → OK
  "all"            → OK（グループメンション予約語）
  "dev"            → OK（グループメンション予約語）
  "org"            → OK（グループメンション予約語）
```

```typescript
// メンションバリデーション（sendツール内）
async function validateMentions(mentions: string[]): Promise<string[] | Error> {
  const groupMentions = ["all", "dev", "org"];
  const resolved: string[] = [];
  
  for (const mention of mentions) {
    // グループメンションは予約語として許可
    if (groupMentions.includes(mention)) {
      resolved.push(mention);
      continue;
    }
    
    // agent_idとして完全一致のみ許可（fuzzy解決しない）
    const agent = await db.getAgent(mention);
    
    if (!agent) {
      const agentList = await db.query(
        "SELECT agent_id, display_name FROM agents"
      );
      return error("INVALID_MENTION_FORMAT",
        `'${mention}' は正しいagent_id形式ではありません。\n` +
        `正しいagent_id一覧:\n` +
        agentList.map(a => `  ${a.agent_id} (${a.display_name})`).join("\n") +
        `\n正しいagent_idで再送してください`
      );
    }
    
    resolved.push(agent.agent_id);
  }
  
  return resolved;
}
```

### 3.4 グループメンション

```
予約語:
  @all → チャンネル全メンバーにpush
  @dev → agent_type="dev" の全メンバーにpush
  @org → agent_type="org" の全メンバーにpush

処理（routeInbound内）:
  mentions配列に "all", "dev", "org" が含まれるか判定
  → 該当するagent_typeのメンバーをpush対象に追加
```

```typescript
function hasGroupMention(mentions: string[], agent: Agent): boolean {
  if (mentions.includes("all")) return true;
  if (mentions.includes("dev") && agent.agent_type === "dev") return true;
  if (mentions.includes("org") && agent.agent_type === "org") return true;
  return false;
}
```

### 3.5 チャンネル外メンバーへのメンション

```
原則:
  agentsテーブルに存在すればメンション可能
  チャンネルのmembersに限定しない

処理:
  mentions対象がチャンネルメンバーの場合 → チャンネル内でpush（通常動作）
  mentions対象がチャンネル外の場合 → DM経由でpush（チャンネル情報 + 引用付き）

DM経由push時に届く内容:
  📨 #dev-arc でメンションされました（from: cto）
  > マーケ観点の意見ほしい
  → reply_to: 元メッセージID
  → 返信先: #dev-arc（自動）

チャンネル外メンバーの返信:
  reply_to経由の一時投稿許可
  → メンションされた場合のみ元チャンネルに返信可能
  → 自発的にそのチャンネルに送信することはできない
```

### 3.6 botのメンションなし送信

```
原則:
  botからのメンションなし送信 → sendツールが拒否（DB保存もしない）
  humanからのメンションなし投稿 → DB保存のみ + 警告

理由:
  sendツールのmentionsパラメータが必須なので
  botのメンションなし送信は構造的に発生しない
  humanはDiscord UIから直接投稿するためsendツールを通らない
  → inbound経由でDB保存 + human送信者に警告返却
```

### 3.7 メンション方式 決定事項まとめ

```
1. agent_idをLLMが知るスクリプト制御
   → sendツールのdescriptionに動的注入（agentsテーブルから一覧取得）
   → Session Boot時にagents()で取得
   → CLAUDE.md依存ではなくツールスキーマで強制

2. 変換はコア層が全自動
   → agent_id ↔ プラットフォーム形式

3. 古い形式はエラーで拒否（fuzzy解決を廃止）
   → INVALID_MENTION_FORMAT エラー
   → 正しいagent_id一覧を返して修正送信を促す
   → LLMが正しい形式を学習する

4. mentions必須
   → 空配列 + reply_toなし → NOT_MENTIONED エラー
   → 空配列 + reply_toあり → NOT_MENTIONED エラー（例外なし）

5. リプライ時は元送信者を自動追加しない
   → mentionsで明示した対象のみpush
   → システムが勝手にpush対象を追加しない

6. botのメンションなし送信は基本NG
   → sendツールが拒否（DB保存もしない）
   → humanのメンションなし → DB保存 + 警告

7. チャンネル外メンバーへのメンション → 許可
   → agentsテーブルに存在すればOK
   → DM経由でpush

8. グループメンション
   → @all / @dev / @org
```

---

## 4. sendツール仕様

### 4.1 パラメータ定義

```typescript
// toパラメータは存在しない。botが宛先を指定できない
send({
  mentions: string[],      // 必須。空配列は常に拒否。例外なし
  content: string,         // 必須。50,000文字上限
  reply_to: string,        // 必須。元メッセージID（「どこに送るか」を決定論的に決める）
})

// ルール:
//   mentions は常に必須。例外なし。
//   reply_to は常に必須。例外なし。宛先は完全に決定論的。
//   「誰に送るか」は常に mentions で明示。
//   「どこに送るか」は常に reply_to で決定。
//   システムが勝手にpush対象を追加しない。
//   last_received_contextフォールバックは廃止（非決定論的であるため）。
```

### 4.2 宛先決定ロジック（コアRouter内部）

```typescript
async function resolveSendDestination(
  sender: Agent,
  params: SendParams
): Promise<Destination | ErrorResult> {

  // reply_to必須チェック
  if (!params.reply_to) {
    return error("NO_REPLY_TO",
      "reply_toは必須です。返信先メッセージIDを指定してください。" +
      "定期タスクの場合は agent-com notify --channel <id> を使用してください");
  }

  // reply_toあり → 元メッセージの場所に送信（唯一の宛先決定パス）
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
```

### 4.3 送信実行（バリデーション付き）

```typescript
async function handleSend(sender: Agent, params: SendParams) {
  // Step 0: mentions必須チェック（常に必須。例外なし）
  if (!params.mentions || params.mentions.length === 0) {
    return error("NOT_MENTIONED",
      "mentions配列にagent_idを1つ以上指定してください。例外なし。");
  }

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

  // Step 3: mentions対象の存在確認 + 配信先分類
  const inChannelTargets = [];
  const outChannelTargets = [];
  for (const mention of params.mentions) {
    const agent = await db.getAgent(mention);
    if (!agent) {
      return error("AGENT_NOT_FOUND", `'${mention}' は登録されていません`);
    }
    if (channel.members.includes(mention)) {
      inChannelTargets.push(mention);  // チャンネル内push
    } else {
      outChannelTargets.push(mention); // DM経由push
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

## 5. 受信制御（routeInbound）

### 5.1 routeInbound()は純粋関数（副作用なし）

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

    // 1. 緊急メッセージ → 全員push（唯一のmentionsバイパス）
    // humanもbotも同一ルール。メンションベースでフィルタ。
    // humanがメンションなしで投稿 → DB保存のみ + 警告返信（パターンA）
    if (isEmergency(msg)) {
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

### 5.2 緊急メッセージの判定（決定論的）

```typescript
function isEmergency(msg: UnifiedMessage): boolean {
  if (msg.message_type === "emergency") return true;
  if (msg.content.startsWith("!stop")) return true;
  return false;
}
```

### 5.3 グループメンションの判定

```typescript
function hasGroupMention(mentions: string[], agent: Agent): boolean {
  if (mentions.includes("all")) return true;
  if (mentions.includes("dev") && agent.agent_type === "dev") return true;
  if (mentions.includes("org") && agent.agent_type === "org") return true;
  return false;
}
```

### 5.4 呼び出し元（daemon onMessage）

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

## 6. agent-com notify CLI（cron/自発的発言用）

### 6.1 コマンド定義

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

### 6.2 cron使用例

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

## 7. last_received_context管理

### 7.1 DBスキーマ

```sql
ALTER TABLE agents ADD COLUMN last_received_channel TEXT;
ALTER TABLE agents ADD COLUMN last_received_thread TEXT;

-- daemon再起動でも消失しない（DB永続化）
```

### 7.2 更新タイミング

```
push対象として選ばれた時のみ更新:
  routeInbound() → pushTargets に含まれる
  → UPDATE agents SET last_received_channel/thread

pushされなかった場合は更新しない:
  → NOT_MENTIONED でdropされたbotのcontextは変わらない
  → 最後にpushされた場所が保持される
```

### 7.3 起動直後の対策

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

## 8. エラーフィードバック仕様

### 8.1 全エラーコード（sendツール用）

```
CHANNEL_NOT_FOUND       チャンネルが存在しない
THREAD_NOT_FOUND        スレッドが存在しない
NOT_A_MEMBER            送信者がメンバーでない
AGENT_NOT_FOUND         メンション先がagentsテーブルに存在しない
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

### 8.2 フィードバック配信

```
全エラーで送信者にフィードバックをpush注入:
  → message_type = "system_error"
  → 通常メッセージと区別可能
  → system_errorにはバリデーションを適用しない（ループ防止）
  → DBにはINSERTしない（audit_logのみ記録）
```

---

## 9. 削除する機能（不要になったもの）

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

## 10. 追加する機能

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
✅ チャンネル外メンション → DM経由push分岐
✅ THREAD_ARCHIVED エラーコード
✅ MESSAGE_NOT_FOUND エラーコード
✅ NOT_MENTIONED_IN_ORIGINAL エラーコード
```

---

## 11. セキュリティ対策

### 11.1 CLI bashバイパス防止

```
botがbash経由で agent-com notify を実行する場合:
  → CLIにも同じバリデーションが適用される（§4.1参照）
  → --agent-id 必須（誰として送信するか明示）
  → membersチェック、mentionsチェック全て実行
  → sendツールと同じ安全性
```

### 11.2 .envファイル保護

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

### 11.3 channel-server HMAC認証

```
daemon → channel-server 間:
  → HMAC-SHA256署名必須
  → botが curl localhost:{port}/push しても
    HMAC_SECRET を知らなければ 401
  → .env を読めないようにdenyListで保護
```

---

## 12. 実装チェックリスト

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
- [ ] mentions 対象の存在確認 + チャンネル内/外分類（DM経由push分岐）
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

## 13. テストケース

### 正常系
- [ ] スレッド内受信 → sendで同じスレッドに送信される
- [ ] チャンネル受信 → sendで同じチャンネルに送信される
- [ ] reply_to指定 → 元メッセージの場所に送信される
- [ ] 伝言（A→B→C）→ 全員同じスレッドに送信される
- [ ] DM受信 → DMに返信される
- [ ] cron CLI → 指定チャンネル/スレッドに送信される
- [ ] 緊急メッセージ → 全員にpushされる
- [ ] humanメンションなし送信 → DB保存のみ + 警告返信（パターンA）
- [ ] グループメンション → 該当グループ全員にpush
- [ ] observer_mode → pushされない

### 異常系
- [ ] mentions空配列 → NOT_MENTIONED エラー
- [ ] 非メンバーチャンネルに送信 → NOT_A_MEMBER エラー
- [ ] mentionsにチャンネル外メンバー → DM経由push（AGENT_NOT_FOUND if不存在）
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
| 2026-04-08 | 追記: メッセージパターン別制御仕様 §2（5パターン、引用テキスト付与） |
| 2026-04-08 | 改訂: パターンC/Dの元送信者自動追加を廃止。mentions常に必須・例外なし。reply_toは「どこに送るか」だけ。システムがpush対象を勝手に追加しない |
| 2026-04-08 | 追記: メンション制御仕様 §3（agent_idスクリプト制御、変換、fuzzy廃止、グループ、チャンネル外メンション、決定事項まとめ8項目）統合完了 |
