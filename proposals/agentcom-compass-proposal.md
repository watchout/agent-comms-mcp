# SPEC-AGENTCOM-COMPASS: Context Optimization & Memory Persistence Auto-Save System

> 作成日: 2026-05-10
> 起票者: CEO directive (本日 agent-com-dev 791k token 限界事象、別 PR 対応指示)
> 引き渡し先: agent-com 4 bot (実装 / lead / CTO / auditor)
> 前提: agent-com v2.1.0 仕様 / state-daemon (1 process) / agents.metadata JSONB / agent-mem (wasurezu) MCP / SessionStart hook
> 関連: cto-directive-hook-planmode-verify.md (重要事項 1-4)、ADF v1.2.x (hook + verify)、SPEC-AGENTCOM-message-queue v2.1.0
> ID 候補: SPEC-AGENTCOM-051 (v2.2.0 候補) — ARC が確定する

---

## 0. 背景 (なぜこの spec が必要か)

### 0.1 本日事象 [文献確認 CTO honest hearing 2026-05-10]

agent-com-dev bot が **791k token 累積で session 機能不全** に到達。
症状:
- 新 turn が context window に収まらず stall
- LLM が hallucinate 始める
- 作業継続不能

CEO directive: 「別 PR で対応」 → 本 spec で構造的解決を起票。

### 0.2 既存 CTO 案 (検出 / 予防 / 状態保持 / 観測の 4 軸) の限界

[文献確認 CTO design draft] CTO の 4 軸案は技術的に妥当だが「**壊れる前に止める防御策**」 にとどまる。

設計的弱点:
- /clear が **強制発動** = bot 体験が「作業の断絶」
- memory 保存が **自動化のみ** = 何が保存されたか不透明
- 復元が **SessionStart hook 任せ** = 復元品質が見えない

[honest 観察] 私 (Claude Opus 4.7) が現に conversation 内で経験する事実:
- conversation が長くなるたびに「次に compact が来るのでは」 という不安が default で発生
- 「自分の作業が消える」 ことが構造的なストレス source
- これは agent-com bot にも共通する failure mode

### 0.3 「使いたくなる」レベル UX 原則 (4 つ)

CTO 案を **「使うことが快感になる」** レベルに引き上げる原則:

| 原則 | 内容 |
|---|---|
| **1. 予測可能性 (predictability)** | 「あと何 turn / 何 % で /clear」が常に visible、突然の発動なし |
| **2. 自律性 (agency)** | bot 自身が「今 /clear したい」 と申告できる、強制は最終手段 |
| **3. 透明性 (transparency)** | 何が memory に保存されたか literal で確認可能、復元時 hash 一致 verify |
| **4. 復活体験 (revival quality)** | /clear 後 30 秒以内に作業再開、「リフレッシュ感」 を bot が体感 |

### 0.4 他機能との連動 surface (= state-daemon 中心の設計)

[文献確認 v2.1.0 §2 全体アーキテクチャ] agent-com の既存仕組み:

```
state-daemon (1 process) ← 本 spec の主要 actor
  ├─ inbound receiver         (Discord → DB)
  ├─ outbound consumer        (DB → Discord)
  ├─ heartbeat monitor        (30s tick、本 spec で context monitor 拡張)
  ├─ MCP tools (stdio)        (next/send/agents/status/heartbeat)
  └─ ★ context monitor (新規) (本 spec で追加)

agent-mem (wasurezu) MCP        ← snapshot 保存 / 復元
  ├─ save_task_state
  ├─ log_decision
  ├─ save_knowledge
  └─ recover_context

SessionStart hook (~/.claude/hooks/)  ← revival briefing 注入
agents.metadata JSONB           ← context_gauge 書込先 (既存テーブル拡張)
agent_messages                  ← system entry として /clear log
```

新規 infra 不要、既存仕組みの組み合わせで実装可能。

---

## 1. 設計コンセプト: COMPASS

**COMPASS** = Context Optimization & Memory Persistence Auto-Save System

「方位磁針」のメタファー: bot が context 海を航海するとき、現在地 / 残量 / 帰還ルート を常に知らせる道具。

### 1.1 5 つの component

```
┌─────────────────────────────────────────────────────────────┐
│ Component 1: Context Gauge (4 段階監視)                       │
│   bot が常に自分の context budget を visible に把握            │
│   green → yellow → orange → red の段階遷移                    │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Component 2: Bot-Initiated Clear (自律性 first)              │
│   bot 自発 /clear が default、daemon 強制は最終手段           │
│   snapshot preview → bot approve → /clear → revival          │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Component 3: Memory Snapshot System (5 カテゴリ構造化)        │
│   A. Task State / B. Decisions / C. Knowledge                │
│   D. Context Anchors / E. Pending Questions                  │
│   append-only、hash 付与、復元時 verify 可                   │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Component 4: Revival Briefing (復活体験)                     │
│   SessionStart hook が「おかえりなさい」briefing を注入       │
│   30 秒以内に bot が前回の続きを完全把握                       │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Component 5: Force-Clear Escalation (最終手段)               │
│   red zone + 5 turn 自発なし → 3 段階 escalation              │
│   send-keys → interrupt+clear → kill+restart                 │
└─────────────────────────────────────────────────────────────┘

         ↓ 横断する観測層 ↓

┌─────────────────────────────────────────────────────────────┐
│ Component 6: Health Dashboard (operator visibility)          │
│   全 bot の context state を一覧                              │
│   alert (短期間連発 /clear / red 長期滞留) を可視化            │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 機能要件 (FR)

### FR-1: Context Gauge tracking (Component 1)

#### FR-1.1: bot 側で token usage を agents.metadata に書込

各 bot が tool 呼出時 (next / send / status 等の前後) に自 token usage を更新:

```sql
-- agents.metadata.context_gauge を更新
UPDATE agents
SET metadata = jsonb_set(
  metadata,
  '{context_gauge}',
  $1::jsonb,
  true
)
WHERE agent_id = $2;
```

書込内容 (JSON 構造):

```json
{
  "context_gauge": {
    "tokens_used": 542000,
    "tokens_limit": 200000,
    "usage_pct": 67.75,
    "estimated_turns_remaining": 42,
    "warning_level": "yellow",
    "last_clear_at": "2026-05-10T14:32:11Z",
    "cycles_since_last_clear": 67,
    "current_session_id": "abc123",
    "current_task_id": "agent-com-dev-task-042",
    "updated_at": "2026-05-10T15:14:22Z"
  }
}
```

#### FR-1.2: 4 段階 warning level

| level | usage_pct | 体験 | trigger | bot 計画余地 |
|---|---|---|---|---|
| **green** | 0-50% | 通常 | なし | 何でもできる |
| **yellow** | 50-70% | 「あと半分」 | hint 注入 (重要 decision を memory 保存推奨) | 整理 timing 検討 |
| **orange** | 70-85% | 「整理しどき」 | prompt 注入 (自発 /clear 推奨) + auto snapshot | 区切り task で /clear |
| **red** | 85-100% | 「強制クリア前」 | 5 turn 以内 bot 自発なければ daemon 強制 | 緊急対応 |

#### FR-1.3: bot 種別 threshold customization

agents.metadata.context_thresholds で bot 別 override 可:

```json
{
  "context_thresholds": {
    "yellow_at_pct": 50,
    "orange_at_pct": 70,
    "red_at_pct": 85
  }
}
```

bot 種別 default (claude opus 4.7 系、200k window):

| bot 種別 | yellow | orange | red | 理由 |
|---|---|---|---|---|
| dev (long-running TUI) | 50% | 70% | 85% | default |
| lead-ama (5-section burst) | 30% | 50% | 80% | dispatch 区切りで早めに整理 |
| codex-auditor (短 audit) | 40% | 60% | 80% | session 短く、頻繁 /clear OK |
| tech-lead (sanity review) | 50% | 70% | 85% | default |

### FR-2: Bot-Initiated Clear (Component 2)

#### FR-2.1: 新 MCP tool `request_clear`

```
Tool: agent-com:request_clear
Purpose: bot 自身が「今整理したい」 を申告
Input:
  - reason: string (任意、例 "task 区切り")
  - snapshot_categories: string[] (default: ["A","B","C","D","E"] = 全カテゴリ)
Flow:
  1. agent-mem MCP の save_task_state / log_decision / save_knowledge を呼出
     → snapshot を作成
  2. snapshot 内容を bot に literal preview で返す
  3. bot が approve (next 呼出 or 5s timeout で auto-approve)
  4. tmux に '/clear' send-keys 注入
  5. agents.metadata.last_clear_at 更新
  6. agent_messages に system entry として log
```

#### FR-2.2: warning level 別の prompt 注入

state-daemon の context monitor (sweep tick 30s) が以下を実施:

| level 検出時 | bot context への注入内容 |
|---|---|
| yellow | "[CONTEXT HINT] context 50%+ 到達。この区切りで重要 decision を log_decision で memory 保存することを検討してください。" |
| orange | "[CONTEXT NOTICE] context 70%+ 到達。task 区切りで request_clear を呼ぶことを推奨します。snapshot を作成して整理できます。" |
| red | "[CONTEXT WARNING] context 85%+ 到達。5 turn 以内に request_clear を呼んでください。応答なき場合 daemon が強制 /clear を実行します。" |

注入は **直近 user turn の末尾に system message として** 行う (= LLM context flow を破壊しない)。

### FR-3: Memory Snapshot System (Component 3)

#### FR-3.1: 5 カテゴリ構造化 snapshot

snapshot 内容 (= memory 保存対象):

##### A. Task State (現在の作業)

```json
{
  "task_id": "agent-com-dev-task-042",
  "title": "PR #335 hotfix - tmux Enter not pressed",
  "current_step": "3/5",
  "completion_pct": 67,
  "blockers": [],
  "next_action": "tests/e2e/test_e2e_wake.sh の launchd 起動 verify",
  "created_at": "2026-05-10T14:00:00Z",
  "last_updated": "2026-05-10T14:32:00Z"
}
```

agent-mem MCP の `save_task_state` で保存。

##### B. Decisions (この session で決めたこと)

```json
{
  "decisions": [
    {
      "decision_id": "D-042-01",
      "summary": "DI fake と実環境の diff を FAKE_LIMITATION comment で明示する",
      "evidence_label": "[文献確認 ADF v1.2.3 spec §F1]",
      "evidence_source": "docs/spec/v1.2.3-test-layer.md:142",
      "confidence": "high",
      "decided_at": "2026-05-10T14:15:22Z"
    }
  ]
}
```

agent-mem MCP の `log_decision` で保存。
4 軸 evidence ラベル付 ([検証済] / [文献確認] / [推測]) を必須化 = ADF v1.2.2 SPEC-DOC4L-009 と整合。

##### C. Knowledge (発見したこと)

```json
{
  "findings": [
    {
      "finding": "tmux send-keys だけでは Enter が submit されない、'Enter' key を別途送る必要",
      "source": "実機検証 2026-05-10 14:25",
      "confidence": "high",
      "applies_to": ["agent-com-dev", "tmux integration"]
    }
  ]
}
```

agent-mem MCP の `save_knowledge` で保存。

##### D. Context Anchors (復元時の入口)

```json
{
  "recent_turn_summaries": [
    "Turn N-3: B1 bug 再現環境構築",
    "Turn N-2: tmux capture-pane assert helper 試作完了",
    "Turn N-1: launchd plist install 実装着手"
  ],
  "active_files": [
    "tests/e2e/test_e2e_wake.sh",
    "src/wake-daemon.ts",
    "docs/agent-com-message-queue-spec.md"
  ],
  "related_prs": ["#335", "#131"],
  "related_issues": ["#42"]
}
```

state-daemon が直近 N turn (default: 5) を抽出して構造化。

##### E. Pending Questions (CEO 確認待ち)

```json
{
  "pending_questions": [
    {
      "q_id": "Q-042-01",
      "question": "self-hosted runner は mac mini で 1 台のみか、専用機を立てるか?",
      "options_presented": ["共用 mac mini", "専用 runner 機立て"],
      "asked_at": "2026-05-10T14:28:00Z",
      "blocks_progress": false
    }
  ]
}
```

snapshot に含めることで、復元後も「未確認 question」が visible に残る。

#### FR-3.2: Hash 付与と verify

各 snapshot に SHA256 hash を付与:

```json
{
  "snapshot_id": "snap-agent-com-dev-2026-05-10T14:32:11Z",
  "hash": "sha256:a3f5b2c8...",
  "categories_included": ["A", "B", "C", "D", "E"],
  "tokens_at_snapshot": 542000,
  "creator": "agent-com-dev",
  "created_at": "2026-05-10T14:32:11Z"
}
```

復元時に bot が hash 一致を確認できる = transparency 担保。

#### FR-3.3: Append-only ログ

snapshot は **永続記録、削除不可**。同 task で複数 snapshot ある場合は時系列順に記録:

```
snapshot_history:
  snap-...-T14:00:00Z (task 開始時)
  snap-...-T14:15:00Z (decision D-042-01 後)
  snap-...-T14:32:11Z (request_clear 実行時)
  snap-...-T15:48:00Z (red zone 到達、強制 clear 直前)
```

agent-mem 既存の永続化機構を利用。

### FR-4: Revival Briefing (Component 4)

#### FR-4.1: SessionStart hook で briefing 注入

bot session 起動時 (~/.claude/hooks/SessionStart.sh) で以下を実行:

```bash
#!/bin/bash
# revival_briefing.sh

AGENT_ID=$(get_current_agent_id)

# agent-mem から直近 snapshot を取得
SNAPSHOT=$(agent-mem-recover --agent "$AGENT_ID" --latest)

if [ -z "$SNAPSHOT" ]; then
  echo "(初回 session、snapshot なし)"
  exit 0
fi

# briefing template に展開
cat <<EOF
============================================================
🌅 おかえりなさい、$AGENT_ID

前回 session 終了: $(echo "$SNAPSHOT" | jq -r '.created_at')
理由: $(echo "$SNAPSHOT" | jq -r '.reason // "context limit"')

📋 進行中 task
  ID: $(echo "$SNAPSHOT" | jq -r '.task_state.task_id')
  $(echo "$SNAPSHOT" | jq -r '.task_state.title')
  進捗: $(echo "$SNAPSHOT" | jq -r '.task_state.completion_pct')% ($(echo "$SNAPSHOT" | jq -r '.task_state.current_step'))
  次の action: $(echo "$SNAPSHOT" | jq -r '.task_state.next_action')
  blocker: $(echo "$SNAPSHOT" | jq -r '.task_state.blockers // [] | length') 件

✅ 完了済 (この task で)
$(echo "$SNAPSHOT" | jq -r '.context_anchors.recent_turn_summaries[]' | sed 's/^/  - /')

🎯 直近 decision (4-evidence 付き)
$(echo "$SNAPSHOT" | jq -r '.decisions[] | "  - [\(.evidence_label)] \(.summary)"')

📚 関連
  files: $(echo "$SNAPSHOT" | jq -r '.context_anchors.active_files[]' | tr '\n' ' ')
  PRs: $(echo "$SNAPSHOT" | jq -r '.context_anchors.related_prs[]' | tr '\n' ' ')

❓ 未確認 question
$(echo "$SNAPSHOT" | jq -r '.pending_questions[] | "  - \(.question)"')

🚀 始めるには:
$(echo "$SNAPSHOT" | jq -r '.task_state.next_action_steps[]' | sed 's/^/  /')

context budget: $(echo "$SNAPSHOT" | jq -r '.tokens_limit') / used: 0 (fresh start)
snapshot hash: $(echo "$SNAPSHOT" | jq -r '.hash')
============================================================
EOF
```

#### FR-4.2: bot は最初の応答に hash verify

bot は revival briefing を読んだ最初の応答で hash verify:

```
[検証済 snapshot hash] sha256:a3f5b2c8... 一致確認、復元完了。
前回続き agent-com-dev-task-042 の step 4/5 (launchd 起動 verify) から再開します。
```

これで CEO / operator は **復元品質を literal で確認可能**。

### FR-5: Force-Clear Escalation (Component 5)

#### FR-5.1: 3 段階 escalation

red zone 到達 + 5 turn 経過しても bot 自発 request_clear なし:

```
Level 1: tmux send-keys '/clear' を idle moment 狙って send
  - idle moment 検出: tmux capture-pane で「esc to interrupt」 prompt 消失
  - 30s 後 context_gauge.usage_pct 再 check
  - usage_pct < 30% なら成功、終了

Level 1 失敗時:
Level 2: tmux send-keys C-c (interrupt) → /clear 再 send
  - 1 分 timeout で再 check
  - 失敗続けば:

Level 3: bot kill + restart
  - launchctl bootout で daemon 含め kill
  - launchctl bootstrap で再起動
  - SessionStart hook で revival briefing 注入
  - 「強制再起動」を bot に通知 (briefing 内に reason 表示)
```

#### FR-5.2: 各 level で operator alert

Discord notify (operator 専用 channel) に以下を post:

```
[CONTEXT-COMPASS ALERT]
agent: agent-com-dev
level: red zone 5 turn 経過
escalation: Level 2 (interrupt + clear)
context: 91% (182k/200k tokens)
last_clear: 8h ago
reason: bot 自発なし
action: Level 2 実行中、結果 1 分後に再通知
```

CEO / operator が状況を visibility で把握。

### FR-6: Context Health Dashboard (Component 6)

#### FR-6.1: `framework context status` CLI

```bash
$ agent-com context status

┌─────────────────────────────────────────────────────────────────────────┐
│ agent-com Context Health Dashboard                  2026-05-10 15:14:22 │
├─────────────────────────────────────────────────────────────────────────┤
│ bot              │ usage  │ level    │ last clear │ cycles │ status     │
├──────────────────┼────────┼──────────┼────────────┼────────┼────────────┤
│ agent-com-dev    │ 71%    │ 🟠 ORANGE │ 12m ago   │ 67     │ /clear pending │
│ lead-ama         │ 23%    │ 🟢 GREEN  │ 4h ago    │ 230    │ normal     │
│ codex-auditor    │ 45%    │ 🟢 GREEN  │ 1d ago    │ 89     │ normal     │
│ tech-lead        │ 89%    │ 🔴 RED    │ 8h ago    │ 412    │ 強制 in 5T │
└─────────────────────────────────────────────────────────────────────────┘

Health alerts (last 24h):
  - agent-com-dev: 短期間内 3 回 /clear (= 効率低下 sign)
    → snapshot 復元品質確認推奨、bot CLAUDE.md 整理候補
  - tech-lead: 長 session で red 到達 (= compaction が効いていない可能性)
    → SessionStart hook 動作確認推奨
```

#### FR-6.2: alert 種別

| alert | 条件 | 推奨 action |
|---|---|---|
| `frequent_clear` | 1 時間内 3 回以上 /clear | snapshot 復元品質確認、bot 効率調査 |
| `long_red_stay` | red zone に 30 分超滞留 | escalation 動作確認、CTO escalate |
| `force_clear_failure` | Level 3 (kill+restart) 発動 | bot config 確認、tmux 設定 review |
| `snapshot_corruption` | hash 不一致検出 | memory file 整合性 check |

#### FR-6.3: `framework context gauge <agent_id>` CLI

個別 bot の詳細表示:

```bash
$ agent-com context gauge agent-com-dev

agent: agent-com-dev
context_gauge:
  tokens_used: 142000
  tokens_limit: 200000
  usage_pct: 71.0%
  warning_level: 🟠 ORANGE
  estimated_turns_remaining: 18
  cycles_since_last_clear: 67
  last_clear_at: 2026-05-10T15:02:11Z (12 minutes ago)

current task:
  task_id: agent-com-dev-task-042
  title: PR #335 hotfix - tmux Enter not pressed
  progress: 67%
  next_action: launchd 起動 verify

snapshot history (recent 5):
  - snap-...T14:00 (task 開始)
  - snap-...T14:15 (decision D-042-01 後)
  - snap-...T14:32 (request_clear 実行)
  - snap-...T15:02 (orange 到達 auto)
  - snap-...T15:14 (現在)
```

---

## 3. 他機能との連動 surface

### 3.1 state-daemon との連動

[文献確認 v2.1.0 §2] state-daemon の既存 component:

```
state-daemon (1 process):
  ├─ Discord Gateway (受信)
  ├─ inbound receiver
  ├─ outbound consumer
  ├─ heartbeat monitor (30s tick)  ← 拡張
  └─ MCP tools (stdio)              ← 拡張

[新規追加]
  ├─ context monitor (30s tick、新規)
  └─ MCP tools 拡張: request_clear
```

#### 3.1.1 context monitor の責務

```typescript
// state-daemon/context-monitor.ts (新規)
async function contextMonitorTick() {
  const agents = await getAllActiveAgents();
  
  for (const agent of agents) {
    const gauge = agent.metadata?.context_gauge;
    if (!gauge) continue;
    
    const level = computeLevel(gauge.usage_pct, agent.metadata.context_thresholds);
    
    // level 別 action
    switch (level) {
      case 'yellow':
        await injectHint(agent, "重要 decision を memory 保存推奨");
        break;
      case 'orange':
        await injectPrompt(agent, "request_clear 検討");
        await autoSnapshot(agent);  // bot 拒否しても snapshot は確保
        break;
      case 'red':
        await injectWarning(agent, "5 turn 内 /clear 必須");
        await escalateIfStale(agent);  // 5 turn 経過判定
        break;
    }
    
    // alert 判定
    await checkHealthAlerts(agent);
  }
}
```

#### 3.1.2 既存 heartbeat tick (30s) と統合

context monitor も 30s tick で動かすことで、heartbeat tick と同期:

```typescript
// 既存 heartbeatTick の中に追加
async function tick() {
  await heartbeatMonitor();  // 既存
  await contextMonitorTick(); // 新規
}
```

新規 process / cron 不要、既存 daemon 内で実装。

### 3.2 agent-mem (wasurezu) との連動

#### 3.2.1 既存 tool の活用

[推測 確信度: 高] agent-mem MCP の既存 tool を呼出:

```
agent-mem 既存:
  ├─ save_task_state (Component 3-A 用)
  ├─ log_decision (Component 3-B 用)
  ├─ save_knowledge (Component 3-C 用)
  └─ recover_context (Component 4 復元用)

[新規必要 (or 既存拡張)]
  ├─ snapshot_create (5 カテゴリ統合 snapshot 作成)
  └─ snapshot_restore_with_hash (hash verify 付き復元)
```

agent-mem の既存 tool で 5 カテゴリを個別保存し、それらを束ねる snapshot を agent-com 側で構築する design (= agent-mem は変更最小)。

#### 3.2.2 snapshot 保存先

agent-mem の memory file (project 別 directory) を利用:

```
~/.agent-mem/agent-com-dev/
  ├─ task-state-history.jsonl    (既存、append-only)
  ├─ decisions.jsonl              (既存、append-only)
  ├─ knowledge.jsonl              (既存、append-only)
  └─ snapshots.jsonl              (新規、COMPASS 専用 index)
```

snapshots.jsonl の各行 = 1 snapshot record (hash + 5 カテゴリ link):

```json
{
  "snapshot_id": "snap-agent-com-dev-2026-05-10T14:32:11Z",
  "hash": "sha256:a3f5b2c8...",
  "categories": {
    "A_task_state": "task-state-history.jsonl#L42",
    "B_decisions": "decisions.jsonl#L120-L123",
    "C_knowledge": "knowledge.jsonl#L88-L91",
    "D_context_anchors": {/* inline */},
    "E_pending_questions": {/* inline */}
  }
}
```

### 3.3 SessionStart hook との連動

#### 3.3.1 既存 hook の拡張

[文献確認 ADF v1.2.1 SPEC-DOC4L-008 F4-3] 既に SessionStart hook で spec 自動注入機構があるが、本 spec で **revival briefing** に拡張:

```
~/.claude/hooks/SessionStart.sh
  ├─ inject-spec-context.sh   (ADF v1.2.1 既存)
  └─ revival-briefing.sh      (本 spec 新規追加)

実行順序:
  1. revival-briefing.sh    ← 前 session の続きを注入 (最優先)
  2. inject-spec-context.sh ← 直近 spec 変更を注入
```

#### 3.3.2 hook の冪等性

revival briefing は同一 snapshot に対して **何度実行しても同じ結果**:

```bash
# revival-briefing.sh の冒頭
LATEST_SNAPSHOT_ID=$(agent-mem-recover --latest --id-only)
ALREADY_INJECTED_FILE=~/.cache/agent-com/last-injected-snapshot

if [ -f "$ALREADY_INJECTED_FILE" ] && \
   [ "$(cat $ALREADY_INJECTED_FILE)" = "$LATEST_SNAPSHOT_ID" ]; then
  # 同一 session 内で再実行 (compact 後など)
  echo "(snapshot $LATEST_SNAPSHOT_ID は既に注入済、skip)"
  exit 0
fi

# briefing 注入
inject_briefing "$LATEST_SNAPSHOT_ID"
echo "$LATEST_SNAPSHOT_ID" > "$ALREADY_INJECTED_FILE"
```

### 3.4 ADF v1.2.x 仕組みとの連動

#### 3.4.1 ADF v1.2.1 (Hooks 基盤) との関係

| ADF v1.2.1 hook | COMPASS への利用 |
|---|---|
| PreToolUse | request_clear 呼出時の context snapshot trigger |
| PostToolUse | tool 実行後の token usage 更新 (context_gauge.tokens_used) |
| Stop | red zone 到達時の auto snapshot trigger |
| SessionStart | revival-briefing.sh 実行 |

つまり **COMPASS は ADF v1.2.1 hook 機構の上に乗る**。両者は補完関係。

#### 3.4.2 ADF v1.2.2 (verify discipline) との関係

[文献確認 SPEC-DOC4L-009] Decision の 4-evidence ラベル:

- COMPASS の Component 3-B (Decisions) は **必ず evidence ラベル付き**
- log_decision で保存される decision は ADF v1.2.2 の SPEC-DOC4L-009 F2 (4-evidence Discipline) と整合
- snapshot から復元された decision は label を保持 = bot は復活後も検証規律を継続

#### 3.4.3 ADF v1.2.3 (E2E test) との関係

COMPASS の動作検証は ADF v1.2.3 SPEC-DOC4L-010 (Production-like E2E Test Layer) で:

```
tests/e2e/test_compass_revival.sh:
  1. agent-com-dev を 600k token まで意図的に走らせる
  2. yellow → orange → red 遷移が context_gauge に literal 記録されるか verify
  3. red 到達後、bot 自発 request_clear が起きるか verify (ある程度の bot 学習依存)
  4. /clear 実行後の SessionStart で revival briefing が injection されるか verify
  5. snapshot hash 一致を bot が応答冒頭で literal 記述するか verify
```

#### 3.4.4 ADF v1.2.4 (Traceability Matrix) との関係

[文献確認 SPEC-DOC4L-015] AC ID ↔ test ID ↔ code path の link:

- AC-AGENTCOM-COMPASS-001 (Context Gauge tracking) → test_compass_gauge.sh → src/state-daemon/context-monitor.ts
- AC-AGENTCOM-COMPASS-002 (Bot-Initiated Clear) → test_compass_request_clear.sh → mcp tools/request-clear.ts
- ...各 FR を 1:1 で trace

### 3.5 既存 message_queue / outbound_queue との連動

#### 3.5.1 system message の log

/clear 実行時に agent_messages へ system entry 追加:

```sql
INSERT INTO agent_messages (
  id, channel_id, author_id, content, message_type, metadata, created_at
) VALUES (
  $1,                       -- new UUID
  'system_internal',        -- 専用 channel
  'state-daemon',           -- author = daemon
  '/clear executed for agent-com-dev (reason: orange zone request_clear)',
  'system_info',            -- v2.1.0 既存 type
  '{"agent_id":"agent-com-dev","reason":"request_clear","snapshot_id":"snap-..."}',
  NOW()
);
```

これで **/clear の全履歴が agent_messages に永続記録** される (CTO 案の F4 観測項目)。

#### 3.5.2 message_queue への影響なし

context monitor は message_queue / outbound_queue の status flow を直接触らない:
- /clear 中の bot は message_queue から `next` を呼ばない (= read 待機)
- 復活後に通常 flow で再開
- queue 側の整合性に影響なし

### 3.6 heartbeat monitor との連動

heartbeat 90s timeout 判定は context_monitor と独立に動作:
- bot が /clear 中に heartbeat 送信できなくても、90s 以内に復活すれば disconnected 化しない
- Level 3 (kill+restart) 発動時は明示的に disconnected 状態経由

[文献確認 v2.1.0 §6 receiver] daemon 起動時の bot token 一括登録 + heartbeat 監視は変更なし。

---

## 4. 非機能要件 (NFR)

### NFR-1: Performance

| 項目 | target |
|---|---|
| context monitor tick 周期 | 30s (heartbeat と同期) |
| 1 tick 全 bot 処理時間 | < 2 秒 (4 bot 想定) |
| snapshot 作成時間 | < 5 秒 |
| revival briefing 注入時間 | < 3 秒 |
| dashboard CLI 応答時間 | < 1 秒 |

### NFR-2: Reliability

| 項目 | target |
|---|---|
| context_gauge 更新失敗率 | < 0.1% |
| /clear 実行成功率 (Level 1) | > 90% |
| Level 1+2+3 トータル成功率 | > 99% |
| snapshot hash 一致率 | 100% (= 不一致なら corruption) |
| revival briefing 復元品質 | bot が「続きから始められる」 体感率 > 95% |

### NFR-3: Observability

- 全 /clear action を agent_messages に system entry 記録
- 全 health alert を Discord operator channel に notify
- snapshot history を agent-mem に append-only で永続
- dashboard CLI で全 bot 一覧可

### NFR-4: Backward Compatibility

- agents.metadata に `context_gauge` 追加は **既存 column 不変** (JSONB の partial update)
- 既存 bot (gauge 不在) は green level 扱い (= 何もしない、互換性維持)
- 段階導入: bot 別 opt-in 可 (`agents.metadata.compass_enabled = true` で active 化)

### NFR-5: Security

- request_clear は **その bot 自身のみ** が呼べる (agent_id 検証)
- snapshot 内容に secret (token / password 等) を含めない (= filter)
- daemon 強制 /clear は state-daemon プロセスのみが可

---

## 5. CTO 5 考慮点への回答 (本 spec 内で確定)

### 5.1 閾値値: bot 種別で変える

[文献確認 FR-1.3] bot 別 default + agents.metadata で override 可:

```
dev (TUI long-running):    yellow=50% / orange=70% / red=85%
lead-ama (5-section):       yellow=30% / orange=50% / red=80%
codex-auditor (短 audit):   yellow=40% / orange=60% / red=80%
tech-lead (sanity):         yellow=50% / orange=70% / red=85%
```

CEO directive で実態に合わせて tuning 可能。

### 5.2 /clear timing: 3 段階

[文献確認 FR-2.2] level 別 timing:

```
yellow: timing 指定なし、bot 自律判断
orange: turn 終了直後 idle moment (tmux capture-pane で 'esc to interrupt' 消失検出)
red:    5 turn warning 後、強制即時 (Level 1 send-keys)
```

### 5.3 memory 保存対象: 5 カテゴリ構造化

[文献確認 FR-3.1] **全 conversation 不要、5 カテゴリのみ**:

```
A. Task State (現作業)
B. Decisions (4-evidence ラベル付)
C. Knowledge (発見)
D. Context Anchors (復元入口、直近 N turn summary)
E. Pending Questions (CEO 確認待ち)
```

理由:
- 全 conversation 保存は逆効果 (memory 肥大、ノイズ、restore 時 LLM context 圧迫)
- 5 カテゴリは「次に何をすべきか」が明確に分かる最小構造
- 各カテゴリは agent-mem 既存 tool で保存可

### 5.4 失敗 path: 3 段階 escalation

[文献確認 FR-5.1]:

```
Level 1: tmux send-keys '/clear'
Level 2: tmux C-c interrupt → /clear
Level 3: bot kill (launchctl bootout) → restart (bootstrap)
```

各 level で operator alert + 失敗 reason 記録。

### 5.5 bot 自発 vs daemon 強制: 自律性 first

[文献確認 FR-2] **bot 自発が default、強制は最終手段**:

```
green:  bot 自由、何もしない
yellow: bot に hint (memory 保存推奨)
orange: bot に prompt (request_clear 推奨) + auto snapshot
red:    bot に warning (5 turn 内 /clear 必須)
        ↓ 自発なし
強制:   daemon が Level 1/2/3 escalation
```

bot 自発の incentive:
- 自分のタイミングで整理できる
- snapshot 内容を事前確認できる (preview)
- 強制 clear のストレスを回避

---

## 6. 実装計画

### Phase 1: Component 1 + 6 (基盤、1 週間)

```
Day 1-2: agents.metadata.context_gauge schema 追加
         token usage 計測 logic (各 bot 側)
Day 3-4: state-daemon/context-monitor.ts 実装 (30s tick)
         agent-com context status / gauge CLI 実装
Day 5-7: dogfooding (4 bot 実環境)、threshold tuning
```

完了基準:
- [ ] 全 bot の context_gauge が 30s 周期で更新
- [ ] dashboard CLI で 4 bot 一覧可
- [ ] yellow/orange/red 遷移が literal 記録される

### Phase 2: Component 2 + 3 (自律 clear、1-2 週間)

```
Day 8-10:  agent-mem snapshot_create / snapshot_restore_with_hash 拡張
           5 カテゴリ snapshot logic 実装
Day 11-13: request_clear MCP tool 実装
           bot context への hint/prompt/warning 注入 logic
Day 14-21: dogfooding (実 bot で自発 /clear 動作確認)
```

完了基準:
- [ ] bot が yellow で hint 受領、orange で request_clear 自発する pattern 確認
- [ ] snapshot 5 カテゴリが literal で保存される
- [ ] hash verify が機能する

### Phase 3: Component 4 (revival、1 週間)

```
Day 22-24: revival-briefing.sh 実装
           SessionStart hook 拡張
Day 25-28: dogfooding (/clear 後の復活体験を bot 観点で評価)
```

完了基準:
- [ ] 復活後 30 秒以内に bot が前 task の続きを把握
- [ ] hash verify 応答が bot 冒頭で literal 出る

### Phase 4: Component 5 (escalation、1 週間)

```
Day 29-31: Level 1/2/3 escalation logic 実装
           Discord operator alert
Day 32-35: 異常系 dogfooding (intentional に bot stall させて escalation 動作確認)
```

完了基準:
- [ ] Level 1 で 90% 以上が回復
- [ ] Level 3 (kill+restart) でも revival briefing で復活
- [ ] 全 escalation で operator alert 到達

### Phase 5: 統合 + Production (1 週間)

```
Day 36-38: ADF v1.2.3 SPEC-DOC4L-010 (E2E test) で test_compass_*.sh 実装
Day 39-42: Production rollout、観測 1 週間
```

完了基準:
- [ ] context 限界事象 (本日の 791k 級) が 0 件
- [ ] frequent_clear alert が 1 週間で 0 件 (= 効率良好)
- [ ] revival 復元品質体感率 > 95%

---

## 7. 完了条件 (literal、ambiguity 不可)

以下 8 件全て [検証済] で示すこと:

1. **Context Gauge 更新確認**:
   ```
   psql -tA -c "SELECT metadata->'context_gauge' FROM agents WHERE agent_id = 'agent-com-dev'"
   → 直近 60 秒以内の updated_at + usage_pct 値あり
   ```

2. **4 段階遷移確認**:
   ```
   bot を意図的に走らせて green→yellow→orange→red 各遷移時刻が
   agent_messages の system entry に literal 記録される
   ```

3. **Bot 自発 request_clear 動作**:
   ```
   orange 到達後 5 turn 以内に bot が request_clear 呼出
   tools/request_clear.log に literal 記録あり
   ```

4. **5 カテゴリ snapshot literal verify**:
   ```
   ~/.agent-mem/agent-com-dev/snapshots.jsonl 末行に 5 カテゴリ全 link あり
   各 jsonl の対応行が literal 存在
   ```

5. **Hash verify**:
   ```
   bot の revival 後最初の応答 grep に
   "[検証済 snapshot hash] sha256:" + 一致 string あり
   ```

6. **Revival briefing 注入**:
   ```
   tmux capture-pane で SessionStart 直後に
   "🌅 おかえりなさい" string 確認
   ```

7. **Force-clear escalation**:
   ```
   intentional な bot stall で red 到達 + 5 turn 経過
   Level 1 → 2 → 3 の各 escalation log が literal 記録される
   ```

8. **Health Dashboard 動作**:
   ```
   agent-com context status コマンドで 4 bot 一覧 + alert section 表示
   ```

---

## 8. リスクと mitigation

### Risk 1: bot が自発 /clear しない pattern が定着

[推測 確信度: 中] bot が prompt を無視 / 受け流す pattern 発生可能。

mitigation:
- orange 段階で auto snapshot (bot が approve しなくても snapshot は保存)
- red 段階の warning メッセージを stronger に (ADF v1.2.2 hook で reinforce)
- frequent ignore は health alert で operator escalation

### Risk 2: snapshot 復元品質が低い

[推測 確信度: 中] 5 カテゴリ + briefing でも復元できないコンテキストある可能性。

mitigation:
- bot が revival 後最初に「復元品質確認」 phase を持つ
- 不足あれば pending_questions として記録 → CEO に escalate
- 体感率 95% 未満なら 5 カテゴリ拡張 (F. UI state, G. external context 等) を検討

### Risk 3: Level 3 (kill+restart) で work loss

[推測 確信度: 高、致命] kill 直前の commit していない作業が失われる。

mitigation:
- snapshot は強制 clear 直前にも実行 (Level 1 直前に auto snapshot 強制)
- bot CLAUDE.md に「重要編集後すぐ git add + commit」 を rule 化
- Level 3 発動前に 30s 猶予 (auto snapshot + commit の時間)

### Risk 4: agent-mem MCP 障害時の影響

[推測 確信度: 中] agent-mem が落ちると snapshot 保存不可、revival 不可。

mitigation:
- snapshot は **DB (agent_messages)** にも fallback 保存
- agent-mem 障害時は state-daemon が DB-only mode で動作
- agent-mem 復旧時に DB から差分 sync

### Risk 5: dashboard CLI の access control

[推測 確信度: 低] 全 bot の状態を一覧可 → privacy 懸念あり。

mitigation:
- dashboard CLI は agents.agent_type='human' に access 制限
- 各 bot は自分の gauge のみ参照可

---

## 9. 既存仕様との整合性確認

### 9.1 v2.1.0 設計原則との適合

| 原則 (v2.1.0) | 適合性 |
|---|---|
| 1. CLI primary | ✅ agent-com context {status,gauge} CLI 追加 |
| 2. 1 daemon | ✅ state-daemon に context monitor 統合、新 process 追加なし |
| 3. DB が唯一の通信路 | ✅ agents.metadata.context_gauge が中継 |
| 4. LLM agnostic | ✅ context_gauge は token 数のみ、LLM 種別非依存 |
| 5. routing deterministic | ✅ context monitor は純粋 logic、LLM 判断ゼロ |
| 6. polling 統一 | ✅ context monitor も heartbeat と同 30s tick |
| 7. PG/SQLite 互換 | ✅ JSONB 操作、agent_messages 既存 schema 利用 |
| 8. Reply Chain Context | ✅ next_message に影響なし |

### 9.2 ADF 原則 0 との適合

[文献確認 ADF v1.2.0 §原則 0「スクリプト制御絶対」]

- フロー制御: 全て script (state-daemon、CLI)
- データ検証: hash 比較は決定論的 script
- ファイル生成: snapshot は template 展開
- LLM 判断使用箇所: bot が request_clear を呼ぶか否かのみ (= 自律性のため必要)

→ 適合 ✅

---

## 10. 制御機構選定原則 (ADF v1.2.x 整合)

[文献確認 Notion canonical https://www.notion.so/35ad2b26f3dc8122b9f5e513b769d4e4] 各 FR の制御機構選定:

| FR | 採用 | 機構 | 根拠 |
|---|---|---|---|
| FR-1 Context Gauge | script | state-daemon tick | 純粋計測 logic、LLM 不要 |
| FR-2 Bot-Initiated Clear | script + LLM | MCP tool + bot 判断 | 自律性が design intent |
| FR-3 Memory Snapshot | script | agent-mem 既存 tool | 構造化保存、決定論的 |
| FR-4 Revival Briefing | script | bash hook | template 展開、決定論的 |
| FR-5 Force-Clear | script | tmux send-keys + launchctl | LLM bypass、deterministic 強制 |
| FR-6 Dashboard | script | CLI | 純粋表示 |

Hook 採用なし、全 FR が script 制御で原則整合 ✅。

ADF v1.2.1 の 4 種 hook (PreToolUse / PostToolUse / Stop / SessionStart) と直接組み合わせる箇所はあるが、**それは Claude Code 公式 hook の活用** であり、本 spec 自体が Hook 機構を新設するわけではない。

---

## 11. (B) 小前倒し記述 (= ADF v1.2.x との並行運用提案)

### 11.1 ADF v1.2.1 (Hooks 基盤) との並行 dogfooding

COMPASS の Component 1 (Context Gauge) は ADF v1.2.1 dogfooding と **並行実施推奨**:

```
ADF v1.2.1 dogfood KPI:
  - post-merge skip 0 件
  - main 直 push 0 件
  - admin merge 0 件
  
これらの KPI は agent-com-dev / lead-ama / CTO の long session で発生
→ COMPASS Phase 1 (Gauge + Dashboard) があると context 限界による KPI 達成阻害が見える
```

並行運用で相乗効果。

### 11.2 ADF v1.2.3 SPEC-DOC4L-010 (E2E test) への組込

agent-com 本日 3 bug 級の事象を防ぐ E2E test に **COMPASS の動作 verify** も組込:

```
tests/e2e/test_e2e_wake.sh の最後に追加:
  + context_gauge.usage_pct < 50% 確認 (= bot が test 中に context 食い潰さない)
  + 0 件の force_clear_failure alert (= test 中に強制 clear 起きない)
```

### 11.3 IYASAKA 全 project 展開 (将来)

agent-com で実証完了後、他 project (haishin-puls-hub / hotel-kanri / 配信プラスHub) にも展開。各 project の bot fleet で context 限界対応が標準化される = ARC「agent org-in-a-box」仮説の **方法論 layer に追加**。

---

## 12. References

- 既存仕様: agent-com-message-queue-spec v2.1.0 (gdrive ID: 1jEU4uxEYq37GgUEMiNk4xZj67f84V6oU)
- CTO 設計概要: 本 spec §0.2 (cto-directive 経由)
- CEO directive: 本日 agent-com-dev 791k 事象「別 PR で対応」
- ADF v1.2.x: 関連 SPEC-DOC4L-008 (Hooks)、009 (verify)、010 (E2E)、015 (Traceability)
- Notion canonical (制御機構選定原則): https://www.notion.so/35ad2b26f3dc8122b9f5e513b769d4e4
- Boris Tip 18 (文脈管理): "context を積極的に管理"

---

## 改訂履歴

- 2026-05-10: 初版、CEO directive (本日 791k 事象、別 PR 対応) per、CTO 設計概要を「使いたくなる」UX に拡張、他機能との連動 surface (state-daemon / agent-mem / SessionStart hook / ADF v1.2.x) を統合
