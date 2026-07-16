// Deterministic subprocess fixture: persist one claim, then exit before
// turn.presented so the parent can prove identity-based restart recovery.

import { SqliteAdapter } from '../../../core/db/sqlite-adapter'
import { claimNextTurn } from '../../../core/eventlog/turns'

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`--${name} is required`)
  return value
}

const db = new SqliteAdapter(arg('db'))
const seatId = arg('seat-id')
const instanceId = arg('instance-id')
const claimed = await claimNextTurn(db, { seatId, seatInstanceId: instanceId })
if (!claimed) throw new Error('fixture found no claimable turn')
process.stdout.write(JSON.stringify({
  turn_id: claimed.turn.turn_id,
  claim_event_id: claimed.claimEventId,
  claim_epoch: claimed.claimEpoch,
}) + '\n')
await db.close()
process.exit(17)
