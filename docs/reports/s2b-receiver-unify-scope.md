# S2-B: Receiver Process Unification — Scope Placeholder

Branch: arc/s2-b-receiver-unify / Issue: #147 / Epic: #141
Author: Arc (scope) / Implementation: agent-com-dev + lead-ama

Arc が CTO 指示で PR 起票枠を作成。実装は dev bot が本ブランチへ commit。
PR description に同内容を転記後、本ファイルは削除可。

## 方針（CEO / lead-ama 反映要）
- retreat path (a) pull-on-notify 正式採用（ADR-041 §改訂3）
- SSE skip
- PollingDriver (PR#139) を polling 基盤として利用
- stdio bot を唯一の inbound source とする
- bot context 品質の積極選択として位置付け

## 対象変更（server.ts）
- L3113 stdio mode onMessage — 保持、正規 receiver として昇格
- L3410 daemon /sse per-bot onMessage — 削除 or 無効化
- L3508 daemon per-bot client onMessage EXPECTED_BOTS loop — 削除 or 無効化
- L3554 daemon shared adapter onMessage EXPECTED_BOTS loop — 削除 or 無効化

## docs
- message-queue-spec §2 設計原則 #2「受信は 1 プロセスだけ」の実装一致を明記
- daemon mode の責務を outbound / admin のみに再定義

## tests
- 単一 onMessage invocation の regression test
- plugin-regression で duplicate INSERT ゼロ検証

## 完了条件
- [ ] server.ts に inbound receiver entry point が 1 つのみ
- [ ] daemon/stdio 同時稼働でも INSERT 重複ゼロ（24h 観測）
- [ ] message-queue-spec §2 原則 #2 と実装一致
- [ ] unit + e2e green
- [ ] codex 二次 + CTO 三次 LGTM

## 参照
- ADR-041 (Receiver-MessageBus)
- spike: docs/reports/adr-041-spike-result.md（agent-com-dev follow-up PR 予定）
- lead-ama 指示: #147 comment (Arc preserved)
