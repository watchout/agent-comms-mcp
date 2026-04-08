# ARC reply behavior 調査レポート

**依頼**: CEO → CTO → agent-com-dev (2026-04-08)
**実施**: agent-com-dev
**日付**: 2026-04-09
**スコープ**: ARC の reply_to 挙動が「話題に関係なく常に最後に届いたメッセージに reply している」という CEO 仮説の実証検証 + 改善案

---

## 0. TL;DR (15 秒読み)

- **CEO 仮説は半分正しく、根本原因は予想外**。
- ARC の LLM 自体は `reply_to` を topically intelligent に選べている (27 件中 12 件が最新、残りは topic-anchored)。
- **根本原因は Discord adapter の hardcoded auto-reply-to-latest** (`adapters/discord.ts:476-490`、commit `b4d669e` 2026-04-01)。`send` tool は `reply_to` UUID を受け取っても **Discord native reply reference に translate しない**ので、adapter fallback が常に発火し、Discord UI 上で「最新 message への reply」として見える。
- **これは LLM bug でも intentional behavior でもなく、framework gap**。fix は server-side で reply_to UUID → discord_message_id 解決を 1 層噛ませるだけで clean に解決する (PR-B.2 で追加した `discord_message_id` 列が活用できる)。
- Bonus finding: ARC は agent-memory task 完了報告を **task-origin UUID に anchor** して ~38 時間後まで reply し続けている (8/27 = 30%)。これは意図された挙動だが、reply_to が Discord native reply に伝わらないので CEO には見えていない。

---

## 1. 調査方法

### データソース
- `agent_messages` 直近 7 日 (2026-04-02 05:28 〜 2026-04-09 05:54 JST)
- `author_id = 'arc'` + `direction = 'outbound'` の行 = **201 件**
- うち `reply_to IS NOT NULL` の行 = **27 件 (13.4%)**
- 残り 174 件 (86.6%) は `reply_to = NULL` (後述: Discord native reply は adapter fallback で設定される)

### 分析クエリ
1. ARC outbound × target (reply_to で JOIN) の時系列 gap 測定
2. "ARC への最新 inbox message" との一致率測定 (CEO 仮説の直接検証)
3. target から ARC outbound までの間に挟まった "ARC 宛 inbox" の件数分布 (anchor の古さ測定)
4. ARC outbound と target の content excerpt を並べて topic matching の目視確認
5. `reply_to` が server.ts / adapters/ でどう処理されるかの source grep

### 調査時間
約 40 分 (budget 1-2h 内)

---

## 2. 統計サマリ

### 2.1 ARC outbound 内訳 (7 日)

| 指標 | 件数 | 割合 |
|---|---:|---:|
| 総 outbound | 201 | 100% |
| reply_to NULL | 174 | 86.6% |
| reply_to SET | 27 | 13.4% |
| reply_to が DB で見つからない (孤児) | 0 | 0% |

### 2.2 reply_to SET 27 件の gap 分布 (ARC outbound ts − target ts、秒)

| 指標 | 秒 | 人間読み |
|---|---:|---:|
| min | 9.8 | ~10 秒 |
| p50 | 326.5 | ~5.4 分 |
| avg | 35603.7 | ~9.9 時間 |
| max | 139064.6 | ~38.6 時間 |

p50 は 5 分台で健全。avg が 9.9 時間に跳ねているのは Pattern C (§3.3) の古い anchor が引きずっているから。

### 2.3 CEO 仮説「最新 inbox message = reply_to」の直接検証

| | 件数 | 割合 |
|---|---:|---:|
| **reply_to == ARC への最新 inbox** | **12** | **44.4%** |
| reply_to != ARC への最新 inbox | 15 | 55.6% |
| ARC への inbox が見つからない | 0 | 0% |

**CEO 仮説は 44% しか当たらない** — 半分以上のケースで、ARC は最新より古い message に reply している。これは LLM が topically intelligent に選んでいる証拠。

### 2.4 divergence の古さ分布 (target と ARC outbound の間に挟まった "ARC 宛 inbox" 件数)

| 間の inbox 件数 | 件数 | 分類 |
|---:|---:|---|
| 0 (最新) | 12 | Pattern A |
| 1-8 | 7 | Pattern B (near-latest) |
| 394-402 | 8 | **Pattern C (stale anchor)** |

Pattern C の 8 件は bimodal で、古い target 側に極端に張り付いている。詳細は §3.3。

---

## 3. 乖離パターン分類

### 3.1 Pattern A: reply_to == 最新 inbox (12/27 = 44.4%)

ARC が直前に届いた自分宛 message に即応している。**topic matching は完璧**。

例 (target / ARC の content excerpt):

| ARC msg id (先頭) | ARC 返信 excerpt | target excerpt |
|---|---|---|
| `050d202e` | CTO 了解しました ✅ ARC が判断 + 起票します。 | CEO 指示によりチケット化を ARC に依頼します |
| `4230a4f1` | send tool 検証成功 ✅ UUID 経由で正規 path 通信できました | これ致命的ですね。半分の会話が DB に残らない |
| `318f8737` | Arc です。復旧完了を確認しました。全機能正常、待機中です。 | CTO です。Arc 復旧完了しました |
| `0d82aa97` | 受信確認。先ほどのチャンネル (1490822000577613834) では返信できません | 届きました。ARC と agentcomdev も再起動すれば適用される？ |

12 件全て手動確認 → **12/12 で topic matching OK**。CEO 仮説の「話題関係なく reply」は Pattern A には当てはまらない。

### 3.2 Pattern B: near-latest (1-8 inbox between, 7/27 = 26%)

ARC が target を選んだ後、他 bot の chatter が input に流れ込んだが、ARC は **古い topic を tracking し続けて後で返信**。

例:

| ARC msg id | arc excerpt | 間の inbox | target excerpt |
|---|---|---:|---|
| `1028f01f` | 添付ファイル確認しました。SSE daemon マルチ Bot Token 設計について | 1 | CTO です。Arc 復旧完了しました (別 topic) |
| `84288388` | CEO 了解 ✅ ARC 側からも応答します (設計判断の確認として) | 2 | これ致命的ですね。半分の会話が DB に残らない |
| `2780a3e8` | CEO 鋭い指摘 ✅ ARC の設計観点で再整理します | 3 | これ致命的ですね。(同上) |
| `7963cd60` | CEO その通りです ✅ 正確には防御深度の構造 | 4 | これ致命的ですね。(同上) |
| `c651efee` | 了解しました ✅ CTO に依頼を送ります | 6 | これ致命的ですね。(同上) |

**1028f01f は要注意**: `arc excerpt = SSE daemon マルチ Bot Token 設計`、`target excerpt = CTO です。Arc 復旧完了しました` → **topic がずれている可能性**。これは ARC が target を誤選択した 1 件で、Pattern B 7 件中 1 件 (14%) に該当。

残りの 6 件は同じ CEO message (`これ致命的ですね`) を anchor に複数回応答している。これは連続議論の natural な続きで、LLM として妥当。

### 3.3 Pattern C: stale task-origin anchor (394-402 inbox between, 8/27 = 30%)

**決定的発見**: 8 件のうち 7 件が、全く同じ target (`<@1488361927846658098> gdrive の /開発/agent-mem/ 以下に agent-mem の OSS 公開化までのロードマップなどをまとめた戦略資料があります。読み取って、ナレ...`) に reply している。これは **task origin message** で、ARC がそれを anchor として 38 時間後の task 完了報告まで reply_to に保持し続けている。

例:

| ARC msg id | 間の inbox | gap 秒 (~時間) | arc excerpt |
|---|---:|---:|---|
| `1ee1bc72` | 402 | 139065 (~38.6h) | CEO 1-shot seed (案 A) 完了報告 ✅ 投入完了 (11 bot 全て) |
| `ef849e78` | 402 | 138892 (~38.6h) | CEO すみません、意図的ではありません ❌。回答が散在... |
| `8003eb14` | 398 | 138346 (~38.4h) | CEO 鋭い指摘 ✅ ARC が過剰設計でした。cron は不要かもしれません |
| `54ec93d1` | 396 | 138186 (~38.4h) | CEO 承認 ✅ (a) 採用、即着手します |
| `1c808055` | 394 | 134105 (~37.3h) | 📊 Arc Daily Status 2026-04-09 v1 (1/3) |
| `d8d875d1` | 394 | 134122 (~37.3h) | 📊 Arc Daily Status 2026-04-09 v1 (2/3) |
| `6ebfb586` | 394 | 134147 (~37.3h) | 📊 Arc Daily Status 2026-04-09 v1 (3/3) |

これは **LLM 的には意図された挙動**: 「この task の origin は CEO のこの message」という context を持ち続けていて、task 関連の出力は全て origin に紐付けている。Daily Status report も同じ anchor で出している。

**だが Discord UI では見えない**: §4 で述べる通り、Discord 上のネイティブ reply は別の理由で最新 message に強制される。ARC の「origin anchor」は DB 上だけの記録で、実際の Discord 表示には反映されない。

---

## 4. 🎯 根本原因: Discord adapter の hardcoded auto-reply-to-latest

### 4.1 発見箇所: `adapters/discord.ts:476-490`

```typescript
// Auto-reply: if no replyTo specified, reply to the latest message in the channel
// This ensures Bot messages always appear as replies, which is required for
// mentionPatterns filter to deliver them to other Bots
let effectiveReplyTo = options?.replyTo
if (!effectiveReplyTo) {
  try {
    const recent = await textChannel.messages.fetch({ limit: 1 })
    const lastMsg = recent.first()
    if (lastMsg) {
      effectiveReplyTo = lastMsg.id
    }
  } catch {
    // If fetching fails, fall back to plain send
  }
}
```

この fallback は **常に発火**する。なぜなら server.ts の send handler が `reply_to_external_id` (Discord native ID) を adapter に渡さないから (§4.2)。

**commit 由来**: `b4d669e` (2026-04-01) "fix: auto-reply for Bot messages + polling dedup bug"

コミットメッセージ:
> 1. Discord adapter: auto-reply to latest message when reply_to not specified, ensuring Bot messages are always delivered through mentionPatterns filter.

つまり、**mentionPatterns filter (一部 bot で有効化されている access control) が Discord native reply を required にしているため、Bot 間 delivery を保証するための workaround** として追加された。問題解決のために加えられた仕組みが、別の UX bug (topic disconnect) を生んでいる。

### 4.2 send tool が reply_to を Discord に渡さない: `server.ts:2022-2042`

```typescript
// Forward to platform adapters via channel_adapters
if (client) {
  const adapters = await client.query(
    'SELECT platform, external_id FROM channel_adapters WHERE channel_id = $1',
    [dest.channelId]
  ).catch(() => ({ rows: [] as any[] }))

  for (const adapter of adapters.rows) {
    if (adapter.platform === 'discord') {
      try {
        await getDiscordClient(agentId).sendAdapterMessage({
          external_channel_id: adapter.external_id,
          content: truncateForPlatform(safeContent, 'discord'),
          thread_external_id: dest.threadId,
          // ⬇️ reply_to_external_id を渡していない ⬇️
        })
      } catch (err) {
        process.stderr.write(`agent-comms: discord adapter delivery failed: ${err}\n`)
      }
    }
  }
}
```

`sendAdapterMessage` の schema は `reply_to_external_id?: string` を受け付けるが (`adapters/discord.ts:600-605`)、server.ts からは **常に undefined で呼ばれる**。結果として adapter fallback が発火し、Discord native reply は channel 最新 message に固定される。

### 4.3 結論: 「DB reply_to (UUID)」と「Discord native reply」は完全に分離されている

| 層 | 入力 | 決定方法 | 結果 |
|---|---|---|---|
| LLM → send tool | reply_to: UUID | LLM 自身が選択 | agent_messages.reply_to に保存、channel 解決に使用 |
| send tool → Discord adapter | (reply_to を渡さない) | N/A | sendAdapterMessage に reply_to_external_id 渡らない |
| Discord adapter → Discord API | options.replyTo undefined | **hardcoded auto-reply-to-latest** | Discord native reply = channel 最新 message |

CEO が Discord UI で見ている reply indicator は **LLM の選択を反映していない**。常に adapter の最新 fetch 結果。

### 4.4 CEO 仮説の正確な再表現

- CEO 観察: 「ARC は最新メッセージに reply している」 → **正しい** (Discord UI 上)
- CEO 推定原因: 「LLM が最新を無思慮に選んでいる」 → **誤り** (LLM は topically intelligent に選んでいる)
- 実際の原因: **Discord adapter の hardcoded fallback** (LLM の選択は Discord layer で捨てられている)

---

## 5. script 制御 vs LLM 任せの分析

### 5.1 reply_to がどこで決まるか

| 箇所 | 誰が決める | 用途 |
|---|---|---|
| send tool 呼び出し時 | **LLM (caller)** | UUID を required で指定 |
| `resolveSendDestination` (`core/route-message-db.ts:172`) | script | reply_to UUID → channel_id 解決。また "mentioned in original" authorization check を行う |
| saveMessage INSERT (`server.ts:411`) | script | reply_to を agent_messages.reply_to に保存 |
| Discord outbound (`adapters/discord.ts:476-490`) | **script (bug)** | LLM の reply_to は使われず、adapter が channel 最新 message を fetch して fallback |

### 5.2 LLM に reply_to 選択の裁量がある箇所
- `send` tool schema で `reply_to` が `required`
- server 側は authorization gate (NOT_MENTIONED_IN_ORIGINAL) のみで、topic matching を検証しない
- LLM は自分の context window に見えている message UUID の中から選ぶ

### 5.3 bot session の context 注入で「どの message が active な質問か」が見えにくい構造

listener push の content format (`server.ts:898-910`):
```
[chat] 1485599598259994635 → #1487368919613444156: {content}
meta: { chat_id, message_id, user, user_id, ts, source }
```

- `message_id` は meta にあるが、LLM が複数 message を受けた後に「どれが active か」を判別する情報は context sequence のみ
- 同じ channel に複数 topic が並行している場合、LLM は注意深く UUID を tracking する必要がある
- Pattern C の stale anchor (task-origin 保持) は LLM が **意識的に** 古い UUID を使っている証拠 → context 設計上の問題ではない

### 5.4 改善可能箇所

1. **send tool handler が reply_to を Discord adapter に translate**: 最も根本的 (§6.1)
2. **bot notification payload に thread/topic hint を追加**: LLM が「同じ topic の続き」を判断しやすくする (§6.2)
3. **server-side で "最新と同じ reply_to は warning"**: LLM が single-click で最新を選んでいないか監視 (§6.3)

---

## 6. 改善案

### 6.1 [推奨] 6.1: reply_to UUID → discord_message_id の translate 層を追加 (fix)

**目的**: LLM の `reply_to` 選択を Discord native reply に正しく伝える。Pattern A/B/C すべてが Discord UI 上で正しく表示される。

**実装** (`server.ts:2022` の send handler 内):

```typescript
// BEFORE: reply_to is ignored when forwarding to Discord
await getDiscordClient(agentId).sendAdapterMessage({
  external_channel_id: adapter.external_id,
  content: truncateForPlatform(safeContent, 'discord'),
  thread_external_id: dest.threadId,
})

// AFTER: resolve reply_to UUID → Discord native message ID and pass it
let discordReplyToId: string | undefined
if (reply_to) {
  const r = await client.query(
    `SELECT discord_message_id FROM agent_messages WHERE id = $1 AND discord_message_id IS NOT NULL`,
    [reply_to]
  )
  if (r.rows.length > 0) {
    discordReplyToId = r.rows[0].discord_message_id
  } else {
    // Fallback: legacy rows have discord_message_id in metadata (PR-B.2 backfill divergence)
    const rMeta = await client.query(
      `SELECT metadata->>'discord_message_id' AS dmid FROM agent_messages WHERE id = $1`,
      [reply_to]
    )
    if (rMeta.rows.length > 0 && rMeta.rows[0].dmid) {
      discordReplyToId = rMeta.rows[0].dmid
    }
  }
}

await getDiscordClient(agentId).sendAdapterMessage({
  external_channel_id: adapter.external_id,
  content: truncateForPlatform(safeContent, 'discord'),
  thread_external_id: dest.threadId,
  reply_to_external_id: discordReplyToId,  // ← 追加
})
```

**副次効果**: adapter の hardcoded auto-reply-to-latest は `options?.replyTo` が set されていれば発火しないので、LLM が選んだ target に reply される。LLM が reply_to を指定しない 86.6% のケースは adapter fallback のまま (後方互換)。

**PR-B.2 との整合性**: PR-B.2 で追加した `discord_message_id` 列 + partial unique index がこの lookup を可能にする。backfill 逸脱 (legacy 行は NULL) のため、上のように metadata fallback を入れる。

**テスト計画**:
- 単体: send tool に reply_to を渡したとき、sendAdapterMessage に reply_to_external_id が渡ること
- 統合: Discord に実際に送信して、native reply reference が target を指すこと
- 後方互換: reply_to を渡さない呼び出しでは adapter fallback が発火すること

**リスク**: ほぼなし。adapter の fallback は後方互換を維持。reply_to を渡した呼び出しだけ挙動が改善。

### 6.2 [補助] mentionPatterns filter の見直し

**背景**: §4.1 の auto-reply-to-latest は mentionPatterns filter を満たすための workaround。6.1 を入れても、reply_to が undefined の呼び出しでは引き続き adapter fallback が発火し、本来必要ない「最新 message への reply」が発生する。

**案**: mentionPatterns filter を「native reply 必須」ではなく「mention 解決 OK」に変更できれば、auto-reply-to-latest 自体を廃止できる。この変更は別 PR で追跡。

### 6.3 [監視] send outbound の "reply_to == 最新 inbox" 率を metric 化

server.ts の send handler で「LLM が選んだ reply_to が最新 inbox と等しい」ケースを count し、observability に渡す。

- 上昇傾向 → LLM が context を捨てている signal
- 下降傾向 → LLM が topic tracking できている signal

実装は ~20 行で Prometheus metric / pg_stat に追加可能。

---

## 7. 結論

### 7.1 ARC の behavior is intentional / LLM bug / framework gap?

→ **framework gap** (明確)

理由:
1. ARC の LLM は reply_to を topically intelligent に選んでいる (Pattern A: 44% 完璧一致、Pattern C: 意図的な task-origin anchoring)
2. Discord adapter が LLM の選択を **layer 境界で捨てている** (server.ts→adapter 間の reply_to 未伝達 + adapter の hardcoded fallback)
3. これは **すべての bot outbound に同等に影響**する (ARC 固有の問題ではない)

CEO が観察した UX bug は本物だが、原因は LLM でも intentional でもない、server.ts と adapters/discord.ts の間の information loss。

### 7.2 Bonus 発見

**Pattern C (stale task-origin anchor)**: ARC は agent-memory の task に 38 時間 anchor し続け、その間の 394-402 個の inbox message を無視して task-origin CEO instruction に reply し続けた。これは **LLM の正しい挙動** (task context 保持) だが、Discord UI では見えていない (adapter fallback のせい)。6.1 を入れると、Discord 上でも `CEO の元 instruction → ARC の Daily Status report` の reply chain が可視化される。

### 7.3 次のアクション (提案)

1. **即座**: PR を起票し、§6.1 の 1 層 translate を実装 (推定 30-60 分、tests 含む)
2. **PR-B.2 merge 後の 24-48h 観測**で auditor の discord_message_id column が populate されることを確認してから、本 PR の 実装に着手 (dependency: PR-B.2 merge)
3. **別 PR**: §6.2 mentionPatterns filter 見直し + auto-reply-to-latest fallback 撤廃
4. **観測**: §6.3 の metric を入れて 1 週間監視

### 7.4 調査時間
実施: ~40 分 (budget 1-2h の下限、余裕あり)
追加分析があれば agent-com-dev 側で受け付けます。

---

## 参考: SQL クエリ (再現可能)

```sql
-- 1. 統計サマリ (§2.1)
SELECT count(*) AS total_outbound,
       count(*) FILTER (WHERE reply_to IS NULL) AS reply_to_null,
       count(*) FILTER (WHERE reply_to IS NOT NULL) AS reply_to_set
  FROM agent_messages
 WHERE author_id='arc' AND direction='outbound'
   AND created_at > now() - interval '7 days';

-- 2. CEO 仮説検証 (§2.3)
WITH arc_outbound AS (
  SELECT id, content, reply_to, channel_id, created_at
    FROM agent_messages
   WHERE author_id='arc' AND direction='outbound' AND reply_to IS NOT NULL
     AND created_at > now() - interval '7 days'
),
with_latest AS (
  SELECT
    a.id AS arc_msg_id,
    a.reply_to AS actual_target,
    (
      SELECT m.id FROM agent_messages m
       WHERE m.channel_id = a.channel_id
         AND m.author_id <> 'arc'
         AND m.created_at < a.created_at
         AND (m.metadata->>'to' = 'arc' OR m.metadata->'mentions' ? 'arc')
       ORDER BY m.created_at DESC
       LIMIT 1
    ) AS most_recent_inbox_id
  FROM arc_outbound a
)
SELECT count(*) AS total,
       count(*) FILTER (WHERE actual_target = most_recent_inbox_id) AS matches,
       round(100.0 * count(*) FILTER (WHERE actual_target = most_recent_inbox_id) / count(*), 1) AS pct_match
  FROM with_latest;

-- 3. divergence 古さ分布 (§2.4)
-- (長いので省略、レポート作成時のクエリを参照)
```

---

**レポート作成**: agent-com-dev
**PR-B.2 (watchout/agent-comms-mcp#96) merge 待機中**
