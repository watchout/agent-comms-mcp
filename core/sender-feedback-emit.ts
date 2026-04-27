// Issue #251 cycle 2 axis 3 (CTO directive `c1c6eb1d`) — caller-side
// consumer for `notifySenderOfDeliveryStatus`'s `emitted` field.
//
// cycle 1 short-circuited the busy / system_info branch of
// `core/sender-feedback.ts` so it stopped enqueueing into
// message_queue (the rows were noisy and never actionable). The
// auditor (msg `02be8430`) flagged this as a `hidden impact` 🔴:
// the production callers `await` the helper but never inspect the
// return value, so the `emitted: 'system_info'` signal had nowhere
// to land — the busy notification was silently dropped, breaking
// the Issue #251 §2 intent ("queue 健全化 + 観測").
//
// CTO Q1 verdict (msg `c1c6eb1d`): adopt option (a) — emit a
// log line + bump a process-local counter every time a busy
// signal is observed. Wraps the call so all three call sites
// (`server.ts:1865`, `server.ts:2213`, `adapters/inbound-receiver.ts:606`)
// stay DRY.
//
// Counter: process-local. The fleet's metric story is currently
// stderr lines aggregated by tmux logs / cron tail; promoting to a
// shared metric backend is out of scope for this cycle. The counter
// is exported for tests / future metric backends to pick up.

import { notifySenderOfDeliveryStatus, type SenderFeedbackDb, type NotifyDeliveryStatusArgs } from './sender-feedback'

interface CounterShape {
  systemInfo: number
  systemError: number
  none: number
}

const counter: CounterShape = { systemInfo: 0, systemError: 0, none: 0 }

/** Snapshot of the in-process counter, primarily for tests. */
export function getSenderFeedbackCounter(): Readonly<CounterShape> {
  return { ...counter }
}

/** Reset between tests. Not exported via the index — production never calls it. */
export function _resetSenderFeedbackCounter(): void {
  counter.systemInfo = 0
  counter.systemError = 0
  counter.none = 0
}

/**
 * `notifySenderOfDeliveryStatus` wrapper that consumes the
 * `emitted` field. Behavior:
 *  - emitted=`system_info` → counter bump + stderr line so a busy
 *    target can be observed without re-introducing the queue noise
 *  - emitted=`system_error` → counter bump (the row IS still in the
 *    queue, the line is for parity with the system_info case)
 *  - emitted=`null` → counter bump only (most common: idle target,
 *    no log noise).
 *
 * Returns the helper's full result so callers retain the option to
 * inspect further if they need to (e.g. metric assertions in tests).
 */
export async function notifySenderAndObserve(
  db: SenderFeedbackDb,
  args: NotifyDeliveryStatusArgs,
): Promise<{ emitted: 'system_info' | 'system_error' | null; reason?: string }> {
  const result = await notifySenderOfDeliveryStatus(db, args)
  if (result.emitted === 'system_info') {
    counter.systemInfo += 1
    process.stderr.write(
      `agent-comms: sender-feedback.system_info — sender=${args.senderId} target=${args.targetId} reason=${result.reason ?? 'unknown'}\n`,
    )
  } else if (result.emitted === 'system_error') {
    counter.systemError += 1
  } else {
    counter.none += 1
  }
  return result
}
