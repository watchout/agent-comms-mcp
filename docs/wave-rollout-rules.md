# Wave Rollout Rules — Phase C aun deployment

> **Status: provisional. Effective upon merge of PR #258 (port resolution fix) and PR #260 (cleanup-orphan-ports PPID==1 fix).** ← this blockquote Status metadata line is the single canonical site of the effective-condition sentence; the rest of this doc references it rather than restating it.
>
> Owner: lead-ama (orchestrate), ARC (bot selection + completion judgment), CTO (L3 sanity + merge), CEO (final approval)
> Source: lead-ama draft v3 (msg `90f125f9`) + ARC review (msg `dac4d418` / `ce856485`) + CTO L3 LGTM (msg `479b9e3e`)

This document is the operational contract for rolling `aun` out across the 18-bot fleet. Effective once the Status condition above holds (no separate restatement here). It defines the vocabulary, the wave-by-wave entry / exit / rollback criteria, the evidence-collection protocol, and the completion judgment.

---

## 1. Terminology (frozen)

The terms `test`, `pilot`, `3 條件 AND PASS`, and `回帰なし` are **not interchangeable**. Mixing them up was the failure mode that v1 of this doc tripped on; v3 keeps them strictly separated.

| term | meaning | who |
|---|---|---|
| **test** | `bun test` run inside the PR merge gate (unit / contract / e2e) | dev-bot (writes), L1 / L2 / L3 (verify) |
| **pilot** | production-environment observation of a real bot under real Discord traffic, with `aun` installed | lead-ama orchestrates; the bot itself is the subject |
| **3 條件 AND PASS** | the pilot pass criteria (auto-wake AND Stop hook AND queue drain), all observed with `回帰なし` in the same observation window | lead-ama judges |
| **回帰なし** | no regression of any other bot in the fleet during the pilot — measured by the metric set in §2 (`### 回帰なし metric set`) | lead-ama judges |
| **fast-merge ≠ L2 skip** | the `route:fast-merge` label is a CEO-gate skip (governance-flow.md), **NOT** an auditor L2 skip. L2 6-axis review is mandatory on every PR regardless of label. | every layer |

The `fast-merge ≠ L2 skip` clarification is included verbatim per CTO directive `479b9e3e` (the lesson from PR #253's governance violation).

---

## 2. Wave 1 — single-bot pilot

**Target:** `secretary` (ARC primary recommendation). Alternates, in order: `research-lead` → `org-build-dev`. CTO may substitute if the primary is not available.

ARC's rationale for `secretary`: low operational criticality, light send/receive traffic, owner of admin / digest workflows so the bot itself can observe the rollout, no new onboarding cost (already has `aun` architecture context).

### Entry

- Per the canonical Status sentence at the top of this document. (Issue #251 / PR #253 + PR #255 are already merged; the remaining gate is PR #258 + PR #260, which together resolve Issue #248 cascade-disconnect.)
- ARC + CTO + lead-ama 連名 GO

### Exit (3 條件 AND + 回帰なし, 30-minute observation window)

All three conditions are observed by **lead-ama as primary**. The pilot bot's chain reply provides corroborating evidence; it is never the sole source. This `lead-ama primary + bot 補強 AND` rule was added by ARC to break the self-attestation circular caught in PR #243 axis 6.

| condition | lead-ama primary | bot 補強 |
|---|---|---|
| (1) auto-wake | `tmux capture-pane -p -t discord-secretary` shows session wake within 5s of test mention | secretary's chain reply confirming the wake timestamp |
| (2) Stop hook fires | `tail -f ~/.claude/hooks/auto-next.log` shows the fire record from outside the bot | secretary's chain reply citing the hook log line |
| (3) queue drain | `psql -c "SELECT status, read_at, replied_at FROM message_queue WHERE recipient_agent_id='secretary' ORDER BY id DESC LIMIT 3"` shows `pending → read → replied` transition | secretary's chain reply quoting its own observation |

### 回帰なし metric set

- `mcp__agent-comms__bot_status` reports every bot ✓ healthy
- queue size has not grown by more than 50 % vs. the pre-pilot baseline
- error log carries 0 new pattern signatures
- `IMPLICIT_ABANDON` count over the window: +0

### Rollback

- `~/.claude/plugins/aun/scripts/uninstall.sh --surgical`
- `scripts/restart-bot.sh discord-secretary`
- The `--surgical` flag relies on the cycle 5 abort machinery in `bin/aun/init.ts` (PR #247). Broken intermediate states do not persist.

---

## 3. Wave 2 — 3-bot main-line pilot

**Targets, in order:** `lead-ama` (1) → `lead-tuk` (2) → `lead-sus` (3). The order reflects familiarity with `aun` internals (lead-ama owns dispatch authoring; lead-tuk owns agent-memory; lead-sus has the lightest current operational load).

`agent-com-dev` is **deliberately held back to Wave 3** despite being the implementer of the queue / dedup / TTL fixes. Independence of cross-checking outweighs convenience: the bot that wrote the code should not also be the bot that pilots its first production exposure.

### Entry

- Wave 1 Exit complete and `secretary` has been stable for 24 hours
- ARC + CTO + lead-ama 連名 GO

### Exit (3 條件 AND PASS × 3 bots + 回帰なし, 1-hour observation window)

Same evidence protocol as Wave 1, scaled to three bots. Failure of any single bot does not require rolling back the whole wave; isolate the failing bot.

### Rollback

- Failure isolation by default — `--surgical` uninstall on the failing bot only, leaving Wave 1 + the surviving Wave 2 bots in place
- If two or more bots fail simultaneously, escalate to CTO + ARC; pause Wave 2 until root cause is understood

---

## 4. Wave 3 — fleet pilot (14 bots)

**Targets:** the remaining 14 bots, including `agent-com-dev`. ARC selects an order that staggers high-traffic bots from low-traffic bots to keep observation tractable.

### Entry

- Wave 2 Exit complete and 24 hours of stability
- queue health baseline checked against the §2 metric set with Wave-2 traffic load mixed in
- ARC + CTO + lead-ama 連名 GO

### Exit (14 bots, 3 條件 AND + 回帰なし, 2-hour observation window)

If more than 3 bots fail, roll back the **whole wave** (re-uninstall on every Wave-3 bot) and treat it as a Wave 2 → Wave 3 boundary regression. Single-bot or two-bot failures isolate as in Wave 2.

### Rollback

- Per-bot `--surgical` uninstall for ≤ 2 failures
- Whole-wave rollback for ≥ 3 failures: every Wave-3 bot uninstalls back to its pre-Wave-3 state; Wave 1 + Wave 2 bots remain installed

---

## 5. Phase C completion judgment

This is the **strategic infrastructure-rollout judgment layer** — distinct axis from the per-PR post-merge verification chain in §5a below. The two chains are not a substitute for each other; both run.

After Wave 3 Exit and 24 hours of stability across all 18 bots, **連名直列** sign-off:

```
ARC → CTO → auditor → CEO
```

Direct sequence, each layer does its own independent verification. CEO is the final approver, signing off on the strategic completion of Phase C as a whole, not on individual PR merges (those go through §5a).

### 5a. Per-PR pre-merge governance + post-merge verification chains

`~/.claude/rules/governance-flow.md` defines **two distinct chains** for each PR. Both run; the merge is the boundary, not the endpoint.

**Pre-merge governance** (the 4-layer review that gates the merge button):
```
dev → lead-bot L1 → codex-auditor L2 → CTO L3 → merge
```
ends at `CTO L3 + merge` for `route:fast-merge` PRs. CEO sign-off enters only on `route:ceo-approval` PRs (DB schema, public API, security, pricing — see governance-flow.md §Routine vs Critical).

**Post-merge verification** (mandatory after every merge per governance-flow.md §Post-merge 全方位検証, CEO directive 2026-04-09):
```
dev bot が target 環境で全方位テスト実行
  → lead-bot 一次検証レビュー
  → codex-auditor 二次検証レビュー (6 axes)
  → CTO 三次検証レビュー (governance / framework 適用)
  → 完了判定 ✅
```
critical PR の場合は + CEO 明示承認で完了。

Runs in the target environment (production / staging / dev framework, depending on product type — see governance-flow.md). Verifies unit / integration / e2e / regression / smoke tests pass in target, the bot is online, peripheral bots remain reachable, and no new error patterns appear in logs. **The merge is the start of post-merge verification, not the end of governance.**

§5a applies to every PR landing during the rollout — this hotfix itself, the gating PRs (#258, #260), the rollout-rules doc PRs (#254 + this hotfix), and future hotfixes. §5 (above) is the orthogonal strategic check that fires once at the end of Wave 3, judging the rollout as a whole; §5a is the per-PR continuous check that runs both before and after every merge.

### Required signals

| signal | check |
|---|---|
| 18 bots all maintain 3 條件 AND PASS | snapshot `mcp__agent-comms__bot_status` and the wave-2/3 evidence dashboards |
| queue health | mean pending row age < 1h, 0 stale rows beyond TTL |
| DB / log error patterns | no new pattern signature accumulated since the rollout started |
| `IMPLICIT_ABANDON` cumulative rate | 0 per 24h window |

---

## 6. Honesty enforcement

Every piece of evidence above is collected with **lead-ama primary + bot 補強 AND**. Bot self-attestation in OR mode is not acceptable. This rule exists because PR #243 axis 6 and PR #253 axes 3 / 5 / 6 each leaned on the implementer's own report and missed real defects.

The auditor independence pattern (an independent verifier reads the artifact, runs the command, compares the claim against the diff) applies at every gate: L1 / L2 / L3 / wave-pilot evidence.

---

## 7. Escalation

| trigger | action |
|---|---|
| any 回帰 observed | immediately stop the current wave; report to CTO + ARC in the same minute |
| two consecutive waves fail | escalate to CEO; do not re-attempt without an explicit authorization |
| an unexpected pattern (anything not enumerated above) | ARC initiates preventive observation; lead-ama pauses orchestration until ARC clears |

---

## 8. Responsibility table

| step | owner |
|---|---|
| wave 1 / 2 / 3 bot candidate selection | ARC |
| pilot execution (test mention dispatch, real-time observation) | lead-ama orchestrate |
| evidence collection (primary) | lead-ama |
| evidence corroboration | the pilot bot itself (chain reply) |
| pass / fail judgment per condition | lead-ama |
| Phase C completion sign-off | ARC + CTO + auditor + CEO (連名直列) |

---

## 9. Source

- lead-ama draft v3: agent-comms message id `90f125f9`
- ARC review verdict: agent-comms message id `dac4d418` (Q1-Q3) + `ce856485` (Q4 honesty refinement)
- CTO L3 LGTM (7 観点全 PASS): agent-comms message id `479b9e3e`
- Storage decision (this file path) recommended by ARC same review: `~/Developer/agent-comms-mcp/docs/wave-rollout-rules.md` — operational doc for an agent-comms-mcp deployment, not an iyasaka-arc artifact
