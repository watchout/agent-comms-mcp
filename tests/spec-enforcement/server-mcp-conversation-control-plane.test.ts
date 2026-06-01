import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(ROOT, 'server.ts'), 'utf8')
const QUEUE_DEDUP_SRC = readFileSync(join(ROOT, 'core', 'queue-dedup.ts'), 'utf8')

function exportedFunctionBody(src: string, fnName: string): string {
  const start = src.indexOf(`export async function ${fnName}`)
  expect(start).toBeGreaterThan(-1)
  const nextFn = src.indexOf('\nexport async function ', start + 1)
  return src.slice(start, nextFn === -1 ? undefined : nextFn)
}

function toolBody(toolName: 'send' | 'notify'): string {
  const start = SERVER_SRC.indexOf(`if (name === '${toolName}')`)
  expect(start).toBeGreaterThan(-1)
  const nextTool = SERVER_SRC.indexOf("\n  if (name === '", start + 1)
  return SERVER_SRC.slice(start, nextTool === -1 ? undefined : nextTool)
}

describe('MCP send/notify conversation control-plane linkage', () => {
  test('queue dedup has a caller-transaction variant for MCP tool transactions', () => {
    const body = exportedFunctionBody(QUEUE_DEDUP_SRC, 'enqueueWithDedupInTransaction')

    expect(QUEUE_DEDUP_SRC).toMatch(/export async function enqueueWithDedupInTransaction/)
    expect(body).toMatch(/pg_advisory_xact_lock/)
    expect(body).not.toMatch(/new Client/)
  })

  test('MCP send links the active-owner queue row to the conversation allocator', () => {
    const body = toolBody('send')

    expect(body).toMatch(/resolveConversationControlPlaneGate\('mcp\.send'\)/)
    expect(body).toMatch(/enqueueWithDedupInTransaction\(/)
    expect(body).toMatch(/runWithTransactionSavepoint\(\s*txClient,\s*'mcp_send_queue_fanout'/)
    expect(body).toMatch(/activeOwnerQueueId\s*=\s*result\.queueId/)
    expect(body).toMatch(/applyMcpConversationControlPlane\([\s\S]*?'mcp\.send'/)
    expect(body).toMatch(/root_message_id:\s*conversationRootMessageId/)
    expect(body).toMatch(/reply_to_conversation_id:\s*replyToConversationId/)
    expect(body).toMatch(/conversation_control_plane=/)
  })

  test('MCP notify is transaction-scoped and links the active-owner queue row', () => {
    const body = toolBody('notify')

    expect(body).toMatch(/await client\.query\('BEGIN'\)/)
    expect(body).toMatch(/if \(!txCommitted\)[\s\S]*ROLLBACK/)
    expect(body).toMatch(/resolveConversationControlPlaneGate\('mcp\.notify'\)/)
    expect(body).toMatch(/enqueueWithDedupInTransaction\(/)
    expect(body).toMatch(/runWithTransactionSavepoint\(\s*client,\s*'mcp_notify_queue_fanout'/)
    expect(body).toMatch(/activeOwnerQueueId\s*=\s*result\.queueId/)
    expect(body).toMatch(/applyMcpConversationControlPlane\([\s\S]*?'mcp\.notify'/)
    expect(body).toMatch(/root_message_id:\s*conversationRootMessageId/)
    expect(body).toMatch(/conversation_control_plane=/)
  })

  test('MCP queue fanout savepoints preserve non-fatal recipient failure isolation', () => {
    const helper = SERVER_SRC.slice(
      SERVER_SRC.indexOf('async function runWithTransactionSavepoint'),
      SERVER_SRC.indexOf('async function loadMessageConversationIdFromClient'),
    )

    expect(helper).toMatch(/SAVEPOINT/)
    expect(helper).toMatch(/ROLLBACK TO SAVEPOINT/)
    expect(helper).toMatch(/RELEASE SAVEPOINT/)
    expect(toolBody('send')).toMatch(/non-fatal fanout error does not poison/)
    expect(toolBody('notify')).toMatch(/non-fatal fanout error does not poison/)
  })
})
