#!/usr/bin/env bun
/**
 * agent-comms-channel — Webhook Channel server for push notifications
 *
 * Lightweight MCP server that receives HTTP POST from SSE daemon
 * and injects messages into the Claude Code session via notification().
 *
 * This replaces the channel plugin's Discord direct monitoring.
 * All filtering is done by the daemon's routeInbound() — this server
 * is a thin bridge that trusts HMAC-signed payloads from the daemon.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:channel-server
 *
 * Env:
 *   CHANNEL_PORT — HTTP listen port (required, from agents.channel_port)
 *   HMAC_SECRET  — Shared secret for HMAC-SHA256 signature verification
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createHmac } from 'node:crypto'

const PORT = parseInt(process.env.CHANNEL_PORT ?? '9001', 10)
const HMAC_SECRET = process.env.HMAC_SECRET ?? ''

// --- MCP Server with claude/channel capability ---
const mcp = new Server(
  { name: 'agent-comms-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
      },
    },
  },
)

// --- HMAC signature verification ---
function verifyHmac(payload: string, signature: string | null): boolean {
  if (!HMAC_SECRET) return true // no secret = skip verification (dev mode)
  if (!signature) return false
  const expected = `sha256=${createHmac('sha256', HMAC_SECRET).update(payload).digest('hex')}`
  return signature === expected
}

// --- HTTP server for push reception ---
const httpServer = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/push') {
      return new Response('Not Found', { status: 404 })
    }

    const body = await req.text()

    // HMAC verification
    if (!verifyHmac(body, req.headers.get('x-signature'))) {
      process.stderr.write(`channel-server: HMAC verification failed\n`)
      return new Response('Unauthorized', { status: 401 })
    }

    try {
      const payload = JSON.parse(body) as {
        content: string
        meta?: {
          chat_id?: string
          message_id?: string
          user?: string
          user_id?: string
          ts?: string
          source?: string
          attachments?: string
        }
      }

      if (!payload.content) {
        return new Response('Missing content', { status: 400 })
      }

      // Inject into Claude Code session via MCP notification
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: payload.content,
          meta: {
            chat_id: payload.meta?.chat_id ?? 'agent-comms',
            message_id: payload.meta?.message_id ?? '',
            user: payload.meta?.user ?? 'unknown',
            user_id: payload.meta?.user_id ?? 'unknown',
            ts: payload.meta?.ts ?? new Date().toISOString(),
            source: payload.meta?.source ?? 'agent-comms',
            ...(payload.meta?.attachments ? { attachments: payload.meta.attachments } : {}),
          },
        },
      })

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      process.stderr.write(`channel-server: push handling error: ${err}\n`)
      return new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  },
})

process.stderr.write(`channel-server: listening on http://127.0.0.1:${PORT}/push\n`)

// --- Connect to Claude Code via stdio ---
const transport = new StdioServerTransport()
await mcp.connect(transport)

// --- Graceful shutdown ---
const shutdown = () => {
  httpServer.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
