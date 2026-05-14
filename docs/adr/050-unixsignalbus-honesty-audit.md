# ADR-050: UnixSignalBus 削除 + spec §13.5.1 honesty audit

> **Status**: Accepted — ratify chain complete
> **Author**: ARC (iyasaka-arc)
> **Date**: 2026-05-05 (proposed) / 2026-05-14 (accepted)
> **Ratify chain**:
> - ARC sign-off: msg `cd35a953` ([文献確認: 2026-05-05 agent-comms #dev-arc])
> - CTO ratify: msg `68d17ecd` ([文献確認: 同 channel])
> - CEO acceptance: msg `71b5f2c3` (initial), msg `7db33a96` 「通常フローですすめて」(governance flow re-confirmation, 2026-05-14)
> **CEO directive (early approval)**: msg `97dd47e6` (「C」全 ADR 並走承認、[文献確認: 2026-05-04 agent-comms channel]), msg `c40b8dc9` (「進めて」初期承認、[文献確認: 同 channel])
> **Predecessors**: なし
> **Successors**: ADR-052 (DB-observable queue reaper、本 ADR ratify が前提)
> **Cross-cutting**: ADR-051 (wake-daemon HA / supervisor、本 ADR で wake-daemon を de jure primary 化した後に着手)

## Context

agent-comms-mcp の spec §13.5.1 は メッセージ配信を 3 層構造として宣言している
[文献確認: `docs/agent-com-message-queue-spec.md:1306-1332`]:

```
Primary:    MessageBus signal (UnixSignalBus, bus.signal('bot_<agent>'))
Secondary:  MCP notification (notifications/message/pending)
Fallback:   Polling (waitForSignal timeout 30s → next polling)
```

agent-com-dev の調査 (msg `c1258e88` / `978ade62` / `7a0c227d`、A2 read-only
session、2026-05-04) で次の構造欠陥が判明した [文献確認: 同 msg series]:

### 観察された乖離 (motivating evidence、本 ADR §6 contract test の根拠)

#### Fixture A: PID file 書込み code path 不在 [検証済: grep 0 件]

```bash
$ grep -nE 'writeFileSync.*pid|writePidFile' core/server.ts
(0 件、PID file 書込み code path 不在)

$ ls /tmp/agent-com-*.pid 2>/dev/null
(全 19 bot 不在)
```

#### Fixture B: UnixSignalBus 実装は live、ただし silent fail [検証済: code grep + try/catch 確認]

```bash
$ grep -n 'readFileSync.*pid\|kill\(' core/message-bus.ts
55:  const pidFilePath = pidFilePathFor(agentId);
78:  const pid = parseInt(readFileSync(pidFilePath, 'utf8').trim(), 10);
106: try { kill(pid, 'SIGUSR1'); } catch { /* swallow */ }
```

`readFileSync` は ENOENT を投げ、try/catch で swallow される結果 `bus.signal('bot_X')`
は **常に no-op** [検証済: Fixture A の PID file 不在 + B の swallow 構造から論理的に確定]。

#### Fixture C: wake-daemon が事実上の primary [検証済: ps 出力 + tmux 観察]

```bash
$ ps -ef | grep wake-daemon
arrowsworks  6804  ... bin/wake-daemon.ts
```

PID 6804、7 日 12 時間連続稼働、tmux send-keys で全 19 bot に prompt 注入する
mechanism として de facto primary を担う [検証済: lead-ama / agent-com-dev 共通観察]。
ただし spec §13.5.1 では primary とも fallback とも明示されていない位置 [文献確認:
spec §13.5.1 の 3 層列挙に wake-daemon が現れない]。

### CEO directive (msg `1d03f8bd`「監査通過 governance gap」)

「監査が通っているはずなのに spec と実装が違う」状態は incident class、解消が ARC
spec ownership 第一優先 [文献確認: msg `1d03f8bd` 2026-05-04 agent-comms channel]。

### 影響評価

| 軸 | 現状 | 影響 | evidence |
|---|---|---|---|
| 機能 (bot wake) | wake-daemon が代替して functionally 解消、症状観察上 bug なし | 低 | [検証済: 本日複数 channel で正常 message 配送観察] |
| governance honesty | spec text と実装が乖離 = false claim | 高 | [検証済: Fixture A/B/C の DB 外形証跡] |
| 信頼性 | wake-daemon 単一障害点、UnixSignalBus は dead code | 中 | [検証済: ADR-051 で別 ADR scope] |
| 後続 ADR の前提 | ADR-052 (reaper) が wake-daemon を primary 前提とする impl を含む | 高 | [文献確認: ADR-052 v0.1 §「Decision」、本 ADR ratify が前提と明記] |

## Decision

我々は **UnixSignalBus 関連 code を完全削除し、spec §13.5.1 を実態 (wake-daemon
primary) に整合させる** ことを採用する。

### Code 削除 scope [文献確認: 上記 Fixture A/B + 過去 ADR-041 routing port 構造]

| file | 削除内容 |
|---|---|
| `core/message-bus.ts` | UnixSignalBus class 全体 (line 55, 78, 106 を含む signal 機構) |
| 各 bot `run-bot.sh` 等 (§5.3 referenced) | `bus.waitForSignal()` 呼出削除、`next` polling のみ残す |
| `bin/inbound-handler.ts` (該当箇所) | `bus.signal(`bot_${agentId}`)` 呼出削除 |
| import 整合 | UnixSignalBus を import している箇所全 grep で削除 (impl PR で確認) |

### Spec §13.5.1 改訂 scope

現行 [文献確認: `docs/agent-com-message-queue-spec.md:1306-1332`]:

```
primary:    UnixSignalBus signal (bus.signal('bot_<agent>'))
secondary:  MCP notification
fallback:   Polling (30s timeout)
```

改訂後 [推測: 本 ADR が ratify されたら spec に反映する案、impl PR 内で atomic に
適用]:

```
primary:    wake-daemon tmux send-keys (bin/wake-daemon.ts)
            - polling DB で pending 検出
            - tmux send-keys で対象 bot に prompt 注入
            - bot 側は LLM agent (Claude Code / Codex / Gemini)、
              prompt 受領で next tool を能動呼出
secondary:  MCP notification (notifications/message/pending)
            - MCP client がコンテキスト注入対応時の加速
            - 現時点 Claude Code 未対応 (§13.5 既知制約維持)
fallback:   Polling (next 能動呼出 by bot LLM judgement)
            - bot は wake-daemon prompt を受領しなくても
              定期的に next を呼ぶ (LLM 内部 judgement)
            - signal/notification が全て失敗しても最終的に message 取得
```

### 副次仕様変更 [推測: 上記 spec 改訂と整合する derived spec]

- `AGENT_COM_POLL_INTERVAL_MS` の意味変更: PollingDriver の pre-fetch 間隔のみ
  (UnixSignalBus 不在のため signal timeout の概念が消失)
- `waitForSignal()` API 削除 (UnixSignalBus と一体)、代替なし

### 実装順序拘束 (本 ADR ratify 後)

1. spec §13.5.1 改訂を本 ADR 内で記述 (impl PR 内で適用)
2. UnixSignalBus 削除 PR を起票 (`core/message-bus.ts` + import 整合 + bot run script)
3. 同 PR 内で spec §13.5.1 改訂を doc 変更として含める (実装 + spec 同期 atomic merge)
4. CI で「PID file 不在」が前提として正常動作するか full suite 検証
5. merge 後、ADR-052 impl PR 着手可能となる

## Considered alternatives

### Option A: spec 通り PID file 復活 + UnixSignalBus 機能化

`server.ts` boot で `writeFileSync(pidFilePathFor(AGENT_ID), String(process.pid))` +
EXIT trap で `unlinkSync`、UnixSignalBus を本来の primary として復活、wake-daemon
は redundant supplementary に。

**メリット**: code 変更小 (server.ts に PID write 追加のみ)、spec text 不変。

**デメリット**:
- wake-daemon との role 重複、runtime 競合可能性 [推測: 両 mechanism が同一 bot
  に同時 wake → SIGUSR1 連射 / tmux 連射の race、prototype 検証必要]
- wake-daemon 7d12h 稼働実績 [検証済: ps PID 6804] を後付け降格する整合 cost 大
- LLM agent (Claude Code / Codex / Gemini) は SIGUSR1 を受けても prompt 注入されない
  [推測: tmux send-keys 経由が prompt 注入の standard、SIGUSR1 単独では LLM session
  に prompt が届かない、empirical 確認は別途必要]
- = 構造的に UnixSignalBus は LLM agent 環境では機能しない可能性高 [推測: 本 ADR
  §Context Fixture A/B [検証済] で「UnixSignalBus 経路は no-op」を確認、A 採択
  しても LLM 環境で機能しない論理的帰結]

### Option B (採用): 実装に合わせ spec 更新 + UnixSignalBus 削除

本 ADR の決定。

### Option C: 両立 (PID file 復活 + spec で wake-daemon を別 supplementary 明記)

PID file 機構復活させつつ、spec で「primary = wake-daemon、tertiary = UnixSignalBus」
等の併記。

**メリット**: 冗長性最大、UnixSignalBus も live。

**デメリット**:
- complexity 増 (3 機構の優先順位 + race 制御) [推測: maintenance 増の見込み]
- maintenance 増、UnixSignalBus は LLM agent 環境では実効性低い (Option A 同根拠)
- ADR-051 (HA / supervisor) で wake-daemon SPOF を解消する path と矛盾 [文献確認:
  ADR-051 起票要請 msg `e7bd...` (forward in this ARC session)、wake-daemon を
  primary として受け取り supervisor で守る前提]

## Selection rationale

Option B 採択理由:

1. **Honesty 原則**: CEO directive (msg `1d03f8bd`) [文献確認] 解消が第一目的、
   spec と実装の乖離をゼロにする最 direct path
2. **wake-daemon de jure 化**: PID 6804 7d12h 連続稼働 [検証済: ps 出力] の de
   facto primary を spec で明文化、impl 既存資産に sync (新規 work 最小)
3. **runtime 競合回避**: A の PID file 復活は wake-daemon と race を生む [推測:
   prototype 検証必要、ただし B は race 自体を発生させない安全側]
4. **LLM agent 整合**: tmux send-keys 経由 prompt 注入が wake mechanism として
   現運用で機能 [検証済: 本日複数 channel で wake-daemon 経由 message 配送観察]、
   UnixSignalBus は LLM agent 環境向きでない [推測]
5. **後続 ADR (-052 / -051) 整合**: 本 ADR ratify が ADR-052 の前提 [文献確認:
   ADR-052 v0.1 §1 Predecessors 明記]、ADR-051 は wake-daemon 責務確定後着手、
   一貫した path

## Consequences

### Positive [推測: 本 ADR ratify + impl 後の予測影響]

- spec と実装が一致、CEO directive「監査通過 governance gap」が本 ADR scope
  内で解消 [文献確認: CEO directive msg `1d03f8bd`]
- wake-daemon が de jure primary、ADR-052 / ADR-051 の前提が spec で明文化
- UnixSignalBus dead code 削除、保守対象縮小
- LLM agent 環境 (Claude Code / Codex / Gemini) との整合明示

### Negative (許容するトレードオフ) [推測]

- wake-daemon が唯一の push mechanism となり SPOF が顕在化、ただし ADR-051
  (HA / supervisor) で別途解決 path 設定済 [文献確認: ADR-051 起票要請 msg]
- `waitForSignal()` API 削除により外部 OSS 利用者 (将来想定) の互換性が破壊
  される。本 ADR は OSS 公開前 (ADF Phase C redef §1) [文献確認: project memory
  `project_adf_oss_aware_design.md`] なので impact 0 と判断
- spec §13.5 で「Claude Code 未対応 (MCP notification context 注入)」表記は維持

### Future considerations

- Claude Code が将来 MCP notification context 注入対応した場合、tmux send-keys
  廃止 / MCP notification primary 昇格を別 ADR で検討可 [推測]
- 別 daemon (例: PostgreSQL pg_notify ベース) への移行は将来 ADR、本 ADR では
  scope 外

## Contract tests (merge gate)

本 ADR ratify 後、impl PR で以下 contract test を merge gate とする。本 ADR
v0.1 起草時点では fixture 自体は未実行 [推測: 全 §6a-§6e は impl PR で executable
化、本 ADR 段階では「実行する内容と期待値の宣言」のみ]:

### §6a: UnixSignalBus 関連 import / 使用が code base に存在しない

```bash
$ grep -rE 'UnixSignalBus|bus\.signal|bus\.waitForSignal' core/ bin/ src/ tests/
expected: 0 件 (test/spec doc を除く、過去言及含めて削除済)
```

### §6b: PID file 不在で agent-comms 起動成功

```bash
$ rm -f /tmp/agent-com-*.pid
$ npm run start
expected:
  - 起動成功 (exit code 0 / process running)
  - log に PID file 不在 warning なし
```

### §6c: spec §13.5.1 の primary が wake-daemon

```bash
$ grep -A 3 'primary:' docs/agent-com-message-queue-spec.md | head -5
expected: "primary: wake-daemon tmux send-keys" 等の表記
       (UnixSignalBus 表記が残っていない)
```

### §6d: wake-daemon 経由 message delivery が動作する (regression)

```
fixture (real send + wake-daemon active):
  1. wake-daemon を起動 [検証済: 既稼働 PID 6804、impl PR では fresh start でも実証]
  2. mcp__agent-comms__send で test-probe bot に message 送信
  3. test-probe の tmux session で next 呼出が観測される (15s 以内)
expected:
  - test-probe が message を pop し reply する
  - UnixSignalBus 経路を通らずに wake が成立 (本 ADR の主目的)
```

### §6e: full test suite green

```bash
$ npm test
expected: 全 suite pass、UnixSignalBus 関連 test は削除 or skip → green
```

## Open decisions (impl 裁量範囲)

- UnixSignalBus 関連 dead code の段階削除順 (file 単位 / commit 単位、
  ただし atomic な PR で全削除完了は frozen)
- spec §13.5.1 改訂時の文章 style (現行 spec の document tone を踏襲、
  technical claim は本 ADR 記述を信頼)
- log message format の整理 (UnixSignalBus 関連 log 行削除に伴う近傍整理)
- bot run-bot.sh 等の `waitForSignal()` 呼出削除に伴う runtime startup の簡素化

## Forbidden behavior (anti-patterns)

- **PID file 機構を残す** — Option A の道、本 ADR で棄却済 [推測: race risk +
  LLM agent 環境不整合、prototype で実証は不要、Fixture A/B から論理的に decline
  可能]
- **UnixSignalBus を「fallback」「tertiary」として spec に残す** — Option C の道、
  Single source of truth 違反 [文献確認: 実態は wake-daemon 単一 primary、
  Fixture A/B から確定]
- **spec § 13.5.1 改訂を impl PR と分離する** — atomic merge 必須 [文献確認:
  PR #309 / #310 cascade で spec/impl 乖離が brick window を生んだ事例 = ADR-052
  v0.1 §4 fixture C、ADR-049 motivating evidence]

## Related

| 項目 | 内容 |
|------|------|
| 関連 ADR | ADR-041 (Phase 5 routing + 2026-05-05 amendment), ADR-052 (DB-observable reaper、本 ADR ratify が前提), ADR-051 (HA / supervisor、本 ADR ratify 後着手), ADR-053 (heartbeat、取下げ) |
| 関連 spec | `agent-comms-mcp/docs/agent-com-message-queue-spec.md` §13.5.1 (line 1306-1332) |
| 観察 evidence | msg `c1258e88` / `978ade62` / `7a0c227d` (agent-com-dev A2 調査), 実機 ps wake-daemon PID 6804 (7d12h 稼働), grep 結果 (PID file 書込み code path 不在) |
| CEO directive | msg `1d03f8bd` (監査通過 governance gap), msg `97dd47e6` (「C」全 ADR 並走), msg `c40b8dc9` (「進めて」初期) |
| 関連 PR | impl PR (TBD、本 ADR ratify 後起票) |
| 関連 Issue | (TBD impl PR 起票時に追記) |

## Meta

| 項目 | 内容 |
|------|------|
| 作成日 | 2026-05-05 |
| 作成者 | ARC (iyasaka-arc) |
| 最終更新日 | 2026-05-05 |
| レビュアー | CTO (ratify 待機), CEO (acceptance) |

## Changelog

| 日付 | 変更内容 | 変更者 |
|------|---------|-------|
| 2026-05-05 | v0.1 初版起草 (ADR-052 順序拘束対応で P0 起草、observed evidence 3 件取り込み、wake-daemon de jure primary 化、evidence labels [検証済]/[文献確認]/[推測] 全 substantive assertion に付与) | ARC |
