#!/usr/bin/env bun
/**
 * agent-com-bridge — Webhook MCP server for push notifications
 *
 * Receives HTTP POST requests from the listener and converts them
 * to MCP notifications/claude/channel, injecting messages into
 * the Claude Code session.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:agent-com-bridge
 *
 * Env:
 *   WEBHOOK_PORT — HTTP port (default: 8789)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const PORT = parseInt(process.env.WEBHOOK_PORT ?? '8789', 10)

const mcp = new Server(
  { name: 'agent-com-bridge', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
  }
)

// HTTP server: receives POST with message payload, pushes to session
const httpServer = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    try {
      const body = await req.json() as {
        content: string
        meta?: {
          chat_id?: string
          message_id?: string
          user?: string
          user_id?: string
          ts?: string
          source?: string
        }
      }

      if (!body.content) {
        return new Response('Missing content', { status: 400 })
      }

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: body.content,
          meta: {
            chat_id: body.meta?.chat_id ?? 'agent-comms',
            message_id: body.meta?.message_id ?? '',
            user: body.meta?.user ?? 'unknown',
            user_id: body.meta?.user_id ?? 'unknown',
            ts: body.meta?.ts ?? new Date().toISOString(),
            source: body.meta?.source ?? 'agent-comms',
          },
        },
      })

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      process.stderr.write(`agent-com-bridge: error processing POST: ${err}\n`)
      return new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  },
})

process.stderr.write(`agent-com-bridge: listening on http://127.0.0.1:${PORT}\n`)

// Connect MCP via stdio
const transport = new StdioServerTransport()
mcp.connect(transport).then(() => {
  process.stderr.write(`agent-com-bridge: MCP connected (claude/channel capability)\n`)
}).catch(err => {
  process.stderr.write(`agent-com-bridge: MCP connect failed: ${err}\n`)
  process.exit(1)
})

const shutdown = () => {
  httpServer.stop()
  process.stderr.write('agent-com-bridge: shutting down\n')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
