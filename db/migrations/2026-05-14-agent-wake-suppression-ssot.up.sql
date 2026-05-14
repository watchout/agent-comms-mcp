-- State-daemon wake suppression SSOT.
--
-- The suppression window is owned by the recipient bot, not by the current
-- set of pending message_queue rows. A single pending row can be claimed and
-- leave `pending` before the next message arrives; row-scoped lookup then
-- loses the wake history and re-wakes the bot. Store the canonical timestamp
-- on agents so it survives message status transitions.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_wake_attempt_at TIMESTAMPTZ;

UPDATE agents a
   SET last_wake_attempt_at = q.bot_last_wake
  FROM (
    SELECT agent_id, MAX(last_wake_attempt_at) AS bot_last_wake
      FROM message_queue
     WHERE last_wake_attempt_at IS NOT NULL
     GROUP BY agent_id
  ) q
 WHERE a.agent_id = q.agent_id
   AND (a.last_wake_attempt_at IS NULL OR a.last_wake_attempt_at < q.bot_last_wake);
