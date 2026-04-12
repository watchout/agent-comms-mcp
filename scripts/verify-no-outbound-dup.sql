-- S2-A (FEAT-005) post-merge regression check
-- Plan: docs/plans/outbound-forwarder-unification.md §4.2
--
-- Detects the class of bug that S2-A closes: identical outbound content
-- posted to Discord by multiple bots (race in outbound_queue consumer
-- combined with shared-client fallback). A green run = zero rows.
--
-- Incidents this query is calibrated against (all 2026-04-12 UTC):
--   21:43:54 — CTO→lead-ama handoff 1                (2-fold)
--   21:50:25 — 追加指示メッセージ                     (3-fold)
--   21:53    — lead-ama→CTO plan v1 報告             (2-fold)
--   22:26:02 — CTO→lead-ama handoff 2 (2-part)       (6-fold = 3 bot × 2 part)
--
-- Usage: psql $DATABASE_URL -f scripts/verify-no-outbound-dup.sql
-- Expected: "0 rows" in all three sections. Any non-empty result = regression.

-- ─────────────────────────────────────────────────────────────────────────────
-- (A) Inbound side: same content, different discord_message_id within 1 hour.
-- Distinct Discord posts with identical content across different bot accounts
-- = the smoking gun of outbound-consumer duplication leaking into inbound.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  md5(content)                                          AS content_hash,
  count(DISTINCT metadata->>'discord_message_id')       AS distinct_discord_msgs,
  count(*)                                              AS total_rows,
  min(created_at)                                       AS first_seen,
  max(created_at)                                       AS last_seen,
  array_agg(DISTINCT author_id)                         AS author_ids
FROM agent_messages
WHERE created_at > now() - interval '1 hour'
  AND direction = 'inbound'
  AND source = 'discord'
GROUP BY content_hash
HAVING count(DISTINCT metadata->>'discord_message_id') > 1
ORDER BY last_seen DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- (B) Outbound-queue side: rows that went to 'sent' more than once per
-- logical message_id — should never happen. If you see this, the claim
-- SQL is letting rows be double-processed.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  message_id,
  agent_id,
  count(*)    AS sent_rows,
  min(sent_at) AS first_sent,
  max(sent_at) AS last_sent
FROM outbound_queue
WHERE status = 'sent'
  AND sent_at > now() - interval '1 hour'
GROUP BY message_id, agent_id
HAVING count(*) > 1
ORDER BY last_sent DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- (C) Orphan processing rows beyond the reclaim window. Should be 0 once
-- the 60s orphan tick has run at least once past OUTBOUND_ORPHAN_TIMEOUT_SEC.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  id, agent_id, claimed_at, attempts, max_attempts, last_error
FROM outbound_queue
WHERE status = 'processing'
  AND claimed_at < now() - interval '10 minutes'
ORDER BY claimed_at ASC;
