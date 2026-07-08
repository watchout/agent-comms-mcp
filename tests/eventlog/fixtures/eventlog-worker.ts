// Fleet-kill fixture worker: one seat instance processing its inbox via
// pull-claim against a shared EventLogCore SQLite file. The parent test
// SIGKILLs this process at arbitrary moments — everything this worker does
// must therefore be crash-safe purely through the log.
//
// Usage: bun tests/eventlog/fixtures/eventlog-worker.ts \
//          --db <path> --seat <seatId> --instance <instanceId>

import { SqliteAdapter } from '../../../core/db/sqlite-adapter'
import {
  claimNextTurn,
  completeTurn,
  openTurnCount,
  recoverSeatClaims,
  StaleClaimError,
  ClaimLostError,
} from '../../../core/eventlog'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing --${name}`)
  return process.argv[i + 1]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  const db = new SqliteAdapter(arg('db'))
  const seatId = arg('seat')
  const seatInstanceId = arg('instance')

  // restart IS the recovery signal: release claims of dead predecessors
  await recoverSeatClaims(db, { seatId, activeInstanceId: seatInstanceId })

  while (true) {
    let claimed
    try {
      claimed = await claimNextTurn(db, { seatId, seatInstanceId })
    } catch (err) {
      if (err instanceof ClaimLostError) continue
      throw err
    }
    if (!claimed) {
      if ((await openTurnCount(db, { seatId })) === 0) process.exit(0)
      await sleep(15)
      continue
    }
    // simulated work — this window is where SIGKILL likes to land
    await sleep(5 + Math.floor(Math.random() * 20))
    try {
      await completeTurn(db, {
        turnId: claimed.turn.turn_id,
        seatId,
        seatInstanceId,
        claimEventId: claimed.claimEventId,
        outcome: 'replied',
        conversationId: claimed.turn.conversation_id,
        replies: [
          {
            content: `processed ${claimed.turn.message_id} by ${seatInstanceId}`,
            channelExternalId: 'chan-fixture',
          },
        ],
      })
    } catch (err) {
      // fenced out by a recovery that raced us — the turn belongs to a
      // newer claim now; just move on
      if (err instanceof StaleClaimError) continue
      throw err
    }
  }
}

main().catch(err => {
  console.error(`[worker ${process.argv.join(' ')}]`, err)
  process.exit(1)
})
