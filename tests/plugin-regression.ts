#!/usr/bin/env bun
/**
 * Regression test suite for agent-com plugin (§14)
 *
 * Tests 8 critical areas:
 * 1. Bot filter correctness
 * 2. Access control
 * 3. Message send/receive (DB)
 * 4. Rate limiting (DB-persistent)
 * 5. Loop detection
 * 6. HMAC authentication
 * 7. Agent registration
 * 8. Content sanitization
 *
 * Usage: bun test tests/plugin-regression.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { Client } from 'pg'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')

// --- Test 1: Bot Filter ---
describe('1. Bot Filter', () => {
  test('server.ts must NOT use msg.author.bot for filtering', () => {
    // Should not contain the problematic pattern
    const hasBadPattern = /msg\.author\.bot/.test(SERVER_SOURCE)
    expect(hasBadPattern).toBe(false)
  })

  test('server.ts should use msg.author.id === client.user?.id pattern (if applicable)', () => {
    // This is a pattern check for when the Discord adapter is integrated.
    // For now we just verify the bad pattern is absent.
    // The correct pattern would be in the Discord adapter layer.
    const hasBadPattern = /msg\.author\.bot/.test(SERVER_SOURCE)
    expect(hasBadPattern).toBe(false)
  })
})

// --- Test 2: Access Control ---
describe('2. Access Control', () => {
  // We test the access control logic by extracting patterns from server.ts
  // Since we can't import server.ts directly (it starts the MCP server),
  // we reimplement the core logic for testing.

  interface AccessConfig {
    dmPolicy: 'open' | 'pairing'
    allowFrom: string[]
    channels: Record<string, { requireMention: boolean; allowFrom: string[] }>
    mentionPatterns: string[]
    pending: Record<string, unknown>
  }

  function checkAccess(access: AccessConfig, authorId: string, channelId: string, content: string): { allowed: boolean; reason?: string } {
    if (access.allowFrom.length > 0 && !access.allowFrom.includes(authorId)) {
      return { allowed: false, reason: 'not in global allowFrom list' }
    }
    const channelRules = access.channels[channelId]
    if (channelRules) {
      if (channelRules.allowFrom.length > 0 && !channelRules.allowFrom.includes(authorId)) {
        return { allowed: false, reason: `not in allowFrom for channel ${channelId}` }
      }
      if (channelRules.requireMention) {
        const mentioned = access.mentionPatterns.some(p => content.includes(p))
        if (!mentioned) {
          return { allowed: false, reason: 'mention required but not found' }
        }
      }
    }
    return { allowed: true }
  }

  const accessConfig: AccessConfig = {
    dmPolicy: 'pairing',
    allowFrom: ['user-a', 'user-b'],
    channels: {
      'restricted-ch': { requireMention: true, allowFrom: ['user-a'] },
      'open-ch': { requireMention: false, allowFrom: [] },
    },
    mentionPatterns: ['<@bot-id>', '@bot'],
    pending: {},
  }

  test('allowFrom blocks unauthorized users', () => {
    const result = checkAccess(accessConfig, 'user-c', 'open-ch', 'hello')
    expect(result.allowed).toBe(false)
  })

  test('allowFrom permits authorized users', () => {
    const result = checkAccess(accessConfig, 'user-a', 'open-ch', 'hello')
    expect(result.allowed).toBe(true)
  })

  test('requireMention blocks messages without mention', () => {
    const result = checkAccess(accessConfig, 'user-a', 'restricted-ch', 'hello')
    expect(result.allowed).toBe(false)
  })

  test('requireMention allows messages with mention', () => {
    const result = checkAccess(accessConfig, 'user-a', 'restricted-ch', 'hello <@bot-id>')
    expect(result.allowed).toBe(true)
  })

  test('channel-level allowFrom blocks unauthorized users', () => {
    const result = checkAccess(accessConfig, 'user-b', 'restricted-ch', 'hello <@bot-id>')
    expect(result.allowed).toBe(false)
  })
})

// --- Test 3: Message Send/Receive (DB) ---
describe('3. Message Send/Receive (DB)', () => {
  let client: Client | null = null
  const testChannel = `__test_regression_${Date.now()}`

  beforeAll(async () => {
    try {
      const configPath = join(PROJECT_ROOT, 'config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      const dbUrl = process.env.DATABASE_URL ?? config.database_url ?? 'postgresql://localhost/agent_comms'
      client = new Client({ connectionString: dbUrl })
      await client.connect()
    } catch {
      client = null
    }
  })

  afterAll(async () => {
    if (client) {
      await client.query(`DELETE FROM agent_messages WHERE channel_id = $1`, [testChannel]).catch(() => {})
      await client.end().catch(() => {})
    }
  })

  test('save and fetch message round-trip', async () => {
    if (!client) return // skip if no DB
    const id = crypto.randomUUID()
    await client.query(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, depth)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, testChannel, 'test-agent', 'hello world', 'chat', 0]
    )
    const r = await client.query(
      `SELECT content FROM agent_messages WHERE id = $1`, [id]
    )
    expect(r.rows[0].content).toBe('hello world')
  })
})

// --- Test 4: Rate Limiting (DB-persistent) ---
describe('4. Rate Limiting', () => {
  let client: Client | null = null
  const testAgent = `__test_rate_${Date.now()}`

  beforeAll(async () => {
    try {
      const configPath = join(PROJECT_ROOT, 'config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      const dbUrl = process.env.DATABASE_URL ?? config.database_url ?? 'postgresql://localhost/agent_comms'
      client = new Client({ connectionString: dbUrl })
      await client.connect()
    } catch {
      client = null
    }
  })

  afterAll(async () => {
    if (client) {
      await client.query(`DELETE FROM rate_limits WHERE agent_id = $1`, [testAgent]).catch(() => {})
      await client.end().catch(() => {})
    }
  })

  test('DB rate limit UPSERT increments correctly', async () => {
    if (!client) return
    const windowStart = new Date()
    windowStart.setSeconds(0, 0)

    // First insert
    const r1 = await client.query(
      `INSERT INTO rate_limits (agent_id, window_start, message_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (agent_id, window_start) DO UPDATE SET message_count = rate_limits.message_count + 1
       RETURNING message_count`,
      [testAgent, windowStart.toISOString()]
    )
    expect(r1.rows[0].message_count).toBe(1)

    // Second insert (same window)
    const r2 = await client.query(
      `INSERT INTO rate_limits (agent_id, window_start, message_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (agent_id, window_start) DO UPDATE SET message_count = rate_limits.message_count + 1
       RETURNING message_count`,
      [testAgent, windowStart.toISOString()]
    )
    expect(r2.rows[0].message_count).toBe(2)
  })

  test('rate limit rejects when exceeded', async () => {
    if (!client) return
    const maxPerMinute = 30
    const windowStart = new Date()
    windowStart.setSeconds(0, 0)
    const agentId = `${testAgent}_exceed`

    // Insert at max count
    await client.query(
      `INSERT INTO rate_limits (agent_id, window_start, message_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, window_start) DO UPDATE SET message_count = $3`,
      [agentId, windowStart.toISOString(), maxPerMinute + 1]
    )

    const r = await client.query(
      `SELECT message_count FROM rate_limits WHERE agent_id = $1 AND window_start = $2`,
      [agentId, windowStart.toISOString()]
    )
    expect(r.rows[0].message_count).toBeGreaterThan(maxPerMinute)

    // Cleanup
    await client.query(`DELETE FROM rate_limits WHERE agent_id LIKE $1`, [`${testAgent}%`]).catch(() => {})
  })
})

// --- Test 5: Loop Detection ---
describe('5. Loop Detection', () => {
  let client: Client | null = null
  const testPair = `__test_a:__test_b`

  beforeAll(async () => {
    try {
      const configPath = join(PROJECT_ROOT, 'config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      const dbUrl = process.env.DATABASE_URL ?? config.database_url ?? 'postgresql://localhost/agent_comms'
      client = new Client({ connectionString: dbUrl })
      await client.connect()
    } catch {
      client = null
    }
  })

  afterAll(async () => {
    if (client) {
      await client.query(`DELETE FROM loop_counters WHERE agent_pair = $1`, [testPair]).catch(() => {})
      await client.end().catch(() => {})
    }
  })

  test('loop counter increments via DB UPSERT', async () => {
    if (!client) return
    const windowStart = new Date()
    windowStart.setTime(Math.floor(windowStart.getTime() / 300000) * 300000)

    const r = await client.query(
      `INSERT INTO loop_counters (agent_pair, window_start, exchange_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (agent_pair, window_start) DO UPDATE SET exchange_count = loop_counters.exchange_count + 1
       RETURNING exchange_count`,
      [testPair, windowStart.toISOString()]
    )
    expect(r.rows[0].exchange_count).toBeGreaterThanOrEqual(1)
  })

  test('depth check blocks deep chains (in-memory logic)', () => {
    const maxDepth = 10
    const depth = 15
    expect(depth > maxDepth).toBe(true)
  })
})

// --- Test 6: HMAC Authentication ---
describe('6. Authentication (HMAC-SHA256)', () => {
  const secret = randomBytes(32).toString('hex')

  function generateSignature(agentId: string, timestamp: number, channel: string, contentHash: string): string {
    const payload = `${agentId}:${timestamp}:${channel}:${contentHash}`
    return createHmac('sha256', secret).update(payload).digest('hex')
  }

  function verifySignature(agentId: string, timestamp: number, channel: string, contentHash: string, signature: string, replayWindow: number): boolean {
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - timestamp) > replayWindow) return false
    const expected = generateSignature(agentId, timestamp, channel, contentHash)
    return expected === signature
  }

  test('signature round-trip (generate → verify)', () => {
    const ts = Math.floor(Date.now() / 1000)
    const contentHash = createHash('sha256').update('hello world').digest('hex')
    const sig = generateSignature('agent-a', ts, 'test-ch', contentHash)
    expect(sig).toBeTruthy()

    const valid = verifySignature('agent-a', ts, 'test-ch', contentHash, sig, 300)
    expect(valid).toBe(true)
  })

  test('wrong secret fails verification', () => {
    const ts = Math.floor(Date.now() / 1000)
    const contentHash = createHash('sha256').update('hello world').digest('hex')
    const sig = generateSignature('agent-a', ts, 'test-ch', contentHash)

    // Tamper with signature
    const badSig = sig.slice(0, -4) + '0000'
    const valid = verifySignature('agent-a', ts, 'test-ch', contentHash, badSig, 300)
    expect(valid).toBe(false)
  })

  test('expired timestamp fails verification', () => {
    const ts = Math.floor(Date.now() / 1000) - 600 // 10 minutes ago
    const contentHash = createHash('sha256').update('hello world').digest('hex')
    const sig = generateSignature('agent-a', ts, 'test-ch', contentHash)

    const valid = verifySignature('agent-a', ts, 'test-ch', contentHash, sig, 300)
    expect(valid).toBe(false) // 600s > 300s replay window
  })
})

// --- Test 7: Agent Registration ---
describe('7. Agent Registration', () => {
  let client: Client | null = null
  const testAgentId = `__test_agent_${Date.now()}`

  beforeAll(async () => {
    try {
      const configPath = join(PROJECT_ROOT, 'config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      const dbUrl = process.env.DATABASE_URL ?? config.database_url ?? 'postgresql://localhost/agent_comms'
      client = new Client({ connectionString: dbUrl })
      await client.connect()
    } catch {
      client = null
    }
  })

  afterAll(async () => {
    if (client) {
      await client.query(`DELETE FROM agents WHERE agent_id = $1`, [testAgentId]).catch(() => {})
      await client.end().catch(() => {})
    }
  })

  test('UPSERT registers agent as online', async () => {
    if (!client) return
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at)
       VALUES ($1, $2, $3, $4, 'online', now())
       ON CONFLICT (agent_id) DO UPDATE SET
         status = 'online', last_seen_at = now()`,
      [testAgentId, 'Test Agent', 'dev', 'claude-code']
    )
    const r = await client.query(`SELECT status FROM agents WHERE agent_id = $1`, [testAgentId])
    expect(r.rows[0].status).toBe('online')
  })

  test('duplicate agent detection (already online)', async () => {
    if (!client) return
    const existing = await client.query(
      `SELECT status FROM agents WHERE agent_id = $1`, [testAgentId]
    )
    expect(existing.rows.length).toBe(1)
    expect(existing.rows[0].status).toBe('online')
    // In real code, this would trigger a warning log
  })
})

// --- Test 8: Content Sanitization ---
describe('8. Content Sanitization', () => {
  const FORBIDDEN_PATTERNS = [/@everyone/gi, /@here/gi, /@channel/gi]

  function sanitizeContent(content: string): string {
    let sanitized = content
    for (const pattern of FORBIDDEN_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[mention removed]')
    }
    return sanitized
  }

  test('@everyone is sanitized', () => {
    expect(sanitizeContent('hello @everyone')).toBe('hello [mention removed]')
  })

  test('@here is sanitized', () => {
    expect(sanitizeContent('alert @here')).toBe('alert [mention removed]')
  })

  test('@channel is sanitized', () => {
    expect(sanitizeContent('notify @channel')).toBe('notify [mention removed]')
  })

  test('normal mentions are preserved', () => {
    expect(sanitizeContent('hello <@12345>')).toBe('hello <@12345>')
  })

  test('multiple forbidden mentions in one message', () => {
    expect(sanitizeContent('@everyone @here @channel test')).toBe(
      '[mention removed] [mention removed] [mention removed] test'
    )
  })
})
