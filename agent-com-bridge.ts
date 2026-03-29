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
import { z } from 'zod'

const PORT = parseInt(process.env.WEBHOOK_PORT ?? '8789', 10)
const OUTBOUND_PORT = PORT + 1000  // Discord adapter outbound port

const mcp = new Server(
  { name: 'agent-com-bridge', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        // Permission-relay opt-in: we authenticate repliers via
        // discord-adapter's access control (allowFrom gate).
        'claude/channel/permission': {},
      },
    },
  }
)

// --- Permission relay: CC → bridge → discord-adapter → Discord DM ---
mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    const { request_id, tool_name, description, input_preview } = params
    try {
      const resp = await fetch(`http://127.0.0.1:${OUTBOUND_PORT}/permission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id, tool_name, description, input_preview }),
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '(no body)')
        process.stderr.write(`agent-com-bridge: permission forward failed (HTTP ${resp.status}): ${text}\n`)
      }
    } catch (err) {
      process.stderr.write(`agent-com-bridge: permission forward failed: ${err}\n`)
    }
  },
)

// HTTP server: receives POST with message payload, pushes to session
const httpServer = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const url = new URL(req.url)

    // --- Permission response from discord-adapter ---
    if (url.pathname === '/permission-response') {
      try {
        const body = await req.json() as { request_id: string; behavior: 'allow' | 'deny' }
        if (!body.request_id || !body.behavior) {
          return new Response(JSON.stringify({ error: 'request_id and behavior required' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          })
        }
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: body.request_id, behavior: body.behavior },
        })
        process.stderr.write(`agent-com-bridge: permission ${body.behavior} for ${body.request_id}\n`)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        process.stderr.write(`agent-com-bridge: permission-response error: ${err}\n`)
        return new Response(JSON.stringify({ ok: false, error: String(err) }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // --- Regular message injection (default path: /) ---
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
