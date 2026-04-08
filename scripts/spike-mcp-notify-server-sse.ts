#!/usr/bin/env bun
/**
 * Q1 PoC Spike — SSE variant.
 *
 * Same notification semantics as the stdio variant, but transport is SSE
 * (HTTP-based) so we can compare whether Claude Code surfaces notifications
 * differently per transport.
 */

import express from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync } from 'node:fs'

const LOG = '/tmp/spike-server-sse.log'
const log = (msg: string) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(LOG, line) } catch {}
  process.stderr.write(line)
}

const PORT = Number(process.env.SPIKE_SSE_PORT ?? 9101)
const SPIKE_TOKEN = `SPIKE-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
let tickCount = 0
let chosenMethod: 'notifications/message' | 'notifications/log' | 'none' = 'notifications/message'
let activeServer: Server | null = null

function makeServer(): Server {
  const server = new Server(
    { name: 'spike-notify-sse', version: '0.0.1' },
    { capabilities: { tools: {}, logging: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log(`ListTools called, emitting tick`)
    await emitTick()
    return { tools: [] }
  })
  return server
}

async function emitTick(): Promise<void> {
  if (!activeServer) return
  tickCount += 1
  const data = `[spike-notify-sse] tick #${tickCount} token=${SPIKE_TOKEN}`
  log(`emit ${chosenMethod}: ${data}`)
  if (chosenMethod === 'none') return
  try {
    await activeServer.notification({
      method: chosenMethod,
      params: { level: 'info', logger: 'spike', data },
    })
  } catch (err) {
    log(`${chosenMethod} threw: ${(err as Error).message}`)
    if (chosenMethod === 'notifications/message') {
      chosenMethod = 'notifications/log'
      log(`falling back to notifications/log`)
      try {
        await activeServer.notification({
          method: chosenMethod,
          params: { level: 'info', logger: 'spike', data },
        })
      } catch (err2) {
        log(`notifications/log also threw: ${(err2 as Error).message}`)
        chosenMethod = 'none'
      }
    } else {
      chosenMethod = 'none'
    }
  }
}

const app = express()
let transport: SSEServerTransport | null = null

app.get('/sse', async (req, res) => {
  log(`/sse client connected from ${req.ip}`)
  transport = new SSEServerTransport('/messages', res)
  activeServer = makeServer()
  await activeServer.connect(transport)
  log(`SSE transport connected, token=${SPIKE_TOKEN}`)
})

app.post('/messages', async (req, res) => {
  if (!transport) {
    res.status(503).end('no transport')
    return
  }
  await transport.handlePostMessage(req, res)
})

app.listen(PORT, () => {
  log(`SSE listener on http://127.0.0.1:${PORT}/sse, token=${SPIKE_TOKEN}, pid=${process.pid}`)
})

setInterval(() => {
  emitTick().catch((err) => log(`tick failed: ${err}`))
}, 800)
